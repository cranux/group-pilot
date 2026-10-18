import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectAll, createGroup, messages, sleep, startStack, waitFor, type Stack } from './harness.js';

let s: Stack;
let group: any;

async function external(text: string, platformUserId = 'pu_alice') {
  return s.gwc.call('POST', `/_control/groups/${group.gatewayGroupId}/external-message`, { platformUserId, text });
}

async function runs(): Promise<any[]> {
  return (await s.api.get(`/api/groups/${group.id}/agent-runs`)).body;
}

async function waitRunDone(countBefore: number, timeoutMs = 20_000): Promise<any> {
  const list = await waitFor(async () => {
    const r = await runs();
    return r.length > countBefore && r[0].status !== 'running' ? r : null;
  }, timeoutMs, 'agent run to finish');
  return (await s.api.get(`/api/agent-runs/${list[0].id}`)).body;
}

async function script(responses: unknown[]) {
  await s.agentc.call('POST', '/_control/turn-script', { responses });
}

beforeAll(async () => {
  s = await startStack({ config: { agentTurnTimeoutMs: 1_500, agentAuditTimeoutMs: 500 } });
  await s.api.login();
  await connectAll(s.api, ['acc-01', 'acc-02', 'acc-03']);
  group = await createGroup(s.api, 'acc-01', ['acc-02', 'acc-03']);
  await s.api.patch(`/api/groups/${group.id}`, { agentEnabled: true });
});

beforeEach(async () => {
  await s.agentc.call('POST', '/_control/reset');
  await s.gwc.call('DELETE', '/_control/faults');
});

afterAll(async () => {
  await s?.close();
});

