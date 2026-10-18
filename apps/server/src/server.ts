import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { AccountService, recoverRateLimited } from './accounts/service.js';
import { AgentClient } from './agent/client.js';
import { AgentRunner } from './agent/runner.js';
import { AgentScheduler } from './agent/scheduler.js';
import { AgentRunService } from './agent/service.js';
import { AuthService } from './auth/service.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { Db } from './db/db.js';
import { currentSchemaVersion, expectedSchemaVersion } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { GatewayClient } from './gateway/client.js';
import { InboxProcessor } from './gateway/inbox.js';
import { GatewayEventStream } from './gateway/sse.js';
import { runCreateGroup, runLeaveAll } from './groups/jobs.js';
import { GroupService } from './groups/service.js';
import { registerAuthHook, registerErrorHandling, registerRoutes } from './http/routes.js';
import { JobRunner } from './jobs/runner.js';
import { Loop } from './lib/loop.js';
import { Signals } from './lib/signals.js';
import { MediaWorker } from './media/worker.js';
import { UnknownResolver } from './messages/resolver.js';
import { OutboxSender } from './messages/sender.js';
import { RealtimeHub } from './realtime/hub.js';
import { registerWebSocket } from './realtime/ws.js';
import { SequenceScheduler, rescheduleOverdueSteps } from './sequences/scheduler.js';
import { SequenceService } from './sequences/service.js';

export class SchemaOutdatedError extends Error {
  constructor(
    readonly current: number | null,
    readonly expected: number,
  ) {
    super(`数据库 schema 版本 ${current ?? '（未初始化）'} 落后于代码要求的 ${expected}，请先执行 pnpm migrate`);
  }
}

export interface ServerOptions {
  logger?: boolean | Record<string, unknown>;
}

export interface ServerHandle {
  app: FastifyInstance;
  ctx: AppContext;
  sse: GatewayEventStream;
  /** 监听端口并启动全部后台工作者；返回实际地址 */
  start(listen?: boolean): Promise<string>;
  stop(): Promise<void>;
}

export async function createServer(config: Config, opts: ServerOptions = {}): Promise<ServerHandle> {
  const pool = createPool(config.databaseUrl);
  const db = new Db(pool);

  // schema 落后于代码 → 拒绝启动
  const expected = expectedSchemaVersion();
  const current = await currentSchemaVersion(pool).catch(async (err) => {
    await pool.end();
    throw err;
  });
  if (current === null || current < expected) {
    await pool.end();
    throw new SchemaOutdatedError(current, expected);
  }

  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
  });
  // 空 body 的 JSON 请求视为 {}
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString();
    if (!text.trim()) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err: any = new Error('请求体不是合法 JSON');
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  const signals = new Signals();
  const hub = new RealtimeHub(db, app.log);
  const ctx: AppContext = {
    config,
    db,
    gateway: new GatewayClient(config.gatewayUrl, {
      timeoutMs: config.gatewayTimeoutMs,
      sendTimeoutMs: config.gatewaySendTimeoutMs,
      kickTimeoutMs: config.gatewayKickTimeoutMs,
    }),
    agent: new AgentClient(config.agentUrl),
    signals,
    log: app.log,
    hub,
  };

  const auth = new AuthService(db, config);
  auth.onSessionRevoked = (sid) => hub.closeSession(sid);
  const services = {
    auth,
    accounts: new AccountService(db, ctx.gateway),
    groups: new GroupService(ctx),
    agentRuns: new AgentRunService(ctx),
    sequences: new SequenceService(ctx),
  };

  await app.register(cookie);
  await app.register(websocket);
  registerErrorHandling(app);
  registerAuthHook(app, auth);
  registerRoutes(app, ctx, services, () => currentSchemaVersion(pool));
  registerWebSocket(app, hub, auth);

  // ---------- 后台工作者 ----------
  const sse = new GatewayEventStream(ctx);
  const inbox = new InboxProcessor(ctx);
  const sender = new OutboxSender(ctx);
  const resolver = new UnknownResolver(ctx);
  const jobs = new JobRunner(ctx, { create_group: runCreateGroup, leave_all: runLeaveAll });
  const agentScheduler = new AgentScheduler(ctx);
  const agentRunner = new AgentRunner(ctx);
  const sequenceScheduler = new SequenceScheduler(ctx);
  const media = new MediaWorker(ctx);

  const loops = [
    { loop: new Loop('inbox', 200, () => inbox.runOnce(), app.log), wake: ['inbox'] as const },
    { loop: new Loop('outbox', 250, () => sender.runOnce(), app.log), wake: ['outbox'] as const },
    { loop: new Loop('resolver', 300, () => resolver.runOnce(), app.log), wake: ['resolver'] as const },
    {
      loop: new Loop(
        'rate-limit-recovery',
        250,
        async () => {
          if ((await recoverRateLimited(db)) > 0) signals.wake('outbox');
        },
        app.log,
      ),
      wake: ['accounts'] as const,
    },
    { loop: new Loop('jobs', 500, () => jobs.runOnce(), app.log), wake: ['jobs'] as const },
    { loop: new Loop('agent-scheduler', 300, () => agentScheduler.runOnce(), app.log), wake: ['agent'] as const },
    { loop: new Loop('agent-runner', 300, () => agentRunner.runOnce(), app.log), wake: ['agent'] as const },
    { loop: new Loop('sequences', 250, () => sequenceScheduler.runOnce(), app.log), wake: ['sequence', 'outbox'] as const },
    { loop: new Loop('media-download', 1_000, () => media.downloadOnce(), app.log), wake: ['media'] as const },
    {
      loop: new Loop('media-cleanup', config.mediaCleanupIntervalMs, async () => void (await media.cleanupOnce()), app.log),
      wake: [] as const,
    },
  ];

  let started = false;
  let stopped = false;
  return {
    app,
    ctx,
    sse,
    async start(listen = true) {
      await hub.start();
      // 重启后只重排每个序列最早一个已过期的步骤
      await rescheduleOverdueSteps(db);
      for (const { loop, wake } of loops) loop.start(signals, [...wake]);
      sse.start();
      started = true;
      if (!listen) return '';
      return app.listen({ port: config.port, host: config.host });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (started) {
        await sse.stop();
        await Promise.all(loops.map(({ loop }) => loop.stop()));
        await Promise.all([agentRunner.stop(), jobs.stop()]);
        await hub.stop();
      }
      await app.close();
      await pool.end();
    },
  };
}
