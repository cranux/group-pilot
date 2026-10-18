import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  gatewayUrl: string;
  agentUrl: string;
  instanceId: string;

  jwtSecret: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  cookieSecure: boolean;

  /** 普通网关请求的超时 */
  gatewayTimeoutMs: number;
  /** send 请求的超时（202 本身可能要一两秒） */
  gatewaySendTimeoutMs: number;
  /** kick 请求的超时（响应可能 1–5 秒） */
  gatewayKickTimeoutMs: number;
  /** 504 之后多久仍查不到即可确认没有发出（网关约定 2 秒） */
  unknownConfirmMs: number;
  /** 建群时等 member_joined 的上限 */
  joinTimeoutMs: number;
  /** 退群后等 member_left 的上限，超时以网关成员列表为准 */
  leaveConfirmMs: number;

  agentTurnTimeoutMs: number;
  agentAuditTimeoutMs: number;
  agentAuditAttempts: number;
  agentMaxSteps: number;
  agentWallClockMs: number;
  agentMaxConsecutiveProtocolErrors: number;
  agentSendWaitMs: number;

  /** 租约时长；崩溃后其它实例 / 重启后的实例在租约过期后接手 */
  leaseMs: number;

  mediaDir: string;
  mediaRetentionDays: number;
  mediaCleanupIntervalMs: number;
  spoolFile: string;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`环境变量 ${key} 不是数字: ${raw}`);
  return n;
}

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const turnTimeout = num(env, 'AGENT_TURN_TIMEOUT_MS', 12_000);
  const config: Config = {
    port: num(env, 'PORT', 3000),
    host: str(env, 'HOST', '0.0.0.0'),
    databaseUrl: str(env, 'DATABASE_URL', 'postgres://localhost:5432/group_pilot'),
    gatewayUrl: str(env, 'GATEWAY_URL', 'http://localhost:4001').replace(/\/$/, ''),
    agentUrl: str(env, 'AGENT_URL', 'http://localhost:4002').replace(/\/$/, ''),
    instanceId: str(env, 'INSTANCE_ID', `srv-${randomUUID().slice(0, 8)}`),

    jwtSecret: str(env, 'JWT_SECRET', 'dev-secret-change-me'),
    accessTokenTtlSec: num(env, 'ACCESS_TOKEN_TTL_SEC', 15 * 60),
    refreshTokenTtlSec: num(env, 'REFRESH_TOKEN_TTL_SEC', 7 * 24 * 3600),
    cookieSecure: str(env, 'COOKIE_SECURE', 'false') === 'true',

    gatewayTimeoutMs: num(env, 'GATEWAY_TIMEOUT_MS', 5_000),
    gatewaySendTimeoutMs: num(env, 'GATEWAY_SEND_TIMEOUT_MS', 6_000),
    gatewayKickTimeoutMs: num(env, 'GATEWAY_KICK_TIMEOUT_MS', 7_000),
    unknownConfirmMs: num(env, 'UNKNOWN_CONFIRM_MS', 2_200),
    joinTimeoutMs: num(env, 'JOIN_TIMEOUT_MS', 10_000),
    leaveConfirmMs: num(env, 'LEAVE_CONFIRM_MS', 5_000),

    // 题目要求每轮超时 10–15 秒（可配）
    agentTurnTimeoutMs: Math.min(15_000, Math.max(10_000, turnTimeout)),
    agentAuditTimeoutMs: num(env, 'AGENT_AUDIT_TIMEOUT_MS', 5_000),
    agentAuditAttempts: 3,
    agentMaxSteps: 12,
    agentWallClockMs: 60_000,
    agentMaxConsecutiveProtocolErrors: 3,
    agentSendWaitMs: 5_000,

    leaseMs: num(env, 'LEASE_MS', 5_000),

    mediaDir: path.resolve(str(env, 'MEDIA_DIR', './media')),
    mediaRetentionDays: num(env, 'MEDIA_RETENTION_DAYS', 30),
    mediaCleanupIntervalMs: num(env, 'MEDIA_CLEANUP_INTERVAL_MS', 60 * 60 * 1000),
    spoolFile: path.resolve(str(env, 'SPOOL_FILE', './data/inbox-spool.jsonl')),
  };
  const merged = { ...config, ...overrides };
  if (env.NODE_ENV === 'production' && merged.jwtSecret === 'dev-secret-change-me') {
    throw new Error('生产环境必须通过 JWT_SECRET 设置签名密钥');
  }
  return merged;
}
