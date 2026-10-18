import { randomBytes } from 'node:crypto';
import { cloneConfig, type GatewayConfig } from './config.js';
import { EventHub } from './events.js';
import { solidPng } from './png.js';
import { ApiError, randIn, randInt, Scheduler, type Reply } from './util.js';

export const ENDPOINTS = [
  'connect',
  'disconnect',
  'createGroup',
  'invite',
  'join',
  'promote',
  'kick',
  'leave',
  'members',
  'send',
  'byClientId',
  'media',
] as const;
export type EndpointName = (typeof ENDPOINTS)[number];

export type TerminalStatus = 'suspended' | 'session_expired';
export type ForbidMode = 'sync' | 'async' | null;

export interface Account {
  accountId: string;
  platformUserId: string;
  online: boolean;
  terminal: TerminalStatus | null;
  /** 限流窗口截止时间（ms）；0 = 未限流 */
  rateLimitedUntil: number;
  /** 当前限流窗口的 retryAfterSeconds（窗口内再次 send 时原样返回并重置计时） */
  retryAfterSeconds: number;
  /** 自动限流用：近期通过限流检查的 send 时间戳 */
  sendTimes: number[];
  createdAt: number;
}

export interface Group {
  groupId: string;
  ownerAccountId: string;
  ownerPlatformUserId: string;
  /** platformUserId → 入群时刻 */
  members: Map<string, number>;
  /** 被 promote 的 accountId */
  promoted: Set<string>;
  ownerLeft: boolean;
  forbid: ForbidMode;
  createdAt: number;
}

export interface Invite {
  link: string;
  groupId: string;
  readyAt: number;
  expiresAt: number | null;
  createdAt: number;
}

export interface StoredMessage {
  msgId: string;
  groupId: string;
  senderPlatformUserId: string;
  senderAccountId: string | null;
  clientMsgId: string | null;
  text: string;
  sentAt: string;
  mediaUrl?: string;
  /** 首次推送 message 事件的 eventId */
  eventId: number;
}

export interface MediaFile {
  id: string;
  groupId: string;
  contentType: string;
  bytes: Buffer;
  expiresAt: number | null;
}

export interface FaultMatch {
  accountId?: string;
  groupId?: string;
  clientMsgId?: string;
}

export interface FaultRule {
  id: string;
  endpoint: EndpointName;
  match?: FaultMatch;
  /** 剩余次数；-1 = 一直生效 */
  times: number;
  status: number;
  body?: Record<string, unknown>;
  delayMs?: number;
  noResponse?: boolean;
  apply?: boolean;
  applyDelayMs?: number;
  /** 已命中次数 */
  hits: number;
}

export interface RequestContext {
  endpoint: EndpointName;
  accountIds: string[];
  groupId?: string;
  clientMsgId?: string;
}

export interface RequestLogEntry {
  at: number;
  endpoint: EndpointName;
  method: string;
  path: string;
  body: unknown;
  status: number | null;
  accountId: string | null;
  accountIds: string[];
  groupId: string | null;
  clientMsgId: string | null;
}

/** apply 模式：故障规则返回假响应的同时仍执行真实操作 */
export interface ApplyMode {
  applied: boolean;
  applyDelayMs?: number;
}

const MAX_REQUEST_LOG = 20_000;

function defaultFaultBody(status: number): Record<string, unknown> {
  switch (status) {
    case 504:
      return { code: 'NETWORK_TIMEOUT', message: 'gateway timeout (injected)' };
    case 503:
      return { code: 'SERVICE_UNAVAILABLE', message: 'service unavailable (injected)' };
    case 500:
      return { code: 'INTERNAL_ERROR', message: 'internal error (injected)' };
    case 429:
      return { code: 'RATE_LIMITED', message: 'rate limited (injected)', retryAfterSeconds: 3 };
    default:
      return status >= 400 ? { code: 'INJECTED_FAULT', message: 'injected fault' } : {};
  }
}

export class Gateway {
  config: GatewayConfig;
  publicUrl = '';

