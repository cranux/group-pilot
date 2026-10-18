import { enterTerminal } from '../accounts/service.js';
import { terminalStatusForGatewayCode } from '../accounts/states.js';
import type { Tx } from '../db/db.js';
import { markGroupUnreachable } from '../groups/lifecycle.js';
import { applyMemberEvent } from '../groups/membership.js';
import { isPlainObject, sanitizeText } from '../lib/json.js';
import type { Signals } from '../lib/signals.js';
import { emitMessage, type MessageRow } from '../messages/model.js';
import { markFailed, markSent } from '../messages/status.js';

export type HandleOutcome = 'done' | 'ignored';

/** 暂时处理不了（例如群刚在网关建好、本地还没落库），稍后重试，不算失败 */
export class DeferEvent extends Error {}

export class InvalidEvent extends Error {}

interface GroupRef {
  id: string;
  status: string;
  agent_enabled: boolean;
}

function str(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  if (typeof v !== 'string' || v === '') throw new InvalidEvent(`字段 ${key} 缺失或不是字符串`);
  return v;
}

function date(data: Record<string, unknown>, key: string): Date {
  const d = new Date(str(data, key));
  if (Number.isNaN(d.getTime())) throw new InvalidEvent(`字段 ${key} 不是合法时间`);
  return d;
}

async function findGroup(tx: Tx, gatewayGroupId: string): Promise<GroupRef | null> {
  const r = await tx.query<GroupRef>('SELECT id, status, agent_enabled FROM groups WHERE gateway_group_id = $1', [gatewayGroupId]);
  if (r.rows[0]) return r.rows[0];
  // 建群 job 在网关建群与本地落库之间：稍后再处理
  const creating = await tx.query(
    `SELECT 1 FROM jobs WHERE type = 'create_group' AND status = 'running'
        AND (state->>'gatewayGroupId' IS NULL OR state->>'gatewayGroupId' = $1)
        AND created_at > now() - interval '2 minutes' LIMIT 1`,
    [gatewayGroupId],
  );
  if (creating.rowCount) throw new DeferEvent(`group ${gatewayGroupId} not yet persisted`);
  return null;
}

export async function handleGatewayEvent(
  tx: Tx,
  event: { event_id: number; type: string; raw: string },
  signals: Signals,
): Promise<HandleOutcome> {
  let data: unknown;
  try {
    data = JSON.parse(event.raw);
  } catch {
    throw new InvalidEvent('事件 data 不是合法 JSON');
  }
  if (!isPlainObject(data)) throw new InvalidEvent('事件 data 不是对象');
  // data 内也带 type；以 data.type 为准，缺省用帧的 event 字段
  const type = typeof data.type === 'string' ? data.type : event.type;

  switch (type) {
    case 'message':
      return onMessage(tx, data, signals);
    case 'message_sent':
      return onMessageSent(tx, data);
    case 'message_failed':
      return onMessageFailed(tx, data);
    case 'member_joined':
    case 'member_left':
      return onMember(tx, data, type === 'member_joined', event.event_id, signals);
    case 'account_status':
      return onAccountStatus(tx, data);
    default:
      return 'ignored';
  }
}

