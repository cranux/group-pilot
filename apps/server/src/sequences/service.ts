import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { Errors, isUniqueViolation } from '../lib/errors.js';
import { toJsonb } from '../lib/json.js';
import { iso } from '../lib/time.js';
import { parseBody } from '../http/validate.js';
import { emitSequenceRun, type SequenceRunRow, type SequenceStepRow } from './progress.js';
import { resolveSequence, type ResolvedStep, type SequenceStepDef } from './resolve.js';

const stepSchema = z.object({
  index: z.number().int().min(0),
  accountRole: z.enum(['admin', 'member']),
  text: z.string(),
  delaySeconds: z.number().min(0).finite(),
});

export const sequenceSchema = z
  .object({ name: z.string().trim().min(1), steps: z.array(stepSchema).min(1) })
  .superRefine((v, ctx) => {
    const seen = new Set<number>();
    for (const s of v.steps) {
      if (seen.has(s.index)) ctx.addIssue({ code: 'custom', message: `重复的步骤 index ${s.index}`, path: ['steps'] });
      seen.add(s.index);
    }
  });

/** 值统一转成字符串；null / undefined 视为未提供 */
const scalar = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .transform((v) => (v === null ? undefined : String(v)));
const varsSchema = z.record(z.string().regex(/^[A-Za-z0-9_]+$/, 'key 只能包含字母、数字、下划线'), scalar).default({});

export const runRequestSchema = z.object({
  sequenceId: z.string().uuid(),
  vars: varsSchema,
  stepVars: z.record(z.string(), varsSchema).default({}),
});

function clean(record: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter((e): e is [string, string] => e[1] !== undefined));
}

interface SequenceRow {
  id: string;
  name: string;
  steps: SequenceStepDef[];
  created_at: Date;
}

function sequenceDto(row: SequenceRow) {
  return { id: row.id, name: row.name, steps: row.steps, createdAt: iso(row.created_at) };
}

function stepDto(s: SequenceStepRow) {
  return {
    index: s.step_index,
    status: s.status,
    scheduledAt: iso(s.scheduled_at),
    sentAt: iso(s.sent_at),
    skippedAt: iso(s.skipped_at),
    clientMsgId: s.client_msg_id,
    resolvedVars: s.resolved_vars,
    varSources: s.var_sources,
    accountRole: s.account_role,
    text: s.text_template,
    resolvedText: s.resolved_text,
    accountId: s.account_id,
    failCode: s.fail_code,
  };
}

function runDto(run: SequenceRunRow & { sequence_name?: string }) {
  return {
    id: run.id,
    groupId: run.group_id,
    sequenceId: run.sequence_id,
    sequenceName: run.sequence_name ?? null,
    status: run.status,
    currentStepIndex: run.current_step_index,
    createdAt: iso(run.created_at),
    endedAt: iso(run.ended_at),
  };
}

export class SequenceService {
  constructor(private readonly ctx: AppContext) {}

  async create(body: unknown): Promise<{ id: string }> {
    const seq = parseBody(sequenceSchema, body);
    const steps = [...seq.steps].sort((a, b) => a.index - b.index);
    const id = randomUUID();
    await this.ctx.db.query('INSERT INTO sequences (id, name, steps) VALUES ($1, $2, $3::jsonb)', [id, seq.name, toJsonb(steps)]);
    return { id };
  }

  async list() {
    const r = await this.ctx.db.query<SequenceRow>('SELECT * FROM sequences ORDER BY created_at DESC');
    return r.rows.map(sequenceDto);
  }

  async get(id: string) {
    const row = await this.ctx.db.one<SequenceRow>('SELECT * FROM sequences WHERE id = $1', [id]).catch(() => null);
    if (!row) throw Errors.notFound('SEQUENCE_NOT_FOUND', '序列不存在');
    return sequenceDto(row);
  }

