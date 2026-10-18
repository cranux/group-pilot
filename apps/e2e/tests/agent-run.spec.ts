import { expect, request, test, type APIRequestContext } from '@playwright/test';

const API = 'http://localhost:3000';
const GATEWAY = 'http://localhost:4001';

async function adminApi(): Promise<APIRequestContext> {
  const login = await (await request.newContext()).post(`${API}/api/auth/login`, { data: { username: 'admin', password: 'admin' } });
  const { accessToken } = await login.json();
  return request.newContext({ baseURL: API, extraHTTPHeaders: { authorization: `Bearer ${accessToken}` } });
}

/** 找两个能用的账号（在线的直接用，空闲 / 离线的先连上） */
async function pickAccounts(api: APIRequestContext, n: number): Promise<string[]> {
  const accounts: Array<{ id: string; status: string }> = await (await api.get('/api/accounts')).json();
  const picked: string[] = [];
  for (const a of accounts) {
    if (picked.length === n) break;
    if (a.status === 'online') picked.push(a.id);
    else if (a.status === 'idle' || a.status === 'disconnected') {
      const r = await api.post(`/api/accounts/${a.id}/connect`);
      if (r.ok()) picked.push(a.id);
    }
  }
  if (picked.length < n) throw new Error('not enough usable accounts for the e2e test');
  return picked;
}

test('登录 → 打开群 → 看到 agent run 的步骤', async ({ page }) => {
  // 准备数据：建群、开 agent、外部用户发一条消息触发 run
  const api = await adminApi();
  const [creator, member] = await pickAccounts(api, 2);
  const job = await (await api.post('/api/groups', { data: { creatorAccountId: creator, memberAccountIds: [member] } })).json();
  let groupId = '';
  await expect
    .poll(async () => {
      const j = await (await api.get(`/api/jobs/${job.jobId}`)).json();
      groupId = j.groupId ?? '';
      return j.status;
    }, { timeout: 30_000 })
    .toBe('finished');
  const group = await (await api.get(`/api/groups/${groupId}`)).json();
  await api.patch(`/api/groups/${groupId}`, { data: { agentEnabled: true } });
  const gw = await request.newContext();
  await gw.post(`${GATEWAY}/_control/groups/${group.gatewayGroupId}/external-message`, {
    data: { platformUserId: 'pu_e2e_user', text: 'E2E：请回复我' },
  });

  // 登录
  await page.goto('/login');
  await page.getByRole('textbox').first().fill('admin');
  await page.locator('input[type="password"]').fill('admin');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/accounts/);

  // 打开群：时间线里能看到触发消息，最近的 agent run 出现并结束
  await page.goto(`/groups/${groupId}`);
  await expect(page.getByText('E2E：请回复我').first()).toBeVisible();
  const runLink = page.locator('a[href^="/agent-runs/"]').first();
  await expect(runLink).toBeVisible();
  await expect(page.getByText('正常结束').first()).toBeVisible({ timeout: 30_000 });

  // 打开 run 详情：每一步的工具名都在
  await runLink.click();
  await expect(page).toHaveURL(/\/agent-runs\//);
  await expect(page.getByText('get_recent_messages').first()).toBeVisible();
  await expect(page.getByText('send_message').first()).toBeVisible();
  await expect(page.getByText('finish').first()).toBeVisible();
});
