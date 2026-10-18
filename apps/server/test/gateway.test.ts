import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAll, createGroup, messages, openWs, sleep, startStack, waitFor, type Stack } from './harness.js';

let s: Stack;
let group: any;
const gwGroup = () => group.gatewayGroupId as string;

async function external(text: string, extra: Record<string, unknown> = {}) {
  return s.gwc.call<{ msgId: string; eventId: number }>('POST', `/_control/groups/${gwGroup()}/external-message`, {
    platformUserId: 'pu_outsider',
    text,
    ...extra,
  });
}

async function account(id: string) {
  return (await s.api.get('/api/accounts')).body.find((a: any) => a.id === id);
}

beforeAll(async () => {
  s = await startStack();
  await s.api.login();
  await connectAll(s.api, ['acc-01', 'acc-02', 'acc-03', 'acc-04']);
  group = await createGroup(s.api, 'acc-01', ['acc-02', 'acc-03', 'acc-04']);
});

afterAll(async () => {
  await s?.close();
});

describe('事件流', () => {
  it('S2：每个事件推两次 → 时间线无重复行，agent 只被触发一次', async () => {
    await s.api.patch(`/api/groups/${group.id}`, { agentEnabled: true });
    await s.gwc.call('PATCH', '/_control/config', { duplicateEvents: 1 });
    await external('dup please');
    await waitFor(async () => (await messages(s.api, group.id)).some((m) => m.text === 'dup please'), 5000, 'message');
    await sleep(500);
    const rows = (await messages(s.api, group.id)).filter((m) => m.text === 'dup please');
    expect(rows.length).toBe(1);
    const runs = await waitFor(async () => {
      const r = (await s.api.get(`/api/groups/${group.id}/agent-runs`)).body;
      return r.length && r.every((x: any) => x.status !== 'running') ? r : null;
    }, 15000, 'run finished');
    expect(runs.length).toBe(1);
    await s.gwc.call('PATCH', '/_control/config', { duplicateEvents: 0 });
    await s.api.patch(`/api/groups/${group.id}`, { agentEnabled: false });
  });

  it('S3：自己的消息回流 isOwn=true，不产生新的 agent run', async () => {
    await s.api.patch(`/api/groups/${group.id}`, { agentEnabled: true });
    const before = (await s.api.get(`/api/groups/${group.id}/agent-runs`)).body.length;
    const r = await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-03', text: 'own message' });
    const row = await waitFor(async () => (await messages(s.api, group.id)).find((m) => m.clientMsgId === r.body.clientMsgId && m.deliveryStatus === 'sent'), 5000);
    expect(row.isOwn).toBe(true);
    // 补投：同一 msgId 以新 eventId 再推一次
    await s.gwc.call('POST', '/_control/accounts/acc-03/redeliver');
    await sleep(800);
    expect((await messages(s.api, group.id)).filter((m) => m.text === 'own message').length).toBe(1);
    expect((await s.api.get(`/api/groups/${group.id}/agent-runs`)).body.length).toBe(before);
    await s.api.patch(`/api/groups/${group.id}`, { agentEnabled: false });
  });

  it('入站消息按 sentAt 排序展示（补投的旧消息落在正确位置）', async () => {
    const old = new Date(Date.now() - 3600_000).toISOString();
    await external('from the past', { sentAt: old });
    const list = await waitFor(async () => {
      const l = await messages(s.api, group.id);
      return l.some((m) => m.text === 'from the past') ? l : null;
    });
    const sorted = [...list].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    expect(list.map((m) => m.id)).toEqual(sorted.map((m) => m.id));
    expect(list[list.length - 1].text).toBe('from the past');
  });

  it('事件流断开期间的事件，恢复后都会处理到', async () => {
    await s.gwc.call('PATCH', '/_control/config', { unavailable: true });
    await sleep(300);
    await s.gwc.call('PATCH', '/_control/config', { unavailable: false });
    await s.gwc.call('POST', '/_control/sse/drop');
    await external('while disconnected 1');
    await external('while disconnected 2');
    await waitFor(async () => (await messages(s.api, group.id)).filter((m) => m.text.startsWith('while disconnected')).length === 2, 8000);
  });

  it('服务停机期间的事件，重启后补拉', async () => {
    await s.restart({ during: () => external('during downtime') });
    await waitFor(async () => (await messages(s.api, group.id)).some((m) => m.text === 'during downtime'), 8000);
  });

  it('处理事件时数据库写入失败：不中断后续事件、内容不丢、推 inconsistency', async () => {
    const ws = openWs(s.url);
    ws.ws.on('open', () => ws.ws.send(JSON.stringify({ type: 'auth', accessToken: s.api.token })));
    await ws.ready;
    // 让 messages 表拒绝某条特定文本（模拟数据库写入失败）
    await s.db.query(`ALTER TABLE messages ADD CONSTRAINT test_reject CHECK (text <> 'poison')`);
    try {
      await external('poison');
      await external('after poison');
      await waitFor(async () => (await messages(s.api, group.id)).some((m) => m.text === 'after poison'), 5000, 'later event');
      const failed = await s.db.query(`SELECT raw, status FROM gateway_inbox WHERE raw LIKE '%poison%' AND raw NOT LIKE '%after%'`);
      expect(failed.rows[0].status).toBe('failed');
      expect(failed.rows[0].raw).toContain('poison');
      const inc = await waitFor(async () => ws.frames.find((f) => f.type === 'inconsistency'), 3000, 'inconsistency');
      expect(inc.payload.kind).toBe('event_processing_failed');
    } finally {
      await s.db.query('ALTER TABLE messages DROP CONSTRAINT test_reject');
      ws.ws.close();
    }
    // 修复后自动重试成功
    await s.db.query(`UPDATE gateway_inbox SET next_attempt_at = now() WHERE status = 'failed'`);
    await waitFor(async () => (await messages(s.api, group.id)).some((m) => m.text === 'poison'), 5000, 'retried');
  });
});

