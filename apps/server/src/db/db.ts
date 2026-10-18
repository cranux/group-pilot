import type pg from 'pg';
import { toJsonb } from '../lib/json.js';

/** 推送事件写入时使用的事务级 advisory lock，保证 ws_events.seq 的顺序等于提交顺序 */
const WS_EVENTS_LOCK = 0x67700001;
export const WS_EVENTS_CHANNEL = 'gp_ws_events';

export interface PendingEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface Tx {
  query<R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
  /** 记录一条推送事件；与业务写入在同一事务里提交 */
  emit(type: string, payload: Record<string, unknown>): void;
  /** 提交成功后执行（用于唤醒后台工作者等纯内存副作用） */
  afterCommit(fn: () => void): void;
  /** 在保存点里执行：失败时回滚到保存点，期间记录的推送事件与钩子一并丢弃，然后抛出原错误 */
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
}

export class Db {
  constructor(readonly pool: pg.Pool) {}

  query<R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(sql, params as any[]);
  }

  async one<R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<R | null> {
    const res = await this.query<R>(sql, params);
    return res.rows[0] ?? null;
  }

  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const events: PendingEvent[] = [];
    const hooks: Array<() => void> = [];
    let spCounter = 0;
    const tx: Tx = {
      query: (sql, params) => client.query(sql, params as any[]),
      emit: (type, payload) => {
        events.push({ type, payload });
      },
      afterCommit: (hook) => {
        hooks.push(hook);
      },
      savepoint: async (inner) => {
        const name = `sp_${++spCounter}`;
        const eventMark = events.length;
        const hookMark = hooks.length;
        await client.query(`SAVEPOINT ${name}`);
        try {
          const value = await inner();
          await client.query(`RELEASE SAVEPOINT ${name}`);
          return value;
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          events.length = eventMark;
          hooks.length = hookMark;
          throw err;
        }
      },
    };
    let released = false;
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      if (events.length > 0) {
        await client.query('SELECT pg_advisory_xact_lock($1)', [WS_EVENTS_LOCK]);
        await client.query(
          `INSERT INTO ws_events (type, payload)
           SELECT e->>'type', e->'payload'
             FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(e, ord)
            ORDER BY ord`,
          [toJsonb(events)],
        );
        await client.query(`SELECT pg_notify('${WS_EVENTS_CHANNEL}', '')`);
      }
      await client.query('COMMIT');
      for (const hook of hooks) {
        try {
          hook();
        } catch {
          // 提交后的钩子只做唤醒，失败不影响结果
        }
      }
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 连接已坏：直接丢弃
        client.release(true);
        released = true;
      }
      throw err;
    } finally {
      if (!released) client.release();
    }
  }
}
