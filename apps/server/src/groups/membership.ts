import type { Tx } from '../db/db.js';

export type MemberRole = 'creator' | 'admin' | 'member';

export interface MemberRow {
  group_id: string;
  platform_user_id: string;
  account_id: string | null;
  role: MemberRole;
  state: 'in' | 'out';
  last_event_id: number;
}

/** 当前已收到的最大网关 eventId：本地合成的成员变更以它为「版本」，比它更旧的乱序事件不会覆盖 */
export async function maxInboxEventId(tx: Tx): Promise<number> {
  const r = await tx.query<{ v: number }>('SELECT coalesce(max(event_id), 0) AS v FROM gateway_inbox');
  return Number(r.rows[0].v);
}

async function upsert(
  tx: Tx,
  groupId: string,
  platformUserId: string,
  accountId: string | null,
  role: MemberRole,
  state: 'in' | 'out',
  version: number,
  strict: boolean,
): Promise<MemberRow | null> {
  const res = await tx.query<MemberRow>(
    `INSERT INTO group_members (group_id, platform_user_id, account_id, role, state, last_event_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (group_id, platform_user_id) DO UPDATE SET
       state = EXCLUDED.state,
       account_id = coalesce(EXCLUDED.account_id, group_members.account_id),
       role = CASE WHEN EXCLUDED.state = 'in' AND group_members.state = 'out' THEN EXCLUDED.role ELSE group_members.role END,
       last_event_id = greatest(EXCLUDED.last_event_id, group_members.last_event_id),
       updated_at = now()
     WHERE ${strict ? 'group_members.last_event_id < EXCLUDED.last_event_id' : 'true'}
     RETURNING *`,
    [groupId, platformUserId, accountId, role, state, version],
  );
  return res.rows[0] ?? null;
}

async function roleFor(tx: Tx, groupId: string, accountId: string | null): Promise<MemberRole> {
  if (!accountId) return 'member';
  const r = await tx.query<{ creator_account_id: string }>('SELECT creator_account_id FROM groups WHERE id = $1', [groupId]);
  return r.rows[0]?.creator_account_id === accountId ? 'creator' : 'member';
}

async function accountByPlatformUser(tx: Tx, platformUserId: string): Promise<string | null> {
  const r = await tx.query<{ id: string }>('SELECT id FROM accounts WHERE platform_user_id = $1', [platformUserId]);
  return r.rows[0]?.id ?? null;
}

/** 网关成员事件：只应用比已记录版本更新的事件（抵御 ≤1s 的乱序） */
export async function applyMemberEvent(
  tx: Tx,
  groupId: string,
  platformUserId: string,
  joined: boolean,
  eventId: number,
): Promise<MemberRow | null> {
  const accountId = await accountByPlatformUser(tx, platformUserId);
  const role = await roleFor(tx, groupId, accountId);
  return upsert(tx, groupId, platformUserId, accountId, role, joined ? 'in' : 'out', eventId, true);
}

/** 本地已确认的成员变化（建群写入群主、ALREADY_MEMBER、退群确认、对账） */
export async function setMembership(
  tx: Tx,
  groupId: string,
  platformUserId: string,
  accountId: string | null,
  state: 'in' | 'out',
  role?: MemberRole,
): Promise<MemberRow | null> {
  const version = await maxInboxEventId(tx);
  return upsert(tx, groupId, platformUserId, accountId, role ?? (await roleFor(tx, groupId, accountId)), state, version, false);
}

export async function removeAccountFromAllGroups(tx: Tx, accountId: string): Promise<string[]> {
  const version = await maxInboxEventId(tx);
  const res = await tx.query<{ group_id: string }>(
    `UPDATE group_members SET state = 'out', last_event_id = greatest(last_event_id, $2), updated_at = now()
      WHERE account_id = $1 AND state = 'in' RETURNING group_id`,
    [accountId, version],
  );
  return res.rows.map((r) => r.group_id);
}

export async function isMember(tx: Tx, groupId: string, accountId: string): Promise<boolean> {
  const r = await tx.query(
    `SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2 AND state = 'in'`,
    [groupId, accountId],
  );
  return (r.rowCount ?? 0) > 0;
}