  readonly hub: EventHub;
  readonly accounts = new Map<string, Account>();
  private readonly puidToAccount = new Map<string, string>();
  readonly groups = new Map<string, Group>();
  private readonly invites = new Map<string, Invite>();
  messages: StoredMessage[] = [];
  private readonly media = new Map<string, MediaFile>();
  faults: FaultRule[] = [];
  requests: RequestLogEntry[] = [];

  /** id 计数器在 reset 后保持单调，避免与仍在运行的后端里的旧 id 冲突 */
  private readonly counters = { group: 0, msg: 0, media: 0, fault: 0 };
  private pendingJoins = 0;
  private pendingSends = 0;

  /** 业务定时器（入群、落地、成员事件）：reset 与 close 时取消 */
  readonly biz = new Scheduler();
  /** 请求内的等待（accept / kick / 故障延迟）：仅 close 时取消 */
  readonly req = new Scheduler();

  constructor(private readonly initialConfig: GatewayConfig) {
    this.config = cloneConfig(initialConfig);
    this.hub = new EventHub(() => this.config);
  }

  // ───────────────────────── 基础 ─────────────────────────

  account(accountId: string): Account {
    let acc = this.accounts.get(accountId);
    if (!acc) {
      acc = {
        accountId,
        platformUserId: `pu_${accountId}`,
        online: false,
        terminal: null,
        rateLimitedUntil: 0,
        retryAfterSeconds: 0,
        sendTimes: [],
        createdAt: Date.now(),
      };
      this.accounts.set(accountId, acc);
      this.puidToAccount.set(acc.platformUserId, accountId);
    }
    return acc;
  }

  accountIdOf(platformUserId: string): string | null {
    return this.puidToAccount.get(platformUserId) ?? null;
  }

  /** 终态检查（所有引用账号的请求） */
  assertNotTerminal(accountId: string): Account {
    const acc = this.account(accountId);
    if (acc.terminal === 'suspended') throw new ApiError(403, 'ACCOUNT_SUSPENDED', `account ${accountId} is suspended`);
    if (acc.terminal === 'session_expired') throw new ApiError(401, 'SESSION_EXPIRED', `account ${accountId} session expired`);
    return acc;
  }

  /** 终态 + 在线检查（send / join / promote / kick / leave / createGroup） */
  assertUsable(accountId: string): Account {
    const acc = this.assertNotTerminal(accountId);
    if (!acc.online) throw new ApiError(409, 'ACCOUNT_OFFLINE', `account ${accountId} is offline`);
    return acc;
  }

  requireGroup(groupId: string): Group {
    const g = this.groups.get(groupId);
    if (!g) throw new ApiError(404, 'GROUP_NOT_FOUND', `group ${groupId} not found`);
    return g;
  }

  emit(type: string, payload: Record<string, unknown>) {
    return this.hub.emit(type, payload);
  }

  private memberEventLater(type: 'member_joined' | 'member_left', groupId: string, platformUserId: string): void {
    this.biz.after(this.config.timing.memberEventLagMs, () => this.emit(type, { groupId, platformUserId }));
  }

  private addMember(group: Group, platformUserId: string): boolean {
    if (group.members.has(platformUserId)) return false;
    group.members.set(platformUserId, Date.now());
    this.memberEventLater('member_joined', group.groupId, platformUserId);
    return true;
  }

  /** 立即从成员列表移除，memberEventLagMs 后推 member_left */
  private removeMember(group: Group, platformUserId: string): boolean {
    if (!group.members.delete(platformUserId)) return false;
    const accountId = this.accountIdOf(platformUserId);
    if (accountId !== null) {
      group.promoted.delete(accountId);
      if (accountId === group.ownerAccountId) group.ownerLeft = true;
    }
    this.memberEventLater('member_left', group.groupId, platformUserId);
    return true;
  }

  // ───────────────────────── 故障规则与请求日志 ─────────────────────────

  addFault(rule: Omit<FaultRule, 'id' | 'hits'>): FaultRule {
    const full: FaultRule = { ...rule, id: `f_${++this.counters.fault}`, hits: 0 };
    this.faults.push(full);
    return full;
  }

