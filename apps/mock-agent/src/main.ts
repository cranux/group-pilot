import { startMockAgent } from './index.js';

const port = Number(process.env.PORT ?? 4002);
const host = process.env.HOST ?? '0.0.0.0';
const chaos = process.env.CHAOS === '1';
const defaultDelayMs = process.env.DEFAULT_DELAY_MS ? Number(process.env.DEFAULT_DELAY_MS) : 0;

const agent = await startMockAgent({ port, host, chaos, defaultDelayMs, logger: process.env.LOG === '1' });

console.log(`[mock-agent] listening on ${agent.url}` + (chaos ? '  [CHAOS]' : ''));

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mock-agent] ${signal} received, closing`);
  await agent.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
