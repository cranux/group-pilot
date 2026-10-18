import type { AppContext } from '../context.js';
import type { MessageRow } from './model.js';
import { markFailed, markSent, markUnknown, requeueForResend } from './status.js';

type Row = MessageRow & { gateway_group_id: string };

/**
 * 结果未知的出站消息：
 * - 504 / 超时 / 崩溃时仍在途 → unknown；
 * - by-client-id 查到 → sent；
 * - 自 unknown 起超过 2 秒仍 404 → 确认没有发出：首次 → 用同一 clientMsgId 重发一次；已重发过 → failed(NETWORK_TIMEOUT)；
 * - 查询接口 503 → 保持 unknown，下一轮（≤ 300ms）再查，恢复后很快得出结论。
 */
export class UnknownResolver {
  private lastAcceptedSweep = 0;
  private readonly inProgress = new Set<number>();

  constructor(private readonly ctx: AppContext) {}

  async runOnce(): Promise<boolean> {
    await this.recoverStaleInFlight();
    const unknown = await this.ctx.db.query<Row>(
      `SELECT m.*, g.gateway_group_id FROM messages m JOIN groups g ON g.id = m.group_id
        WHERE m.delivery_status = 'unknown' ORDER BY m.id LIMIT 100`,
    );
    await Promise.all(unknown.rows.filter((r) => !this.inProgress.has(r.id)).map((r) => this.resolve(r)));
    if (Date.now() - this.lastAcceptedSweep > 5_000) {
      this.lastAcceptedSweep = Date.now();
      await this.sweepAccepted();
    }
    return false;
  }

  /** 在途超过发送超时 + 1s 仍未结案的（通常是进程崩溃留下的）按结果未知处理 */
  private async recoverStaleInFlight(): Promise<void> {
    const staleMs = this.ctx.config.gatewaySendTimeoutMs + 1_000;
    const stale = await this.ctx.db.query<{ id: number }>(
      `SELECT id FROM messages WHERE in_flight_at IS NOT NULL AND in_flight_at < now() - make_interval(secs => $1)`,
      [staleMs / 1000],
    );
    for (const { id } of stale.rows) {
      await this.ctx.db.tx(async (tx) => {
        await markUnknown(tx, id);
      });
    }
  }

  private async resolve(row: Row): Promise<void> {
    this.inProgress.add(row.id);
    try {
      let landed: { msgId: string; sentAt: string } | null;
      try {
        landed = await this.ctx.gateway.byClientId(row.gateway_group_id, row.client_msg_id!);
      } catch {
        return; // 查询不可用：保持 unknown
      }
      await this.ctx.db.tx(async (tx) => {
        const fresh = await tx.query<MessageRow>('SELECT * FROM messages WHERE id = $1 FOR UPDATE', [row.id]);
        const current = fresh.rows[0];
        if (!current || current.delivery_status !== 'unknown') return;
        if (landed) {
          await markSent(tx, current, landed.msgId, new Date(landed.sentAt));
          return;
        }
        const since = current.unknown_since?.getTime() ?? 0;
        if (Date.now() - since < this.ctx.config.unknownConfirmMs) return;
        if (!current.resend_used) {
          await requeueForResend(tx, current.id);
          tx.afterCommit(() => this.ctx.signals.wake('outbox'));
        } else {
          await markFailed(tx, current.id, 'NETWORK_TIMEOUT', ['unknown']);
        }
      });
    } finally {
      this.inProgress.delete(row.id);
    }
  }

  /** 兜底：accepted 很久没等到 message_sent 时主动查询一次 */
  private async sweepAccepted(): Promise<void> {
    const rows = await this.ctx.db.query<Row>(
      `SELECT m.*, g.gateway_group_id FROM messages m JOIN groups g ON g.id = m.group_id
        WHERE m.delivery_status = 'accepted' AND m.accepted_at < now() - interval '10 seconds'
        ORDER BY m.accepted_at LIMIT 20`,
    );
    for (const row of rows.rows) {
      const landed = await this.ctx.gateway.byClientId(row.gateway_group_id, row.client_msg_id!).catch(() => null);
      if (!landed) continue;
      await this.ctx.db.tx(async (tx) => {
        const fresh = await tx.query<MessageRow>('SELECT * FROM messages WHERE id = $1 FOR UPDATE', [row.id]);
        if (fresh.rows[0]?.delivery_status === 'accepted') await markSent(tx, fresh.rows[0], landed.msgId, new Date(landed.sentAt));
      });
    }
  }
}
