import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import WebSocket from 'ws';
import { FAST_TIMING, startMockGateway, type MockGatewayHandle } from '@gp/mock-gateway';
import { startMockAgent, type MockAgentHandle } from '@gp/mock-agent';
import { loadConfig, type Config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createServer, type ServerHandle } from '../src/server.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/group_pilot_test';

export async function resetDatabase(url = TEST_DB): Promise<void> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000, label = 'condition'): Promise<T> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (err) {
      last = err;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ''}`);
    await sleep(50);
  }
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class Api {
  token: string | null = null;
  cookie: string | null = null;

  constructor(readonly baseUrl: string) {}

  async req<T = any>(method: string, p: string, body?: unknown, opts: { token?: string | null; cookie?: string | null } = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const token = opts.token === undefined ? this.token : opts.token;
    if (token) headers.authorization = `Bearer ${token}`;
    const cookie = opts.cookie === undefined ? this.cookie : opts.cookie;
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${this.baseUrl}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  get = <T = any>(p: string) => this.req<T>('GET', p);
  post = <T = any>(p: string, body?: unknown) => this.req<T>('POST', p, body ?? {});
  patch = <T = any>(p: string, body?: unknown) => this.req<T>('PATCH', p, body ?? {});

  async login(username = 'admin', password = username): Promise<ApiResponse> {
    const res = await this.req('POST', '/api/auth/login', { username, password }, { token: null });
    if (res.status === 200) {
      this.token = res.body.accessToken;
      this.cookie = refreshCookie(res.headers);
    }
    return res;
  }
}

export function refreshCookie(headers: Headers): string | null {
  const raw = headers.getSetCookie?.() ?? [];
  const c = raw.find((x) => x.startsWith('gp_refresh='));
  return c ? c.split(';')[0] : null;
}

export class Control {
  constructor(readonly baseUrl: string) {}

  async call<T = any>(method: string, p: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${p}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`control ${method} ${p} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : (null as T);
  }
}

export interface Stack {
  config: Config;
  server: ServerHandle;
  gw: MockGatewayHandle;
  agent: MockAgentHandle;
  url: string;
  api: Api;
  gwc: Control;
  agentc: Control;
  db: pg.Pool;
  close(): Promise<void>;
  /** 模拟崩溃重启：停掉服务（不做额外清理）再用同一配置拉起 */
  restart(opts?: { downMs?: number; during?: () => Promise<unknown> }): Promise<void>;
}

export interface StackOptions {
  gateway?: Record<string, unknown>;
  config?: Partial<Config>;
  reset?: boolean;
  agentDelayMs?: number;
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  if (opts.reset !== false) await resetDatabase();
  const gw = await startMockGateway({ port: 0, config: { timing: FAST_TIMING, ...(opts.gateway ?? {}) } as any });
  const agent = await startMockAgent({ port: 0, defaultDelayMs: opts.agentDelayMs ?? 0 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-test-'));
  const config = loadConfig(
    {},
    {
      port: 0,
      host: '127.0.0.1',
      databaseUrl: TEST_DB,
      gatewayUrl: gw.url,
      agentUrl: agent.url,
      leaseMs: 1_500,
      mediaDir: path.join(tmp, 'media'),
      spoolFile: path.join(tmp, 'spool.jsonl'),
      ...(opts.config ?? {}),
    },
  );
  let server = await createServer(config, { logger: false });
  let url = await server.start();
  const api = new Api(url);
  const db = new pg.Pool({ connectionString: TEST_DB, max: 4 });
  pg.types.setTypeParser(20, (v) => Number(v));
  const stack: Stack = {
    config,
    server,
    gw,
    agent,
    url,
    api,
    gwc: new Control(gw.url),
    agentc: new Control(agent.url),
    db,
    async close() {
      await stack.server.stop().catch(() => undefined);
      await gw.close();
      await agent.close();
      await db.end();
    },
    async restart({ downMs = 0, during } = {}) {
      await stack.server.stop();
      if (during) await during();
      if (downMs) await sleep(downMs);
      server = await createServer({ ...config, port: Number(new URL(url).port) }, { logger: false });
      url = await server.start();
      stack.server = server;
      stack.url = url;
    },
  };
  return stack;
}

/** 登录 admin、把账号连上网关 */
export async function connectAll(api: Api, ids: string[]): Promise<void> {
  for (const id of ids) {
    const r = await api.post(`/api/accounts/${id}/connect`);
    if (r.status !== 200) throw new Error(`connect ${id} → ${r.status} ${JSON.stringify(r.body)}`);
  }
}

export async function waitJob(api: Api, jobId: string, timeoutMs = 20_000): Promise<any> {
  return waitFor(
    async () => {
      const r = await api.get(`/api/jobs/${jobId}`);
      return r.body?.status && r.body.status !== 'running' ? r.body : null;
    },
    timeoutMs,
    `job ${jobId}`,
  );
}

export async function createGroup(api: Api, creator: string, members: string[]): Promise<any> {
  const r = await api.post('/api/groups', { creatorAccountId: creator, memberAccountIds: members });
  if (r.status !== 202) throw new Error(`create group → ${r.status} ${JSON.stringify(r.body)}`);
  const job = await waitJob(api, r.body.jobId);
  if (job.status !== 'finished') throw new Error(`create group job failed: ${JSON.stringify(job)}`);
  return (await api.get(`/api/groups/${job.groupId}`)).body;
}

export async function messages(api: Api, groupId: string): Promise<any[]> {
  return (await api.get(`/api/groups/${groupId}/messages?limit=200`)).body.items;
}

export function openWs(url: string): { ws: WebSocket; frames: any[]; ready: Promise<any> } {
  const ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws');
  const frames: any[] = [];
  let resolveReady!: (v: any) => void;
  const ready = new Promise((r) => (resolveReady = r));
  ws.on('message', (data) => {
    const f = JSON.parse(data.toString());
    if (f.type === 'auth') resolveReady(f);
    else frames.push(f);
  });
  return { ws, frames, ready };
}
