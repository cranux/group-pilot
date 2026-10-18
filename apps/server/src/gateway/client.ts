import { isPlainObject } from '../lib/json.js';

/**
 * kind:
 * - http：网关给了响应（status/code 来自响应）
 * - timeout：我们这边等超时了，结果未知（等同 NETWORK_TIMEOUT）
 * - unreachable：连接都没建立（ECONNREFUSED 等），可以确定请求没被处理
 * - network：连接中途出错，结果未知
 */
export type GatewayErrorKind = 'http' | 'timeout' | 'unreachable' | 'network';

export class GatewayError extends Error {
  constructor(
    readonly kind: GatewayErrorKind,
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `${code} (${status})`);
  }

  get retryAfterSeconds(): number | undefined {
    const b = this.body as Record<string, any> | undefined;
    const v = b?.retryAfterSeconds ?? b?.error?.retryAfterSeconds;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }

  /** 结果未知：网关可能已经执行 */
  get outcomeUnknown(): boolean {
    return this.kind === 'timeout' || this.kind === 'network' || (this.kind === 'http' && this.status === 504);
  }

  /** 可以确定网关没有处理（可安全重试） */
  get notProcessed(): boolean {
    return this.kind === 'unreachable' || (this.kind === 'http' && this.status === 503);
  }
}

function extractCode(status: number, body: unknown): string {
  if (isPlainObject(body)) {
    if (typeof body.code === 'string') return body.code;
    const err = body.error;
    if (isPlainObject(err) && typeof err.code === 'string') return err.code;
    if (typeof err === 'string') return err;
  }
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  if (status === 504) return 'NETWORK_TIMEOUT';
  return `HTTP_${status}`;
}

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

export interface GatewayClientOptions {
  timeoutMs: number;
  sendTimeoutMs: number;
  kickTimeoutMs: number;
}

export class GatewayClient {
  constructor(
    readonly baseUrl: string,
    private readonly opts: GatewayClientOptions,
  ) {}

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.opts.timeoutMs): Promise<{ status: number; body: T }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (ac.signal.aborted) throw new GatewayError('timeout', 0, 'NETWORK_TIMEOUT', null, `gateway ${method} ${path} timed out`);
      const code = err?.cause?.code ?? err?.code;
      if (UNREACHABLE_CODES.has(code)) throw new GatewayError('unreachable', 0, 'GATEWAY_UNREACHABLE', null, String(code));
      throw new GatewayError('network', 0, 'NETWORK_ERROR', null, String(err?.message ?? err));
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      clearTimeout(timer);
      if (ac.signal.aborted) throw new GatewayError('timeout', 0, 'NETWORK_TIMEOUT', null, `gateway ${method} ${path} timed out`);
      throw new GatewayError('network', 0, 'NETWORK_ERROR', null, 'failed to read gateway response');
    }
    clearTimeout(timer);
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const code = extractCode(res.status, parsed);
      const msg = isPlainObject(parsed) && typeof parsed.message === 'string' ? parsed.message : undefined;
      throw new GatewayError('http', res.status, code, parsed, msg);
    }
    return { status: res.status, body: parsed as T };
  }

  connect(accountId: string) {
    return this.request<{ platformUserId: string }>('POST', `/accounts/${enc(accountId)}/connect`).then((r) => r.body);
  }

  disconnect(accountId: string) {
    return this.request('POST', `/accounts/${enc(accountId)}/disconnect`).then(() => undefined);
  }

  createGroup(creatorAccountId: string) {
    return this.request<{ groupId: string }>('POST', '/groups', { creatorAccountId }).then((r) => r.body);
  }

  invite(groupId: string) {
    return this.request<{ inviteLink: string; readyAfterMs?: number }>('POST', `/groups/${enc(groupId)}/invite`).then(
      (r) => r.body,
    );
  }

  join(groupId: string, accountId: string, inviteLink: string) {
    return this.request('POST', `/groups/${enc(groupId)}/join`, { accountId, inviteLink }).then(() => undefined);
  }

  promote(groupId: string, byAccountId: string, accountId: string) {
    return this.request('POST', `/groups/${enc(groupId)}/promote`, { byAccountId, accountId }).then(() => undefined);
  }

  kick(groupId: string, byAccountId: string, targetPlatformUserId: string) {
    return this.request<{ kicked: boolean }>(
      'POST',
      `/groups/${enc(groupId)}/kick`,
      { byAccountId, targetPlatformUserId },
      this.opts.kickTimeoutMs,
    ).then((r) => r.body);
  }

  leave(groupId: string, accountId: string) {
    return this.request('POST', `/groups/${enc(groupId)}/leave`, { accountId }).then(() => undefined);
  }

  members(groupId: string) {
    return this.request<Array<{ platformUserId: string }>>('GET', `/groups/${enc(groupId)}/members`).then((r) =>
      Array.isArray(r.body) ? r.body : [],
    );
  }

  send(groupId: string, accountId: string, clientMsgId: string, text: string) {
    return this.request(
      'POST',
      `/groups/${enc(groupId)}/send`,
      { accountId, clientMsgId, text },
      this.opts.sendTimeoutMs,
    ).then(() => undefined);
  }

  /** 200 → 已落地；404 → null */
  async byClientId(groupId: string, clientMsgId: string): Promise<{ msgId: string; sentAt: string } | null> {
    try {
      const r = await this.request<{ msgId: string; sentAt: string }>(
        'GET',
        `/groups/${enc(groupId)}/messages/by-client-id/${enc(clientMsgId)}`,
      );
      return r.body;
    } catch (err) {
      if (err instanceof GatewayError && err.kind === 'http' && err.status === 404) return null;
      throw err;
    }
  }

  /** 媒体地址可能是绝对 URL，也可能是网关相对路径 */
  mediaUrl(url: string): string {
    return /^https?:\/\//.test(url) ? url : `${this.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  }
}

const enc = encodeURIComponent;
