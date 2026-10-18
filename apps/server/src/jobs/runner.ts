import type { AppContext } from '../context.js';
import type { Tx } from '../db/db.js';
import { toJsonb } from '../lib/json.js';
import { sleep } from '../lib/time.js';

export type JobType = 'create_group' | 'leave_all';
export type JobStatus = 'running' | 'finished' | 'failed';

export interface JobError {
  step: string;
  code: string;
}

export interface JobRow {
  id: string;
  type: JobType;
  status: JobStatus;
  group_id: string | null;
  params: any;
  state: any;
  errors: JobError[];
}

export interface JobDto {
  id: string;
  type: JobType;
  status: JobStatus;
  errors: JobError[];
  groupId: string | null;
}

export function jobDto(row: JobRow): JobDto {
  return { id: row.id, type: row.type, status: row.status, errors: row.errors, groupId: row.group_id };
}

export function emitJob(tx: Tx, row: JobRow): void {
  tx.emit('job', { jobId: row.id, type: row.type, status: row.status, groupId: row.group_id });
}

export class LeaseLost extends Error {}

/** 交给具体 job 的执行上下文：所有进度都要通过 save() 落库，才能在重启后从断点继续 */
export class JobContext {
  readonly signal: AbortSignal;

  constructor(
    readonly app: AppContext,
    readonly row: JobRow,
    private readonly owner: string,
    private readonly controller: AbortController,
  ) {
    this.signal = controller.signal;
  }

  get state(): any {
    return this.row.state;
  }

  get params(): any {
    return this.row.params;
  }

  addError(step: string, code: string): void {
    if (!this.row.errors.some((e) => e.step === step && e.code === code)) this.row.errors.push({ step, code });
  }

  /** 持久化进度；可附带其它写入（同一事务） */
  async save(extra?: (tx: Tx) => Promise<void>): Promise<void> {
    this.ensureLease();
    await this.app.db.tx(async (tx) => {
      const r = await tx.query(
        `UPDATE jobs SET state = $3::jsonb, errors = $4::jsonb, group_id = $5, updated_at = now()
          WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
        [this.row.id, this.owner, toJsonb(this.row.state), toJsonb(this.row.errors), this.row.group_id],
      );
      if (!r.rowCount) throw new LeaseLost();
      if (extra) await extra(tx);
    });
  }

  async finish(): Promise<void> {
    this.ensureLease();
    const status: JobStatus = this.row.errors.length ? 'failed' : 'finished';
    await this.app.db.tx(async (tx) => {
      const r = await tx.query<JobRow>(
        `UPDATE jobs SET status = $3, state = $4::jsonb, errors = $5::jsonb, group_id = $6,
                finished_at = now(), updated_at = now(), lease_owner = NULL, lease_until = NULL
          WHERE id = $1 AND lease_owner = $2 AND status = 'running' RETURNING *`,
        [this.row.id, this.owner, status, toJsonb(this.row.state), toJsonb(this.row.errors), this.row.group_id],
      );
      if (!r.rows[0]) throw new LeaseLost();
      this.row.status = status;
      emitJob(tx, r.rows[0]);
    });
  }

  sleep(ms: number): Promise<void> {
    return sleep(ms, this.signal);
  }

  ensureLease(): void {
    if (this.signal.aborted) throw new LeaseLost();
  }
}

export type JobHandler = (job: JobContext) => Promise<void>;

/** 认领到期租约的 running job 并执行；租约由心跳续期，进程崩溃后租约过期即被重新认领 */
export class JobRunner {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(
    private readonly ctx: AppContext,
    private readonly handlers: Record<JobType, JobHandler>,
  ) {}

  async runOnce(): Promise<boolean> {
    const leaseSec = this.ctx.config.leaseMs / 1000;
    const claimed = await this.ctx.db.query<JobRow>(
      `UPDATE jobs SET lease_owner = $1, lease_until = now() + make_interval(secs => $2)
        WHERE id IN (
          SELECT id FROM jobs
           WHERE status = 'running' AND (lease_until IS NULL OR lease_until < now())
           ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [this.ctx.config.instanceId, leaseSec],
    );
    for (const row of claimed.rows) {
      if (this.active.has(row.id)) continue;
      this.start(row);
    }
    return false;
  }

  async stop(): Promise<void> {
    const all = [...this.active.values()];
    for (const a of all) a.controller.abort();
    await Promise.all(all.map((a) => a.done));
    // 主动释放租约，重启后可立即接手
    await this.ctx.db
      .query(`UPDATE jobs SET lease_until = now() WHERE lease_owner = $1 AND status = 'running'`, [this.ctx.config.instanceId])
      .catch(() => undefined);
  }

  private start(row: JobRow): void {
    const controller = new AbortController();
    const job = new JobContext(this.ctx, row, this.ctx.config.instanceId, controller);
    const heartbeat = setInterval(() => void this.renew(row.id, controller), Math.max(200, this.ctx.config.leaseMs / 3));
    const done = (async () => {
      try {
        await this.handlers[row.type](job);
        if (job.row.status === 'running' && !controller.signal.aborted) await job.finish();
      } catch (err) {
        if (!(err instanceof LeaseLost) && !controller.signal.aborted) {
          this.ctx.log.warn({ err, jobId: row.id }, 'job iteration failed; will retry after lease expiry');
        }
      } finally {
        clearInterval(heartbeat);
        this.active.delete(row.id);
      }
    })();
    this.active.set(row.id, { controller, done });
  }

  private async renew(id: string, controller: AbortController): Promise<void> {
    try {
      const r = await this.ctx.db.query(
        `UPDATE jobs SET lease_until = now() + make_interval(secs => $3) WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
        [id, this.ctx.config.instanceId, this.ctx.config.leaseMs / 1000],
      );
      if (!r.rowCount) controller.abort();
    } catch {
      // 数据库暂时不可用：下次心跳再试；租约过期前恢复则不受影响
    }
  }
}
