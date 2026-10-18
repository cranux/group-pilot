import type { Tx } from '../db/db.js';
import type { MessageRow } from '../messages/model.js';

export interface SequenceRunRow {
  id: string;
  sequence_id: string;
  group_id: string;
  status: 'running' | 'finished' | 'failed' | 'stopped';
  vars: Record<string, string>;
  step_vars: Record<string, Record<string, string>>;
  current_step_index: number | null;
  created_at: Date;
  updated_at: Date;
  ended_at: Date | null;
}

export interface SequenceStepRow {
  run_id: string;
  pos: number;
  step_index: number;
  account_role: 'admin' | 'member';
  text_template: string;
  delay_seconds: number;
  resolved_text: string;
  resolved_vars: Record<string, string>;
  var_sources: Record<string, string>;
  status: 'pending' | 'accepted' | 'sent' | 'skipped' | 'failed';
  scheduled_at: Date | null;
  sent_at: Date | null;
  skipped_at: Date | null;
  account_id: string | null;
  message_id: number | null;
  client_msg_id: string | null;
  fail_code: string | null;
}

/** 账号终态导致的失败按「跳过」处理（与排队消息被取消的结果一致） */
const SKIP_CODES = new Set(['ACCOUNT_TERMINAL', 'ACCOUNT_SUSPENDED', 'SESSION_EXPIRED']);

export function emitSequenceRun(tx: Tx, run: Pick<SequenceRunRow, 'id' | 'group_id' | 'status' | 'current_step_index'>): void {
  tx.emit('sequence_run', {
    runId: run.id,
    groupId: run.group_id,
    status: run.status,
    currentStepIndex: run.current_step_index,
  });
}

/** 某一步「发出」（sent 或 skipped）后：排期下一步，或结束整个运行 */
export async function advanceAfter(tx: Tx, run: SequenceRunRow, pos: number, at: Date): Promise<void> {
  const next = await tx.query<SequenceStepRow>(
    'SELECT * FROM sequence_run_steps WHERE run_id = $1 AND pos = $2 FOR UPDATE',
    [run.id, pos + 1],
  );
  const step = next.rows[0];
  if (!step) {
    const done = await tx.query<SequenceRunRow>(
      `UPDATE sequence_runs SET status = 'finished', ended_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'running' RETURNING *`,
      [run.id],
    );
    if (done.rows[0]) emitSequenceRun(tx, done.rows[0]);
    return;
  }
  await tx.query(
    `UPDATE sequence_run_steps SET scheduled_at = $3::timestamptz + make_interval(secs => delay_seconds), updated_at = now()
      WHERE run_id = $1 AND pos = $2`,
    [run.id, step.pos, at],
  );
  const updated = await tx.query<SequenceRunRow>(
    `UPDATE sequence_runs SET current_step_index = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [run.id, step.step_index],
  );
  emitSequenceRun(tx, updated.rows[0]);
}

export async function skipStep(tx: Tx, run: SequenceRunRow, step: SequenceStepRow, at: Date): Promise<void> {
  await tx.query(
    `UPDATE sequence_run_steps SET status = 'skipped', skipped_at = $3, sent_at = $3, updated_at = now()
      WHERE run_id = $1 AND pos = $2`,
    [run.id, step.pos, at],
  );
  if (run.status === 'running') await advanceAfter(tx, run, step.pos, at);
  else emitSequenceRun(tx, run);
}

/**
 * 出站消息状态变化 → 对应序列步骤联动（在消息状态更新的同一事务里执行）。
 * 「发出」以收到 message_sent 的时刻为准：下一步从这一刻起计 delaySeconds。
 */
export async function onSequenceMessageStatus(tx: Tx, msg: MessageRow): Promise<void> {
  if (!msg.sequence_run_id || msg.sequence_step_pos === null) return;
  const runRes = await tx.query<SequenceRunRow>('SELECT * FROM sequence_runs WHERE id = $1 FOR UPDATE', [msg.sequence_run_id]);
  const run = runRes.rows[0];
  if (!run) return;
  const stepRes = await tx.query<SequenceStepRow>(
    'SELECT * FROM sequence_run_steps WHERE run_id = $1 AND pos = $2 FOR UPDATE',
    [run.id, msg.sequence_step_pos],
  );
  const step = stepRes.rows[0];
  if (!step || step.message_id !== msg.id) return;
  const now = new Date();

  switch (msg.delivery_status) {
    case 'accepted':
      if (step.status === 'pending') {
        await tx.query(`UPDATE sequence_run_steps SET status = 'accepted', updated_at = now() WHERE run_id = $1 AND pos = $2`, [
          run.id,
          step.pos,
        ]);
        emitSequenceRun(tx, run);
      }
      return;
    case 'sent':
      if (step.status === 'pending' || step.status === 'accepted' || step.status === 'failed') {
        await tx.query(
          `UPDATE sequence_run_steps SET status = 'sent', sent_at = $3, fail_code = NULL, updated_at = now() WHERE run_id = $1 AND pos = $2`,
          [run.id, step.pos, now],
        );
        if (run.status === 'running') await advanceAfter(tx, run, step.pos, now);
        else emitSequenceRun(tx, run);
      }
      return;
    case 'cancelled':
    case 'failed': {
      if (step.status !== 'pending' && step.status !== 'accepted') return;
      if (SKIP_CODES.has(msg.fail_code ?? '')) {
        await skipStep(tx, run, step, now);
        return;
      }
      await tx.query(
        `UPDATE sequence_run_steps SET status = 'failed', fail_code = $3, updated_at = now() WHERE run_id = $1 AND pos = $2`,
        [run.id, step.pos, msg.fail_code],
      );
      // 群不可写时由群状态变化把运行置为 stopped；其它失败让整个运行失败
      const groupGone = msg.fail_code === 'GROUP_WRITE_FORBIDDEN' || msg.fail_code === 'GROUP_UNREACHABLE';
      if (run.status === 'running' && !groupGone) {
        const failed = await tx.query<SequenceRunRow>(
          `UPDATE sequence_runs SET status = 'failed', ended_at = now(), updated_at = now() WHERE id = $1 AND status = 'running' RETURNING *`,
          [run.id],
        );
        if (failed.rows[0]) emitSequenceRun(tx, failed.rows[0]);
      } else {
        emitSequenceRun(tx, run);
      }
      return;
    }
    default:
      return;
  }
}
