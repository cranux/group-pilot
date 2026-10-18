import type { AppContext } from '../context.js';
import { DeferEvent, handleGatewayEvent } from './handlers.js';

const BATCH = 200;
const MAX_ATTEMPTS = 20;

interface InboxRow {
  event_id: number;
  type: string;
  raw: string;
  attempts: number;
}

/**
 * 按 eventId 顺序处理收件箱。每个事件一个事务，业务处理放在保存点里：
 * 处理失败 → 回滚保存点、记录失败与退避时间、同事务推 inconsistency，然后继续处理后面的事件；
 * 事件原文一直留在 inbox 里，不会丢。
 */
export class InboxProcessor {
  constructor(private readonly ctx: AppContext) {}

  async runOnce(): Promise<boolean> {
    const ids = await this.ctx.db.query<{ event_id: number }>(
      `SELECT event_id FROM gateway_inbox
        WHERE status IN ('pending', 'failed') AND next_attempt_at <= now()
        ORDER BY event_id LIMIT $1`,
      [BATCH],
    );
    for (const { event_id } of ids.rows) await this.processOne(event_id);
    return ids.rows.length === BATCH;
  }

  async processOne(eventId: number): Promise<void> {
    try {
      await this.ctx.db.tx(async (tx) => {
        const res = await tx.query<InboxRow>(
          `SELECT event_id, type, raw, attempts FROM gateway_inbox
            WHERE event_id = $1 AND status IN ('pending', 'failed') FOR UPDATE SKIP LOCKED`,
          [eventId],
        );
        const row = res.rows[0];
        if (!row) return;
        try {
          const outcome = await tx.savepoint(() => handleGatewayEvent(tx, row, this.ctx.signals));
          await tx.query(
            `UPDATE gateway_inbox SET status = $2, processed_at = now(), attempts = attempts + 1, last_error = NULL WHERE event_id = $1`,
            [eventId, outcome],
          );
        } catch (err) {
          if (err instanceof DeferEvent) {
            await tx.query(`UPDATE gateway_inbox SET next_attempt_at = now() + interval '500 milliseconds' WHERE event_id = $1`, [
              eventId,
            ]);
            return;
          }
          const attempts = row.attempts + 1;
          const dead = attempts >= MAX_ATTEMPTS;
          const backoffSec = Math.min(60, 2 ** Math.min(attempts, 6) / 2);
          const message = String((err as Error)?.message ?? err).slice(0, 1000);
          await tx.query(
            `UPDATE gateway_inbox SET status = $2, attempts = $3, last_error = $4,
                    next_attempt_at = now() + make_interval(secs => $5)
              WHERE event_id = $1`,
            [eventId, dead ? 'dead' : 'failed', attempts, message, backoffSec],
          );
          if (attempts === 1 || dead) {
            tx.emit('inconsistency', {
              kind: dead ? 'event_dead_lettered' : 'event_processing_failed',
              ref: `event:${eventId}`,
              message: `处理网关事件 ${eventId}（${row.type}）失败${dead ? '，已停止重试（原文保留在收件箱）' : '，将自动重试'}：${message}`,
            });
          }
          this.ctx.log.warn({ eventId, type: row.type, err: message }, 'gateway event processing failed');
        }
      });
    } catch (err) {
      // 连失败记录都写不进去（数据库整体不可用）：事件仍是 pending，下轮重试；先用内存通道告知操作员
      this.ctx.hub.broadcastTransient('inconsistency', {
        kind: 'event_processing_failed',
        ref: `event:${eventId}`,
        message: `处理网关事件 ${eventId} 时数据库不可用，将自动重试：${String((err as Error)?.message ?? err)}`,
      });
    }
  }
}
