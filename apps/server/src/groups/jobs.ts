import { enterTerminal } from '../accounts/service.js';
import { terminalStatusForGatewayCode } from '../accounts/states.js';
import { GatewayError } from '../gateway/client.js';
import type { JobContext } from '../jobs/runner.js';
import { markGroupLeft } from './lifecycle.js';
import { setMembership } from './membership.js';

type MemberProgress = {
  status: 'pending' | 'requested' | 'joined' | 'failed';
  requestedAt?: number;
  expiredRetried?: boolean;
  notReadyRetries?: number;
};

interface CreateGroupState {
  gatewayGroupId?: string;
  invite?: { link: string; readyAt: number; readyAfterMs: number };
  members: Record<string, MemberProgress>;
  promote: { calls: number; done: boolean };
}

const asGatewayError = (err: unknown) =>
  err instanceof GatewayError ? err : new GatewayError('network', 0, 'NETWORK_ERROR', null, String(err));

/** 网关明确没处理（503 / 连不上）时重试几次 */
async function withRetry<T>(job: JobContext, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const e = asGatewayError(err);
      if (!e.notProcessed || i >= attempts) throw e;
      await job.sleep(300 * i);
      job.ensureLease();
    }
  }
}

async function onTerminalError(job: JobContext, accountId: string, err: GatewayError): Promise<void> {
  const terminal = terminalStatusForGatewayCode(err.code);
  if (!terminal) return;
  await job.app.db.tx((tx) => enterTerminal(tx, accountId, terminal as 'suspended' | 'session_expired'));
}

async function platformUserIdOf(job: JobContext, accountId: string): Promise<string | null> {
  const r = await job.app.db.one<{ platform_user_id: string | null }>('SELECT platform_user_id FROM accounts WHERE id = $1', [
    accountId,
  ]);
  return r?.platform_user_id ?? null;
}

