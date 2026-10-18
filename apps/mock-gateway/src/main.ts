import { FAST_TIMING, startMockGateway, type DeepPartial, type GatewayConfig } from './index.js';

const port = Number(process.env.PORT ?? 4001);
const host = process.env.HOST ?? '0.0.0.0';
const chaos = process.env.CHAOS === '1';
const fast = process.env.FAST === '1';

const config: DeepPartial<GatewayConfig> = {};
if (fast) config.timing = FAST_TIMING;
if (chaos) {
  // 随机故障：重复事件 0.3、乱序窗口 800ms；其余（send 5% 504、2% 503、定期断 SSE、邀请 TTL 5–30s）由 chaos 开关驱动
  config.duplicateEvents = 0.3;
  config.reorderWindowMs = 800;
  config.chaos = true;
}

const gw = await startMockGateway({
  port,
  host,
  config,
  publicUrl: process.env.PUBLIC_URL,
  logger: process.env.LOG === '1',
});

console.log(
  `[mock-gateway] listening on ${gw.url}  control panel: ${gw.url}/_control` +
    (chaos ? '  [CHAOS]' : '') +
    (fast ? '  [FAST]' : ''),
);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mock-gateway] ${signal} received, closing`);
  await gw.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
