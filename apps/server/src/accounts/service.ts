import type { Db, Tx } from '../db/db.js';
import { GatewayError, type GatewayClient } from '../gateway/client.js';
import { removeAccountFromAllGroups } from '../groups/membership.js';
import { AppError, Errors } from '../lib/errors.js';
import { iso } from '../lib/time.js';
import { cancelQueuedForAccount } from '../messages/status.js';
import {
  TRANSITIONS,
  isAccountStatus,
  isLegalTransition,
  isTerminal,
  terminalStatusForGatewayCode,
  type AccountStatus,
} from './states.js';

export interface AccountRow {
  id: string;
  status: AccountStatus;
  platform_user_id: string | null;
  rate_limited_until: Date | null;
  updated_at: Date;
}

export interface AccountDto {
  id: string;
  status: AccountStatus;
  platformUserId: string | null;
  rateLimitedUntil: string | null;
  allowedTransitions: AccountStatus[];
}

export function accountDto(row: AccountRow): AccountDto {
  return {
    id: row.id,
    status: row.status,
    platformUserId: row.platform_user_id,
    rateLimitedUntil: iso(row.rate_limited_until),
    allowedTransitions: [...TRANSITIONS[row.status]],
  };
}

export async function lockAccount(tx: Tx, id: string): Promise<AccountRow | null> {
  const r = await tx.query<AccountRow>('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [id]);
  return r.rows[0] ?? null;
}

/**
 * 在已加锁的账号行上执行一次状态转移，并在同一事务里完成全部后果与推送。
 * 调用方负责校验转移合法性；这里只做写入。
 */
async function applyTransition(
  tx: Tx,
  row: AccountRow,
  to: AccountStatus,
  patch: { platformUserId?: string; rateLimitedUntil?: Date | null } = {},
): Promise<AccountRow> {
  const res = await tx.query<AccountRow>(
    `UPDATE accounts SET status = $2,
            platform_user_id = coalesce($3, platform_user_id),
            rate_limited_until = $4,
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [row.id, to, patch.platformUserId ?? null, to === 'rate_limited' ? (patch.rateLimitedUntil ?? null) : null],
  );
  const updated = res.rows[0];
  tx.emit('account_status_changed', { accountId: row.id, from: row.status, to, account: accountDto(updated) });
  if (isTerminal(to)) {
    // 终态的后果与状态本身同生共死（同一事务）
    const groups = await removeAccountFromAllGroups(tx, row.id);
    await cancelQueuedForAccount(tx, row.id);
    for (const groupId of groups) tx.emit('group_updated', { groupId });
    tx.emit('account_terminal', { accountId: row.id, status: to });
  }
  return updated;
}

/** 任何来源（发送错误、网关事件、操作员）进入终态都走这里；重复进入终态静默忽略 */
export async function enterTerminal(tx: Tx, accountId: string, status: 'suspended' | 'session_expired'): Promise<boolean> {
  const row = await lockAccount(tx, accountId);
  if (!row || isTerminal(row.status)) return false;
  await applyTransition(tx, row, status);
  return true;
}

/** 网关返回 RATE_LIMITED：online → rate_limited；已在限流中只刷新截止时间（不算状态转移） */
export async function markRateLimited(tx: Tx, accountId: string, until: Date): Promise<void> {
  const row = await lockAccount(tx, accountId);
  if (!row) return;
  if (row.status === 'online') {
    await applyTransition(tx, row, 'rate_limited', { rateLimitedUntil: until });
  } else if (row.status === 'rate_limited') {
    await tx.query('UPDATE accounts SET rate_limited_until = greatest(rate_limited_until, $2), updated_at = now() WHERE id = $1', [
      accountId,
      until,
    ]);
  }
}

/** 到期自动恢复；到期时已不是 rate_limited 的不动 */
export async function recoverRateLimited(db: Db): Promise<number> {
  return db.tx(async (tx) => {
    const due = await tx.query<AccountRow>(
      `SELECT * FROM accounts WHERE status = 'rate_limited' AND rate_limited_until <= now()
        ORDER BY id FOR UPDATE SKIP LOCKED`,
    );
    for (const row of due.rows) await applyTransition(tx, row, 'online');
    return due.rows.length;
  });
}

/** 网关错误如果意味着账号终态，就地转入终态并返回 true */
export async function handleTerminalGatewayError(tx: Tx, accountId: string, err: unknown): Promise<boolean> {
  if (!(err instanceof GatewayError) || err.kind !== 'http') return false;
  const terminal = terminalStatusForGatewayCode(err.code);
  if (!terminal) return false;
  await enterTerminal(tx, accountId, terminal as 'suspended' | 'session_expired');
  return true;
}

function gatewayFailure(err: unknown): AppError {
  if (err instanceof GatewayError) {
    return Errors.badGateway('GATEWAY_ERROR', `网关请求失败：${err.code}`, { gatewayCode: err.code, gatewayStatus: err.status });
  }
  return Errors.badGateway('GATEWAY_ERROR', '网关请求失败');
}

export class AccountService {
  constructor(
    private readonly db: Db,
    private readonly gateway: GatewayClient,
  ) {}

  async list(): Promise<AccountDto[]> {
    const r = await this.db.query<AccountRow>('SELECT * FROM accounts ORDER BY id');
    return r.rows.map(accountDto);
  }

  /** POST /api/accounts/:id/connect：idle / disconnected → online */
  async connect(id: string): Promise<{ status: AccountStatus; platformUserId: string | null }> {
    return this.mutate(id, async (tx, row) => {
      if (row.status !== 'idle' && row.status !== 'disconnected') {
        throw Errors.conflict('ILLEGAL_TRANSITION', `账号当前为 ${row.status}，不能 connect`, { from: row.status, to: 'online' });
      }
      return this.goOnline(tx, row);
    });
  }

  /** POST /api/accounts/:id/transition：操作员手动标记（CAS） */
  async transition(id: string, to: unknown, expectedFrom: unknown): Promise<{ status: AccountStatus }> {
    if (!isAccountStatus(to)) throw Errors.validation('to 不是合法的账号状态', { field: 'to' });
    if (!isAccountStatus(expectedFrom)) throw Errors.validation('expectedFrom 必填且必须是合法的账号状态', { field: 'expectedFrom' });
    return this.mutate(id, async (tx, row) => {
      if (!isLegalTransition(expectedFrom, to)) {
        throw Errors.conflict('ILLEGAL_TRANSITION', `不允许 ${expectedFrom} → ${to}`, { from: expectedFrom, to });
      }
      if (row.status !== expectedFrom) {
        throw Errors.conflict('CAS_CONFLICT', `账号当前状态是 ${row.status}，不是 ${expectedFrom}`, {
          currentStatus: row.status,
        });
      }
      if (to === 'online') {
        if (row.status === 'rate_limited') return { status: (await applyTransition(tx, row, 'online')).status };
        return this.goOnline(tx, row);
      }
      if (to === 'disconnected' || to === 'idle') {
        try {
          await this.gateway.disconnect(row.id);
        } catch (err) {
          if (!(err instanceof GatewayError && err.kind === 'http' && err.code === 'ACCOUNT_OFFLINE')) {
            if (await handleTerminalGatewayError(tx, row.id, err)) return { terminal: (err as GatewayError).code };
            throw gatewayFailure(err);
          }
        }
        return { status: (await applyTransition(tx, row, to)).status };
      }
      if (to === 'rate_limited') {
        const until = new Date(Date.now() + 60_000);
        return { status: (await applyTransition(tx, row, 'rate_limited', { rateLimitedUntil: until })).status };
      }
      return { status: (await applyTransition(tx, row, to)).status };
    });
  }

  private async goOnline(tx: Tx, row: AccountRow): Promise<any> {
    let platformUserId: string;
    try {
      platformUserId = (await this.gateway.connect(row.id)).platformUserId;
    } catch (err) {
      if (await handleTerminalGatewayError(tx, row.id, err)) return { terminal: (err as GatewayError).code };
      throw gatewayFailure(err);
    }
    if (typeof platformUserId !== 'string' || !platformUserId) throw Errors.badGateway('GATEWAY_ERROR', '网关未返回 platformUserId');
    const updated = await applyTransition(tx, row, 'online', { platformUserId });
    return { status: updated.status, platformUserId: updated.platform_user_id };
  }

  /**
   * 在账号行锁内执行变更（含网关调用）：并发请求在锁上排队，后到的看到新状态 → CAS_CONFLICT。
   * 网关报告账号已进入终态时，终态照常提交，然后以 409 返回给调用方。
   */
  private async mutate<T>(id: string, fn: (tx: Tx, row: AccountRow) => Promise<T | { terminal: string }>): Promise<T> {
    let result: T | { terminal: string };
    try {
      result = await this.db.tx(async (tx) => {
        await tx.query(`SET LOCAL lock_timeout = '10s'`);
        const row = await lockAccount(tx, id);
        if (!row) throw Errors.notFound('ACCOUNT_NOT_FOUND', `账号 ${id} 不存在`);
        return fn(tx, row);
      });
    } catch (err) {
      // 等锁超时：另一个变更一直占着这个账号
      if ((err as { code?: string }).code === '55P03') throw Errors.conflict('CAS_CONFLICT', '账号正在被另一个操作修改');
      throw err;
    }
    if (result && typeof result === 'object' && 'terminal' in (result as object)) {
      const code = (result as { terminal: string }).terminal;
      throw Errors.conflict(code, `网关报告账号已不可用：${code}`);
    }
    return result as T;
  }
}
