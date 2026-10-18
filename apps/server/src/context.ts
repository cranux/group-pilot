import type { AgentClient } from './agent/client.js';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import type { GatewayClient } from './gateway/client.js';
import type { Logger } from './lib/logger.js';
import type { Signals } from './lib/signals.js';
import type { RealtimeHub } from './realtime/hub.js';

export interface AppContext {
  config: Config;
  db: Db;
  gateway: GatewayClient;
  agent: AgentClient;
  signals: Signals;
  log: Logger;
  hub: RealtimeHub;
}
