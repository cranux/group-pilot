import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAST_TIMING, startMockGateway, type MockGatewayHandle } from '../src/index.js';
import { client, openSse, sleep, waitFor } from './helpers.js';

let gw: MockGatewayHandle;
let api: ReturnType<typeof client>;

beforeAll(async () => {
  gw = await startMockGateway({ port: 0, config: { timing: FAST_TIMING } });
  api = client(gw.url);
});

afterAll(async () => {
  await gw.close();
});

beforeEach(async () => {
  await api.post('/_control/reset');
});

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** a1 建群，a2 入群（等到出现在成员列表） */
async function setupGroup(): Promise<string> {
  await api.post('/accounts/a1/connect');
  await api.post('/accounts/a2/connect');
  const created = await api.post('/groups', { creatorAccountId: 'a1' });
  expect(created.status).toBe(200);
  const groupId: string = created.body.groupId;
  const inv = await api.post(`/groups/${groupId}/invite`);
  const joined = await api.post(`/groups/${groupId}/join`, { accountId: 'a2', inviteLink: inv.body.inviteLink });
  expect(joined).toEqual({ status: 202, body: { accepted: true } });
  await waitFor(async () => {
    const m = await api.get(`/groups/${groupId}/members`);
    return m.body.some((x: { platformUserId: string }) => x.platformUserId === 'pu_a2');
  });
  return groupId;
}

describe('accounts', () => {
  it('connect 返回稳定的 platformUserId；离线与终态错误', async () => {
    const a = await api.post('/accounts/a1/connect');
    const b = await api.post('/accounts/a1/connect');
    expect(a).toEqual({ status: 200, body: { platformUserId: 'pu_a1' } });
    expect(b.body.platformUserId).toBe('pu_a1');

    const offlineCreate = await api.post('/groups', { creatorAccountId: 'nobody' });
    expect(offlineCreate.status).toBe(409);
    expect(offlineCreate.body.code).toBe('ACCOUNT_OFFLINE');

    const { body } = await api.post('/groups', { creatorAccountId: 'a1' });
    const offlineSend = await api.post(`/groups/${body.groupId}/send`, { accountId: 'a9', clientMsgId: 'c', text: 'x' });
    expect(offlineSend.status).toBe(409);
    expect(offlineSend.body).toMatchObject({ code: 'ACCOUNT_OFFLINE' });
    expect(typeof offlineSend.body.message).toBe('string');

    await api.post('/accounts/a1/disconnect');
    const afterDisconnect = await api.post(`/groups/${body.groupId}/send`, { accountId: 'a1', clientMsgId: 'c', text: 'x' });
    expect(afterDisconnect.body.code).toBe('ACCOUNT_OFFLINE');

    await api.post('/_control/accounts/a1/status', { status: 'suspended' });
    expect((await api.post('/accounts/a1/connect')).status).toBe(403);
    expect((await api.post('/accounts/a1/connect')).body.code).toBe('ACCOUNT_SUSPENDED');
    await api.post('/_control/accounts/a3/status', { status: 'session_expired' });
    const expired = await api.post('/accounts/a3/disconnect');
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('SESSION_EXPIRED');
  });

  it('终态：移出所有群并推 member_left 与 account_status', async () => {
    const groupId = await setupGroup();
    const sse = await openSse(gw.url);
    await api.post('/_control/accounts/a2/status', { status: 'suspended' });
    await sse.waitFor((e) => e.type === 'account_status' && e.accountId === 'a2' && e.status === 'suspended');
    await sse.waitFor((e) => e.type === 'member_left' && e.platformUserId === 'pu_a2' && e.groupId === groupId);
    const members = await api.get(`/groups/${groupId}/members`);
    expect(members.body).toEqual([{ platformUserId: 'pu_a1' }]);
    const send = await api.post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 'c', text: 'x' });
    expect(send.status).toBe(403);
    expect(send.body.code).toBe('ACCOUNT_SUSPENDED');

    await api.post('/_control/accounts/a1/status', { status: 'session_expired', push: false });
    await sse.waitFor((e) => e.type === 'member_left' && e.platformUserId === 'pu_a1');
    await sleep(30);
    expect(sse.events.some((e) => e.type === 'account_status' && e.accountId === 'a1')).toBe(false);
    sse.close();
  });
});