async function onMessage(tx: Tx, data: Record<string, unknown>, signals: Signals): Promise<HandleOutcome> {
  const group = await findGroup(tx, str(data, 'groupId'));
  if (!group) return 'ignored';
  const msgId = str(data, 'msgId');
  const sentAt = date(data, 'sentAt');
  const sender = typeof data.senderPlatformUserId === 'string' ? data.senderPlatformUserId : null;
  const text = typeof data.text === 'string' ? sanitizeText(data.text) : '';
  const mediaUrl = typeof data.mediaUrl === 'string' && data.mediaUrl ? data.mediaUrl : null;

  const existing = await tx.query<{ id: number; media_url: string | null }>(
    'SELECT id, media_url FROM messages WHERE group_id = $1 AND msg_id = $2',
    [group.id, msgId],
  );
  if (existing.rows[0]) {
    // 重复 / 补投：时间线已有这一行
    if (mediaUrl && !existing.rows[0].media_url) {
      await tx.query(`UPDATE messages SET media_url = $2, media_status = 'pending', updated_at = now() WHERE id = $1`, [
        existing.rows[0].id,
        mediaUrl,
      ]);
      tx.afterCommit(() => signals.wake('media'));
    }
    return 'done';
  }

  const acc = sender
    ? await tx.query<{ id: string }>('SELECT id FROM accounts WHERE platform_user_id = $1', [sender])
    : { rows: [] as Array<{ id: string }> };
  const ownAccountId = acc.rows[0]?.id ?? null;
  const isOwn = ownAccountId !== null;

  const inserted = await tx.query<MessageRow>(
    `INSERT INTO messages (group_id, msg_id, sender_account_id, sender_platform_user_id, is_own, text, sent_at,
                           delivery_status, source, media_url, media_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'inbound', $9, $10)
     ON CONFLICT (group_id, msg_id) DO NOTHING
     RETURNING *`,
    [group.id, msgId, ownAccountId, sender, isOwn, text, sentAt, isOwn ? 'sent' : null, mediaUrl, mediaUrl ? 'pending' : null],
  );
  const row = inserted.rows[0];
  if (!row) return 'done';
  emitMessage(tx, row);
  if (mediaUrl) tx.afterCommit(() => signals.wake('media'));

  // 自己的消息回流不触发 agent；其它消息在 agentEnabled 的群里记为待处理，由调度器建 run
  if (!isOwn && group.status === 'active' && group.agent_enabled) {
    await tx.query(
      'INSERT INTO agent_pending_triggers (group_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [group.id, row.id],
    );
    tx.afterCommit(() => signals.wake('agent'));
  }
  return 'done';
}

async function lockByClientId(tx: Tx, clientMsgId: string): Promise<MessageRow | null> {
  const r = await tx.query<MessageRow>('SELECT * FROM messages WHERE client_msg_id = $1 FOR UPDATE', [clientMsgId]);
  return r.rows[0] ?? null;
}

async function onMessageSent(tx: Tx, data: Record<string, unknown>): Promise<HandleOutcome> {
  const row = await lockByClientId(tx, str(data, 'clientMsgId'));
  if (!row) return 'ignored';
  await markSent(tx, row, str(data, 'msgId'), date(data, 'sentAt'));
  return 'done';
}

async function onMessageFailed(tx: Tx, data: Record<string, unknown>): Promise<HandleOutcome> {
  const row = await lockByClientId(tx, str(data, 'clientMsgId'));
  if (!row) return 'ignored';
  const code = str(data, 'code');
  if (code === 'GROUP_WRITE_FORBIDDEN') {
    await markGroupUnreachable(tx, row.group_id);
    await markFailed(tx, row.id, code);
    return 'done';
  }
  await markFailed(tx, row.id, code);
  const terminal = terminalStatusForGatewayCode(code);
  if (terminal && row.sender_account_id) {
    await enterTerminal(tx, row.sender_account_id, terminal as 'suspended' | 'session_expired');
  }
  return 'done';
}

async function onMember(
  tx: Tx,
  data: Record<string, unknown>,
  joined: boolean,
  eventId: number,
  signals: Signals,
): Promise<HandleOutcome> {
  const group = await findGroup(tx, str(data, 'groupId'));
  if (!group) return 'ignored';
  const changed = await applyMemberEvent(tx, group.id, str(data, 'platformUserId'), joined, eventId);
  if (changed) {
    tx.emit('group_updated', { groupId: group.id });
    tx.afterCommit(() => signals.wake('jobs'));
  }
  return 'done';
}

async function onAccountStatus(tx: Tx, data: Record<string, unknown>): Promise<HandleOutcome> {
  const accountId = str(data, 'accountId');
  const status = str(data, 'status');
  if (status !== 'suspended' && status !== 'session_expired') return 'ignored';
  const exists = await tx.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
  if (!exists.rowCount) return 'ignored';
  // 已在终态（含重复进入同一终态）静默忽略
  await enterTerminal(tx, accountId, status);
  return 'done';
}
