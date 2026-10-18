import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { Errors } from '../lib/errors.js';
import { verifyPassword } from './passwords.js';

export type Role = 'admin' | 'viewer';

export interface AuthUser {
  userId: number;
  username: string;
  role: Role;
  sessionId: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  user: { username: string; role: Role };
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class AuthService {
  private readonly key: Uint8Array;
  /** 会话作废时通知（用于断开该会话的 WS 连接） */
  onSessionRevoked: (sessionId: string) => void = () => undefined;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {
    this.key = new TextEncoder().encode(config.jwtSecret);
  }

  async login(username: string, password: string): Promise<IssuedTokens> {
    const user = await this.db.one<{ id: number; username: string; password_hash: string; role: Role }>(
      'SELECT id, username, password_hash, role FROM users WHERE username = $1',
      [username],
    );
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw Errors.unauthorized('用户名或密码错误');
    }
    const sessionId = randomUUID();
    await this.db.query('INSERT INTO auth_sessions (id, user_id) VALUES ($1, $2)', [sessionId, user.id]);
    const refreshToken = await this.issueRefreshToken(sessionId);
    return {
      accessToken: await this.signAccess(user.id, user.username, user.role, sessionId),
      refreshToken,
      user: { username: user.username, role: user.role },
    };
  }

  /**
   * 轮换 refresh token。已经用过的 token 再次出现 → 判定为泄露，整个会话作废：
   * 该会话此前换出的 refresh token 和 access token 全部立即失效（access token 校验时会检查会话）。
   */
  async refresh(refreshToken: string | undefined): Promise<IssuedTokens> {
    if (!refreshToken) throw Errors.unauthorized('缺少 refresh token');
    const tokenHash = hashToken(refreshToken);
    const consumed = await this.db.one<{ session_id: string }>(
      `UPDATE refresh_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING session_id`,
      [tokenHash],
    );
    if (!consumed) {
      const existing = await this.db.one<{ session_id: string; used_at: Date | null }>(
        'SELECT session_id, used_at FROM refresh_tokens WHERE token_hash = $1',
        [tokenHash],
      );
      if (existing?.used_at) await this.revokeSession(existing.session_id, 'refresh_token_reuse');
      throw Errors.unauthorized('refresh token 无效');
    }
    const session = await this.db.one<{ revoked_at: Date | null; user_id: number; username: string; role: Role }>(
      `SELECT s.revoked_at, u.id AS user_id, u.username, u.role
         FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
      [consumed.session_id],
    );
    if (!session || session.revoked_at) throw Errors.unauthorized('会话已失效');
    const next = await this.issueRefreshToken(consumed.session_id);
    return {
      accessToken: await this.signAccess(session.user_id, session.username, session.role, consumed.session_id),
      refreshToken: next,
      user: { username: session.username, role: session.role },
    };
  }

  async logout(opts: { accessToken?: string; refreshToken?: string }): Promise<void> {
    let sessionId: string | undefined;
    if (opts.accessToken) {
      sessionId = (await this.decodeAccess(opts.accessToken).catch(() => null))?.sid;
    }
    if (!sessionId && opts.refreshToken) {
      const row = await this.db.one<{ session_id: string }>(
        'SELECT session_id FROM refresh_tokens WHERE token_hash = $1',
        [hashToken(opts.refreshToken)],
      );
      sessionId = row?.session_id;
    }
    if (sessionId) await this.revokeSession(sessionId, 'logout');
  }

  async verifyAccess(token: string | undefined): Promise<AuthUser> {
    if (!token) throw Errors.unauthorized();
    const claims = await this.decodeAccess(token).catch(() => null);
    if (!claims) throw Errors.unauthorized('access token 无效或已过期');
    const session = await this.db.one<{ revoked_at: Date | null; username: string; role: Role; user_id: number }>(
      `SELECT s.revoked_at, u.username, u.role, u.id AS user_id
         FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
      [claims.sid],
    );
    if (!session || session.revoked_at) throw Errors.unauthorized('会话已失效');
    return { userId: session.user_id, username: session.username, role: session.role, sessionId: claims.sid };
  }

  private async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.db.query(
      'UPDATE auth_sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL',
      [sessionId, reason],
    );
    this.onSessionRevoked(sessionId);
  }

  private async issueRefreshToken(sessionId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.query(
      `INSERT INTO refresh_tokens (token_hash, session_id, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))`,
      [hashToken(token), sessionId, this.config.refreshTokenTtlSec],
    );
    return token;
  }

  private signAccess(userId: number, username: string, role: Role, sessionId: string): Promise<string> {
    return new SignJWT({ sid: sessionId, role, username })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(userId))
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${this.config.accessTokenTtlSec}s`)
      .sign(this.key);
  }

  private async decodeAccess(token: string): Promise<{ sid: string }> {
    const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
    if (typeof payload.sid !== 'string') throw new Error('missing sid');
    return { sid: payload.sid };
  }
}