describe('groups', () => {
  it('建群 → join → member_joined → promote → kick → leave', async () => {
    const sse = await openSse(gw.url);
    await api.post('/accounts/a1/connect');
    await api.post('/accounts/a2/connect');
    const groupId: string = (await api.post('/groups', { creatorAccountId: 'a1' })).body.groupId;
    expect(groupId).toMatch(/^g_\d+$/);
    expect((await api.get(`/groups/${groupId}/members`)).body).toEqual([{ platformUserId: 'pu_a1' }]);

    const early = await api.post(`/groups/${groupId}/promote`, { byAccountId: 'a1', accountId: 'a2' });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('NOT_MEMBER_YET');

    const inv = await api.post(`/groups/${groupId}/invite`);
    expect(inv.body.readyAfterMs).toBe(0);
    await api.post(`/groups/${groupId}/join`, { accountId: 'a2', inviteLink: inv.body.inviteLink });
    await sse.waitFor((e) => e.type === 'member_joined' && e.platformUserId === 'pu_a2');

    const again = await api.post(`/groups/${groupId}/join`, { accountId: 'a2', inviteLink: inv.body.inviteLink });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_MEMBER');

    const notOwner = await api.post(`/groups/${groupId}/promote`, { byAccountId: 'a2', accountId: 'a2' });
    expect(notOwner.status).toBe(403);
    expect(notOwner.body.code).toBe('NO_PERMISSION');
    expect((await api.post(`/groups/${groupId}/promote`, { byAccountId: 'a1', accountId: 'a2' })).status).toBe(200);

    await api.post(`/_control/groups/${groupId}/external-join`, { platformUserId: 'ext_1' });
    await sse.waitFor((e) => e.type === 'member_joined' && e.platformUserId === 'ext_1');
    const kick = await api.post(`/groups/${groupId}/kick`, { byAccountId: 'a2', targetPlatformUserId: 'ext_1' });
    expect(kick).toEqual({ status: 200, body: { kicked: true } });
    await sse.waitFor((e) => e.type === 'member_left' && e.platformUserId === 'ext_1');
    const notMember = await api.post(`/groups/${groupId}/kick`, { byAccountId: 'a2', targetPlatformUserId: 'ext_1' });
    expect(notMember.status).toBe(409);
    expect(notMember.body.code).toBe('NOT_MEMBER');

    expect((await api.post(`/groups/${groupId}/leave`, { accountId: 'a1' })).status).toBe(200);
    await sse.waitFor((e) => e.type === 'member_left' && e.platformUserId === 'pu_a1');
    const ownerLeft = await api.post(`/groups/${groupId}/kick`, { byAccountId: 'a2', targetPlatformUserId: 'pu_a2' });
    expect(ownerLeft.status).toBe(409);
    expect(ownerLeft.body.code).toBe('OWNER_LEFT');
    const leaveAgain = await api.post(`/groups/${groupId}/leave`, { accountId: 'a1' });
    expect(leaveAgain.body.code).toBe('NOT_MEMBER');

    // 创建者不会有 member_joined
    expect(sse.events.some((e) => e.type === 'member_joined' && e.platformUserId === 'pu_a1')).toBe(false);
    sse.close();
  });

  it('kick：目标立即移除，响应要等 kickDelayMs', async () => {
    const groupId = await setupGroup();
    await api.patch('/_control/config', { timing: { kickDelayMs: [300, 300] } });
    const started = Date.now();
    const pending = api.post(`/groups/${groupId}/kick`, { byAccountId: 'a1', targetPlatformUserId: 'pu_a2' });
    await sleep(60);
    expect((await api.get(`/groups/${groupId}/members`)).body).toEqual([{ platformUserId: 'pu_a1' }]);
    const res = await pending;
    expect(res.body).toEqual({ kicked: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  it('邀请链接：未就绪 409、未知或过期 410', async () => {
    await api.post('/accounts/a1/connect');
    await api.post('/accounts/a2/connect');
    const groupId: string = (await api.post('/groups', { creatorAccountId: 'a1' })).body.groupId;
    await api.patch('/_control/config', { timing: { inviteReadyAfterMs: [200, 200] } });
    const inv = await api.post(`/groups/${groupId}/invite`);
    expect(inv.body.readyAfterMs).toBe(200);
    const notReady = await api.post(`/groups/${groupId}/join`, { accountId: 'a2', inviteLink: inv.body.inviteLink });
    expect(notReady.status).toBe(409);
    expect(notReady.body.code).toBe('INVITE_NOT_READY');
    await sleep(220);
    expect((await api.post(`/groups/${groupId}/join`, { accountId: 'a2', inviteLink: inv.body.inviteLink })).status).toBe(202);

    const unknown = await api.post(`/groups/${groupId}/join`, { accountId: 'a2', inviteLink: 'bogus' });
    expect(unknown.status).toBe(410);
    expect(unknown.body.code).toBe('INVITE_EXPIRED');

    await api.post(`/_control/groups/${groupId}/expire-invites`);
    const expired = await api.post(`/groups/${groupId}/join`, { accountId: 'a2', inviteLink: inv.body.inviteLink });
    expect(expired.status).toBe(410);
  });
});

describe('send', () => {
  it('202 受理 → message_sent + message；不按 clientMsgId 去重；by-client-id 返回最早一条', async () => {
    const groupId = await setupGroup();
    const sse = await openSse(gw.url);
    const r1 = await api.post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 'c1', text: 'hello' });
    expect(r1).toEqual({ status: 202, body: { accepted: true } });
    const first = await sse.waitFor((e) => e.type === 'message_sent' && e.clientMsgId === 'c1');
    await api.post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 'c1', text: 'hello' });
    await waitFor(() => sse.events.filter((e) => e.type === 'message_sent' && e.clientMsgId === 'c1').length === 2);

    const sent = sse.events.filter((e) => e.type === 'message_sent');
    expect(new Set(sent.map((e) => e.msgId)).size).toBe(2);
    expect(first.sentAt).toMatch(ISO_MS);
    const msg = await sse.waitFor((e) => e.type === 'message' && e.msgId === first.msgId);
    expect(msg).toMatchObject({ groupId, senderPlatformUserId: 'pu_a2', text: 'hello', sentAt: first.sentAt });

    const q = await api.get(`/groups/${groupId}/messages/by-client-id/c1`);
    expect(q).toEqual({ status: 200, body: { msgId: first.msgId, sentAt: first.sentAt } });
    const missing = await api.get(`/groups/${groupId}/messages/by-client-id/nope`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');

    await api.post('/accounts/a3/connect');
    const outsider = await api.post(`/groups/${groupId}/send`, { accountId: 'a3', clientMsgId: 'c3', text: 'x' });
    expect(outsider.status).toBe(403);
    expect(outsider.body.code).toBe('SENDER_NOT_IN_GROUP');
    sse.close();
  });

  it('限流窗口内再次 send 仍 429 且计时重置；自动限流', async () => {
    const groupId = await setupGroup();
    await api.post('/_control/accounts/a2/rate-limit', { retryAfterSeconds: 0.4 });
    const send = () => api.post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 'rl', text: 'x' });
    const r1 = await send();
    expect(r1.status).toBe(429);
    expect(r1.body).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 0.4 });
    await sleep(250);
    expect((await send()).status).toBe(429); // 截止时间被重置为 now + 0.4s
    await sleep(250);
    expect((await send()).status).toBe(429);
    await sleep(450);
    expect((await send()).status).toBe(202);

    await api.patch('/_control/config', { rateLimit: { maxPerWindow: 2, windowMs: 10_000, retryAfterSeconds: 7 } });
    await api.post('/accounts/a1/connect');
    const s = () => api.post(`/groups/${groupId}/send`, { accountId: 'a1', clientMsgId: 'auto', text: 'x' });
    expect((await s()).status).toBe(202);
    expect((await s()).status).toBe(202);
    const limited = await s();
    expect(limited.status).toBe(429);
    expect(limited.body.retryAfterSeconds).toBe(7);
  });

  it('群禁写：sync 同步 403，async 推 message_failed', async () => {
    const groupId = await setupGroup();
    const sse = await openSse(gw.url);
    await api.post(`/_control/groups/${groupId}/forbid`, { mode: 'sync' });
    const sync = await api.post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 's1', text: 'x' });
    expect(sync.status).toBe(403);
    expect(sync.body.code).toBe('GROUP_WRITE_FORBIDDEN');
    await api.post(`/_control/groups/${groupId}/forbid`, { mode: 'async' });
    expect((await api.post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 's2', text: 'x' })).status).toBe(202);
    await sse.waitFor((e) => e.type === 'message_failed' && e.clientMsgId === 's2' && e.code === 'GROUP_WRITE_FORBIDDEN');
    expect(sse.events.some((e) => e.type === 'message_sent' && e.clientMsgId === 's2')).toBe(false);
    sse.close();
  });
});