  /** 按添加顺序匹配第一条规则；times 递减到 0 时移除 */
  takeFault(ctx: RequestContext): FaultRule | null {
    const idx = this.faults.findIndex((r) => {
      if (r.endpoint !== ctx.endpoint) return false;
      const m = r.match;
      if (!m) return true;
      if (m.accountId !== undefined && !ctx.accountIds.includes(m.accountId)) return false;
      if (m.groupId !== undefined && ctx.groupId !== m.groupId) return false;
      if (m.clientMsgId !== undefined && ctx.clientMsgId !== m.clientMsgId) return false;
      return true;
    });
    if (idx < 0) return null;
    const rule = this.faults[idx];
    rule.hits++;
    if (rule.times > 0) {
      rule.times--;
      if (rule.times === 0) this.faults.splice(idx, 1);
    }
    return { ...rule };
  }

  faultBody(rule: FaultRule): Record<string, unknown> {
    const def = defaultFaultBody(rule.status);
    if (!rule.body) return def;
    if (rule.status >= 400 && rule.body.code !== undefined && rule.body.message === undefined) {
      return { ...rule.body, message: String(def.message ?? 'injected fault') };
    }
    return rule.body;
  }

  logRequest(entry: RequestLogEntry): void {
    this.requests.push(entry);
    if (this.requests.length > MAX_REQUEST_LOG) this.requests.splice(0, this.requests.length - MAX_REQUEST_LOG);
  }

  // ───────────────────────── 公开端点 ─────────────────────────

  connect(accountId: string): Reply {
    const acc = this.account(accountId);
    acc.online = true;
    return { status: 200, body: { platformUserId: acc.platformUserId } };
  }

  disconnect(accountId: string): Reply {
    this.account(accountId).online = false;
    return { status: 200, body: {} };
  }

  createGroup(creatorAccountId: string): Reply {
    const acc = this.account(creatorAccountId);
    const groupId = `g_${++this.counters.group}`;
    const now = Date.now();
    this.groups.set(groupId, {
      groupId,
      ownerAccountId: creatorAccountId,
      ownerPlatformUserId: acc.platformUserId,
      members: new Map([[acc.platformUserId, now]]),
      promoted: new Set(),
      ownerLeft: false,
      forbid: null,
      createdAt: now,
    });
    // 创建者立即是成员，不推 member_joined
    return { status: 200, body: { groupId } };
  }

  invite(groupId: string): Reply {
    this.requireGroup(groupId);
    const now = Date.now();
    const readyAfterMs = randIn(this.config.timing.inviteReadyAfterMs);
    const ttl = this.config.chaos ? randInt(5_000, 30_000) : this.config.timing.inviteTtlMs;
    const link = `${this.publicUrl}/invite/${groupId}/${randomBytes(6).toString('hex')}`;
    this.invites.set(link, {
      link,
      groupId,
      readyAt: now + readyAfterMs,
      expiresAt: ttl === null ? null : now + ttl,
      createdAt: now,
    });
    return { status: 200, body: { inviteLink: link, readyAfterMs } };
  }

  join(groupId: string, accountId: string, inviteLink: string): Reply {
    const group = this.requireGroup(groupId);
    const acc = this.account(accountId);
    const now = Date.now();
    const inv = this.invites.get(inviteLink);
    if (!inv || inv.groupId !== groupId || (inv.expiresAt !== null && now >= inv.expiresAt)) {
      throw new ApiError(410, 'INVITE_EXPIRED', 'invite link expired or unknown');
    }
    if (now < inv.readyAt) {
      throw new ApiError(409, 'INVITE_NOT_READY', 'invite link not ready yet', { readyInMs: inv.readyAt - now });
    }
    if (group.members.has(acc.platformUserId)) {
      throw new ApiError(409, 'ALREADY_MEMBER', `account ${accountId} is already a member`);
    }
    if (Math.random() >= this.config.dropJoinProbability) {
      this.pendingJoins++;
      this.biz.after(randIn(this.config.timing.joinDelayMs), () => {
        this.pendingJoins = Math.max(0, this.pendingJoins - 1);
        const g = this.groups.get(groupId);
        const a = this.accounts.get(accountId);
        if (!g || !a || a.terminal) return;
        this.addMember(g, a.platformUserId);
      });
    }
    return { status: 202, body: { accepted: true } };
  }

