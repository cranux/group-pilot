import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectAll, createGroup, openWs, startStack, waitFor, waitJob, type Stack } from './harness.js';

let s: Stack;

beforeAll(async () => {
  s = await startStack({ config: { joinTimeoutMs: 1_500 } });
  await s.api.login();
  await connectAll(s.api, ['acc-01', 'acc-02', 'acc-03', 'acc-04', 'acc-05']);
});

beforeEach(async () => {
  await s.gwc.call('DELETE', '/_control/faults');
  await s.gwc.call('DELETE', '/_control/requests');
});

afterAll(async () => {
  await s?.close();
});

async function startCreate(members: string[], creator = 'acc-01') {
  const r = await s.api.post('/api/groups', { creatorAccountId: creator, memberAccountIds: members });
  expect(r.status).toBe(202);
  return waitJob(s.api, r.body.jobId);
}

describe('B2 建群异常路径', () => {
  it('INVITE_NOT_READY → 等 readyAfterMs 后重试', async () => {
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'join', match: { accountId: 'acc-02' }, status: 409, body: { code: 'INVITE_NOT_READY' } });
    const job = await startCreate(['acc-02']);
    expect(job).toMatchObject({ status: 'finished', errors: [] });
    expect((await s.gwc.call<any[]>('GET', '/_control/requests?endpoint=join&accountId=acc-02')).length).toBe(2);
  });

  it('INVITE_EXPIRED → 重新申请链接后重试一次', async () => {
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'join', match: { accountId: 'acc-03' }, status: 410, body: { code: 'INVITE_EXPIRED' } });
    const job = await startCreate(['acc-02', 'acc-03']);
    expect(job).toMatchObject({ status: 'finished', errors: [] });
    expect((await s.gwc.call<any[]>('GET', '/_control/requests?endpoint=invite')).length).toBe(2);
  });

  it('连续两次 INVITE_EXPIRED → 该成员失败，群和账号状态不变', async () => {
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'join', match: { accountId: 'acc-03' }, status: 410, body: { code: 'INVITE_EXPIRED' }, times: 2 });
    const job = await startCreate(['acc-02', 'acc-03']);
    expect(job.status).toBe('failed');
    expect(job.errors).toEqual([{ step: 'join:acc-03', code: 'INVITE_EXPIRED' }]);
    const g = (await s.api.get(`/api/groups/${job.groupId}`)).body;
    expect(g.status).toBe('active');
    const accounts = (await s.api.get('/api/accounts')).body;
    expect(accounts.find((a: any) => a.id === 'acc-03').status).toBe('online');
  });

  it('ALREADY_MEMBER → 视为成功，直接 promote；promote 调用总数 ≤ 2', async () => {
    // join 实际被处理了，但响应是 ALREADY_MEMBER；promote 可能先撞上 NOT_MEMBER_YET
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'join', match: { accountId: 'acc-02' }, status: 409, body: { code: 'ALREADY_MEMBER' }, apply: true });
    const job = await startCreate(['acc-02', 'acc-03']);
    expect(job).toMatchObject({ status: 'finished', errors: [] });
    const promotes = await s.gwc.call<any[]>('GET', '/_control/requests?endpoint=promote');
    expect(promotes.length).toBeLessThanOrEqual(2);
    const g = (await s.api.get(`/api/groups/${job.groupId}`)).body;
    expect(g.members.find((m: any) => m.accountId === 'acc-02').role).toBe('admin');
  });

  it('member_joined 超过时限未到 → job failed，errors[].code = JOIN_TIMEOUT', async () => {
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'join', match: { accountId: 'acc-03' }, status: 202, body: { accepted: true } });
    const job = await startCreate(['acc-02', 'acc-03']);
    expect(job.status).toBe('failed');
    expect(job.errors).toEqual([{ step: 'join:acc-03', code: 'JOIN_TIMEOUT' }]);
    const g = (await s.api.get(`/api/groups/${job.groupId}`)).body;
    expect(g.members.map((m: any) => m.accountId).sort()).toEqual(['acc-01', 'acc-02']);
  });

  it('建群 job 进行中重启 → 从断点继续完成', async () => {
    await s.gwc.call('PATCH', '/_control/config', { timing: { joinDelayMs: [600, 600] } });
    const r = await s.api.post('/api/groups', { creatorAccountId: 'acc-01', memberAccountIds: ['acc-02', 'acc-03'] });
    await new Promise((res) => setTimeout(res, 300));
    await s.restart();
    const job = await waitJob(s.api, r.body.jobId, 20_000);
    expect(job).toMatchObject({ status: 'finished', errors: [] });
    expect((await s.gwc.call<any[]>('GET', '/_control/requests?endpoint=createGroup')).length).toBe(1);
    await s.gwc.call('PATCH', '/_control/config', { timing: { joinDelayMs: [20, 60] } });
  });
});

