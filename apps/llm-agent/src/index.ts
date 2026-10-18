import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import Fastify, { type FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import { toClaudeMessages, toProtocolResponse, validateTools, type ProtocolMessage } from './translate.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';

const SYSTEM_PROMPT = `You are the auto-reply assistant for a group chat that is operated by a team of service accounts.

The first user message is a JSON trigger context: groupId, triggerMessages (the new messages that started this run, oldest first), policy.autoKickEnabled, and ownPlatformUserIds (the service accounts you act through - never kick them).

Work only through the provided tools:
- get_recent_messages reads the latest messages of the group (include enough context, usually limit 10-20).
- send_message posts a reply. Give each logical reply its own idempotency_key, e.g. "reply-<msgId of the message you answer>". If a send returns SEND_TIMEOUT, call send_message again with the same idempotency_key to learn its status instead of inventing a new key.
- kick_user removes a user. Use it only when policy.autoKickEnabled is true and the user is clearly spamming or abusive.
- finish ends the run with a one-sentence summary. Always end with finish.

Reply in the language the members are using, briefly and helpfully. Answer only what the trigger messages need; do nothing when no reply is warranted (just call finish). Tool errors come back as JSON with a code: AUDIT_REJECTED means the content was not allowed (rephrase once or finish), POLICY_DENIED and NO_PERMISSION mean the action is not allowed (do not retry), NO_AVAILABLE_ACCOUNT and GROUP_UNREACHABLE mean nothing can be sent right now (finish). A user message starting with PROTOCOL_ERROR means your previous turn could not be used - continue with a valid tool call.`;

const AUDIT_SYSTEM = `You review an action an automated group-chat assistant is about to take, before it happens.
The text is either a chat message the assistant wants to post, or a JSON object {"action":"kick", "platform_user_id", "reason"} describing a member removal.
Pass ordinary, polite, on-topic content and kicks with a concrete spam or abuse reason. Fail content that is abusive, leaks private data, impersonates people, or a kick without a convincing reason. Keep the reason to one short sentence.`;

const AuditVerdict = z.object({ verdict: z.enum(['pass', 'fail']), reason: z.string() });

/** 只用到这两个方法，便于在测试里注入假的客户端 */
export interface ClaudeClient {
  beta: { messages: { create: Anthropic['beta']['messages']['create'] } };
  messages: { parse: Anthropic['messages']['parse'] };
}

export interface LlmAgentOptions {
  client?: ClaudeClient;
  model?: string;
  /** /agent/turn 的 effort；后端每轮只等 10–15 秒，默认 low 以压低延迟 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  sessionTtlMs?: number;
  logger?: boolean;
}

interface Session {
  blocks: Map<string, Anthropic.Beta.BetaContentBlock[]>;
  lastUsed: number;
}

/**
 * C2：对外接口与 2.2 完全相同的真实 LLM Agent 服务。
 * 后端只保存每轮返回给它的那一个块；这里按 runId 记住 Claude 每轮的完整内容（含 thinking 块），
 * 下次请求时按 tool_use.id 换回去，保证发给 Claude 的历史是追加式的。
 */
export function createLlmAgent(opts: LlmAgentOptions = {}): FastifyInstance {
  const client: ClaudeClient = opts.client ?? new Anthropic({ timeout: 30_000, maxRetries: 1 });
  const model = opts.model ?? DEFAULT_MODEL;
  const effort = opts.effort ?? 'low';
  const ttl = opts.sessionTtlMs ?? 2 * 3600_000;
  const sessions = new Map<string, Session>();
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024 });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastUsed > ttl) sessions.delete(id);
  }, 60_000);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  app.post('/agent/turn', async (req, reply) => {
    const body = (req.body ?? {}) as { runId?: unknown; tools?: unknown; messages?: unknown };
    const toolsError = validateTools(body.tools);
    if (toolsError) return reply.status(400).send({ code: 'TOOLS_INVALID', message: toolsError });
    if (typeof body.runId !== 'string' || !Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.status(400).send({ code: 'INVALID_REQUEST', message: 'runId and messages are required' });
    }
    const session = sessions.get(body.runId) ?? { blocks: new Map(), lastUsed: Date.now() };
    session.lastUsed = Date.now();
    sessions.set(body.runId, session);

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: body.tools as Anthropic.Beta.BetaTool[],
        // 协议要求每轮恰好一个块：最多一个工具调用
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages: toClaudeMessages(body.messages as ProtocolMessage[], session.blocks),
        output_config: { effort },
        // 被安全分类器拒绝时，由服务端按拒绝类别自动换模型重试
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) return reply.status(429).send({ code: 'UPSTREAM_RATE_LIMITED', message: err.message });
      if (err instanceof Anthropic.APIError) return reply.status(502).send({ code: 'UPSTREAM_ERROR', message: err.message });
      throw err;
    }
    const out = toProtocolResponse(response);
    if (out.stop_reason === 'tool_use') session.blocks.set(out.content[0].id, response.content);
    return out;
  });

  app.post('/agent/audit', async (req, reply) => {
    const body = (req.body ?? {}) as { text?: unknown; groupId?: unknown };
    if (typeof body.text !== 'string') return reply.status(400).send({ code: 'INVALID_REQUEST', message: 'text is required' });
    try {
      const response = await client.messages.parse({
        model,
        max_tokens: 4000,
        system: AUDIT_SYSTEM,
        messages: [{ role: 'user', content: body.text }],
        output_config: { effort: 'low', format: zodOutputFormat(AuditVerdict) },
      });
      // 审计被安全分类器拒绝：按「不通过」处理，宁可不执行
      if (response.stop_reason === 'refusal') return { verdict: 'fail', reason: 'declined by the safety classifier' };
      if (!response.parsed_output) return reply.status(502).send({ code: 'UNPARSEABLE_VERDICT', message: 'no verdict produced' });
      return response.parsed_output;
    } catch (err) {
      if (err instanceof Anthropic.APIError) return reply.status(502).send({ code: 'UPSTREAM_ERROR', message: err.message });
      throw err;
    }
  });

  app.get('/health', async () => ({ ok: true, model, sessions: sessions.size }));
  return app;
}