  promote(groupId: string, byAccountId: string, accountId: string): Reply {
    const group = this.requireGroup(groupId);
    if (group.ownerLeft || group.ownerAccountId !== byAccountId) {
      throw new ApiError(403, 'NO_PERMISSION', `${byAccountId} is not the group owner`);
    }
    const target = this.account(accountId);
    if (!group.members.has(target.platformUserId)) {
      throw new ApiError(409, 'NOT_MEMBER_YET', `${accountId} has not joined yet`);
    }
    group.promoted.add(accountId);
    return { status: 200, body: {} };
  }

  async kick(groupId: string, byAccountId: string, targetPlatformUserId: string, mode: ApplyMode): Promise<Reply> {
    const group = this.requireGroup(groupId);
    if (group.ownerLeft) throw new ApiError(409, 'OWNER_LEFT', 'group owner has left');
    const by = this.account(byAccountId);
    const privileged = group.ownerAccountId === byAccountId || group.promoted.has(byAccountId);
    if (!privileged || !group.members.has(by.platformUserId)) {
      throw new ApiError(403, 'NO_PERMISSION', `${byAccountId} cannot kick`);
    }
    if (!group.members.has(targetPlatformUserId)) {
      throw new ApiError(409, 'NOT_MEMBER', `${targetPlatformUserId} is not a member`);
    }
    // 200 返回之前目标已从成员列表移除
    this.removeMember(group, targetPlatformUserId);
    if (!mode.applied) await this.req.sleep(randIn(this.config.timing.kickDelayMs));
    return { status: 200, body: { kicked: true } };
  }

  leave(groupId: string, accountId: string): Reply {
    const group = this.requireGroup(groupId);
    const acc = this.account(accountId);
    if (!this.removeMember(group, acc.platformUserId)) {
      throw new ApiError(409, 'NOT_MEMBER', `${accountId} is not a member`);
    }
    return { status: 200, body: {} };
  }

  members(groupId: string): Reply {
    const group = this.requireGroup(groupId);
    return { status: 200, body: [...group.members.keys()].map((platformUserId) => ({ platformUserId })) };
  }

  async send(groupId: string, accountId: string, clientMsgId: string, text: string, mode: ApplyMode): Promise<Reply> {
    const group = this.requireGroup(groupId);
    const acc = this.account(accountId);
    const now = Date.now();
    if (acc.rateLimitedUntil > now) {
      // 等待期内任何 send 都再次得到同样的错误，并且计时重置
      acc.rateLimitedUntil = now + acc.retryAfterSeconds * 1000;
      throw this.rateLimitedError(acc);
    }
    const rl = this.config.rateLimit;
    if (rl) {
      acc.sendTimes = acc.sendTimes.filter((t) => t > now - rl.windowMs);
      if (acc.sendTimes.length >= rl.maxPerWindow) {
        acc.sendTimes = [];
        this.enterRateLimit(acc, rl.retryAfterSeconds);
        throw this.rateLimitedError(acc);
      }
      acc.sendTimes.push(now);
    }
    if (group.forbid === 'sync') throw new ApiError(403, 'GROUP_WRITE_FORBIDDEN', `group ${groupId} is not writable`);
    if (!group.members.has(acc.platformUserId)) {
      throw new ApiError(403, 'SENDER_NOT_IN_GROUP', `${accountId} is not in group ${groupId}`);
    }
    if (mode.applied) {
      this.scheduleLanding(groupId, accountId, clientMsgId, text, mode.applyDelayMs ?? randIn(this.config.timing.messageSentDelayMs));
      return { status: 202, body: { accepted: true } };
    }
    await this.req.sleep(randIn(this.config.timing.sendAcceptDelayMs));
    // 受理即生效：即使客户端已超时断开，消息照样落地
    this.scheduleLanding(groupId, accountId, clientMsgId, text, randIn(this.config.timing.messageSentDelayMs));
    return { status: 202, body: { accepted: true } };
  }

  private rateLimitedError(acc: Account): ApiError {
    return new ApiError(429, 'RATE_LIMITED', `account ${acc.accountId} is rate limited`, {
      retryAfterSeconds: acc.retryAfterSeconds,
    });
  }

