import { isRecord } from './http.js';

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface TurnResponse {
  stop_reason: 'tool_use' | 'end_turn';
  content: Array<ToolUseBlock | TextBlock>;
}

export interface TriggerMessage {
  msgId: string;
  senderPlatformUserId: string;
  text: string;
  sentAt: string;
}

export interface TriggerContext {
  groupId: string | null;
  triggerMessages: TriggerMessage[];
  autoKickEnabled: boolean;
  ownPlatformUserIds: string[];
}

interface ToolResult {
  isError: boolean;
  /** content 解析成 JSON 后的值（解析失败为 null） */
  parsed: unknown;
}

export interface History {
  ctx: TriggerContext;
  assistantCount: number;
  toolUses: ToolUseBlock[];
  results: Map<string, ToolResult>;
}

export const SPAM_PATTERN = /广告|spam|kick/i;
export const MAX_ASSISTANT_MESSAGES = 10;

function blocksOf(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function tryParse(s: unknown): unknown {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function resultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content.filter((b) => isRecord(b) && b.type === 'text' && typeof b.text === 'string');
    if (texts.length) return texts.map((b) => (b as { text: string }).text).join('');
  }
  return null;
}

/** 从 messages[0] 的 text 解析触发上下文；解析失败时返回空上下文 */
export function parseTriggerContext(messages: unknown[]): TriggerContext {
  const first = messages[0];
  const block = isRecord(first) ? blocksOf(first.content)[0] : undefined;
  const raw = isRecord(block) && typeof block.text === 'string' ? tryParse(block.text) : null;
  const obj = isRecord(raw) ? raw : {};
  const triggers = Array.isArray(obj.triggerMessages) ? obj.triggerMessages : [];
  const policy = isRecord(obj.policy) ? obj.policy : {};
  return {
    groupId: typeof obj.groupId === 'string' ? obj.groupId : null,
    triggerMessages: triggers.filter(isRecord).map((m) => ({
      msgId: String(m.msgId ?? ''),
      senderPlatformUserId: String(m.senderPlatformUserId ?? ''),
      text: String(m.text ?? ''),
      sentAt: String(m.sentAt ?? ''),
    })),
    autoKickEnabled: policy.autoKickEnabled === true,
    ownPlatformUserIds: Array.isArray(obj.ownPlatformUserIds)
      ? obj.ownPlatformUserIds.filter((x): x is string => typeof x === 'string')
      : [],
  };
}

export function analyzeHistory(messages: unknown[]): History {
  const toolUses: ToolUseBlock[] = [];
  const results = new Map<string, ToolResult>();
  let assistantCount = 0;
  for (const m of messages) {
    if (!isRecord(m)) continue;
    const blocks = blocksOf(m.content);
    if (m.role === 'assistant') {
      assistantCount++;
      for (const b of blocks) {
        if (isRecord(b) && b.type === 'tool_use' && typeof b.name === 'string') {
          toolUses.push({ type: 'tool_use', id: String(b.id ?? ''), name: b.name, input: b.input });
        }
      }
    } else if (m.role === 'user') {
      for (const b of blocks) {
        if (isRecord(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          results.set(b.tool_use_id, { isError: b.is_error === true, parsed: tryParse(resultText(b.content)) });
        }
      }
    }
  }
  return { ctx: parseTriggerContext(messages), assistantCount, toolUses, results };
}

function clip(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n).join('') + '…' : s;
}

function errorCode(r: ToolResult | undefined): string | null {
  if (!r?.isError) return null;
  return isRecord(r.parsed) && typeof r.parsed.code === 'string' ? r.parsed.code : 'ERROR';
}

/** 根据历史生成 finish 的 summary */
export function summarize(h: History, prefix?: string): string {
  const parts: string[] = [];
  if (prefix) parts.push(prefix);
  const reads = h.toolUses.filter((t) => t.name === 'get_recent_messages');
  if (reads.length) {
    const r = h.results.get(reads[reads.length - 1].id);
    const err = errorCode(r);
    const list = isRecord(r?.parsed) && Array.isArray(r.parsed.messages) ? r.parsed.messages : null;
    parts.push(err ? `读取最近消息失败（${err}）` : list ? `读取了最近 ${list.length} 条消息` : '读取了最近消息');
  }
  for (const t of h.toolUses) {
    const input = isRecord(t.input) ? t.input : {};
    const err = errorCode(h.results.get(t.id));
    if (t.name === 'send_message') {
      const text = clip(String(input.text ?? ''), 30);
      parts.push(err ? `回复「${text}」失败（${err}）` : `发送了回复「${text}」`);
    } else if (t.name === 'kick_user') {
      const who = String(input.platform_user_id ?? '');
      parts.push(err ? `移除 ${who} 失败（${err}）` : `移除了 ${who}（${String(input.reason ?? '')}）`);
    }
  }
  if (!parts.length) parts.push('没有需要处理的事情');
  return parts.join('；');
}

