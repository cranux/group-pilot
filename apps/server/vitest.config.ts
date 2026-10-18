import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 所有集成测试共用一个测试库，逐个文件串行执行
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