  private enterRateLimit(acc: Account, retryAfterSeconds: number): void {
    acc.retryAfterSeconds = retryAfterSeconds;
    acc.rateLimitedUntil = Date.now() + retryAfterSeconds * 1000;
  }

  private scheduleLanding(groupId: string, accountId: string, clientMsgId: string, text: string, delayMs: number): void {
    this.pendingSends++;
    this.biz.after(delayMs, () => {
      this.pendingSends = Math.max(0, this.pendingSends - 1);
      const group = this.groups.get(groupId);
      const acc = this.accounts.get(accountId);
      if (!group || !acc) return;
      if (acc.terminal) {
        this.emit('message_failed', {
          clientMsgId,
          code: acc.terminal === 'suspended' ? 'ACCOUNT_SUSPENDED' : 'SESSION_EXPIRED',
        });
        return;
      }
      if (group.forbid) {
        this.emit('message_failed', { clientMsgId, code: 'GROUP_WRITE_FORBIDDEN' });
        return;
      }
      const sentAt = new Date().toISOString();
      const msgId = `m_${++this.counters.msg}`;
      this.emit('message_sent', { clientMsgId, msgId, sentAt });
      const ev = this.emit('message', { groupId, msgId, senderPlatformUserId: acc.platformUserId, text, sentAt });
      this.messages.push({
        msgId,
        groupId,
        senderPlatformUserId: acc.platformUserId,
        senderAccountId: accountId,
        clientMsgId,
        text,
        sentAt,
        eventId: ev.eventId,
      });
    });
  }

  byClientId(groupId: string, clientMsgId: string): Reply {
    this.requireGroup(groupId);
    const m = this.messages.find((x) => x.groupId === groupId && x.clientMsgId === clientMsgId);
    if (!m) throw new ApiError(404, 'NOT_FOUND', `no message landed for clientMsgId ${clientMsgId}`);
    return { status: 200, body: { msgId: m.msgId, sentAt: m.sentAt } };
  }

  getMedia(id: string): MediaFile {
    const f = this.media.get(id);
    if (!f || (f.expiresAt !== null && Date.now() >= f.expiresAt)) {
      if (f) this.media.delete(id);
      throw new ApiError(404, 'NOT_FOUND', `media ${id} not found or expired`);
    }
    return f;
  }

  mediaGroupId(id: string): string | undefined {
    return this.media.get(id)?.groupId;
  }

  // ───────────────────────── 控制接口 ─────────────────────────

  setTerminal(accountId: string, status: TerminalStatus, push: boolean): { removedFrom: string[] } {
    const acc = this.account(accountId);
    acc.terminal = status;
    acc.online = false;
    if (push) this.emit('account_status', { accountId, status });
    const removedFrom: string[] = [];
    for (const g of this.groups.values()) {
      if (this.removeMember(g, acc.platformUserId)) removedFrom.push(g.groupId);
    }
    return { removedFrom };
  }

  setRateLimit(accountId: string, retryAfterSeconds: number): { rateLimitedUntil: string } {
    const acc = this.account(accountId);
    this.enterRateLimit(acc, retryAfterSeconds);
    return { rateLimitedUntil: new Date(acc.rateLimitedUntil).toISOString() };
  }

  setForbid(groupId: string, mode: ForbidMode): void {
    this.requireGroup(groupId).forbid = mode;
  }

  externalJoin(groupId: string, platformUserId: string): boolean {
    return this.addMember(this.requireGroup(groupId), platformUserId);
  }

  externalLeave(groupId: string, platformUserId: string): boolean {
    return this.removeMember(this.requireGroup(groupId), platformUserId);
  }

  expireInvites(groupId: string): number {
    this.requireGroup(groupId);
    let n = 0;
    const now = Date.now();
    for (const inv of this.invites.values()) {
      if (inv.groupId === groupId && (inv.expiresAt === null || inv.expiresAt > now)) {
        inv.expiresAt = now;
        n++;
      }
    }
    return n;
  }