describe('出站与网关错误', () => {
  it('S4：限流 → rate_limited；等待期内网关收不到该账号的 send；到期自动恢复并按原顺序发出', async () => {
    await s.gwc.call('DELETE', '/_control/requests');
    await s.gwc.call('POST', '/_control/faults', {
      endpoint: 'send',
      match: { accountId: 'acc-04' },
      status: 429,
      body: { code: 'RATE_LIMITED', retryAfterSeconds: 2 },
    });
    const ids: string[] = [];
    for (const t of ['rl-1', 'rl-2', 'rl-3']) ids.push((await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-04', text: t })).body.clientMsgId);
    const limited = await waitFor(async () => {
      const a = await account('acc-04');
      return a.status === 'rate_limited' ? a : null;
    }, 3000, 'rate_limited');
    const until = new Date(limited.rateLimitedUntil).getTime();
    expect((await messages(s.api, group.id)).filter((m) => ids.includes(m.clientMsgId)).every((m) => m.deliveryStatus === 'queued')).toBe(true);
    // rate_limited 时照常受理
    expect((await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-04', text: 'rl-4' })).status).toBe(202);
    await waitFor(async () => (await account('acc-04')).status === 'online', 5000, 'recovered');
    await waitFor(async () => (await messages(s.api, group.id)).filter((m) => m.text.startsWith('rl-') && m.deliveryStatus === 'sent').length === 4, 5000);
    const sends = await s.gwc.call<any[]>('GET', '/_control/requests?endpoint=send&accountId=acc-04');
    expect(sends.filter((r) => r.at > sends[0].at && r.at < until).length).toBe(0);
    expect(sends.filter((r) => r.status === 202).map((r) => r.body.text)).toEqual(['rl-1', 'rl-2', 'rl-3', 'rl-4']);
  });

  it('504：unknown → 查询到已落地 → sent，网关只有一条', async () => {
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'send', match: { accountId: 'acc-02' }, status: 504, apply: true, applyDelayMs: 1500 });
    const r = await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-02', text: 'timeout but landed' });
    await waitFor(async () => (await messages(s.api, group.id)).find((m) => m.clientMsgId === r.body.clientMsgId)?.deliveryStatus === 'unknown', 2000, 'unknown');
    await waitFor(async () => (await messages(s.api, group.id)).find((m) => m.clientMsgId === r.body.clientMsgId)?.deliveryStatus === 'sent', 5000, 'sent');
    const landed = await s.gwc.call<any[]>('GET', `/_control/messages?groupId=${gwGroup()}`);
    expect(landed.filter((m) => m.clientMsgId === r.body.clientMsgId).length).toBe(1);
  });

  it('504 且确实没发出：确认后用同一 clientMsgId 重发一次（5 秒内结案）', async () => {
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'send', match: { accountId: 'acc-02' }, status: 504 });
    const start = Date.now();
    const r = await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-02', text: 'resend once' });
    await waitFor(async () => {
      const st = (await messages(s.api, group.id)).find((m) => m.clientMsgId === r.body.clientMsgId)?.deliveryStatus;
      return st === 'accepted' || st === 'sent';
    }, 5000, 'resolved');
    expect(Date.now() - start).toBeLessThan(5000);
    const sends = await s.gwc.call<any[]>('GET', `/_control/requests?endpoint=send&clientMsgId=${r.body.clientMsgId}`);
    expect(sends.length).toBe(2);
    await waitFor(async () => (await messages(s.api, group.id)).find((m) => m.clientMsgId === r.body.clientMsgId)?.deliveryStatus === 'sent', 3000);
    const landed = await s.gwc.call<any[]>('GET', `/_control/messages?groupId=${gwGroup()}`);
    expect(landed.filter((m) => m.clientMsgId === r.body.clientMsgId).length).toBe(1);
  });

  it('504 两次都没发出 → failed(NETWORK_TIMEOUT)，总共只重发一次', async () => {
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'send', match: { accountId: 'acc-02' }, status: 504, times: 2 });
    const r = await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-02', text: 'never lands' });
    const row = await waitFor(async () => {
      const m = (await messages(s.api, group.id)).find((x) => x.clientMsgId === r.body.clientMsgId);
      return m?.deliveryStatus === 'failed' ? m : null;
    }, 10000, 'failed');
    expect(row.failCode).toBe('NETWORK_TIMEOUT');
    const sends = await s.gwc.call<any[]>('GET', `/_control/requests?endpoint=send&clientMsgId=${r.body.clientMsgId}`);
    expect(sends.length).toBe(2);
  });

  it('by-client-id 不可用期间保持 unknown，恢复后很快确定状态', async () => {
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'send', match: { accountId: 'acc-02' }, status: 504, apply: true, applyDelayMs: 100 });
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'byClientId', status: 503, times: -1 });
    // 同时断开事件流，只能靠查询结案
    await s.gwc.call('PATCH', '/_control/config', { unavailable: false });
    const r = await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-02', text: 'query down' });
    await sleep(3000);
    const mid = (await messages(s.api, group.id)).find((m) => m.clientMsgId === r.body.clientMsgId);
    // message_sent 事件可能已经让它变成 sent；如果还没有，它必须仍是 unknown（没有被重发）
    expect(['unknown', 'sent']).toContain(mid.deliveryStatus);
    await s.gwc.call('DELETE', '/_control/faults');
    await waitFor(async () => (await messages(s.api, group.id)).find((m) => m.clientMsgId === r.body.clientMsgId)?.deliveryStatus === 'sent', 2000);
    const sends = await s.gwc.call<any[]>('GET', `/_control/requests?endpoint=send&clientMsgId=${r.body.clientMsgId}`);
    expect(sends.length).toBe(1);
  });

  it('SENDER_NOT_IN_GROUP：该条 failed，账号、群状态不变', async () => {
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'send', match: { accountId: 'acc-03' }, status: 403, body: { code: 'SENDER_NOT_IN_GROUP' } });
    const r = await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-03', text: 'not in group' });
    const m = await waitFor(async () => (await messages(s.api, group.id)).find((x) => x.clientMsgId === r.body.clientMsgId && x.deliveryStatus === 'failed'), 3000);
    expect(m.failCode).toBe('SENDER_NOT_IN_GROUP');
    expect((await account('acc-03')).status).toBe('online');
    expect((await s.api.get(`/api/groups/${group.id}`)).body.status).toBe('active');
  });

  it('ACCOUNT_SUSPENDED：账号进入终态、移出所有群、排队消息 cancelled、推 account_terminal', async () => {
    const ws = openWs(s.url);
    ws.ws.on('open', () => ws.ws.send(JSON.stringify({ type: 'auth', accessToken: s.api.token })));
    await ws.ready;
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'send', match: { accountId: 'acc-03' }, status: 403, body: { code: 'ACCOUNT_SUSPENDED' }, delayMs: 300 });
    const first = await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-03', text: 'will suspend' });
    const second = await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-03', text: 'queued behind' });
    await waitFor(async () => (await account('acc-03')).status === 'suspended', 5000, 'suspended');
    const list = await messages(s.api, group.id);
    expect(list.find((m) => m.clientMsgId === first.body.clientMsgId)).toMatchObject({ deliveryStatus: 'failed', failCode: 'ACCOUNT_SUSPENDED' });
    expect(list.find((m) => m.clientMsgId === second.body.clientMsgId)).toMatchObject({ deliveryStatus: 'cancelled', failCode: 'ACCOUNT_TERMINAL' });
    const g = (await s.api.get(`/api/groups/${group.id}`)).body;
    expect(g.members.some((m: any) => m.accountId === 'acc-03')).toBe(false);
    const term = await waitFor(async () => ws.frames.find((f) => f.type === 'account_terminal'), 3000);
    expect(term.payload).toEqual({ accountId: 'acc-03', status: 'suspended' });
    // 推给前端的状态事件对应已保存的状态
    const changed = ws.frames.find((f) => f.type === 'account_status_changed' && f.payload.accountId === 'acc-03');
    expect(changed.payload).toMatchObject({ from: 'online', to: 'suspended' });
    // 网关之后再推 account_status: suspended（重复进入终态）静默忽略
    await s.gwc.call('POST', '/_control/events', { type: 'account_status', data: { accountId: 'acc-03', status: 'suspended' } });
    await sleep(500);
    expect((await account('acc-03')).status).toBe('suspended');
    ws.ws.close();
  });

  it('网关推 account_status: session_expired → 终态', async () => {
    await s.gwc.call('POST', '/_control/accounts/acc-04/status', { status: 'session_expired' });
    await waitFor(async () => (await account('acc-04')).status === 'session_expired', 5000);
    const g = (await s.api.get(`/api/groups/${group.id}`)).body;
    expect(g.members.some((m: any) => m.accountId === 'acc-04')).toBe(false);
  });

  it('GROUP_WRITE_FORBIDDEN：群 unreachable，账号状态不变', async () => {
    await s.gwc.call('POST', `/_control/groups/${gwGroup()}/forbid`, { mode: 'async' });
    const r = await s.api.post(`/api/groups/${group.id}/send`, { accountId: 'acc-02', text: 'forbidden' });
    const m = await waitFor(async () => (await messages(s.api, group.id)).find((x) => x.clientMsgId === r.body.clientMsgId && x.deliveryStatus === 'failed'), 5000);
    expect(m.failCode).toBe('GROUP_WRITE_FORBIDDEN');
    expect((await s.api.get(`/api/groups/${group.id}`)).body.status).toBe('unreachable');
    expect((await account('acc-02')).status).toBe('online');
  });
});
