import pg from 'pg';

// int8（bigserial / count）按 number 解析：本系统的 id 与 eventId 都远小于 2^53
pg.types.setTypeParser(20, (v) => Number(v));

export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export function createPool(databaseUrl: string, max = 20): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max });
  // 空闲连接上的错误（例如数据库重启）不能让进程崩溃
  pool.on('error', () => undefined);
  return pool;
}

export { pg };