  /** 预检：解析全部步骤，不写任何记录 */
  async preflight(groupId: string, body: unknown): Promise<{ sequence: SequenceRow; steps: ResolvedStep[]; vars: Record<string, string>; stepVars: Record<string, Record<string, string>> }> {
    const req = parseBody(runRequestSchema, body);
    const group = await this.ctx.db.one('SELECT id FROM groups WHERE id = $1', [groupId]);
    if (!group) throw Errors.notFound('GROUP_NOT_FOUND', '群不存在');
    const sequence = await this.ctx.db.one<SequenceRow>('SELECT * FROM sequences WHERE id = $1', [req.sequenceId]);
    if (!sequence) throw Errors.notFound('SEQUENCE_NOT_FOUND', '序列不存在');
    const vars = clean(req.vars);
    const stepVars = Object.fromEntries(Object.entries(req.stepVars).map(([k, v]) => [k, clean(v)]));
    const result = resolveSequence(sequence.steps, vars, stepVars);
    if (!result.ok) {
      throw Errors.unprocessable('UNRESOLVED_PLACEHOLDER', `第 ${result.stepIndex} 步的占位符 {${result.key}} 无法解析`, {
        stepIndex: result.stepIndex,
        key: result.key,
      });
    }
    return { sequence, steps: result.steps, vars, stepVars };
  }

  async start(groupId: string, body: unknown): Promise<{ runId: string }> {
    const { sequence, steps, vars, stepVars } = await this.preflight(groupId, body);
    const runId = randomUUID();
    try {
      await this.ctx.db.tx(async (tx) => {
        const g = await tx.query<{ status: string }>('SELECT status FROM groups WHERE id = $1', [groupId]);
        if (g.rows[0]?.status !== 'active') throw Errors.conflict('GROUP_NOT_ACTIVE', '群当前不可用，不能启动序列');
        // 部分唯一索引：同一群至多一个 running；并发两次启动，后提交的在这里撞上唯一约束 → 409
        const run = await tx.query<SequenceRunRow>(
          `INSERT INTO sequence_runs (id, sequence_id, group_id, vars, step_vars, current_step_index)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6) RETURNING *`,
          [runId, sequence.id, groupId, toJsonb(vars), toJsonb(stepVars), steps[0].index],
        );
        for (const [pos, s] of steps.entries()) {
          await tx.query(
            `INSERT INTO sequence_run_steps (run_id, pos, step_index, account_role, text_template, delay_seconds,
                                             resolved_text, resolved_vars, var_sources, scheduled_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
                     CASE WHEN $2 = 0 THEN now() + make_interval(secs => $6) END)`,
            [runId, pos, s.index, s.accountRole, s.text, s.delaySeconds, s.resolvedText, toJsonb(s.resolvedVars), toJsonb(s.varSources)],
          );
        }
        emitSequenceRun(tx, run.rows[0]);
        tx.emit('group_updated', { groupId });
        tx.afterCommit(() => this.ctx.signals.wake('sequence'));
      });
    } catch (err) {
      if (isUniqueViolation(err, 'sequence_runs_one_running')) {
        throw Errors.conflict('SEQUENCE_ALREADY_RUNNING', '该群已有运行中的序列');
      }
      throw err;
    }
    return { runId };
  }

  async getRun(id: string) {
    const run = await this.ctx.db
      .one<SequenceRunRow & { sequence_name: string }>(
        `SELECT r.*, s.name AS sequence_name FROM sequence_runs r JOIN sequences s ON s.id = r.sequence_id WHERE r.id = $1`,
        [id],
      )
      .catch(() => null);
    if (!run) throw Errors.notFound('SEQUENCE_RUN_NOT_FOUND', '序列运行不存在');
    const steps = await this.ctx.db.query<SequenceStepRow>('SELECT * FROM sequence_run_steps WHERE run_id = $1 ORDER BY pos', [id]);
    return { ...runDto(run), steps: steps.rows.map(stepDto) };
  }

  async listRuns(groupId: string) {
    const r = await this.ctx.db.query<SequenceRunRow & { sequence_name: string }>(
      `SELECT r.*, s.name AS sequence_name FROM sequence_runs r JOIN sequences s ON s.id = r.sequence_id
        WHERE r.group_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
      [groupId],
    );
    return r.rows.map(runDto);
  }
}
