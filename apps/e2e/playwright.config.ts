import { defineConfig } from '@playwright/test';

/**
 * C3：登录 → 打开群 → 看到 agent run 的步骤。
 * 默认复用已经在跑的开发环境（pnpm dev）；没有在跑时按下面的命令拉起四个进程。
 * 使用本机已安装的 Chrome（channel: 'chrome'），不需要额外下载浏览器。
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://localhost:5173',
    channel: process.env.PW_CHANNEL ?? 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: 'pnpm --filter @gp/mock-gateway start', url: 'http://localhost:4001/_control/state', reuseExistingServer: true },
    { command: 'pnpm --filter @gp/mock-agent start', url: 'http://localhost:4002/_control/state', reuseExistingServer: true },
    {
      command: 'pnpm --filter @gp/server migrate && pnpm --filter @gp/server serve',
      url: 'http://localhost:3000/api/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    { command: 'pnpm --filter @gp/web dev', url: 'http://localhost:5173', reuseExistingServer: true },
  ],
});
