import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { emitMessage, type MessageRow } from '../messages/model.js';

const MAX_ATTEMPTS = 5;

function safeName(url: string): string {
  const base = url.split('?')[0].split('/').filter(Boolean).pop() ?? 'file';
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'file';
}

/**
 * C1：message 带 mediaUrl 时把文件下载到本地 media/，路径记在 localFilePath；
 * 定期删除超过 N 天的文件——先清数据库里的路径再删文件，保证不会留下指向已删文件的记录；
 * 所在群有运行中的 agent run 时不删。
 */
export class MediaWorker {
  constructor(private readonly ctx: AppContext) {}

  async downloadOnce(): Promise<boolean> {
    const rows = await this.ctx.db.query<MessageRow>(
      `SELECT * FROM messages WHERE media_status = 'pending' AND media_attempts < $1 ORDER BY id LIMIT 10`,
      [MAX_ATTEMPTS],
    );
    for (const row of rows.rows) await this.download(row);
    return rows.rows.length === 10;
  }

  private async download(row: MessageRow): Promise<void> {
    const url = this.ctx.gateway.mediaUrl(row.media_url!);
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch {
      await this.bump(row.id);
      return;
    }
    if (res.status === 404) {
      // 网关上已过期
      await this.ctx.db.tx(async (tx) => {
        const r = await tx.query<MessageRow>(
          `UPDATE messages SET media_status = 'gone', updated_at = now() WHERE id = $1 AND media_status = 'pending' RETURNING *`,
          [row.id],
        );
        if (r.rows[0]) emitMessage(tx, r.rows[0]);
      });
      return;
    }
    if (!res.ok) {
      await this.bump(row.id);
      return;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const dir = path.join(this.ctx.config.mediaDir, row.group_id);
    const file = path.join(dir, `${row.id}-${safeName(row.media_url!)}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, bytes);
    const saved = await this.ctx.db.tx(async (tx) => {
      const r = await tx.query<MessageRow>(
        `UPDATE messages SET local_file_path = $2, media_status = 'downloaded', media_downloaded_at = now(), updated_at = now()
          WHERE id = $1 AND media_status = 'pending' RETURNING *`,
        [row.id, file],
      );
      if (r.rows[0]) emitMessage(tx, r.rows[0]);
      return r.rows[0];
    });
    if (!saved) await fs.rm(file, { force: true });
  }

  private async bump(id: number): Promise<void> {
    await this.ctx.db.query(
      `UPDATE messages SET media_attempts = media_attempts + 1,
              media_status = CASE WHEN media_attempts + 1 >= $2 THEN 'failed' ELSE media_status END,
              updated_at = now()
        WHERE id = $1`,
      [id, MAX_ATTEMPTS],
    );
  }

  async cleanupOnce(): Promise<number> {
    const days = this.ctx.config.mediaRetentionDays;
    const expired = await this.ctx.db.query<{ id: number }>(
      `SELECT m.id FROM messages m
        WHERE m.media_status = 'downloaded'
          AND m.media_downloaded_at < now() - make_interval(secs => $1)
          AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.group_id = m.group_id AND r.status = 'running')
        ORDER BY m.id LIMIT 200`,
      [days * 86_400],
    );
    let removed = 0;
    for (const { id } of expired.rows) {
      const filePath = await this.ctx.db.tx(async (tx) => {
        const r = await tx.query<MessageRow>(
          `SELECT * FROM messages WHERE id = $1 AND media_status = 'downloaded' FOR UPDATE`,
          [id],
        );
        const row = r.rows[0];
        if (!row) return null;
        const inUse = await tx.query(`SELECT 1 FROM agent_runs WHERE group_id = $1 AND status = 'running'`, [row.group_id]);
        if (inUse.rowCount) return null;
        const updated = await tx.query<MessageRow>(
          `UPDATE messages SET local_file_path = NULL, media_status = 'deleted', updated_at = now() WHERE id = $1 RETURNING *`,
          [id],
        );
        emitMessage(tx, updated.rows[0]);
        return row.local_file_path;
      });
      if (filePath) {
        await fs.rm(filePath, { force: true });
        removed++;
      }
    }
    await this.clearDangling();
    return removed;
  }

  /** 文件被外部删掉的记录也要清掉路径 */
  private async clearDangling(): Promise<void> {
    const rows = await this.ctx.db.query<{ id: number; local_file_path: string }>(
      `SELECT id, local_file_path FROM messages WHERE media_status = 'downloaded' AND local_file_path IS NOT NULL ORDER BY id LIMIT 500`,
    );
    for (const row of rows.rows) {
      try {
        await fs.access(row.local_file_path);
      } catch {
        await this.ctx.db.tx(async (tx) => {
          const r = await tx.query<MessageRow>(
            `UPDATE messages SET local_file_path = NULL, media_status = 'deleted', updated_at = now()
              WHERE id = $1 AND local_file_path = $2 RETURNING *`,
            [row.id, row.local_file_path],
          );
          if (r.rows[0]) emitMessage(tx, r.rows[0]);
        });
      }
    }
  }
}