describe('B2 leave-all', () => {
  it('非群主退群失败 → 记入 errors，其余继续，群主不退；失败的账号在本地与网关都仍是成员', async () => {
    const group = await createGroup(s.api, 'acc-01', ['acc-02', 'acc-03', 'acc-04']);
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'leave', match: { accountId: 'acc-03' }, status: 500 });
    const r = await s.api.post(`/api/groups/${group.id}/leave-all`);
    const job = await waitJob(s.api, r.body.jobId);
    expect(job.status).toBe('failed');
    expect(job.errors).toEqual([{ step: 'leave:acc-03', code: 'INTERNAL_ERROR' }]);
    const g = (await s.api.get(`/api/groups/${group.id}`)).body;
    expect(g.status).toBe('active');
    expect(g.members.map((m: any) => m.accountId).sort()).toEqual(['acc-01', 'acc-03']);
    const gwMembers = await s.gwc.call<any[]>('GET', `/groups/${group.gatewayGroupId}/members`);
    expect(gwMembers.map((m) => m.platformUserId).sort()).toEqual(['pu_acc-01', 'pu_acc-03']);
    const leaves = await s.gwc.call<any[]>('GET', `/_control/requests?endpoint=leave&groupId=${group.gatewayGroupId}`);
    expect(leaves.some((x) => x.body.accountId === 'acc-01')).toBe(false);
  });
});

describe('B4 WebSocket 断线补齐', () => {
  it('重连带 sinceSeq：补发断线期间的事件，不重复，seq 单调', async () => {
    const group = await createGroup(s.api, 'acc-01', ['acc-05']);
    const first = openWs(s.url);
    first.ws.on('open', () => first.ws.send(JSON.stringify({ type: 'auth', accessToken: s.api.token })));
    const auth = await first.ready;
    expect(auth.success).toBe(true);
    await s.gwc.call('POST', `/_control/groups/${group.gatewayGroupId}/external-message`, { platformUserId: 'pu_x', text: 'before disconnect' });
    await waitFor(async () => first.frames.find((f) => f.type === 'message' && f.payload.item.text === 'before disconnect'), 3000);
    const lastSeq = first.frames[first.frames.length - 1].seq;
    first.ws.close();

    for (const t of ['gap-1', 'gap-2', 'gap-3']) {
      await s.gwc.call('POST', `/_control/groups/${group.gatewayGroupId}/external-message`, { platformUserId: 'pu_x', text: t });
    }
    await waitFor(async () => (await s.api.get(`/api/groups/${group.id}/messages`)).body.items.some((m: any) => m.text === 'gap-3'), 3000);

    const second = openWs(s.url);
    second.ws.on('open', () => second.ws.send(JSON.stringify({ type: 'auth', accessToken: s.api.token, sinceSeq: lastSeq })));
    await second.ready;
    await waitFor(async () => second.frames.some((f) => f.type === 'message' && f.payload.item.text === 'gap-3'), 3000);
    const seqs = second.frames.map((f) => f.seq);
    expect(seqs[0]).toBeGreaterThan(lastSeq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const texts = second.frames.filter((f) => f.type === 'message').map((f) => f.payload.item.text);
    expect(texts).toEqual(['gap-1', 'gap-2', 'gap-3']);
    second.ws.close();
  });

  it('无效 token 认证失败', async () => {
    const ws = openWs(s.url);
    ws.ws.on('open', () => ws.ws.send(JSON.stringify({ type: 'auth', accessToken: 'bogus' })));
    expect((await ws.ready).success).toBe(false);
  });
});
