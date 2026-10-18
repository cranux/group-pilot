import { fastify } from 'fastify';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CONFIG, mergeConfig, type DeepPartial, type GatewayConfig } from './config.js';
import { Gateway } from './gateway.js';
import { installHttpBasics, urlFor } from './http.js';
import { registerApiRoutes } from './routes-api.js';
import { registerControlRoutes } from './routes-control.js';
import { randInt } from './util.js';

export {
  DEFAULT_CONFIG,
  DEFAULT_TIMING,
  FAST_TIMING,
  type DeepPartial,
  type GatewayConfig,
  type RateLimitConfig,
  type Range,
  type TimingConfig,
} from './config.js';
export { ENDPOINTS, type EndpointName, type FaultRule, type RequestLogEntry } from './gateway.js';

export interface MockGatewayHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface StartMockGatewayOptions {
  /** 0 = 随机端口 */
  port?: number;
  /** 默认 127.0.0.1 */
  host?: string;
  /** 在 DEFAULT_CONFIG 上深合并；也是 /_control/reset 恢复到的配置 */
  config?: DeepPartial<GatewayConfig>;
  /** 生成 inviteLink / mediaUrl 用的对外地址；默认等于监听地址 */
  publicUrl?: string;
  /** 打开 fastify 请求日志 */
  logger?: boolean;
}

const PING_INTERVAL_MS = 15_000;

export async function startMockGateway(opts: StartMockGatewayOptions = {}): Promise<MockGatewayHandle> {
  const config = mergeConfig(DEFAULT_CONFIG, opts.config ?? {});
  const gw = new Gateway(config);

  const app = fastify({
    logger: opts.logger ?? false,
    bodyLimit: 10 * 1024 * 1024,
    forceCloseConnections: true,
  });
  installHttpBasics(app, 'mock-gateway');
  registerApiRoutes(app, gw);
  registerControlRoutes(app, gw);

  // SSE 心跳
  const ping = setInterval(() => gw.hub.pingAll(), PING_INTERVAL_MS);
  // chaos：约每 60s 断开一次所有 SSE 连接
  const scheduleChaosDrop = () => {
    gw.req.after(randInt(50_000, 70_000), () => {
      if (gw.config.chaos) gw.hub.dropAll();
      scheduleChaosDrop();
    });
  };
  scheduleChaosDrop();

  app.addHook('preClose', async () => {
    clearInterval(ping);
    gw.hub.dropAll();
  });
  app.addHook('onClose', async () => {
    gw.biz.cancelAll();
    gw.req.cancelAll();
  });

  const host = opts.host ?? '127.0.0.1';
  try {
    await app.listen({ port: opts.port ?? 0, host });
  } catch (err) {
    clearInterval(ping);
    gw.req.cancelAll();
    throw err;
  }
  const port = (app.server.address() as AddressInfo).port;
  const url = urlFor(host, port);
  gw.publicUrl = (opts.publicUrl ?? url).replace(/\/+$/, '');

  let closing: Promise<void> | null = null;
  return {
    url,
    port,
    close: () => (closing ??= app.close().then(() => undefined)),
  };
}
