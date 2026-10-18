import type { Tx } from '../db/db.js';
import { onSequenceMessageStatus } from '../sequences/progress.js';
import { emitMessage, type DeliveryStatus, type MessageRow } from './model.js';

/**
 * 出站消息状态的唯一写入口：条件更新（只从 from 列表里的状态转出，乱序/重复事件不会把状态改回去），
 * 同一事务里推送 message 事件并联动序列步骤。返回 null 表示条件不满足、未改动。
 */
async function transition(
  tx: Tx,
  id: number,
  from: DeliveryStatus[],
  set: string,
  params: unknown[],
  extraWhere = '',
): Promise<MessageRow | null> {
  const res = await tx.query<MessageRow>(
    `UPDATE messages SET ${set}, updated_at = now()
      WHERE id = $1 AND delivery_status = ANY($2::text[]) ${extraWhere}
      RETURNING *`,
    [id, from, ...params],
  );
  const row = res.rows[0] ?? null;
  if (row) {
    emitMessage(tx, row);
    await onSequenceMessageStatus(tx, row);
  }
  return row;
}

/** 发送前占用：写 in_flight_at 并累计尝试次数（崩溃后据此判断「可能已经发出」） */
export async function claimForSend(tx: Tx, id: number): Promise<MessageRow | null> {
  const res = await tx.query<MessageRow>(
    `UPDATE messages SET in_flight_at = now(), attempt_count = attempt_count + 1, updated_at = now()
      WHERE id = $1 AND delivery_status = 'queued' AND in_flight_at IS NULL
      RETURNING *`,
    [id],
  );
  return res.rows[0] ?? null;
}

export function markAccepted(tx: Tx, id: number) {
  return transition(tx, id, ['queued'], `delivery_status = 'accepted', accepted_at = now(), in_flight_at = NULL`, []);
}

export async function markSent(tx: Tx, row: MessageRow, msgId: string, sentAt: Date): Promise<MessageRow | null> {
  // 回流的 message 事件可能先到，已经生成了一行孤儿（无 clientMsgId）：合并进出站行，保证一条消息只有一行
  const orphans = await tx.query<{ id: number; media_url: string | null }>(
    `DELETE FROM messages
      WHERE group_id = $1 AND msg_id = $2 AND id <> $3 AND client_msg_id IS NULL
      RETURNING id, media_url`,
    [row.group_id, msgId, row.id],
  );
  for (const o of orphans.rows) tx.emit('message_removed', { groupId: row.group_id, id: String(o.id) });
  const mediaUrl = orphans.rows.find((o) => o.media_url)?.media_url ?? null;
  return transition(
    tx,
    row.id,
    ['queued', 'accepted', 'unknown', 'failed'],
    `delivery_status = 'sent', msg_id = $3, sent_at = $4, fail_code = NULL, in_flight_at = NULL, unknown_since = NULL,
     media_url = coalesce(media_url, $5::text), media_status = CASE WHEN $5::text IS NOT NULL AND media_status IS NULL THEN 'pending' ELSE media_status END`,
    [msgId, sentAt, mediaUrl],
    // failed → sent 只允许「判定超时失败、其实已落地」这一种真实情况
    `AND (delivery_status <> 'failed' OR fail_code = 'NETWORK_TIMEOUT')`,
  );
}

export function markFailed(tx: Tx, id: number, code: string, from: DeliveryStatus[] = ['queued', 'accepted', 'unknown']) {
  return transition(
    tx,
    id,
    from,
    `delivery_status = 'failed', fail_code = $3, in_flight_at = NULL, unknown_since = NULL`,
    [code],
  );
}

export function markCancelled(tx: Tx, id: number, code: string) {
  return transition(
    tx,
    id,
    ['queued'],
    `delivery_status = 'cancelled', fail_code = $3, in_flight_at = NULL`,
    [code],
    'AND in_flight_at IS NULL',
  );
}

export function markUnknown(tx: Tx, id: number) {
  return transition(tx, id, ['queued'], `delivery_status = 'unknown', unknown_since = now(), in_flight_at = NULL`, []);
}

/** 网关明确没处理（429 / 503 / 连不上）：退回队列，不算一次尝试 */
export async function releaseUnprocessed(tx: Tx, id: number, retryAt: Date | null): Promise<void> {
  await tx.query(
    `UPDATE messages SET in_flight_at = NULL, attempt_count = greatest(attempt_count - 1, 0), next_attempt_at = $2, updated_at = now()
      WHERE id = $1 AND delivery_status = 'queued'`,
    [id, retryAt],
  );
}

/** 已确认没有发出：回到队列，用同一个 clientMsgId 重发（只允许一次） */
export function requeueForResend(tx: Tx, id: number) {
  return transition(
    tx,
    id,
    ['unknown'],
    `delivery_status = 'queued', resend_used = true, unknown_since = NULL, next_attempt_at = NULL`,
    [],
    'AND resend_used = false',
  );
}

/** 账号进入终态：取消它所有排队中（未在途）的消息 */
export async function cancelQueuedForAccount(tx: Tx, accountId: string): Promise<void> {
  const ids = await tx.query<{ id: number }>(
    `SELECT id FROM messages WHERE sender_account_id = $1 AND delivery_status = 'queued' AND in_flight_at IS NULL
      ORDER BY id FOR UPDATE`,
    [accountId],
  );
  for (const { id } of ids.rows) await markCancelled(tx, id, 'ACCOUNT_TERMINAL');
}

/** 群不可写：该群所有排队中（未在途）的消息失败 */
export async function failQueuedForGroup(tx: Tx, groupId: string, code: string): Promise<void> {
  const ids = await tx.query<{ id: number }>(
    `SELECT id FROM messages WHERE group_id = $1 AND delivery_status = 'queued' AND in_flight_at IS NULL
      ORDER BY id FOR UPDATE`,
    [groupId],
  );
  for (const { id } of ids.rows) await markFailed(tx, id, code, ['queued']);
}
