import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAll, createGroup, messages, sleep, startStack, waitFor, type Stack } from './harness.js';

let s: Stack;
let group: any;

beforeAll(async () => {
  // 保留 1.5 秒、每 200ms 清理一次，便于测试
  s = await startStack({ config: { mediaRetentionDays: 1.5 / 86_400, mediaCleanupIntervalMs: 200, agentTurnTimeoutMs: 10_000 } });
  await s.api.login();
  await connectAll(s.api, ['acc-01', 'acc-02']);
  group = await createGroup(s.api, 'acc-01', ['acc-02']);
});

afterAll(async () => {
  await s?.close();
});

describe('C1 媒体文件', () => {
  it('带 mediaUrl 的消息下载到本地，过期后删除文件且不留下指向已删文件的记录', async () => {
    await s.gwc.call('POST', `/_control/groups/${group.gatewayGroupId}/external-message`, { platformUserId: 'pu_m', text: 'pic', withMedia: true });
    const row = await waitFor(async () => (await messages(s.api, group.id)).find((m) => m.text === 'pic' && m.localFilePath), 5000, 'download');
    expect(row.mediaUrl).toMatch(/\/media\//);
    expect(fs.existsSync(row.localFilePath)).toBe(true);
    const file = row.localFilePath;
    await waitFor(async () => (await messages(s.api, group.id)).find((m) => m.text === 'pic')?.localFilePath === null, 5000, 'cleanup');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('仍被运行中的 agent run 用到的文件不删', async () => {
    await s.api.patch(`/api/groups/${group.id}`, { agentEnabled: true });
    await s.agentc.call('POST', '/_control/turn-script', {
      responses: [{ toolUse: { name: 'get_recent_messages', input: { limit: 5 } }, delayMs: 3000 }, { toolUse: { name: 'finish', input: { summary: 'done' } } }],
    });
    await s.gwc.call('POST', `/_control/groups/${group.gatewayGroupId}/external-message`, { platformUserId: 'pu_m', text: 'pic2', withMedia: true });
    const row = await waitFor(async () => (await messages(s.api, group.id)).find((m) => m.text === 'pic2' && m.localFilePath), 5000, 'download');
    await sleep(2200); // 已超过保留期，但 run 还在跑
    expect(fs.existsSync(row.localFilePath)).toBe(true);
    expect((await messages(s.api, group.id)).find((m) => m.text === 'pic2').localFilePath).toBe(row.localFilePath);
    await waitFor(async () => (await messages(s.api, group.id)).find((m) => m.text === 'pic2')?.localFilePath === null, 8000, 'cleanup after run');
    expect(fs.existsSync(row.localFilePath)).toBe(false);
  });
});