describe('faults', () => {
  it('send 504 + apply：结果未知，applyDelayMs 后落地', async () => {
    const groupId = await setupGroup();
    const rule = await api.post('/_control/faults', {
      endpoint: 'send',
      match: { clientMsgId: 'x1' },
      status: 504,
      body: { code: 'NETWORK_TIMEOUT' },
      apply: true,
      applyDelayMs: 300,
    });
    expect(rule.body.id).toBeTruthy();
    const r = await api.post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 'x1', text: 'x' });
    expect(r.status).toBe(504);
    expect(r.body.code).toBe('NETWORK_TIMEOUT');
    expect((await api.get(`/groups/${groupId}/messages/by-client-id/x1`)).status).toBe(404);
    await waitFor(async () => (await api.get(`/groups/${groupId}/messages/by-client-id/x1`)).status === 200, 1500);
    // times 默认 1：规则已用完
    expect((await api.get('/_control/faults')).body).toEqual([]);
    expect((await api.post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 'x1', text: 'x' })).status).toBe(202);
  });

  it('不 apply 的故障不执行真实操作；times 与 match；noResponse 挂起', async () => {
    const groupId = await setupGroup();
    await api.post('/_control/faults', { endpoint: 'leave', status: 500 });
    const leave = await api.post(`/groups/${groupId}/leave`, { accountId: 'a2' });
    expect(leave.status).toBe(500);
    expect(leave.body.code).toBe('INTERNAL_ERROR');
    expect((await api.get(`/groups/${groupId}/members`)).body).toHaveLength(2);

    await api.post('/_control/faults', { endpoint: 'members', match: { groupId: 'other' }, status: 503 });
    await api.post('/_control/faults', { endpoint: 'members', match: { groupId }, status: 503, times: 2 });
    expect((await api.get(`/groups/${groupId}/members`)).status).toBe(503);
    expect((await api.get(`/groups/${groupId}/members`)).status).toBe(503);
    expect((await api.get(`/groups/${groupId}/members`)).status).toBe(200);
    expect((await api.get('/_control/faults')).body).toHaveLength(1);
    await api.del('/_control/faults');

    await api.post('/_control/faults', { endpoint: 'byClientId', status: 200, noResponse: true });
    await expect(
      fetch(`${gw.url}/groups/${groupId}/messages/by-client-id/zz`, { signal: AbortSignal.timeout(200) }),
    ).rejects.toThrow();

    // kick 返回 504 但目标已移除
    await api.post('/_control/faults', { endpoint: 'kick', status: 504, apply: true });
    const kick = await api.post(`/groups/${groupId}/kick`, { byAccountId: 'a1', targetPlatformUserId: 'pu_a2' });
    expect(kick.status).toBe(504);
    expect((await api.get(`/groups/${groupId}/members`)).body).toEqual([{ platformUserId: 'pu_a1' }]);
  });

  it('unavailable：非 /_control 端点 503，控制接口照常；请求日志可按条件过滤', async () => {
    await api.post('/accounts/a1/connect');
    await api.patch('/_control/config', { unavailable: true });
    const r = await api.post('/accounts/a1/connect');
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('SERVICE_UNAVAILABLE');
    expect((await fetch(`${gw.url}/events`)).status).toBe(503);
    expect((await api.get('/_control/state')).status).toBe(200);
    await api.patch('/_control/config', { unavailable: false });

    const log = await api.get('/_control/requests?endpoint=connect&accountId=a1');
    expect(log.body.map((x: { status: number }) => x.status)).toEqual([200, 503]);
    expect(log.body[0]).toMatchObject({ endpoint: 'connect', method: 'POST', path: '/accounts/a1/connect' });
    await api.del('/_control/requests');
    expect((await api.get('/_control/requests')).body).toEqual([]);
  });
});

