import type Anthropic from '@anthropic-ai/sdk';

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;

/** 2.2 协议里的一条历史消息（后端只保存每轮的那一个块） */
export interface ProtocolMessage {
  role: 'user' | 'assistant';
  content: Array<Record<string, unknown>>;
}

export type ProtocolResponse =
  | { stop_reason: 'tool_use'; content: [{ type: 'tool_use'; id: string; name: string; input: unknown }] }
  | { stop_reason: 'end_turn'; content: [{ type: 'text'; text: string }] };

/**
 * 原样回放给 Claude 的 assistant 内容。发生过服务端 fallback 时，最后一个 fallback 块之前的
 * 非 text 块（thinking / tool_use 等）要省略；fallback 块本身只是审计标记，丢掉。
 */
export function echoable(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const lastFallback = content.map((b) => b.type).lastIndexOf('fallback');
  return content
    .filter((b, i) => b.type !== 'fallback' && (i > lastFallback || b.type === 'text'))
    .map((b) => b as unknown as BetaContentBlockParam);
}

/**
 * 把后端发来的 messages 还原成发给 Claude 的历史：后端每轮只存了返回给它的那一个 tool_use 块，
 * 这里按 tool_use.id 换回 Claude 当时的完整内容（含 thinking 块）。这样每次发出去的历史都是
 * 上一次的追加（append-only），满足 preserved thinking 的前缀校验，也能命中 prompt cache。
 * 找不到原始内容（例如本服务重启过）时退回只发那个块——所有 thinking 块都不发，同样合法。
 */
export function toClaudeMessages(messages: ProtocolMessage[], stored: Map<string, BetaContentBlock[]>): BetaMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const toolUse = m.content.find((b) => b.type === 'tool_use') as { id?: string } | undefined;
      const original = toolUse?.id ? stored.get(toolUse.id) : undefined;
      if (original) return { role: 'assistant', content: echoable(original) };
    }
    return { role: m.role, content: m.content as unknown as BetaContentBlockParam[] };
  });
}

/** Claude 的响应 → 2.2 协议要求的「恰好一个块」 */
export function toProtocolResponse(response: BetaMessage): ProtocolResponse {
  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category ?? 'unspecified';
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: `The model declined this request (${category}).` }] };
  }
  const toolUse = response.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
  if (toolUse) {
    return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input }] };
  }
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: text || `(stopped: ${response.stop_reason ?? 'unknown'})` }] };
}

const EXPECTED_TOOLS = ['finish', 'get_recent_messages', 'kick_user', 'send_message'];

/** 与 2.2 一致：恰好 4 个工具，input_schema 合法且 required 覆盖全部入参 */
export function validateTools(tools: unknown): string | null {
  if (!Array.isArray(tools)) return 'tools must be an array';
  const names = tools.map((t) => (t as { name?: unknown })?.name);
  if ([...names].sort().join(',') !== EXPECTED_TOOLS.join(',')) return `tools must be exactly: ${EXPECTED_TOOLS.join(', ')}`;
  for (const t of tools as Array<Record<string, any>>) {
    const schema = t.input_schema;
    if (typeof t.description !== 'string' || !schema || schema.type !== 'object' || typeof schema.properties !== 'object') {
      return `tool ${t.name} has an invalid definition`;
    }
    const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
    if (!Object.keys(schema.properties).every((k) => required.includes(k))) return `tool ${t.name}: required must cover all inputs`;
  }
  return null;
}
