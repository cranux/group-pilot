import type { Tx } from '../db/db.js';
import { failQueuedForGroup } from '../messages/status.js';
import { emitSequenceRun, type SequenceRunRow } from '../sequences/progress.js';

/** 停掉该群运行中的序列（群不可写 / 已退群） */
async function stopSequenceRuns(tx: Tx, groupId: string): Promise<void> {
  const res = await tx.query<SequenceRunRow>(
    `UPDATE sequence_runs SET status = 'stopped', ended_at = now(), updated_at = now()
      WHERE group_id = $1 AND status = 'running' RETURNING *`,
    [groupId],
  );
  for (const run of res.rows) emitSequenceRun(tx, run);
}

/**
 * GROUP_WRITE_FORBIDDEN → 群 unreachable：序列运行 stopped、不再触发 agent、排队消息失败；
 * 正在执行的 agent run 由执行器在当前步结束后检查群状态并 cancelled。账号状态不变。
 */
export async function markGroupUnreachable(tx: Tx, groupId: string): Promise<boolean> {
  const res = await tx.query(
    `UPDATE groups SET status = 'unreachable', updated_at = now() WHERE id = $1 AND status = 'active' RETURNING id`,
    [groupId],
  );
  if (!res.rowCount) return false;
  await stopSequenceRuns(tx, groupId);
  await tx.query('DELETE FROM agent_pending_triggers WHERE group_id = $1', [groupId]);
  await failQueuedForGroup(tx, groupId, 'GROUP_UNREACHABLE');
  tx.emit('group_updated', { groupId });
  return true;
}

/** leave-all 完成：群 left，成员清空，后续不再有序列与 agent */
export async function markGroupLeft(tx: Tx, groupId: string): Promise<void> {
  await tx.query(`UPDATE groups SET status = 'left', updated_at = now() WHERE id = $1`, [groupId]);
  await tx.query(`UPDATE group_members SET state = 'out', updated_at = now() WHERE group_id = $1 AND state = 'in'`, [groupId]);
  await stopSequenceRuns(tx, groupId);
  await tx.query('DELETE FROM agent_pending_triggers WHERE group_id = $1', [groupId]);
  await failQueuedForGroup(tx, groupId, 'GROUP_UNREACHABLE');
  tx.emit('group_updated', { groupId });
}