describe('event stream', () => {
  it('since 独占补发历史后推实时；帧格式；reset 保留 eventId', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push((await api.post('/_control/events', { type: 'message', data: { n: i } })).body.eventId);
    expect(ids[1]).toBe(ids[0] + 1);

    const sse = await openSse(gw.url, ids[0]);
    expect(sse.status).toBe(200);
    expect(sse.contentType).toContain('text/event-stream');
    await waitFor(() => sse.events.length >= 2);
    expect(sse.events.map((e) => e.eventId)).toEqual([ids[1], ids[2]]);
    expect(sse.frames[0]).toEqual({ id: String(ids[1]), event: 'message' });

    const live = (await api.post('/_control/events', { type: 'member_joined', data: { groupId: 'g', platformUserId: 'p' } })).body.eventId;
    const ev = await sse.waitFor((e) => e.eventId === live);
    expect(ev).toEqual({ groupId: 'g', platformUserId: 'p', eventId: live, type: 'member_joined' });

    // 不带 since：只推之后的新事件
    const fresh = await openSse(gw.url);
    await api.post('/_control/reset');
    const after = (await api.post('/_control/events', { type: 'x', data: {} })).body.eventId;
    expect(after).toBe(live + 1);
    await fresh.waitFor((e) => e.eventId === after);
    expect(fresh.events.map((e) => e.eventId)).toEqual([after]);
    sse.close();
    fresh.close();
  });

  it('duplicateEvents = 1：每个事件对同一连接推两次', async () => {
    await api.patch('/_control/config', { duplicateEvents: 1 });
    const sse = await openSse(gw.url);
    const id = (await api.post('/_control/events', { type: 'message', data: {} })).body.eventId;
    await waitFor(() => sse.events.filter((e) => e.eventId === id).length === 2);
    await sleep(30);
    expect(sse.events.filter((e) => e.eventId === id)).toHaveLength(2);
    sse.close();
  });

  it('乱序只交换相邻事件，且不丢事件', async () => {
    await api.patch('/_control/config', { reorderWindowMs: 150 });
    const sse = await openSse(gw.url);
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) ids.push((await api.post('/_control/events', { type: 'message', data: { i } })).body.eventId);
    await waitFor(() => sse.events.length >= 30, 3000);
    const got = sse.events.map((e) => e.eventId);
    expect([...got].sort((a, b) => a - b)).toEqual(ids);
    got.forEach((id, pos) => expect(Math.abs(id - ids[0] - pos)).toBeLessThanOrEqual(1));
    sse.close();
  });

  it('外部消息带媒体（过期后 404）；补投用新 eventId、原 msgId / sentAt', async () => {
    const groupId = await setupGroup();
    const sse = await openSse(gw.url);
    const ext = await api.post(`/_control/groups/${groupId}/external-message`, {
      platformUserId: 'ext_9',
      text: 'look',
      withMedia: true,
      mediaTtlMs: 250,
    });
    const msg = await sse.waitFor((e) => e.eventId === ext.body.eventId);
    expect(msg).toMatchObject({ type: 'message', msgId: ext.body.msgId, senderPlatformUserId: 'ext_9' });
    expect(String(msg.mediaUrl)).toMatch(new RegExp(`^${gw.url}/media/md_\\d+$`));
    const media = await fetch(String(msg.mediaUrl));
    expect(media.status).toBe(200);
    expect(media.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await media.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG');
    await sleep(300);
    expect((await fetch(String(msg.mediaUrl))).status).toBe(404);

    await api.post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 'r1', text: 'mine' });
    const sent = await sse.waitFor((e) => e.type === 'message_sent' && e.clientMsgId === 'r1');
    const original = await sse.waitFor((e) => e.type === 'message' && e.msgId === sent.msgId);
    const re = await api.post('/_control/accounts/a2/redeliver');
    expect(re.body.count).toBe(1);
    const again = await sse.waitFor((e) => e.eventId === re.body.eventIds[0]);
    expect(again.eventId).toBeGreaterThan(original.eventId);
    expect(again).toMatchObject({ type: 'message', msgId: sent.msgId, sentAt: sent.sentAt, text: 'mine' });
    sse.close();
  });
});
