import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAll, createGroup, sleep, startStack, waitFor, type Stack } from './harness.js';

let s: Stack;
let group: any;

const SEQ = {
  name: '发布提醒',
  steps: [
    { index: 1, accountRole: 'admin', text: '{event} 将于 {time} 开始，请提前准备', delaySeconds: 0.3 },
    { index: 2, accountRole: 'member', text: '提醒：{event} 的资料已上传到 {location}', delaySeconds: 0.3 },
    { index: 3, accountRole: 'member', text: '{event} 资料位置：{location}', delaySeconds: 0.3 },
  ],
};

async function createSequence(body: unknown = SEQ): Promise<string> {
  const r = await s.api.post('/api/sequences', body);
  expect(r.status).toBe(201);
  return r.body.id;
}

async function waitRun(runId: string, timeoutMs = 15_000) {
  return waitFor(async () => {
    const r = (await s.api.get(`/api/sequence-runs/${runId}`)).body;
    return r.status !== 'running' ? r : null;
  }, timeoutMs, `sequence run ${runId}`);
}

beforeAll(async () => {
  s = await startStack();
  await s.api.login();
  await connectAll(s.api, ['acc-01', 'acc-02', 'acc-03', 'acc-04']);
  group = await createGroup(s.api, 'acc-01', ['acc-02', 'acc-04', 'acc-03']);
});

afterAll(async () => {
  await s?.close();
});

