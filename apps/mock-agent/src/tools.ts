import { isRecord } from './http.js';

type ParamKind = 'number' | 'string';

/** 题目 2.2 固定的 4 个工具及其入参 */
export const TOOL_PARAMS: Readonly<Record<string, Readonly<Record<string, ParamKind>>>> = {
  get_recent_messages: { limit: 'number' },
  send_message: { text: 'string', idempotency_key: 'string' },
  kick_user: { platform_user_id: 'string', reason: 'string' },
  finish: { summary: 'string' },
};

export const TOOL_NAMES = Object.keys(TOOL_PARAMS);

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const KIND_TYPES: Record<ParamKind, Set<string>> = {
  number: new Set(['number', 'integer']),
  string: new Set(['string']),
};

function typeList(t: unknown): string[] | null {
  if (typeof t === 'string') return [t];
  if (Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === 'string')) return t as string[];
  return null;
}

/**
 * 校验 /agent/turn 的 tools：必须恰好是 4 个固定工具；每个都有 name / description / input_schema；
 * input_schema 为 `type: 'object'` 的 JSON Schema，properties 与固定入参一致，required 覆盖全部入参。
 * 返回错误描述；合法时返回 null。
 */
export function validateTools(tools: unknown): string | null {
  if (!Array.isArray(tools)) return 'tools must be an array';
  if (tools.length !== TOOL_NAMES.length) {
    return `tools must contain exactly ${TOOL_NAMES.length} tools (${TOOL_NAMES.join(', ')}), got ${tools.length}`;
  }
  const seen = new Set<string>();
  for (const [i, t] of tools.entries()) {
    if (!isRecord(t)) return `tools[${i}] must be an object`;
    const name = t.name;
    if (typeof name !== 'string' || name.length === 0) return `tools[${i}].name must be a non-empty string`;
    const expected = TOOL_PARAMS[name];
    if (!expected) return `tools[${i}]: unknown tool "${name}"`;
    if (seen.has(name)) return `tool "${name}" is declared more than once`;
    seen.add(name);
    if (typeof t.description !== 'string' || t.description.trim().length === 0) {
      return `tool "${name}": description must be a non-empty string`;
    }
    const schema = t.input_schema;
    if (!isRecord(schema)) return `tool "${name}": input_schema must be an object`;
    if (schema.type !== 'object') return `tool "${name}": input_schema.type must be "object"`;
    const props = schema.properties;
    if (!isRecord(props)) return `tool "${name}": input_schema.properties must be an object`;
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((x) => typeof x === 'string'))) {
      return `tool "${name}": input_schema.required must be an array of strings`;
    }
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== 'boolean' &&
      !isRecord(schema.additionalProperties)
    ) {
      return `tool "${name}": input_schema.additionalProperties must be a boolean or a schema`;
    }
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const propNames = Object.keys(props);
    const expectedNames = Object.keys(expected);
    for (const p of expectedNames) {
      if (!(p in props)) return `tool "${name}": input_schema.properties is missing "${p}"`;
    }
    for (const p of propNames) {
      const kind = expected[p];
      if (!kind) return `tool "${name}": unexpected property "${p}"`;
      const ps = props[p];
      if (!isRecord(ps)) return `tool "${name}": property "${p}" must be a schema object`;
      if (ps.type !== undefined) {
        const types = typeList(ps.type);
        if (!types || !types.every((x) => JSON_TYPES.has(x))) {
          return `tool "${name}": property "${p}" has an invalid JSON Schema type`;
        }
        if (!types.some((x) => KIND_TYPES[kind].has(x))) {
          return `tool "${name}": property "${p}" must be of type ${[...KIND_TYPES[kind]].join(' | ')}`;
        }
      }
      if (!required.has(p)) return `tool "${name}": required must include "${p}"`;
    }
    for (const r of required) {
      if (!(r in props)) return `tool "${name}": required lists unknown property "${r}"`;
    }
  }
  return null;
}
