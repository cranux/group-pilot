import { describe, expect, it } from 'vitest';
import { compactJson, formatCountdown, formatDuration, formatElapsed, prettyJson, remainingMs, truncate } from './format';

describe('倒计时', () => {
  const now = Date.parse('2026-09-26T08:00:00.000Z');

  it('remainingMs', () => {
    expect(remainingMs('2026-09-26T08:00:05.000Z', now)).toBe(5000);
    expect(remainingMs('2026-09-26T07:59:00.000Z', now)).toBe(0);
    expect(remainingMs(null, now)).toBe(0);
    expect(remainingMs('garbage', now)).toBe(0);
  });

  it('formatCountdown 到期返回 null，不足一秒向上取整', () => {
    expect(formatCountdown('2026-09-26T08:00:00.200Z', now)).toBe('1秒');
    expect(formatCountdown('2026-09-26T08:02:05.000Z', now)).toBe('2分05秒');
    expect(formatCountdown('2026-09-26T09:00:01.000Z', now)).toBe('1时00分01秒');
    expect(formatCountdown('2026-09-26T08:00:00.000Z', now)).toBeNull();
    expect(formatCountdown(null, now)).toBeNull();
  });

  it('formatDuration / formatElapsed', () => {
    expect(formatDuration(0)).toBe('0秒');
    expect(formatElapsed('2026-09-26T08:00:00.000Z', '2026-09-26T08:01:30.000Z', now)).toBe('1分30秒');
    expect(formatElapsed('2026-09-26T07:59:50.000Z', null, now)).toBe('10秒');
    expect(formatElapsed(null, null, now)).toBe('—');
  });
});

describe('文本工具', () => {
  it('truncate', () => {
    expect(truncate('abcdef', 3)).toBe('abc…');
    expect(truncate('ab', 3)).toBe('ab');
    expect(truncate(null, 3)).toBe('');
  });

  it('prettyJson 美化对象与 JSON 字符串，非 JSON 字符串原样返回', () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson('```json oops')).toBe('```json oops');
    expect(prettyJson(null)).toBe('null');
  });

  it('compactJson', () => {
    expect(compactJson({ limit: 10 })).toBe('{"limit":10}');
    expect(compactJson(null)).toBe('null');
  });
});