describe('B1 定时序列', () => {
  it('S8：第 3 步有解析不了的占位符 → 422（stepIndex=3、key），网关收不到任何消息，之后可正常启动', async () => {
    const id = await createSequence();
    await s.gwc.call('DELETE', '/_control/requests');
    const bad = await s.api.post(`/api/groups/${group.id}/sequence-runs`, {
      sequenceId: id,
      vars: { event: '发布会', time: '10:00', location: '' },
      stepVars: { '2': { location: '共享盘' } },
    });
    // 第 2 步给了 location，第 3 步沿用 → 能解析；换一个只在第 3 步缺的序列
    expect(bad.status).toBe(201);
    await waitRun(bad.body.runId);

    const seq3 = await createSequence({
      name: 's8',
      steps: [
        { index: 1, accountRole: 'admin', text: 'a {event}', delaySeconds: 0 },
        { index: 2, accountRole: 'member', text: 'b {event}', delaySeconds: 0 },
        { index: 3, accountRole: 'member', text: 'c {missing_key}', delaySeconds: 0 },
      ],
    });
    await s.gwc.call('DELETE', '/_control/requests');
    const r = await s.api.post(`/api/groups/${group.id}/sequence-runs`, { sequenceId: seq3, vars: { event: 'x' }, stepVars: {} });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'UNRESOLVED_PLACEHOLDER', stepIndex: 3, key: 'missing_key' });
    await sleep(500);
    expect((await s.gwc.call<any[]>('GET', '/_control/requests?endpoint=send')).length).toBe(0);
    const g = (await s.api.get(`/api/groups/${group.id}`)).body;
    expect(g.activeSequenceRunId).toBeNull();
    // 之后可以正常启动
    const ok = await s.api.post(`/api/groups/${group.id}/sequence-runs`, { sequenceId: seq3, vars: { event: 'x' }, stepVars: { '3': { missing_key: 'y' } } });
    expect(ok.status).toBe(201);
    await waitRun(ok.body.runId);
  });

  it('取值规则与 varSources：stepVars 从该步起生效，"" 表示不改；vars 里的 "" 视为未提供', async () => {
    const id = await createSequence();
    const r = await s.api.post(`/api/groups/${group.id}/sequence-runs/preflight`, {
      sequenceId: id,
      vars: { event: '发布会', time: '10:00', location: '' },
      stepVars: { '2': { location: '共享盘/第二季度', event: '' }, '3': { event: '复盘会' } },
    });
    expect(r.status).toBe(200);
    expect(r.body.steps.map((x: any) => [x.resolvedVars, x.varSources])).toEqual([
      [{ event: '发布会', time: '10:00' }, { event: 'default', time: 'default' }],
      [{ event: '发布会', location: '共享盘/第二季度' }, { event: 'default', location: 'step:2' }],
      [{ event: '复盘会', location: '共享盘/第二季度' }, { event: 'step:3', location: 'step:2' }],
    ]);
    // vars 里 location 是 "" → 第 2 步之前没有 location；不给 stepVars 就解析不了
    const bad = await s.api.post(`/api/groups/${group.id}/sequence-runs/preflight`, {
      sequenceId: id,
      vars: { event: 'e', time: 't', location: '' },
      stepVars: {},
    });
    expect(bad.body.error).toMatchObject({ code: 'UNRESOLVED_PLACEHOLDER', stepIndex: 2, key: 'location' });
  });

  it('S7：并发两次启动，恰好一个 201、一个 409 SEQUENCE_ALREADY_RUNNING', async () => {
    const id = await createSequence({
      name: 'slow',
      steps: [{ index: 1, accountRole: 'admin', text: 'slow', delaySeconds: 2 }],
    });
    const body = { sequenceId: id, vars: {}, stepVars: {} };
    const results = await Promise.all([
      s.api.post(`/api/groups/${group.id}/sequence-runs`, body),
      s.api.post(`/api/groups/${group.id}/sequence-runs`, body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('SEQUENCE_ALREADY_RUNNING');
    const runId = results.find((r) => r.status === 201)!.body.runId;
    expect((await s.api.get(`/api/groups/${group.id}`)).body.activeSequenceRunId).toBe(runId);
    await waitRun(runId);
  });

  it('排期与账号选择：admin 步由管理员发，member 步按 accountId 字典序取第一个 online member；第 n 步在第 n-1 步发出后 delaySeconds 发送', async () => {
    const id = await createSequence();
    const r = await s.api.post(`/api/groups/${group.id}/sequence-runs`, {
      sequenceId: id,
      vars: { event: '发布会', time: '10:00' },
      stepVars: { '2': { location: '共享盘' } },
    });
    const run = await waitRun(r.body.runId);
    expect(run.status).toBe('finished');
    expect(run.steps.map((x: any) => [x.status, x.accountId])).toEqual([
      ['sent', 'acc-02'],
      ['sent', 'acc-03'],
      ['sent', 'acc-03'],
    ]);
    for (let i = 1; i < run.steps.length; i++) {
      const gap = new Date(run.steps[i].scheduledAt).getTime() - new Date(run.steps[i - 1].sentAt).getTime();
      expect(gap).toBeGreaterThanOrEqual(299);
      expect(gap).toBeLessThan(400);
    }
    expect(run.steps.every((x: any) => x.clientMsgId)).toBe(true);
    const landed = await s.gwc.call<any[]>('GET', `/_control/messages?groupId=${group.gatewayGroupId}`);
    expect(landed.some((m) => m.text === '提醒：发布会 的资料已上传到 共享盘')).toBe(true);
  });

  it('限流的账号不算没有：该步顺延到限流结束后发', async () => {
    await s.gwc.call('POST', '/_control/faults', {
      endpoint: 'send',
      match: { accountId: 'acc-02' },
      status: 429,
      body: { code: 'RATE_LIMITED', retryAfterSeconds: 1 },
    });
    const id = await createSequence({ name: 'rl', steps: [{ index: 1, accountRole: 'admin', text: 'admin after rl', delaySeconds: 0 }] });
    const r = await s.api.post(`/api/groups/${group.id}/sequence-runs`, { sequenceId: id, vars: {}, stepVars: {} });
    const run = await waitRun(r.body.runId);
    expect(run.steps[0]).toMatchObject({ status: 'sent', accountId: 'acc-02' });
  });

  it('没有匹配账号 → 该步 skipped（有时间戳），进度照常推进', async () => {
    // acc-03、acc-04 是 member：把它们都标为离线
    await s.api.post('/api/accounts/acc-03/transition', { to: 'disconnected', expectedFrom: 'online' });
    await s.api.post('/api/accounts/acc-04/transition', { to: 'disconnected', expectedFrom: 'online' });
    const id = await createSequence({
      name: 'skip',
      steps: [
        { index: 1, accountRole: 'member', text: 'nobody', delaySeconds: 0 },
        { index: 2, accountRole: 'admin', text: 'admin speaks', delaySeconds: 0.2 },
      ],
    });
    const r = await s.api.post(`/api/groups/${group.id}/sequence-runs`, { sequenceId: id, vars: {}, stepVars: {} });
    const run = await waitRun(r.body.runId);
    expect(run.status).toBe('finished');
    expect(run.steps[0].status).toBe('skipped');
    expect(run.steps[0].skippedAt).toBeTruthy();
    expect(run.steps[1].status).toBe('sent');
    await s.api.post('/api/accounts/acc-03/connect');
    await s.api.post('/api/accounts/acc-04/connect');
  });

  it('重启后只重排最早一个已过期的步骤，后续仍按「前一步发出后」排期', async () => {
    const id = await createSequence({
      name: 'restart',
      steps: [
        { index: 1, accountRole: 'admin', text: 'r1', delaySeconds: 0.5 },
        { index: 2, accountRole: 'admin', text: 'r2', delaySeconds: 0.5 },
        { index: 3, accountRole: 'admin', text: 'r3', delaySeconds: 0.5 },
      ],
    });
    const r = await s.api.post(`/api/groups/${group.id}/sequence-runs`, { sequenceId: id, vars: {}, stepVars: {} });
    // 停机 2 秒：第 1 步在停机期间过期
    await s.restart({ downMs: 2000 });
    const restartedAt = Date.now();
    const run = await waitRun(r.body.runId);
    expect(run.status).toBe('finished');
    const sent = run.steps.map((x: any) => new Date(x.sentAt).getTime());
    expect(sent[0]).toBeGreaterThanOrEqual(restartedAt + 400);
    expect(sent[1] - sent[0]).toBeGreaterThanOrEqual(450);
    expect(sent[2] - sent[1]).toBeGreaterThanOrEqual(450);
  });

  it('群变 unreachable → 序列运行 stopped', async () => {
    const id = await createSequence({
      name: 'stop',
      steps: [
        { index: 1, accountRole: 'admin', text: 'will be forbidden', delaySeconds: 0 },
        { index: 2, accountRole: 'admin', text: 'never', delaySeconds: 0 },
      ],
    });
    await s.gwc.call('POST', `/_control/groups/${group.gatewayGroupId}/forbid`, { mode: 'sync' });
    const r = await s.api.post(`/api/groups/${group.id}/sequence-runs`, { sequenceId: id, vars: {}, stepVars: {} });
    const run = await waitRun(r.body.runId);
    expect(run.status).toBe('stopped');
    expect(run.steps[0]).toMatchObject({ status: 'failed' });
  });
});