async function isInGroup(job: JobContext, groupId: string, accountId: string): Promise<boolean> {
  const r = await job.app.db.query(
    `SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2 AND state = 'in'`,
    [groupId, accountId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * 建群：网关建群 → 申请邀请链接 → 各成员 join → 等 member_joined → 把 memberAccountIds[0] 提升为管理员。
 * 每一步的进度都落在 job.state 里，重启后从断点继续。
 */
export async function runCreateGroup(job: JobContext): Promise<void> {
  const { creatorAccountId, memberAccountIds, groupId } = job.params as {
    creatorAccountId: string;
    memberAccountIds: string[];
    groupId: string;
  };
  const state = job.state as CreateGroupState;
  state.members ??= {};
  state.promote ??= { calls: 0, done: false };
  const gw = job.app.gateway;

  // 1. 建群
  if (!state.gatewayGroupId) {
    let gatewayGroupId: string;
    try {
      gatewayGroupId = (await withRetry(job, () => gw.createGroup(creatorAccountId))).groupId;
    } catch (err) {
      const e = asGatewayError(err);
      await onTerminalError(job, creatorAccountId, e);
      job.addError('create', e.code);
      return job.finish();
    }
    const creatorPu = await platformUserIdOf(job, creatorAccountId);
    state.gatewayGroupId = gatewayGroupId;
    job.row.group_id = groupId;
    await job.save(async (tx) => {
      await tx.query(
        `INSERT INTO groups (id, gateway_group_id, creator_account_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [groupId, gatewayGroupId, creatorAccountId],
      );
      // 创建者在建群成功后写入成员表（网关不会为它推 member_joined）
      if (creatorPu) await setMembership(tx, groupId, creatorPu, creatorAccountId, 'in', 'creator');
      tx.emit('group_updated', { groupId });
      tx.emit('job', { jobId: job.row.id, type: job.row.type, status: 'running', groupId });
    });
  }
  const gatewayGroupId = state.gatewayGroupId!;

  const newInvite = async (): Promise<boolean> => {
    try {
      const inv = await withRetry(job, () => gw.invite(gatewayGroupId));
      const readyAfterMs = Math.max(0, Number(inv.readyAfterMs) || 0);
      state.invite = { link: inv.inviteLink, readyAt: Date.now() + readyAfterMs, readyAfterMs };
      await job.save();
      return true;
    } catch (err) {
      job.addError('invite', asGatewayError(err).code);
      await job.save();
      return false;
    }
  };

  // 2. 邀请链接
  if (!state.invite && !(await newInvite())) return job.finish();

  // 3. 各成员 join
  for (const accountId of memberAccountIds) {
    const m = (state.members[accountId] ??= { status: 'pending' });
    while (m.status === 'pending') {
      const wait = state.invite!.readyAt - Date.now();
      if (wait > 0) await job.sleep(wait);
      job.ensureLease();
      try {
        await withRetry(job, () => gw.join(gatewayGroupId, accountId, state.invite!.link));
        m.status = 'requested';
        m.requestedAt = Date.now();
      } catch (err) {
        const e = asGatewayError(err);
        if (e.code === 'INVITE_NOT_READY' && (m.notReadyRetries ?? 0) < 20) {
          m.notReadyRetries = (m.notReadyRetries ?? 0) + 1;
          state.invite!.readyAt = Date.now() + Math.max(state.invite!.readyAfterMs, 200);
        } else if (e.code === 'INVITE_EXPIRED' && !m.expiredRetried) {
          // 链接过期：重新申请一个，再试一次
          m.expiredRetried = true;
          if (!(await newInvite())) m.status = 'failed';
        } else if (e.code === 'ALREADY_MEMBER') {
          // 已经在群里：视为成功（不会再推 member_joined）
          const pu = await platformUserIdOf(job, accountId);
          m.status = 'joined';
          await job.save(async (tx) => {
            if (pu) {
              await setMembership(tx, groupId, pu, accountId, 'in');
              tx.emit('group_updated', { groupId });
            }
          });
          continue;
        } else {
          await onTerminalError(job, accountId, e);
          job.addError(`join:${accountId}`, e.code);
          m.status = 'failed';
        }
      }
      await job.save();
    }
  }

  // 4. 等 member_joined（以事件为准；超过 10 秒未到 → JOIN_TIMEOUT）
  for (;;) {
    let waiting = false;
    for (const accountId of memberAccountIds) {
      const m = state.members[accountId];
      if (m.status !== 'requested') continue;
      if (await isInGroup(job, groupId, accountId)) {
        m.status = 'joined';
      } else if (Date.now() - (m.requestedAt ?? 0) > job.app.config.joinTimeoutMs) {
        m.status = 'failed';
        job.addError(`join:${accountId}`, 'JOIN_TIMEOUT');
      } else {
        waiting = true;
      }
    }
    await job.save();
    if (!waiting) break;
    await job.sleep(150);
    job.ensureLease();
  }

  // 5. 提升 memberAccountIds[0]（只在确认入群之后调用；总调用次数 ≤ 2）
  const adminId = memberAccountIds[0];
  if (state.members[adminId]?.status === 'joined' && !state.promote.done) {
    let lastCode = '';
    while (!state.promote.done && state.promote.calls < 2) {
      state.promote.calls += 1;
      await job.save(); // 先记次数再调用：崩溃重启也不会超过上限
      try {
        await gw.promote(gatewayGroupId, creatorAccountId, adminId);
        state.promote.done = true;
        await job.save(async (tx) => {
          await tx.query(
            `UPDATE group_members SET role = 'admin', updated_at = now() WHERE group_id = $1 AND account_id = $2`,
            [groupId, adminId],
          );
          tx.emit('group_updated', { groupId });
        });
      } catch (err) {
        const e = asGatewayError(err);
        lastCode = e.code;
        if (terminalStatusForGatewayCode(e.code)) {
          await onTerminalError(job, creatorAccountId, e);
          break;
        }
        const retriable = e.code === 'NOT_MEMBER_YET' || e.notProcessed || e.outcomeUnknown;
        if (!retriable) break;
        await job.sleep(e.code === 'NOT_MEMBER_YET' ? 1_000 : 500);
      }
    }
    if (!state.promote.done) job.addError('promote', lastCode || 'PROMOTE_FAILED');
  }
  await job.finish();
}

interface LeaveAllState {
  results: Record<string, 'left' | 'failed'>;
}

/**
 * 全员退群：非群主先退（失败的记错误、其余继续），全部成功后群主最后退；
 * 退群以 member_left 为准，超时则以网关成员列表为准；最后用网关成员列表对账。
 */
export async function runLeaveAll(job: JobContext): Promise<void> {
  const { groupId } = job.params as { groupId: string };
  const state = job.state as LeaveAllState;
  state.results ??= {};
  const db = job.app.db;
  const group = await db.one<{ gateway_group_id: string; creator_account_id: string; status: string }>(
    'SELECT gateway_group_id, creator_account_id, status FROM groups WHERE id = $1',
    [groupId],
  );
  if (!group) return job.finish();
  const gw = job.app.gateway;

  const members = await db.query<{ account_id: string; platform_user_id: string }>(
    `SELECT account_id, platform_user_id FROM group_members
      WHERE group_id = $1 AND state = 'in' AND account_id IS NOT NULL ORDER BY account_id`,
    [groupId],
  );
  const creatorId = group.creator_account_id;
  const others = members.rows.filter((m) => m.account_id !== creatorId);
  const creator = members.rows.find((m) => m.account_id === creatorId);

  const leaveOne = async (accountId: string, platformUserId: string): Promise<void> => {
    if (state.results[accountId]) return;
    let confirmByList = false;
    try {
      await withRetry(job, () => gw.leave(group.gateway_group_id, accountId), 3);
    } catch (err) {
      const e = asGatewayError(err);
      if (terminalStatusForGatewayCode(e.code)) {
        // 终态账号已被网关自动移出所有群
        await onTerminalError(job, accountId, e);
        state.results[accountId] = 'left';
        return job.save();
      }
      if (e.code === 'NOT_MEMBER') {
        confirmByList = true;
      } else if (e.outcomeUnknown) {
        confirmByList = true;
      } else {
        job.addError(`leave:${accountId}`, e.code);
        state.results[accountId] = 'failed';
        return job.save();
      }
    }
    const deadline = Date.now() + (confirmByList ? 0 : job.app.config.leaveConfirmMs);
    while (Date.now() < deadline && (await isInGroup(job, groupId, accountId))) {
      await job.sleep(150);
      job.ensureLease();
    }
    if (await isInGroup(job, groupId, accountId)) {
      let present: boolean;
      try {
        present = (await withRetry(job, () => gw.members(group.gateway_group_id), 3)).some(
          (m) => m.platformUserId === platformUserId,
        );
      } catch (err) {
        job.addError(`leave:${accountId}`, asGatewayError(err).code);
        state.results[accountId] = 'failed';
        return job.save();
      }
      if (present) {
        job.addError(`leave:${accountId}`, 'LEAVE_NOT_CONFIRMED');
        state.results[accountId] = 'failed';
        return job.save();
      }
      await db.tx(async (tx) => {
        await setMembership(tx, groupId, platformUserId, accountId, 'out');
        tx.emit('group_updated', { groupId });
      });
    }
    state.results[accountId] = 'left';
    await job.save();
  };

  for (const m of others) await leaveOne(m.account_id, m.platform_user_id);
  const othersOk = others.every((m) => state.results[m.account_id] === 'left');
  // 群主先退的话剩下的账号无法再操作：只有其它账号全部退成功才退群主
  if (othersOk && creator) await leaveOne(creator.account_id, creator.platform_user_id);

  await reconcileMembers(job, groupId, group.gateway_group_id);
  const allLeft = othersOk && (!creator || state.results[creator.account_id] === 'left');
  if (allLeft) await db.tx((tx) => markGroupLeft(tx, groupId));
  await job.finish();
}

/** 以网关成员列表为准修正本地服务账号的成员关系 */
async function reconcileMembers(job: JobContext, groupId: string, gatewayGroupId: string): Promise<void> {
  let list: Array<{ platformUserId: string }>;
  try {
    list = await withRetry(job, () => job.app.gateway.members(gatewayGroupId), 3);
  } catch {
    return;
  }
  const present = new Set(list.map((m) => m.platformUserId));
  await job.app.db.tx(async (tx) => {
    const ours = await tx.query<{ id: string; platform_user_id: string; in_group: boolean }>(
      `SELECT a.id, a.platform_user_id, coalesce(gm.state = 'in', false) AS in_group
         FROM accounts a
         LEFT JOIN group_members gm ON gm.group_id = $1 AND gm.platform_user_id = a.platform_user_id
        WHERE a.platform_user_id IS NOT NULL`,
      [groupId],
    );
    let changed = false;
    for (const acc of ours.rows) {
      const shouldBeIn = present.has(acc.platform_user_id);
      if (shouldBeIn !== acc.in_group) {
        await setMembership(tx, groupId, acc.platform_user_id, acc.id, shouldBeIn ? 'in' : 'out');
        changed = true;
      }
    }
    if (changed) tx.emit('group_updated', { groupId });
  });
}
