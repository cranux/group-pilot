import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { Tx } from '../db/db.js';
import { isUniqueViolation } from '../lib/errors.js';
import { toJsonb } from '../lib/json.js';
import { iso } from '../lib/time.js';
import type { MessageRow } from '../messages/model.js';
import { emitRun, type AgentRunRow } from './model.js';

export async function ownPlatformUserIds(tx: Pick<Tx, 'query'>): Promise<string[]> {
  const r = await tx.query<{ platform_user_id: string }>(
    'SELECT platform_user_id FROM accounts WHERE platform_user_id IS NOT NULL ORDER BY id',
  );
  return r.rows.map((x) => x.platform_user_id);
}

/**
 * 群里有待处理消息且没有 running 的 run → 把待处理消息全部放进 triggerMessages 建一个新 run。
 * 调用方必须已经（或由这里）持有群行锁；部分唯一索引保证多实例下同一群至多一个 running。
 */
export async function createRunFromPending(tx: Tx, groupId: string): Promise<AgentRunRow | null> {
  const g = await tx.query<{ status: string; agent_enabled: boolean; auto_kick_enabled: boolean }>(
    'SELECT status, agent_enabled, auto_kick_enabled FROM groups WHERE id = $1 FOR UPDATE',
    [groupId],
  );
  const group = g.rows[0];
  if (!group) return null;
  if (group.status !== 'active' || !group.agent_enabled) {
    await tx.query('DELETE FROM agent_pending_triggers WHERE group_id = $1', [groupId]);
    return null;
  }
  const running = await tx.query(`SELECT 1 FROM agent_runs WHERE group_id = $1 AND status = 'running'`, [groupId]);
  if (running.rowCount) return null;
  const taken = await tx.query<{ message_id: number }>(
    'DELETE FROM agent_pending_triggers WHERE group_id = $1 RETURNING message_id',
    [groupId],
  );
  if (!taken.rowCount) return null;
  const msgs = await tx.query<MessageRow>(
    'SELECT * FROM messages WHERE id = ANY($1::bigint[]) ORDER BY sent_at, id',
    [taken.rows.map((r) => r.message_id)],
  );
  const triggerMessages = msgs.rows.map((m) => ({
    msgId: m.msg_id,
    senderPlatformUserId: m.sender_platform_user_id,
    text: m.text,
    sentAt: iso(m.sent_at),
  }));
  const context = {
    groupId,
    triggerMessages,
    policy: { autoKickEnabled: group.auto_kick_enabled },
    ownPlatformUserIds: await ownPlatformUserIds(tx),
  };
  const history = [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(context) }] }];
  const res = await tx.query<AgentRunRow>(
    `INSERT INTO agent_runs (id, group_id, trigger_message_ids, trigger_messages, history)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING *`,
    [randomUUID(), groupId, msgs.rows.map((m) => m.id), toJsonb(triggerMessages), toJsonb(history)],
  );
  const run = res.rows[0];
  emitRun(tx, run);
  tx.emit('group_updated', { groupId });
  return run;
}

export class AgentScheduler {
  constructor(private readonly ctx: AppContext) {}

  async runOnce(): Promise<boolean> {
    const groups = await this.ctx.db.query<{ group_id: string }>(
      `SELECT DISTINCT p.group_id FROM agent_pending_triggers p
        WHERE NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.group_id = p.group_id AND r.status = 'running')`,
    );
    for (const { group_id } of groups.rows) {
      try {
        const run = await this.ctx.db.tx((tx) => createRunFromPending(tx, group_id));
        if (run) this.ctx.signals.wake('agent');
      } catch (err) {
        // 另一个实例同时建了 run：唯一索引拦下，待处理消息留给那个 run 结束后处理
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return false;
  }
}
