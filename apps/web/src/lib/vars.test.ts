import { describe, expect, it } from 'vitest';
import {
  SEQUENCE_EXAMPLE,
  addMissingKeys,
  buildSequenceRunRequest,
  buildStepVars,
  describeVarSource,
  extractPlaceholders,
  newRow,
  parseSequenceJson,
  rowsToRecord,
  sequencePlaceholders,
  validateRows,
} from './vars';

describe('extractPlaceholders', () => {
  it('按出现顺序去重，只认 [A-Za-z0-9_]+', () => {
    expect(extractPlaceholders('{event} 将于 {time} 开始，{event}！{bad-key} {a_1}')).toEqual(['event', 'time', 'a_1']);
    expect(extractPlaceholders('没有占位符')).toEqual([]);
  });

  it('整个序列的占位符', () => {
    const v = parseSequenceJson(SEQUENCE_EXAMPLE);
    expect(v.ok).toBe(true);
    const steps = (v as { ok: true; value: { steps: never[] } }).value.steps;
    expect(sequencePlaceholders(steps)).toEqual(['event', 'time', 'location']);
  });
});

describe('rowsToRecord / buildStepVars', () => {
  it('保留空字符串值，忽略空键行，键去首尾空白', () => {
    const rows = [newRow('event', '周会'), newRow('time', ''), newRow('', ''), newRow('  ', 'x'), newRow(' loc ', '共享盘')];
    expect(rowsToRecord(rows)).toEqual({ event: '周会', time: '', loc: '共享盘' });
  });

  it('stepVars：空值有语义要保留；完全没有有效键的步骤省略', () => {
    const out = buildStepVars({
      '1': [newRow('', '')],
      '2': [newRow('location', '共享盘/第二季度')],
      '3': [newRow('location', '')],
    });
    expect(out).toEqual({ '2': { location: '共享盘/第二季度' }, '3': { location: '' } });
  });

  it('组装启动请求', () => {
    const req = buildSequenceRunRequest('seq1', [newRow('event', '发布会'), newRow('time', '')], {
      '2': [newRow('location', '共享盘/第二季度')],
    });
    expect(req).toEqual({
      sequenceId: 'seq1',
      vars: { event: '发布会', time: '' },
      stepVars: { '2': { location: '共享盘/第二季度' } },
    });
  });
});

describe('validateRows', () => {
  it('格式错误与重复键是错误，空键带值只是警告', () => {
    const a = newRow('ok', '1');
    const b = newRow('bad key', '1');
    const c = newRow('ok', '2');
    const d = newRow('', 'orphan');
    const e = newRow('', '');
    const { errors, warnings } = validateRows([a, b, c, d, e]);
    expect(errors.map((x) => x.rowId)).toEqual([b.rowId, c.rowId]);
    expect(warnings.map((x) => x.rowId)).toEqual([d.rowId]);
  });
});

describe('addMissingKeys', () => {
  it('只补缺失的键，去掉空白占位行', () => {
    const rows = [newRow('event', 'x'), newRow('', '')];
    const out = addMissingKeys(rows, ['event', 'time']);
    expect(out.map((r) => [r.key, r.value])).toEqual([
      ['event', 'x'],
      ['time', ''],
    ]);
    expect(addMissingKeys(out, ['event'])).toBe(out);
  });
});

describe('describeVarSource', () => {
  it('default 与 step:<index>', () => {
    expect(describeVarSource('default')).toBe('默认值（vars）');
    expect(describeVarSource('step:2')).toBe('第 2 步（stepVars）');
    expect(describeVarSource(undefined)).toBe('—');
    expect(describeVarSource('other')).toBe('other');
  });
});

describe('parseSequenceJson', () => {
  it('示例合法', () => {
    expect(parseSequenceJson(SEQUENCE_EXAMPLE).ok).toBe(true);
  });
  it('各种非法输入', () => {
    expect(parseSequenceJson('{').ok).toBe(false);
    expect(parseSequenceJson('[]').ok).toBe(false);
    expect(parseSequenceJson('{"name":"a","steps":[]}').ok).toBe(false);
    expect(parseSequenceJson('{"name":"a","steps":[{"index":1,"accountRole":"x","text":"","delaySeconds":1}]}').ok).toBe(
      false,
    );
    expect(parseSequenceJson('{"name":"a","steps":[{"index":1,"accountRole":"admin","text":"t","delaySeconds":-1}]}').ok).toBe(
      false,
    );
  });
});
