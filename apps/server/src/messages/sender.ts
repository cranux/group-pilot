import { enterTerminal, markRateLimited } from '../accounts/service.js';
import { terminalStatusForGatewayCode } from '../accounts/states.js';
import type { AppContext } from '../context.js';
import { GatewayError } from '../gateway/client.js';
import { markGroupUnreachable } from '../groups/lifecycle.js';
import type { MessageRow } from './model.js';
import {
  claimForSend,
  markAccepted,
  markCancelled,
  markFailed,
  markUnknown,
  releaseUnprocessed,
} from './status.js';

const MAX_PARALLEL = 16;

interface Claimed {
  row: MessageRow;
  gatewayGroupId: string;
}

/**
 * 出站发送器：每个账号严格串行、按 id 顺序取队首（限流到期后按原顺序发出）。
 * 只给 online 账号发送，所以限流等待期内网关收不到该账号的 send。
 */
export class OutboxSender {
  private readonly busy = new Set<string>();

  constructor(private readonly ctx: AppContext) {}

  async runOnce(): Promise<boolean> {
    const heads = await this.ctx.db.query<{ id: number; sender_account_id: string; in_flight: boolean; not_before: Date | null }>(
      `SELECT DISTINCT ON (sender_account_id) id, sender_account_id, in_flight_at IS NOT NULL AS in_flight, next_attempt_at AS not_before
         FROM messages
        WHERE delivery_status = 'queued'
        ORDER BY sender_account_id, id`,
    );
    const now = Date.now();
    const ready = heads.rows.filter(
      (h) => !h.in_flight && !this.busy.has(h.sender_account_id) && (!h.not_before || h.not_before.getTime() <= now),
    );
    if (!ready.length) return false;
    const batch = ready.slice(0, MAX_PARALLEL);
    await Promise.all(
      batch.map(async (h) => {
        this.busy.add(h.sender_account_id);
        try {
          await this.sendOne(h.id, h.sender_account_id);
        } catch (err) {
          this.ctx.log.warn({ err, messageId: h.id }, 'send attempt failed');
        } finally {
          this.busy.delete(h.sender_account_id);
        }
      }),
    );
    return ready.length > batch.length;
  }

  private async claim(messageId: number, accountId: string): Promise<Claimed | null> {
    return this.ctx.db.tx(async (tx) => {
      const acc = await tx.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1 FOR UPDATE SKIP LOCKED', [accountId]);
      const account = acc.rows[0];
      if (!account) return null;
      const busy = await tx.query('SELECT 1 FROM messages WHERE sender_account_id = $1 AND in_flight_at IS NOT NULL LIMIT 1', [accountId]);
      if (busy.rowCount) return null;
      const msgRes = await tx.query<MessageRow & { gateway_group_id: string; group_status: string }>(
        `SELECT m.*, g.gateway_group_id, g.status AS group_status
           FROM messages m JOIN groups g ON g.id = m.group_id
          WHERE m.id = $1 FOR UPDATE OF m`,
        [messageId],
      );
      const msg = msgRes.rows[0];
      if (!msg || msg.delivery_status !== 'queued' || msg.in_flight_at) return null;

      switch (account.status) {
        case 'rate_limited':
          return null; // 等限流结束
        case 'suspended':
        case 'session_expired':
          await markCancelled(tx, msg.id, 'ACCOUNT_TERMINAL');
          return null;
        case 'idle':
        case 'disconnected':
          await markFailed(tx, msg.id, 'ACCOUNT_OFFLINE', ['queued']);
          return null;
      }
      if (msg.group_status !== 'active') {
        await markFailed(tx, msg.id, 'GROUP_UNREACHABLE', ['queued']);
        return null;
      }
      const claimed = await claimForSend(tx, msg.id);
      return claimed ? { row: claimed, gatewayGroupId: msg.gateway_group_id } : null;
    });
  }

  private async sendOne(messageId: number, accountId: string): Promise<void> {
    const claimed = await this.claim(messageId, accountId);
    if (!claimed) return;
    const { row, gatewayGroupId } = claimed;
    let error: unknown = null;
    try {
      await this.ctx.gateway.send(gatewayGroupId, accountId, row.client_msg_id!, row.text);
    } catch (err) {
      error = err;
    }
    // 这一步写库失败时消息停在 in-flight，由解析器按「结果未知」处理，不会盲目重发
    await this.ctx.db.tx(async (tx) => {
      if (!error) {
        await markAccepted(tx, row.id);
        return;
      }
      const err = error instanceof GatewayError ? error : new GatewayError('network', 0, 'NETWORK_ERROR', null, String(error));
      if (err.kind === 'http' && err.status === 429) {
        const seconds = err.retryAfterSeconds ?? 1;
        await releaseUnprocessed(tx, row.id, null);
        await markRateLimited(tx, accountId, new Date(Date.now() + seconds * 1000));
        return;
      }
      if (err.notProcessed) {
        await releaseUnprocessed(tx, row.id, new Date(Date.now() + 1_000));
        return;
      }
      if (err.outcomeUnknown || (err.kind === 'http' && err.status >= 500)) {
        await markUnknown(tx, row.id);
        tx.afterCommit(() => this.ctx.signals.wake('resolver'));
        return;
      }
      const terminal = terminalStatusForGatewayCode(err.code);
      if (terminal) {
        await markFailed(tx, row.id, err.code, ['queued']);
        await enterTerminal(tx, accountId, terminal as 'suspended' | 'session_expired');
        return;
      }
      if (err.code === 'GROUP_WRITE_FORBIDDEN') {
        await markGroupUnreachable(tx, row.group_id);
        await markFailed(tx, row.id, err.code, ['queued']);
        return;
      }
      // SENDER_NOT_IN_GROUP / ACCOUNT_OFFLINE / 其它明确的拒绝：该条失败，账号与群状态不变
      await markFailed(tx, row.id, err.code, ['queued']);
    });
  }
}
