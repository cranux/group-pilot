import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, connectAll, createGroup, messages, openWs, startStack, waitFor, waitJob, type Stack } from './harness.js';

let s: Stack;

/** 用绝对 URL 作请求目标（`GET http://host/api/... HTTP/1.1`），fetch 发不出这种写法 */
function absoluteForm(method: string, p: string, token?: string | null): Promise<number> {
  const u = new URL(s.url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, method, path: `${s.url}${p}`, headers: token ? { authorization: `Bearer ${token}` } : {} },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  s = await startStack();
  await s.api.login();
});

afterAll(async () => {
  await s?.close();
});

describe('A0 基础', () => {
  it('health 返回 schemaVersion', async () => {
    const r = await new Api(s.url).get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, schemaVersion: 1 });
  });

  it('未登录 401，错误格式统一', async () => {
    const r = await new Api(s.url).get('/api/accounts');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHORIZED');
    expect(typeof r.body.error.requestId).toBe('string');
  });

  it('viewer 对写操作 403，读操作正常', async () => {
    const viewer = new Api(s.url);
    expect((await viewer.login('viewer')).status).toBe(200);
    expect((await viewer.get('/api/accounts')).status).toBe(200);
    const w = await viewer.post('/api/accounts/acc-01/connect');
    expect(w.status).toBe(403);
    expect(w.body.error.code).toBe('FORBIDDEN');
    expect((await viewer.post('/api/groups', {})).status).toBe(403);
  });

  it('编码路径、绝对 URL 写法绕不过登录和 viewer 写保护', async () => {
    const anon = new Api(s.url);
    const viewer = new Api(s.url);
    await viewer.login('viewer');
    const acc01 = async () => (await s.api.get('/api/accounts')).body.find((a: any) => a.id === 'acc-01');
    const before = await acc01();

    // 路由器先解码 %XX、去掉绝对 URL 的 scheme+host 再匹配，这些写法都会命中真实路由
    expect((await anon.get('/%61pi/accounts')).status).toBe(401);
    expect((await anon.post('/%61pi/accounts/acc-01/connect')).status).toBe(401);
    expect(await absoluteForm('GET', '/api/accounts')).toBe(401);
    expect(await absoluteForm('POST', '/api/accounts/acc-01/connect')).toBe(401);
    expect((await viewer.post('/%61pi/accounts/acc-01/connect')).status).toBe(403);
    expect(await absoluteForm('POST', '/api/accounts/acc-01/connect', viewer.token)).toBe(403);
    // 不存在的路径同样先要求登录，不向未登录者暴露路由表
    expect((await anon.get('/%61pi/nope')).status).toBe(401);

    // 带合法 token 时这些写法照常可用，公开接口也照常公开
    expect((await s.api.get('/%61pi/accounts')).status).toBe(200);
    expect(await absoluteForm('GET', '/api/accounts', s.api.token)).toBe(200);
    expect((await anon.get('/%61pi/health')).status).toBe(200);

    expect(await acc01()).toEqual(before);
  });

  it('错误密码 401', async () => {
    const r = await new Api(s.url).login('admin', 'nope');
    expect(r.status).toBe(401);
  });
});

describe('B3 登录会话', () => {
  it('refresh token 只在 HttpOnly cookie 里，轮换后旧的再用会作废整个会话', async () => {
    const a = new Api(s.url);
    const login = await a.login();
    expect(login.body.refreshToken).toBeUndefined();
    const setCookie = login.headers.getSetCookie().join(';');
    expect(setCookie).toMatch(/HttpOnly/i);
    const oldCookie = a.cookie;

    const r1 = await a.req('POST', '/api/auth/refresh', undefined, { token: null });
    expect(r1.status).toBe(200);
    const newCookie = r1.headers.getSetCookie().find((c) => c.startsWith('gp_refresh='))!.split(';')[0];
    const newAccess = r1.body.accessToken;
    expect((await a.req('GET', '/api/accounts', undefined, { token: newAccess })).status).toBe(200);

    // 旧 refresh token 再次使用 → 401，并且之前换出的新 token 全部失效
    const reuse = await a.req('POST', '/api/auth/refresh', undefined, { token: null, cookie: oldCookie });
    expect(reuse.status).toBe(401);
    expect((await a.req('GET', '/api/accounts', undefined, { token: newAccess })).status).toBe(401);
    expect((await a.req('POST', '/api/auth/refresh', undefined, { token: null, cookie: newCookie })).status).toBe(401);
  });

  it('logout 之后同一个 access token 立即失效', async () => {
    const a = new Api(s.url);
    await a.login();
    expect((await a.get('/api/accounts')).status).toBe(200);
    expect((await a.post('/api/auth/logout')).status).toBe(204);
    expect((await a.get('/api/accounts')).status).toBe(401);
  });
});