  externalMessage(opts: {
    groupId: string;
    platformUserId: string;
    text: string;
    withMedia?: boolean;
    mediaTtlMs?: number | null;
    sentAt?: string;
  }): { msgId: string; eventId: number; mediaUrl?: string } {
    this.requireGroup(opts.groupId);
    const msgId = `m_${++this.counters.msg}`;
    const sentAt = opts.sentAt ?? new Date().toISOString();
    let mediaUrl: string | undefined;
    if (opts.withMedia) {
      const id = `md_${++this.counters.media}`;
      const ttl = opts.mediaTtlMs ?? null;
      this.media.set(id, {
        id,
        groupId: opts.groupId,
        contentType: 'image/png',
        bytes: solidPng(16),
        expiresAt: ttl === null ? null : Date.now() + ttl,
      });
      mediaUrl = `${this.publicUrl}/media/${id}`;
    }
    const payload: Record<string, unknown> = {
      groupId: opts.groupId,
      msgId,
      senderPlatformUserId: opts.platformUserId,
      text: opts.text,
      sentAt,
    };
    if (mediaUrl) payload.mediaUrl = mediaUrl;
    const ev = this.emit('message', payload);
    this.messages.push({
      msgId,
      groupId: opts.groupId,
      senderPlatformUserId: opts.platformUserId,
      senderAccountId: this.accountIdOf(opts.platformUserId),
      clientMsgId: null,
      text: opts.text,
      sentAt,
      mediaUrl,
      eventId: ev.eventId,
    });
    return { msgId, eventId: ev.eventId, ...(mediaUrl ? { mediaUrl } : {}) };
  }

  /** 补投：该账号历史上发出的所有消息用新的 eventId、原 msgId/sentAt 重新推 message */
  redeliver(accountId: string): { count: number; eventIds: number[] } {
    const eventIds: number[] = [];
    for (const m of this.messages) {
      if (m.senderAccountId !== accountId) continue;
      const payload: Record<string, unknown> = {
        groupId: m.groupId,
        msgId: m.msgId,
        senderPlatformUserId: m.senderPlatformUserId,
        text: m.text,
        sentAt: m.sentAt,
      };
      if (m.mediaUrl) payload.mediaUrl = m.mediaUrl;
      eventIds.push(this.emit('message', payload).eventId);
    }
    return { count: eventIds.length, eventIds };
  }

  /** 清空业务状态并恢复启动时配置；保留 eventId 计数器、事件历史与各类 id 计数器 */
  reset(): void {
    this.biz.cancelAll();
    this.accounts.clear();
    this.puidToAccount.clear();
    this.groups.clear();
    this.invites.clear();
    this.messages = [];
    this.media.clear();
    this.faults = [];
    this.requests = [];
    this.pendingJoins = 0;
    this.pendingSends = 0;
    this.config = cloneConfig(this.initialConfig);
  }

  snapshot() {
    const now = Date.now();
    return {
      accounts: [...this.accounts.values()].map((a) => ({
        accountId: a.accountId,
        platformUserId: a.platformUserId,
        online: a.online,
        terminal: a.terminal,
        rateLimitedUntil: a.rateLimitedUntil > now ? new Date(a.rateLimitedUntil).toISOString() : null,
        retryAfterSeconds: a.rateLimitedUntil > now ? a.retryAfterSeconds : null,
      })),
      groups: [...this.groups.values()].map((g) => ({
        groupId: g.groupId,
        ownerAccountId: g.ownerAccountId,
        ownerPlatformUserId: g.ownerPlatformUserId,
        ownerLeft: g.ownerLeft,
        forbid: g.forbid,
        promoted: [...g.promoted],
        members: [...g.members.entries()].map(([platformUserId, joinedAt]) => ({
          platformUserId,
          accountId: this.accountIdOf(platformUserId),
          joinedAt: new Date(joinedAt).toISOString(),
        })),
        createdAt: new Date(g.createdAt).toISOString(),
      })),
      stats: {
        lastEventId: this.hub.lastEventId,
        eventCount: this.hub.size,
        sseClients: this.hub.clientCount,
        messages: this.messages.length,
        pendingJoins: this.pendingJoins,
        pendingSends: this.pendingSends,
        faults: this.faults.length,
        requests: this.requests.length,
      },
      config: this.config,
    };
  }
}