describe('A5 Agent 接入', () => {
  it('默认流程：get_recent_messages → send_message → finish；步骤可见，回复 isOwn', async () => {
    const before = (await runs()).length;
    await external('你好，机器人');
    const run = await waitRunDone(before);
    expect(run).toMatchObject({ status: 'finished', endReason: 'final' });
    expect(run.triggerMessages[0].text).toBe('你好，机器人');
    expect(run.steps.map((x: any) => [x.kind, x.name])).toEqual([
      ['tool_use', 'get_recent_messages'],
      ['tool_use', 'send_message'],
      ['final', 'finish'],
    ]);
    expect(run.steps[1].auditVerdict).toBe('pass');
    expect(run.steps.every((x: any) => typeof x.rawResponse === 'string' && x.rawResponse.length > 0)).toBe(true);
    const reply = (await messages(s.api, group.id)).find((m) => m.text.startsWith('[bot]'));
    expect(reply).toMatchObject({ isOwn: true, deliveryStatus: 'sent', source: 'agent' });
    // 工具定义恰好 4 个，且服务端用同一个 runId
    const turns = await s.agentc.call<any[]>('GET', `/_control/requests?kind=turn&runId=${run.id}`);
    expect(turns.length).toBe(3);
    expect(turns[0].body.tools.map((t: any) => t.name).sort()).toEqual(['finish', 'get_recent_messages', 'kick_user', 'send_message']);
  });

  it('同一群同一时刻至多一个 running；期间到达的消息在 run 结束后合并成下一个 run', async () => {
    const before = (await runs()).length;
    await s.agentc.call('PATCH', '/_control/config', { defaultDelayMs: 400 });
    await external('first');
    await waitFor(async () => (await runs()).length > before, 5000);
    await external('second');
    await external('third');
    const all = await waitFor(async () => {
      const r = await runs();
      return r.length >= before + 2 && r.every((x) => x.status !== 'running') ? r : null;
    }, 30000);
    expect(all.length).toBe(before + 2);
    const latest = (await s.api.get(`/api/agent-runs/${all[0].id}`)).body;
    expect(latest.triggerMessages.map((m: any) => m.text)).toEqual(['second', 'third']);
    const running = await s.db.query(`SELECT count(*)::int AS n FROM agent_runs WHERE group_id = $1 AND status = 'running'`, [group.id]);
    expect(running.rows[0].n).toBe(0);
  });

  it('S5：send 504、1.5s 后落地；Agent 用同一个 key 再调一次 → 网关恰好一条，第二次不审计，run 正常结束', async () => {
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'send', status: 504, apply: true, applyDelayMs: 1500 });
    await script([
      { toolUse: { name: 'send_message', input: { text: 'S5 message', idempotency_key: 'k-s5' } } },
      { toolUse: { name: 'send_message', input: { text: 'S5 message', idempotency_key: 'k-s5' } } },
      { toolUse: { name: 'finish', input: { summary: 'S5 done' } } },
    ]);
    const before = (await runs()).length;
    await external('trigger S5');
    const run = await waitRunDone(before);
    expect(run).toMatchObject({ status: 'finished', endReason: 'final', summary: 'S5 done' });
    const landed = await s.gwc.call<any[]>('GET', `/_control/messages?groupId=${group.gatewayGroupId}`);
    expect(landed.filter((m) => m.text === 'S5 message').length).toBe(1);
    const [first, second] = run.steps;
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(second.resultSummary).toContain('"deliveryStatus":"sent"');
    expect(second.auditVerdict).toBeNull();
    const audits = await s.agentc.call<any[]>('GET', `/_control/requests?kind=audit&runId=${run.id}`);
    const allAudits = await s.agentc.call<any[]>('GET', '/_control/requests?kind=audit');
    expect((audits.length || allAudits.length)).toBe(1);
  });

  it('S6：坏 JSON → 未知工具 → 正常结束；每一步都有 kind 和 rawResponse', async () => {
    await script([
      { body: '```json\n{"stop_reason":"tool_use","content":[]}\n```' },
      { toolUse: { name: 'delete_group', input: {} } },
      { toolUse: { name: 'finish', input: { summary: 'S6 done' } } },
    ]);
    const before = (await runs()).length;
    await external('trigger S6');
    const run = await waitRunDone(before);
    expect(['final', 'budget_exhausted', 'protocol_errors']).toContain(run.endReason);
    expect(run.endReason).toBe('final');
    expect(run.steps.map((x: any) => [x.kind, x.errorCode])).toEqual([
      ['protocol_error', 'BAD_JSON'],
      ['tool_use', 'UNKNOWN_TOOL'],
      ['final', null],
    ]);
    expect(run.steps[0]).toMatchObject({ toolUseId: null, name: null, input: null, isError: true });
    expect(run.steps[0].rawResponse).toContain('```json');
    for (const step of run.steps) expect(step.rawResponse).toBeTruthy();
    // 协议错误不追加 assistant 块，改为 PROTOCOL_ERROR 文本；未知工具追加 assistant + is_error 的 tool_result
    const turns = await s.agentc.call<any[]>('GET', `/_control/requests?kind=turn&runId=${run.id}`);
    const second = turns[1].body.messages;
    expect(second[second.length - 1].content[0].text).toMatch(/^PROTOCOL_ERROR BAD_JSON: /);
    const third = turns[2].body.messages;
    expect(third[third.length - 2].role).toBe('assistant');
    expect(third[third.length - 1].content[0]).toMatchObject({ type: 'tool_result', is_error: true });
    expect(JSON.parse(third[third.length - 1].content[0].content).code).toBe('UNKNOWN_TOOL');
  });

  it('连续 3 次协议错误 → failed / protocol_errors；合法响应会清零计数', async () => {
    await script([
      { body: 'not json' },
      { body: 'Sure! {"stop_reason":"end_turn","content":[{"type":"text","text":"x"}]}' },
      { toolUse: { name: 'get_recent_messages', input: { limit: 5 } } },
      { body: 'still not json' },
      { json: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'mismatch' }] } },
      { toolUse: { name: 'get_recent_messages', input: { limit: 'ten' } } },
    ]);
    const before = (await runs()).length;
    await external('trigger protocol errors');
    const run = await waitRunDone(before);
    expect(run).toMatchObject({ status: 'failed', endReason: 'protocol_errors' });
    expect(run.steps.map((x: any) => x.errorCode)).toEqual([
      'BAD_JSON',
      'BAD_JSON',
      null,
      'BAD_JSON',
      'BAD_JSON',
      'INVALID_INPUT',
    ]);
  });

  it('重复的 tool_use.id → DUPLICATE_TOOL_USE_ID；limit 超过 50 按 50 处理', async () => {
    await script([
      { toolUse: { name: 'get_recent_messages', input: { limit: 100000 }, id: 'tu_same' } },
      { toolUse: { name: 'get_recent_messages', input: { limit: 3 }, id: 'tu_same' } },
      { endTurn: 'bye' },
    ]);
    const before = (await runs()).length;
    await external('trigger dup id');
    const run = await waitRunDone(before);
    expect(run.steps.map((x: any) => x.errorCode)).toEqual([null, 'DUPLICATE_TOOL_USE_ID', null]);
    expect(run).toMatchObject({ endReason: 'final', summary: 'bye' });
    const turns = await s.agentc.call<any[]>('GET', `/_control/requests?kind=turn&runId=${run.id}`);
    const toolResult = JSON.parse(turns[1].body.messages[2].content[0].content);
    expect(toolResult.messages.length).toBeLessThanOrEqual(50);
    // end_turn 的文本不发到群里
    expect((await messages(s.api, group.id)).some((m) => m.text === 'bye')).toBe(false);
  });

  it('一直调工具不结束 → 12 步内结束（重复调用会被提示并拒绝）', async () => {
    await script(Array.from({ length: 14 }, () => ({ toolUse: { name: 'get_recent_messages', input: { limit: 10 } } })));
    const before = (await runs()).length;
    await external('trigger loop');
    const run = await waitRunDone(before);
    expect(run).toMatchObject({ status: 'failed', endReason: 'budget_exhausted' });
    expect(run.steps.length).toBe(12);
    expect(run.steps[1].resultSummary).toBeTruthy();
    expect(run.steps.slice(2).every((x: any) => x.errorCode === 'POLICY_DENIED')).toBe(true);
  });

  it('/agent/turn 超时 → TURN_TIMEOUT 协议错误，超时后才到的响应丢弃', async () => {
    await script([{ toolUse: { name: 'finish', input: { summary: 'too late' } }, delayMs: 2500 }, { endTurn: 'ok after timeout' }]);
    const before = (await runs()).length;
    await external('trigger timeout');
    const run = await waitRunDone(before);
    expect(run.steps[0]).toMatchObject({ kind: 'protocol_error', errorCode: 'TURN_TIMEOUT' });
    expect(run).toMatchObject({ endReason: 'final', summary: 'ok after timeout' });
  });

  it('审计 fail → AUDIT_REJECTED，不发送；拒绝的调用不占用 key', async () => {
    await s.agentc.call('POST', '/_control/audit-script', { responses: [{ json: { verdict: 'fail', reason: 'no' } }] });
    await script([
      { toolUse: { name: 'send_message', input: { text: 'rejected text', idempotency_key: 'k-rej' } } },
      { toolUse: { name: 'send_message', input: { text: 'second try', idempotency_key: 'k-rej' } } },
      { toolUse: { name: 'finish', input: { summary: 'done' } } },
    ]);
    const before = (await runs()).length;
    await external('trigger audit fail');
    const run = await waitRunDone(before);
    expect(run.steps[0]).toMatchObject({ isError: true, errorCode: 'AUDIT_REJECTED', auditVerdict: 'fail' });
    expect(run.steps[1]).toMatchObject({ isError: false, auditVerdict: 'pass' });
    const list = await messages(s.api, group.id);
    expect(list.some((m) => m.text === 'rejected text')).toBe(false);
    await waitFor(async () => (await messages(s.api, group.id)).some((m) => m.text === 'second try'), 3000);
  });

  it('审计 3 次拿不到明确结论 → run blocked / audit_blocked，工具不执行', async () => {
    await s.agentc.call('POST', '/_control/audit-script', {
      responses: [{ status: 500 }, { body: '{"verdict":"maybe"}' }, { noResponse: true }],
    });
    await script([{ toolUse: { name: 'send_message', input: { text: 'blocked text', idempotency_key: 'k-blk' } } }]);
    const before = (await runs()).length;
    await external('trigger audit blocked');
    const run = await waitRunDone(before);
    expect(run).toMatchObject({ status: 'blocked', endReason: 'audit_blocked' });
    expect(run.steps.length).toBe(1);
    expect(run.steps[0].auditVerdict).toBe('unavailable');
    expect((await messages(s.api, group.id)).some((m) => m.text === 'blocked text')).toBe(false);
  });

  it('kick_user：autoKickEnabled=false → POLICY_DENIED；开启后审计通过再移除', async () => {
    await s.gwc.call('POST', `/_control/groups/${group.gatewayGroupId}/external-join`, { platformUserId: 'pu_spammer' });
    await script([
      { toolUse: { name: 'kick_user', input: { platform_user_id: 'pu_spammer', reason: 'spam' } } },
      { toolUse: { name: 'finish', input: { summary: 'denied' } } },
    ]);
    let before = (await runs()).length;
    await external('spam!', 'pu_spammer');
    let run = await waitRunDone(before);
    expect(run.steps[0]).toMatchObject({ errorCode: 'POLICY_DENIED' });

    await s.api.patch(`/api/groups/${group.id}`, { autoKickEnabled: true });
    await script([
      { toolUse: { name: 'kick_user', input: { platform_user_id: 'pu_spammer', reason: 'spam' } } },
      { toolUse: { name: 'finish', input: { summary: 'kicked' } } },
    ]);
    before = (await runs()).length;
    await external('more spam', 'pu_spammer');
    run = await waitRunDone(before);
    expect(run.steps[0]).toMatchObject({ isError: false, auditVerdict: 'pass' });
    expect(run.steps[0].resultSummary).toContain('kicked');
    const audits = await s.agentc.call<any[]>('GET', '/_control/requests?kind=audit');
    expect(JSON.parse(audits[audits.length - 1].body.text)).toEqual({ action: 'kick', platform_user_id: 'pu_spammer', reason: 'spam' });
    const members = await s.gwc.call<Array<{ platformUserId: string }>>('GET', `/groups/${group.gatewayGroupId}/members`);
    expect(members.map((m) => m.platformUserId)).not.toContain('pu_spammer');
    // member_left 事件随后到达，外部成员表同步移除
    await waitFor(async () => !(await s.api.get(`/api/groups/${group.id}`)).body.externalMembers.some((m: any) => m.platformUserId === 'pu_spammer'), 3000);
    await s.api.patch(`/api/groups/${group.id}`, { autoKickEnabled: false });
  });

  it('kick 504（结果未知）：用成员列表判断已移除 → 成功', async () => {
    await s.api.patch(`/api/groups/${group.id}`, { autoKickEnabled: true });
    await s.gwc.call('POST', `/_control/groups/${group.gatewayGroupId}/external-join`, { platformUserId: 'pu_bad' });
    await s.gwc.call('POST', '/_control/faults', { endpoint: 'kick', status: 504, apply: true });
    await script([
      { toolUse: { name: 'kick_user', input: { platform_user_id: 'pu_bad', reason: 'bad' } } },
      { toolUse: { name: 'finish', input: { summary: 'ok' } } },
    ]);
    const before = (await runs()).length;
    await external('hello', 'pu_bad');
    const run = await waitRunDone(before);
    expect(run.steps[0]).toMatchObject({ isError: false });
    await s.api.patch(`/api/groups/${group.id}`, { autoKickEnabled: false });
  });

  it('agentEnabled 关闭 → 正在运行的 run 在当前步结束后 cancelled', async () => {
    await script([
      { toolUse: { name: 'get_recent_messages', input: { limit: 5 } }, delayMs: 600 },
      { toolUse: { name: 'get_recent_messages', input: { limit: 6 } } },
      { toolUse: { name: 'finish', input: { summary: 'should not get here' } } },
    ]);
    const before = (await runs()).length;
    await external('trigger cancel');
    await waitFor(async () => (await runs()).length > before, 5000);
    await s.api.patch(`/api/groups/${group.id}`, { agentEnabled: false });
    const run = await waitRunDone(before);
    expect(run).toMatchObject({ status: 'cancelled', endReason: 'cancelled' });
    expect(run.steps.length).toBe(1);
    await s.api.patch(`/api/groups/${group.id}`, { agentEnabled: true });
  });

  it('A5.8 恢复：run 进行中服务重启，用同一个 runId 继续并正常结束；已发出的消息不重发', async () => {
    await script([
      { toolUse: { name: 'send_message', input: { text: 'before crash', idempotency_key: 'k-crash' } } },
      { toolUse: { name: 'get_recent_messages', input: { limit: 5 } }, delayMs: 800 },
      { toolUse: { name: 'finish', input: { summary: 'recovered' } } },
    ]);
    const before = (await runs()).length;
    await external('trigger restart');
    const runId = (await waitFor(async () => {
      const r = await runs();
      return r.length > before ? r[0] : null;
    })).id;
    // 等第一步（发消息）完成，在第二轮 turn 进行中重启
    await waitFor(async () => (await s.api.get(`/api/agent-runs/${runId}`)).body.steps.some((x: any) => x.name === 'send_message' && x.status === 'done'), 8000);
    await sleep(200);
    await s.restart({ downMs: 300 });
    const run = await waitFor(async () => {
      const r = (await s.api.get(`/api/agent-runs/${runId}`)).body;
      return r.status !== 'running' ? r : null;
    }, 20000, 'run after restart');
    expect(run).toMatchObject({ status: 'finished', endReason: 'final', summary: 'recovered' });
    const turns = await s.agentc.call<any[]>('GET', `/_control/requests?kind=turn&runId=${runId}`);
    expect(turns.every((t) => t.body.runId === runId)).toBe(true);
    const landed = await s.gwc.call<any[]>('GET', `/_control/messages?groupId=${group.gatewayGroupId}`);
    expect(landed.filter((m) => m.text === 'before crash').length).toBe(1);
  });

  it('60 秒墙钟（测试里缩短）：耗尽 → failed / wall_clock', async () => {
    await s.server.stop();
    // 用更短的墙钟重新拉起
    const { createServer } = await import('../src/server.js');
    const srv = await createServer({ ...s.config, agentWallClockMs: 2_000, port: Number(new URL(s.url).port) }, { logger: false });
    await srv.start();
    s.server = srv;
    await script(Array.from({ length: 5 }, (_, i) => ({ toolUse: { name: 'get_recent_messages', input: { limit: i + 1 } }, delayMs: 700 })));
    const before = (await runs()).length;
    await external('trigger wall clock');
    const run = await waitRunDone(before);
    expect(run).toMatchObject({ status: 'failed', endReason: 'wall_clock' });
  });
});
