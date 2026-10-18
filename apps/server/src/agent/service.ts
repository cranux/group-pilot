import { z } from 'zod';
import type { AppContext } from '../context.js';
import { Errors } from '../lib/errors.js';
import { runSummaryDto, stepDto, type AgentRunRow, type AgentStepRow } from './model.js';

export class AgentRunService {
  constructor(private readonly ctx: AppContext) {}

  async get(id: string) {
    if (!z.string().uuid().safeParse(id).success) throw Errors.notFound('AGENT_RUN_NOT_FOUND', 'agent run 不存在');
    const run = await this.ctx.db.one<AgentRunRow>('SELECT * FROM agent_runs WHERE id = $1', [id]);
    if (!run) throw Errors.notFound('AGENT_RUN_NOT_FOUND', 'agent run 不存在');
    const steps = await this.ctx.db.query<AgentStepRow>('SELECT * FROM agent_steps WHERE run_id = $1 ORDER BY step_no', [id]);
    return { ...runSummaryDto(run), triggerMessages: run.trigger_messages, steps: steps.rows.map(stepDto) };
  }

  async listForGroup(groupId: string) {
    if (!z.string().uuid().safeParse(groupId).success) throw Errors.notFound('GROUP_NOT_FOUND', '群不存在');
    const group = await this.ctx.db.one('SELECT 1 FROM groups WHERE id = $1', [groupId]);
    if (!group) throw Errors.notFound('GROUP_NOT_FOUND', '群不存在');
    const r = await this.ctx.db.query<AgentRunRow>(
      'SELECT * FROM agent_runs WHERE group_id = $1 ORDER BY created_at DESC LIMIT 20',
      [groupId],
    );
    return r.rows.map(runSummaryDto);
  }
}
