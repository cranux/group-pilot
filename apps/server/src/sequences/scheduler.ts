import type { AppContext } from '../context.js';
import type { Db } from '../db/db.js';
import { enqueueOwnMessage } from '../messages/outbox.js';
import { emitSequenceRun, skipStep, type SequenceRunRow, type SequenceStepRow } from './progress.js';

interface Candidate {
  id: string;
  platform_user_id: string | null;
  status: string;
  rate_limited_until: Date | null;
  role: string;
}

/**
 * 到期步骤 → 选账号 → 入出站队列。
 * admin：role ∈ {creator, admin} 且 online（优先 admin）；member：role = member 且 online，按 accountId 字典序第一个。
 * 只有 rate_limited 的候选 → 顺延到限流结束；完全没有候选 → skipped。
 */
export class SequenceScheduler {
  constructor(private readonly ctx: AppContext) {}

  async runOnce(): Promise<boolean> {
    const due = await this.ctx.db.query<{ run_id: string; pos: number }>(
      `SELECT s.run_id, s.pos FROM sequence_run_steps s JOIN sequence_runs r ON r.id = s.run_id
        WHERE r.status = 'running' AND s.status = 'pending' AND s.message_id IS NULL AND s.scheduled_at <= now()
        ORDER BY s.scheduled_at LIMIT 50`,
    );
    for (const d of due.rows) await this.fire(d.run_id, d.pos);
    return due.rows.length === 50;
  }

  private async fire(runId: string, pos: number): Promise<void> {
    await this.ctx.db.tx(async (tx) => {
      const runRes = await tx.query<SequenceRunRow>('SELECT * FROM sequence_runs WHERE id = $1 FOR UPDATE SKIP LOCKED', [runId]);
      const run = runRes.rows[0];
      if (!run || run.status !== 'running') return;
      const stepRes = await tx.query<SequenceStepRow>('SELECT * FROM sequence_run_steps WHERE run_id = $1 AND pos = $2 FOR UPDATE', [
        runId,
        pos,
      ]);
      const step = stepRes.rows[0];
      if (!step || step.status !== 'pending' || step.message_id !== null || !step.scheduled_at || step.scheduled_at > new Date()) return;

      const roles = step.account_role === 'admin' ? ['admin', 'creator'] : ['member'];
      const candidates = await tx.query<Candidate>(
        `SELECT a.id, a.platform_user_id, a.status, a.rate_limited_until, gm.role
           FROM group_members gm JOIN accounts a ON a.id = gm.account_id
          WHERE gm.group_id = $1 AND gm.state = 'in' AND gm.role = ANY($2::text[]) AND a.status IN ('online', 'rate_limited')
          ORDER BY array_position($2::text[], gm.role), a.id`,
        [run.group_id, roles],
      );
      const online = candidates.rows.find((c) => c.status === 'online');
      if (!online) {
        const limited = candidates.rows.filter((c) => c.status === 'rate_limited');
        if (limited.length) {
          // 限流中的账号不算「没有」：顺延到最早的限流结束时刻
          const until = Math.min(...limited.map((c) => c.rate_limited_until?.getTime() ?? Date.now() + 1_000));
          await tx.query('UPDATE sequence_run_steps SET scheduled_at = $3, updated_at = now() WHERE run_id = $1 AND pos = $2', [
            runId,
            pos,
            new Date(Math.max(until, Date.now() + 100)),
          ]);
          emitSequenceRun(tx, run);
          return;
        }
        await skipStep(tx, run, step, new Date());
        return;
      }
      // 文本在发送时按启动参数解析（取值在启动时已确定，结果与预检一致）
      const msg = await enqueueOwnMessage(
        tx,
        {
          groupId: run.group_id,
          accountId: online.id,
          platformUserId: online.platform_user_id,
          text: step.resolved_text,
          source: 'sequence',
          sequenceRunId: run.id,
          sequenceStepPos: step.pos,
        },
        this.ctx.signals,
      );
      await tx.query(
        `UPDATE sequence_run_steps SET message_id = $3, client_msg_id = $4, account_id = $5, updated_at = now()
          WHERE run_id = $1 AND pos = $2`,
        [runId, pos, msg.id, msg.client_msg_id, online.id],
      );
      emitSequenceRun(tx, run);
    });
  }
}

/** 重启后：每个运行中序列只重排最早一个已过期的步骤（重启时刻 + 该步 delaySeconds） */
export async function rescheduleOverdueSteps(db: Db): Promise<number> {
  const r = await db.query(
    `UPDATE sequence_run_steps s SET scheduled_at = now() + make_interval(secs => s.delay_seconds), updated_at = now()
       FROM sequence_runs r
      WHERE r.id = s.run_id AND r.status = 'running' AND s.status = 'pending' AND s.message_id IS NULL
        AND s.scheduled_at IS NOT NULL AND s.scheduled_at < now()`,
  );
  return r.rowCount ?? 0;
}