function toolUse(id: string, name: string, input: unknown): TurnResponse {
  return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] };
}

/**
 * 默认大脑（确定性）：
 * 1. 没调过 get_recent_messages → 调 get_recent_messages { limit: 20 }
 * 2. 没调过 send_message / kick_user → 看最后一条触发消息：疑似广告且允许自动踢人且不是自己 → kick_user；否则回复
 * 3. 否则 finish
 * assistant 消息超过 10 条时直接 finish。
 */
export function defaultBrain(messages: unknown[], newId: () => string): TurnResponse {
  const h = analyzeHistory(messages);
  if (h.assistantCount > MAX_ASSISTANT_MESSAGES) {
    return toolUse(newId(), 'finish', { summary: summarize(h, '步骤过多，提前结束') });
  }
  if (!h.toolUses.some((t) => t.name === 'get_recent_messages')) {
    return toolUse(newId(), 'get_recent_messages', { limit: 20 });
  }
  if (!h.toolUses.some((t) => t.name === 'send_message' || t.name === 'kick_user')) {
    const last = h.ctx.triggerMessages[h.ctx.triggerMessages.length - 1];
    if (!last) return toolUse(newId(), 'finish', { summary: summarize(h, '没有触发消息，无需处理') });
    const isOwn = h.ctx.ownPlatformUserIds.includes(last.senderPlatformUserId);
    if (SPAM_PATTERN.test(last.text) && h.ctx.autoKickEnabled && !isOwn) {
      return toolUse(newId(), 'kick_user', { platform_user_id: last.senderPlatformUserId, reason: 'spam detected' });
    }
    return toolUse(newId(), 'send_message', {
      text: '[bot] 收到：' + Array.from(last.text).slice(0, 100).join(''),
      idempotency_key: 'reply-' + last.msgId,
    });
  }
  return toolUse(newId(), 'finish', { summary: summarize(h) });
}

export interface AuditVerdict {
  verdict: 'pass' | 'fail';
  reason: string;
}

export function defaultAudit(text: string): AuditVerdict {
  if (text.includes('违禁') || /forbidden/i.test(text)) {
    return { verdict: 'fail', reason: 'text contains forbidden content' };
  }
  return { verdict: 'pass', reason: 'ok' };
}

export interface ChaosOutcome {
  raw: string;
  extraDelayMs: number;
  /** 本次注入的坏行为（无则为空数组） */
  kinds: string[];
}

/**
 * CHAOS 模式：10% markdown 围栏、5% 前后夹文字、5% 未知工具、5% 重复上一个 tool_use.id、
 * 3% 用同一个 idempotency_key 再调一次 send_message；另有独立的 5% 慢 8s。
 */
export function applyChaos(
  out: TurnResponse,
  messages: unknown[],
  newId: () => string,
  rand: () => number = Math.random,
): ChaosOutcome {
  const kinds: string[] = [];
  let resp = out;
  let wrap: 'fence' | 'prose' | null = null;
  const r = rand();
  const h = analyzeHistory(messages);
  if (r < 0.1) {
    wrap = 'fence';
  } else if (r < 0.15) {
    wrap = 'prose';
  } else if (r < 0.2) {
    resp = toolUse(newId(), 'search_web', { query: 'how to manage a group chat' });
    kinds.push('unknown_tool');
  } else if (r < 0.25) {
    const lastId = h.toolUses[h.toolUses.length - 1]?.id;
    const block = resp.content[0];
    if (lastId && block?.type === 'tool_use') {
      resp = { ...resp, content: [{ ...block, id: lastId }] };
      kinds.push('duplicate_tool_use_id');
    }
  } else if (r < 0.28) {
    const lastSend = [...h.toolUses].reverse().find((t) => t.name === 'send_message');
    if (lastSend) {
      resp = toolUse(newId(), 'send_message', lastSend.input);
      kinds.push('repeat_idempotency_key');
    }
  }
  let raw = JSON.stringify(resp);
  if (wrap === 'fence') {
    raw = '```json\n' + JSON.stringify(resp, null, 2) + '\n```';
    kinds.push('markdown_fence');
  } else if (wrap === 'prose') {
    raw = '好的，这是我的决定：\n' + raw + '\n以上。';
    kinds.push('surrounding_text');
  }
  let extraDelayMs = 0;
  if (rand() < 0.05) {
    extraDelayMs = 8000;
    kinds.push('slow_8s');
  }
  return { raw, extraDelayMs, kinds };
}
