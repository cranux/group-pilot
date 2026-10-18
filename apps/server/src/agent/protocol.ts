import { Ajv, type ValidateFunction } from 'ajv';
import { isPlainObject } from '../lib/json.js';

export type ToolName = 'get_recent_messages' | 'send_message' | 'kick_user' | 'finish';

export interface ToolDefinition {
  name: ToolName;
  description: string;
  input_schema: Record<string, unknown>;
}

/** 发给 Agent 服务的工具定义：恰好 4 个，required 覆盖全部入参 */
export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_recent_messages',
    description:
      'Read the most recent messages of the group, oldest first. Includes the trigger messages and messages that arrived during this run. limit is capped at 50.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', minimum: 1, description: 'How many recent messages to return (max 50).' } },
      required: ['limit'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description:
      'Send a text message to the group as one of the service accounts. Re-using the same idempotency_key within this run returns the status of the earlier message instead of sending again.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, description: 'Message text.' },
        idempotency_key: { type: 'string', minLength: 1, description: 'Unique key for this logical message.' },
      },
      required: ['text', 'idempotency_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'kick_user',
    description: 'Remove a user from the group. Requires the group policy autoKickEnabled=true.',
    input_schema: {
      type: 'object',
      properties: {
        platform_user_id: { type: 'string', minLength: 1, description: 'platformUserId of the user to remove.' },
        reason: { type: 'string', description: 'Why the user is removed.' },
      },
      required: ['platform_user_id', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: 'End this run with a short summary of what was done.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'Summary of the run.' } },
      required: ['summary'],
      additionalProperties: false,
    },
  },
];

const ajv = new Ajv({ allErrors: false, strict: false });
const validators = new Map<string, ValidateFunction>(TOOLS.map((t) => [t.name, ajv.compile(t.input_schema)]));

export function isKnownTool(name: string): name is ToolName {
  return validators.has(name);
}

export function validateToolInput(name: ToolName, input: unknown): string | null {
  const validate = validators.get(name)!;
  if (validate(input)) return null;
  const e = validate.errors?.[0];
  return e ? `${e.instancePath || '(input)'} ${e.message}` : 'input does not match schema';
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type TurnParse =
  | { kind: 'tool_use'; block: ToolUseBlock }
  | { kind: 'end_turn'; text: string }
  | { kind: 'bad_json'; reason: string };

/**
 * 严格校验 /agent/turn 的响应：
 * 非 2xx、不是纯 JSON（含 markdown 围栏 / 前后夹文字）、缺 stop_reason、块数 ≠ 1、stop_reason 与块类型不一致 → BAD_JSON。
 */
export function parseTurnResponse(status: number, body: string): TurnParse {
  if (status < 200 || status >= 300) return { kind: 'bad_json', reason: `HTTP ${status}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: 'bad_json', reason: 'response body is not valid JSON' };
  }
  if (!isPlainObject(parsed)) return { kind: 'bad_json', reason: 'response is not a JSON object' };
  const { stop_reason: stopReason, content } = parsed;
  if (typeof stopReason !== 'string') return { kind: 'bad_json', reason: 'missing stop_reason' };
  if (!Array.isArray(content) || content.length !== 1) return { kind: 'bad_json', reason: 'content must contain exactly one block' };
  const block = content[0];
  if (!isPlainObject(block)) return { kind: 'bad_json', reason: 'content block is not an object' };
  if (stopReason === 'tool_use') {
    if (block.type !== 'tool_use') return { kind: 'bad_json', reason: 'stop_reason tool_use requires a tool_use block' };
    if (typeof block.id !== 'string' || !block.id) return { kind: 'bad_json', reason: 'tool_use.id missing' };
    if (typeof block.name !== 'string' || !block.name) return { kind: 'bad_json', reason: 'tool_use.name missing' };
    const input = block.input === undefined ? {} : block.input;
    if (!isPlainObject(input)) return { kind: 'bad_json', reason: 'tool_use.input must be an object' };
    return { kind: 'tool_use', block: { type: 'tool_use', id: block.id, name: block.name, input } };
  }
  if (stopReason === 'end_turn') {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      return { kind: 'bad_json', reason: 'stop_reason end_turn requires a text block' };
    }
    return { kind: 'end_turn', text: block.text };
  }
  return { kind: 'bad_json', reason: `unsupported stop_reason ${String(stopReason)}` };
}

export interface AuditParse {
  verdict: 'pass' | 'fail' | null;
  reason: string | null;
}

/** 只有合法 JSON 且 verdict 恰为 pass/fail 才算明确结论；其余（含 500、坏 JSON、缺字段、别的值）都是「拿不到结论」 */
export function parseAuditResponse(status: number, body: string): AuditParse {
  if (status !== 200) return { verdict: null, reason: `HTTP ${status}` };
  try {
    const parsed = JSON.parse(body);
    if (isPlainObject(parsed) && (parsed.verdict === 'pass' || parsed.verdict === 'fail')) {
      return { verdict: parsed.verdict, reason: typeof parsed.reason === 'string' ? parsed.reason : null };
    }
    return { verdict: null, reason: 'missing or invalid verdict' };
  } catch {
    return { verdict: null, reason: 'audit response is not valid JSON' };
  }
}