describe('A1 账号状态', () => {
  it('connect：idle → online，并保存 platformUserId', async () => {
    const r = await s.api.post('/api/accounts/acc-08/connect');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'online', platformUserId: 'pu_acc-08' });
    const again = await s.api.post('/api/accounts/acc-08/connect');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('transition 的 400 / 404 / ILLEGAL_TRANSITION / CAS_CONFLICT', async () => {
    expect((await s.api.post('/api/accounts/acc-08/transition', { to: 'idle' })).body.error.code).toBe('VALIDATION_ERROR');
    const nf = await s.api.post('/api/accounts/nope/transition', { to: 'idle', expectedFrom: 'online' });
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('ACCOUNT_NOT_FOUND');
    const same = await s.api.post('/api/accounts/acc-08/transition', { to: 'online', expectedFrom: 'online' });
    expect(same.body.error.code).toBe('ILLEGAL_TRANSITION');
    const cas = await s.api.post('/api/accounts/acc-08/transition', { to: 'online', expectedFrom: 'disconnected' });
    expect(cas.status).toBe(409);
    expect(cas.body.error.code).toBe('CAS_CONFLICT');
  });

  it('并发变更同一账号：至多一个成功，另一个 CAS_CONFLICT', async () => {
    const [a, b] = await Promise.all([
      s.api.post('/api/accounts/acc-08/transition', { to: 'disconnected', expectedFrom: 'online' }),
      s.api.post('/api/accounts/acc-08/transition', { to: 'idle', expectedFrom: 'online' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect([a, b].find((x) => x.status === 409)!.body.error.code).toBe('CAS_CONFLICT');
    // 标为离线时调了网关 disconnect
    const reqs = await s.gwc.call<any[]>('GET', '/_control/requests?endpoint=disconnect&accountId=acc-08');
    expect(reqs.length).toBe(1);
  });

  it('终态不能再转移', async () => {
    await s.api.post('/api/accounts/acc-07/connect');
    const r = await s.api.post('/api/accounts/acc-07/transition', { to: 'suspended', expectedFrom: 'online' });
    expect(r.body).toEqual({ status: 'suspended' });
    const back = await s.api.post('/api/accounts/acc-07/transition', { to: 'online', expectedFrom: 'suspended' });
    expect(back.body.error.code).toBe('ILLEGAL_TRANSITION');
    const reconnect = await s.api.post('/api/accounts/acc-07/connect');
    expect(reconnect.status).toBe(409);
  });
});

describe('A3 建群 + S1 受理与发出', () => {
  let group: any;

  it('校验：成员为空 / 含群主 → 400；账号不在线 → 422', async () => {
    expect((await s.api.post('/api/groups', { creatorAccountId: 'acc-01', memberAccountIds: [] })).status).toBe(400);
    expect((await s.api.post('/api/groups', { creatorAccountId: 'acc-01', memberAccountIds: ['acc-01'] })).status).toBe(400);
    const r = await s.api.post('/api/groups', { creatorAccountId: 'acc-01', memberAccountIds: ['acc-02'] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ACCOUNT_NOT_ONLINE');
  });

  it('建群 + 拉人 + 提升管理员', async () => {
    await connectAll(s.api, ['acc-01', 'acc-02', 'acc-03']);
    group = await createGroup(s.api, 'acc-01', ['acc-02', 'acc-03']);
    expect(group.status).toBe('active');
    expect(group.agentEnabled).toBe(false);
    expect(group.autoKickEnabled).toBe(false);
    const roles = Object.fromEntries(group.members.map((m: any) => [m.accountId, m.role]));
    expect(roles).toEqual({ 'acc-01': 'creator', 'acc-02': 'admin', 'acc-03': 'member' });
    const promotes = await s.gwc.call<any[]>('GET', '/_control/requests?endpoint=promote');
    expect(promotes.length).toBe(1);
  });

  it('S1：202 后 accepted，message_sent 后 sent；一条消息只有一行', async () => {
    await s.gwc.call('PATCH', '/_control/config', { timing: { sendAcceptDelayMs: [0, 0], messageSentDelayMs: [800, 800] } });
    const ws = openWs(s.url);
    ws.ws.on('open', () => ws.ws.send(JSON.stringify({ type: 'auth', accessToken: s.api.token })));
    expect((await ws.ready).success).toBe(true);

    const r = await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-02', text: 'hello S1' });
    expect(r.status).toBe(202);
    const clientMsgId = r.body.clientMsgId;
    const accepted = await waitFor(async () => (await messages(s.api, group.id)).find((m) => m.clientMsgId === clientMsgId && m.deliveryStatus === 'accepted'), 3000, 'accepted');
    expect(accepted.isOwn).toBe(true);
    const sent = await waitFor(async () => (await messages(s.api, group.id)).find((m) => m.clientMsgId === clientMsgId && m.deliveryStatus === 'sent'), 5000, 'sent');
    expect(sent.msgId).toBeTruthy();
    // 回流的 message 事件不产生第二行
    await new Promise((r) => setTimeout(r, 300));
    const rows = (await messages(s.api, group.id)).filter((m) => m.text === 'hello S1');
    expect(rows.length).toBe(1);
    // WS 推送：seq 单调递增、至少包含 queued→accepted→sent
    const statuses = ws.frames.filter((f) => f.type === 'message' && f.payload.clientMsgId === clientMsgId).map((f) => f.payload.item.deliveryStatus);
    expect(statuses).toEqual(expect.arrayContaining(['queued', 'accepted', 'sent']));
    const seqs = ws.frames.map((f) => f.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    ws.ws.close();
    await s.gwc.call('PATCH', '/_control/config', { timing: { sendAcceptDelayMs: [0, 20], messageSentDelayMs: [20, 60] } });
  });

  it('send 校验：不在群 409 ACCOUNT_NOT_IN_GROUP；离线 409 ACCOUNT_UNAVAILABLE', async () => {
    const notIn = await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-04', text: 'x' });
    expect(notIn.body.error.code).toBe('ACCOUNT_NOT_IN_GROUP');
    await s.api.post('/api/accounts/acc-03/transition', { to: 'disconnected', expectedFrom: 'online' });
    const off = await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-03', text: 'x' });
    expect(off.body.error.code).toBe('ACCOUNT_UNAVAILABLE');
    await s.api.post('/api/accounts/acc-03/connect');
  });

  it('消息分页：游标翻页不重不漏（翻页期间有新消息写入）', async () => {
    for (let i = 0; i < 12; i++) {
      await s.gwc.call('POST', `/_control/groups/${group.gatewayGroupId}/external-message`, { platformUserId: 'pu_ext', text: `page-${i}` });
    }
    await waitFor(async () => (await messages(s.api, group.id)).filter((m) => m.text.startsWith('page-')).length === 12, 5000, 'inbound');
    const seen: string[] = [];
    let cursor: string | null = null;
    let first = true;
    do {
      const r: { body: { items: any[]; nextCursor: string | null } } = await s.api.get(`/api/groups/${group.id}/messages?limit=5${cursor ? `&before=${cursor}` : ''}`);
      seen.push(...r.body.items.map((m: any) => m.id));
      cursor = r.body.nextCursor;
      if (first) {
        first = false;
        await s.gwc.call('POST', `/_control/groups/${group.gatewayGroupId}/external-message`, { platformUserId: 'pu_ext', text: 'late-new' });
        await new Promise((r) => setTimeout(r, 300));
      }
    } while (cursor);
    const all = await messages(s.api, group.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(all.length - 1); // 只少了翻页开始后才写入的那条
  });

  it('leave-all：非群主先退，群主最后退，完成后 left 且 members=[]', async () => {
    const r = await s.api.post(`/api/groups/${group.id}/leave-all`);
    expect(r.status).toBe(202);
    const job = await waitJob(s.api, r.body.jobId);
    expect(job).toMatchObject({ status: 'finished', errors: [] });
    const g = (await s.api.get(`/api/groups/${group.id}`)).body;
    expect(g.status).toBe('left');
    expect(g.members).toEqual([]);
    const leaves = await s.gwc.call<any[]>('GET', `/_control/requests?endpoint=leave&groupId=${group.gatewayGroupId}`);
    expect(leaves[leaves.length - 1].body.accountId).toBe('acc-01');
  });
});
