import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { parseBody } from '../http/validate.js';
import { Errors, isUniqueViolation } from '../lib/errors.js';
import { toJsonb } from '../lib/json.js';
import { iso } from '../lib/time.js';
import { emitJob, type JobRow } from '../jobs/runner.js';
import { messageDto, type MessageRow } from '../messages/model.js';
import { enqueueOwnMessage } from '../messages/outbox.js';

interface GroupRow {
  id: string;
  gateway_group_id: string;
  status: 'active' | 'unreachable' | 'left';
  creator_account_id: string;
  agent_enabled: boolean;
  auto_kick_enabled: boolean;
  created_at: Date;
}

const createSchema = z.object({
  creatorAccountId: z.string().min(1),
  memberAccountIds: z.array(z.string().min(1)).min(1, 'memberAccountIds 至少 1 个'),
});

const patchSchema = z
  .object({ agentEnabled: z.boolean().optional(), autoKickEnabled: z.boolean().optional() })
  .strict();

const sendSchema = z.object({ accountId: z.string().min(1), text: z.string().min(1).max(4000) });

const ROLE_ORDER: Record<string, number> = { creator: 0, admin: 1, member: 2 };

/** 消息游标：(sentAt, id) 的复合键，倒序分页时「加载更早」不会受新写入影响 */
export function encodeCursor(sentAt: Date, id: number): string {
  return Buffer.from(`${sentAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { sentAt: Date; id: number } | null {
  try {
    const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const sentAt = new Date(ts);
    const n = Number(id);
    if (Number.isNaN(sentAt.getTime()) || !Number.isSafeInteger(n)) return null;
    return { sentAt, id: n };
  } catch {
    return null;
  }
}

export class GroupService {
  constructor(private readonly ctx: AppContext) {}

  private async dto(rows: GroupRow[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [members, agentRuns, seqRuns] = await Promise.all([
      this.ctx.db.query<{ group_id: string; account_id: string | null; platform_user_id: string; role: string }>(
        `SELECT group_id, account_id, platform_user_id, role FROM group_members
          WHERE group_id = ANY($1::uuid[]) AND state = 'in' ORDER BY account_id NULLS LAST, platform_user_id`,
        [ids],
      ),
      this.ctx.db.query<{ group_id: string; id: string }>(
        `SELECT group_id, id FROM agent_runs WHERE group_id = ANY($1::uuid[]) AND status = 'running'`,
        [ids],
      ),
      this.ctx.db.query<{ group_id: string; id: string }>(
        `SELECT group_id, id FROM sequence_runs WHERE group_id = ANY($1::uuid[]) AND status = 'running'`,
        [ids],
      ),
    ]);
    return rows.map((g) => {
      const own = members.rows.filter((m) => m.group_id === g.id);
      return {
        id: g.id,
        gatewayGroupId: g.gateway_group_id,
        status: g.status,
        creatorAccountId: g.creator_account_id,
        agentEnabled: g.agent_enabled,
        autoKickEnabled: g.auto_kick_enabled,
        members: own
          .filter((m) => m.account_id)
          .map((m) => ({ accountId: m.account_id!, platformUserId: m.platform_user_id, role: m.role }))
          .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.accountId.localeCompare(b.accountId)),
        externalMembers: own.filter((m) => !m.account_id).map((m) => ({ platformUserId: m.platform_user_id })),
        activeSequenceRunId: seqRuns.rows.find((r) => r.group_id === g.id)?.id ?? null,
        activeAgentRunId: agentRuns.rows.find((r) => r.group_id === g.id)?.id ?? null,
        createdAt: iso(g.created_at),
      };
    });
  }

  async list() {
    const r = await this.ctx.db.query<GroupRow>('SELECT * FROM groups ORDER BY created_at DESC');
    return this.dto(r.rows);
  }

  private async load(id: string): Promise<GroupRow> {
    if (!z.string().uuid().safeParse(id).success) throw Errors.notFound('GROUP_NOT_FOUND', '群不存在');
    const row = await this.ctx.db.one<GroupRow>('SELECT * FROM groups WHERE id = $1', [id]);
    if (!row) throw Errors.notFound('GROUP_NOT_FOUND', '群不存在');
    return row;
  }

  async get(id: string) {
    return (await this.dto([await this.load(id)]))[0];
  }

  /** POST /api/groups：校验后建 job，异步执行 */
  async create(body: unknown): Promise<{ jobId: string }> {
    const req = parseBody(createSchema, body);
    if (req.memberAccountIds.includes(req.creatorAccountId)) throw Errors.validation('memberAccountIds 不能包含群主');
    if (new Set(req.memberAccountIds).size !== req.memberAccountIds.length) throw Errors.validation('memberAccountIds 有重复');
    const all = [req.creatorAccountId, ...req.memberAccountIds];
    const accounts = await this.ctx.db.query<{ id: string; status: string }>('SELECT id, status FROM accounts WHERE id = ANY($1)', [all]);
    const missing = all.filter((id) => !accounts.rows.some((a) => a.id === id));
    if (missing.length) throw Errors.validation(`账号不存在：${missing.join(', ')}`, { accountIds: missing });
    const notOnline = accounts.rows.filter((a) => a.status !== 'online').map((a) => a.id);
    if (notOnline.length) {
      throw Errors.unprocessable('ACCOUNT_NOT_ONLINE', `账号不在线：${notOnline.join(', ')}`, { accountIds: notOnline });
    }
    const jobId = randomUUID();
    await this.ctx.db.tx(async (tx) => {
      const r = await tx.query<JobRow>(
        `INSERT INTO jobs (id, type, params) VALUES ($1, 'create_group', $2::jsonb) RETURNING *`,
        [jobId, toJsonb({ ...req, groupId: randomUUID() })],
      );
      emitJob(tx, r.rows[0]);
      tx.afterCommit(() => this.ctx.signals.wake('jobs'));
    });
    return { jobId };
  }

  async patch(id: string, body: unknown) {
    const req = parseBody(patchSchema, body);
    await this.load(id);
    await this.ctx.db.tx(async (tx) => {
      await tx.query(
        `UPDATE groups SET agent_enabled = coalesce($2, agent_enabled), auto_kick_enabled = coalesce($3, auto_kick_enabled),
                updated_at = now() WHERE id = $1`,
        [id, req.agentEnabled ?? null, req.autoKickEnabled ?? null],
      );
      // 关闭 agent：待处理消息作废；正在运行的 run 由执行器在当前步结束后 cancelled
      if (req.agentEnabled === false) await tx.query('DELETE FROM agent_pending_triggers WHERE group_id = $1', [id]);
      tx.emit('group_updated', { groupId: id });
    });
    return this.get(id);
  }

  /** 操作员以某服务账号身份发消息（遵守 A2 的发送规则：先落库 queued，再由发送器发出） */
  async send(id: string, body: unknown): Promise<{ clientMsgId: string }> {
    const req = parseBody(sendSchema, body);
    const group = await this.load(id);
    if (group.status !== 'active') throw Errors.conflict('GROUP_UNREACHABLE', `群当前状态为 ${group.status}，不能发送`);
    return this.ctx.db.tx(async (tx) => {
      const acc = await tx.query<{ id: string; status: string; platform_user_id: string | null }>(
        'SELECT id, status, platform_user_id FROM accounts WHERE id = $1 FOR SHARE',
        [req.accountId],
      );
      const account = acc.rows[0];
      if (!account) throw Errors.notFound('ACCOUNT_NOT_FOUND', `账号 ${req.accountId} 不存在`);
      const member = await tx.query(
        `SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2 AND state = 'in'`,
        [id, req.accountId],
      );
      if (!member.rowCount) throw Errors.conflict('ACCOUNT_NOT_IN_GROUP', `账号 ${req.accountId} 不在这个群里`);
      // rate_limited 照常受理（保持 queued，到期后按顺序发出）
      if (account.status !== 'online' && account.status !== 'rate_limited') {
        throw Errors.conflict('ACCOUNT_UNAVAILABLE', `账号当前为 ${account.status}，不能发送`, { status: account.status });
      }
      const msg = await enqueueOwnMessage(
        tx,
        { groupId: id, accountId: account.id, platformUserId: account.platform_user_id, text: req.text, source: 'operator' },
        this.ctx.signals,
      );
      return { clientMsgId: msg.client_msg_id! };
    });
  }

  async leaveAll(id: string): Promise<{ jobId: string }> {
    const group = await this.load(id);
    if (group.status === 'left') throw Errors.conflict('GROUP_ALREADY_LEFT', '群已全部退出');
    const jobId = randomUUID();
    try {
      await this.ctx.db.tx(async (tx) => {
        const r = await tx.query<JobRow>(
          `INSERT INTO jobs (id, type, group_id, params) VALUES ($1, 'leave_all', $2, $3::jsonb) RETURNING *`,
          [jobId, id, toJsonb({ groupId: id })],
        );
        emitJob(tx, r.rows[0]);
        tx.afterCommit(() => this.ctx.signals.wake('jobs'));
      });
    } catch (err) {
      if (isUniqueViolation(err, 'jobs_one_leave_all')) throw Errors.conflict('JOB_ALREADY_RUNNING', '该群已有进行中的退群任务');
      throw err;
    }
    return { jobId };
  }

  async messages(id: string, query: { before?: string; limit?: string }) {
    await this.load(id);
    const limit = Math.max(1, Math.min(200, Number(query.limit ?? 50) || 50));
    let cursor: { sentAt: Date; id: number } | null = null;
    if (query.before) {
      cursor = decodeCursor(query.before);
      if (!cursor) throw Errors.validation('before 不是合法的游标');
    }
    const r = await this.ctx.db.query<MessageRow>(
      cursor
        ? `SELECT * FROM messages WHERE group_id = $1 AND (sent_at, id) < ($3, $4) ORDER BY sent_at DESC, id DESC LIMIT $2`
        : `SELECT * FROM messages WHERE group_id = $1 ORDER BY sent_at DESC, id DESC LIMIT $2`,
      cursor ? [id, limit + 1, cursor.sentAt, cursor.id] : [id, limit + 1],
    );
    const rows = r.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      items: rows.map(messageDto),
      nextCursor: r.rows.length > limit && last ? encodeCursor(last.sent_at, last.id) : null,
    };
  }
}
