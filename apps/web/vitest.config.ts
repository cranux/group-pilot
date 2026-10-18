import { defineConfig } from 'vitest/config';

// 纯逻辑单测：node 环境，不依赖 DOM。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
