import { loadConfig } from './config.js';
import { SchemaOutdatedError, createServer } from './server.js';

const config = loadConfig();

try {
  const server = await createServer(config);
  const address = await server.start();
  server.app.log.info({ address, instanceId: config.instanceId }, 'group-pilot server started');
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    server.app.log.info({ signal }, 'shutting down');
    await server.stop().catch((err) => console.error(err));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
} catch (err) {
  if (err instanceof SchemaOutdatedError) {
    console.error(`[group-pilot] 拒绝启动：${err.message}`);
  } else {
    console.error('[group-pilot] 启动失败：', err);
  }
  process.exit(1);
}
