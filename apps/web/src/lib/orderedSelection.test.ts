import { describe, expect, it } from 'vitest';
import { moveItem, removeItem, toggleOrdered, validateCreateGroup } from './orderedSelection';
import { describeJobStep, lookup, ACCOUNT_STATUS } from './labels';

describe('有序多选', () => {
  it('toggle 按点击顺序追加 / 取消', () => {
    let l: string[] = [];
    l = toggleOrdered(l, 'b');
    l = toggleOrdered(l, 'a');
    l = toggleOrdered(l, 'c');
    expect(l).toEqual(['b', 'a', 'c']);
    expect(toggleOrdered(l, 'a')).toEqual(['b', 'c']);
  });

  it('moveItem 上移 / 下移并夹在边界内', () => {
    const l = ['a', 'b', 'c'];
    expect(moveItem(l, 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(l, 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(l, 'a', 5)).toEqual(['b', 'c', 'a']);
    expect(moveItem(l, 'x', 1)).toEqual(l);
    expect(removeItem(l, 'b')).toEqual(['a', 'c']);
  });
});

describe('validateCreateGroup', () => {
  const online = new Set(['a', 'b', 'c']);
  it('通过', () => {
    expect(validateCreateGroup('a', ['b', 'c'], online)).toEqual([]);
  });
  it('缺群主 / 缺成员 / 含群主 / 不在线', () => {
    expect(validateCreateGroup('', [], online)).toEqual(['请选择群主', '至少选择 1 个成员']);
    expect(validateCreateGroup('a', ['a'], online)).toContain('成员不能包含群主');
    expect(validateCreateGroup('a', ['d'], online)).toEqual(['以下账号当前不在线：d']);
  });
});

describe('labels', () => {
  it('job 步骤说明', () => {
    expect(describeJobStep('create')).toBe('网关建群');
    expect(describeJobStep('join:acc-2')).toBe('账号 acc-2 入群');
    expect(describeJobStep('leave:acc-1')).toBe('账号 acc-1 退群');
    expect(describeJobStep('weird')).toBe('weird');
  });
  it('lookup 未知值原样显示', () => {
    expect(lookup(ACCOUNT_STATUS, 'online').label).toBe('在线');
    expect(lookup(ACCOUNT_STATUS, 'zzz').label).toBe('zzz');
    expect(lookup(ACCOUNT_STATUS, null).label).toBe('—');
  });
});
