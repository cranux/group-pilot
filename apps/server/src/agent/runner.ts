import { enterTerminal } from '../accounts/service.js';
import { terminalStatusForGatewayCode } from '../accounts/states.js';
import type { AppContext } from '../context.js';
import type { Tx } from '../db/db.js';
import { GatewayError } from '../gateway/client.js';
import { toJsonb } from '../lib/json.js';
import { byteLength, truncateBytes, truncateChars } from '../lib/text.js';
import { sleep } from '../lib/time.js';
import type { MessageRow } from '../messages/model.js';
import { enqueueOwnMessage } from '../messages/outbox.js';
import {
  END_STATUS,
  emitRun,
  type AgentRunRow,
  type EndReason,
  type PendingTool,
  type RunMemo,
} from './model.js';
import { TOOLS, isKnownTool, parseAuditResponse, parseTurnResponse, validateToolInput, type ToolUseBlock } from './protocol.js';
import { createRunFromPending, ownPlatformUserIds } from './scheduler.js';

const RAW_LIMIT = 2048;
const RESULT_LIMIT = 8 * 1024;
const SUMMARY_LIMIT = 200;
const MAX_RECENT = 50;
const TEXT_LIMIT = 500;

class LeaseLost extends Error {}

type ToolOutcome =
  | { kind: 'result'; content: Record<string, unknown>; isError: boolean; errorCode?: string; auditVerdict?: string | null }
  | { kind: 'blocked' }
  | { kind: 'wall_clock' };

const ok = (content: Record<string, unknown>, auditVerdict: string | null = null): ToolOutcome => ({
  kind: 'result',
  content,
  isError: false,
  auditVerdict,
});

const toolError = (code: string, message: string, hint?: string, auditVerdict: string | null = null): ToolOutcome => ({
  kind: 'result',
  content: hint ? { code, message, hint } : { code, message },
  isError: true,
  errorCode: code,
  auditVerdict,
});

/** 单个 tool_result 的 content ≤ 8KB，超出截断并置 truncated: true */
export function limitResultContent(content: Record<string, unknown>): string {
  let json = JSON.stringify(content);
  if (byteLength(json) <= RESULT_LIMIT) return json;
  if (Array.isArray(content.messages)) {
    const messages = [...(content.messages as unknown[])];
    while (messages.length && byteLength(json) > RESULT_LIMIT) {
      messages.shift(); // 丢最旧的
      json = JSON.stringify({ ...content, messages, truncated: true });
    }
    if (byteLength(json) <= RESULT_LIMIT) return json;
  }
  const overhead = byteLength(JSON.stringify({ truncated: true, text: '' }));
  return JSON.stringify({ truncated: true, text: truncateBytes(JSON.stringify(content), RESULT_LIMIT - overhead - 64) });
}

function summarize(text: string): string {
  return truncateChars(text, SUMMARY_LIMIT);
}

/**
 * 一个 run 的执行。所有进度（历史、步数、连续协议错误、累计活跃时长、待执行工具及其阶段）都在 agent_runs 里，
 * 任何时刻崩溃，下一个认领者都能用同一个 runId 从断点继续。写入都带租约条件，丢失租约立即停止。
 */
class RunExecution {
  private segmentStart = Date.now();
  private baseActiveMs: number;

  constructor(
    private readonly ctx: AppContext,
    private run: AgentRunRow,
    private readonly owner: string,
    readonly controller: AbortController,
  ) {
    this.baseActiveMs = Number(run.active_ms);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  elapsed(): number {
    return this.baseActiveMs + (Date.now() - this.segmentStart);
  }

  remaining(): number {
    return this.ctx.config.agentWallClockMs - this.elapsed();
  }

  private ensure(): void {
    if (this.signal.aborted) throw new LeaseLost();
  }

  async heartbeat(): Promise<void> {
    const r = await this.ctx.db.query(
      `UPDATE agent_runs SET lease_until = now() + make_interval(secs => $3), active_ms = $4
        WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [this.run.id, this.owner, this.ctx.config.leaseMs / 1000, Math.round(this.elapsed())],
    );
    if (!r.rowCount) this.controller.abort();
  }

  /** 带租约条件更新 run；返回最新行 */
  private async saveRun(tx: Tx, patch: Partial<Pick<AgentRunRow, 'history' | 'step_count' | 'consecutive_protocol_errors' | 'pending' | 'memo'>>): Promise<AgentRunRow> {
    const next = { ...this.run, ...patch };
    const r = await tx.query<AgentRunRow>(
      `UPDATE agent_runs SET history = $3::jsonb, step_count = $4, consecutive_protocol_errors = $5,
              pending = $6::jsonb, memo = $7::jsonb, active_ms = $8, updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = 'running' RETURNING *`,
      [
        this.run.id,
        this.owner,
        toJsonb(next.history),
        next.step_count,
        next.consecutive_protocol_errors,
        next.pending ? toJsonb(next.pending) : null,
        toJsonb(next.memo ?? {}),
        Math.round(this.elapsed()),
      ],
    );
    if (!r.rows[0]) throw new LeaseLost();
    return r.rows[0];
  }

  private async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.ensure();
    return this.ctx.db.tx(fn);
  }

  private async insertStep(
    tx: Tx,
    step: {
      stepNo: number;
      kind: 'tool_use' | 'final' | 'protocol_error';
      block?: ToolUseBlock | null;
      resultSummary?: string | null;
      isError?: boolean;
      errorCode?: string | null;
      auditVerdict?: string | null;
      rawResponse: string;
      status?: 'executing' | 'done';
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO agent_steps (run_id, step_no, kind, tool_use_id, name, input, result_summary, is_error, error_code,
                                audit_verdict, raw_response, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (run_id, step_no) DO NOTHING`,
      [
        this.run.id,
        step.stepNo,
        step.kind,
        step.block?.id ?? null,
        step.block?.name ?? null,
        step.block ? toJsonb(step.block.input) : null,
        step.resultSummary ?? null,
        step.isError ?? false,
        step.errorCode ?? null,
        step.auditVerdict ?? null,
        truncateBytes(step.rawResponse.replace(/\u0000/g, ''), RAW_LIMIT),
        step.status ?? 'done',
      ],
    );
    tx.emit('agent_step', { runId: this.run.id, groupId: this.run.group_id, stepNo: step.stepNo });
  }

  /** 结束 run；同一事务里若有待处理消息立即建下一个 run */
  private async end(reason: EndReason, summary: string | null, extra?: (tx: Tx) => Promise<void>): Promise<void> {
    const status = END_STATUS[reason];
    await this.tx(async (tx) => {
      // 先锁群行，与调度器保持同样的加锁顺序（群 → run），避免死锁
      await tx.query('SELECT 1 FROM groups WHERE id = $1 FOR UPDATE', [this.run.group_id]);
      if (extra) await extra(tx);
      const r = await tx.query<AgentRunRow>(
        `UPDATE agent_runs SET status = $3, end_reason = $4, summary = coalesce($5, summary), pending = NULL,
                active_ms = $6, ended_at = now(), updated_at = now(), lease_owner = NULL, lease_until = NULL
          WHERE id = $1 AND lease_owner = $2 AND status = 'running' RETURNING *`,
        [this.run.id, this.owner, status, reason, summary, Math.round(this.elapsed())],
      );
      if (!r.rows[0]) throw new LeaseLost();
      this.run = r.rows[0];
      emitRun(tx, this.run);
      tx.emit('group_updated', { groupId: this.run.group_id });
      const next = await createRunFromPending(tx, this.run.group_id);
      if (next) tx.afterCommit(() => this.ctx.signals.wake('agent'));
    });
  }

  async execute(): Promise<void> {
    for (;;) {
      this.ensure();
      const fresh = await this.ctx.db.one<AgentRunRow>('SELECT * FROM agent_runs WHERE id = $1', [this.run.id]);
      if (!fresh || fresh.status !== 'running' || fresh.lease_owner !== this.owner) return;
      this.run = fresh;

      if (this.run.pending) {
        await this.executePending(this.run.pending);
        continue;
      }
      // 每一步结束后检查外部状态：群不可写或 agent 被关闭 → cancelled
      const group = await this.ctx.db.one<{ status: string; agent_enabled: boolean }>(
        'SELECT status, agent_enabled FROM groups WHERE id = $1',
        [this.run.group_id],
      );
      if (!group || group.status !== 'active' || !group.agent_enabled) return this.end('cancelled', null);
      if (this.run.step_count >= this.ctx.config.agentMaxSteps) return this.end('budget_exhausted', null);
      if (this.remaining() <= 0) return this.end('wall_clock', null);
      const finished = await this.turn();
      if (finished) return;
    }
  }

  /** 一步 = 一次 /agent/turn 往返；返回 true 表示 run 已结束 */
  private async turn(): Promise<boolean> {
    const stepNo = this.run.step_count + 1;
    const limitedByClock = this.remaining() < this.ctx.config.agentTurnTimeoutMs;
    const timeout = Math.max(1, Math.min(this.ctx.config.agentTurnTimeoutMs, this.remaining()));
    const res = await this.ctx.agent.turn({ runId: this.run.id, tools: TOOLS, messages: this.run.history }, timeout, this.signal);
    this.ensure();
    if (res.timedOut && limitedByClock) {
      await this.end('wall_clock', null);
      return true;
    }
    if (res.timedOut) {
      // 超时后才到的响应已被丢弃
      await this.protocolError(stepNo, 'TURN_TIMEOUT', `no response within ${timeout}ms`, '');
      return this.run.status !== 'running';
    }
    if (res.status === 0) {
      await this.protocolError(stepNo, 'BAD_JSON', `agent service request failed: ${res.error ?? 'network error'}`, res.body);
      return this.run.status !== 'running';
    }
    const parsed = parseTurnResponse(res.status, res.body);
    if (parsed.kind === 'bad_json') {
      await this.protocolError(stepNo, 'BAD_JSON', parsed.reason, res.body);
      return this.run.status !== 'running';
    }
    if (parsed.kind === 'end_turn') {
      // end_turn：结束，text 存为 summary，不发到群里
      await this.tx(async (tx) => {
        await this.insertStep(tx, { stepNo, kind: 'final', resultSummary: summarize(parsed.text), rawResponse: res.body });
        this.run = await this.saveRun(tx, { step_count: stepNo, consecutive_protocol_errors: 0 });
      });
      await this.end('final', parsed.text);
      return true;
    }

    const block = parsed.block;
    if (this.usedToolUseIds().has(block.id)) {
      await this.protocolError(stepNo, 'DUPLICATE_TOOL_USE_ID', `tool_use.id ${block.id} was already used in this run`, res.body);
      return this.run.status !== 'running';
    }
    if (!isKnownTool(block.name)) {
      await this.toolProtocolError(stepNo, block, 'UNKNOWN_TOOL', `unknown tool ${block.name}`, res.body, {
        hint: `available tools: ${TOOLS.map((t) => t.name).join(', ')}`,
      });
      return this.run.status !== 'running';
    }
    const invalid = validateToolInput(block.name, block.input);
    if (invalid) {
      await this.toolProtocolError(stepNo, block, 'INVALID_INPUT', invalid, res.body, { hint: 'input must match input_schema' });
      return this.run.status !== 'running';
    }

    const assistant = { role: 'assistant', content: [block] };
    if (block.name === 'finish') {
      const summary = String((block.input as { summary: string }).summary);
      await this.tx(async (tx) => {
        await this.insertStep(tx, {
          stepNo,
          kind: 'final',
          block,
          resultSummary: summarize(JSON.stringify({ ok: true })),
          rawResponse: res.body,
        });
        const history = [
          ...this.run.history,
          assistant,
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ ok: true }) }] },
        ];
        this.run = await this.saveRun(tx, { history, step_count: stepNo, consecutive_protocol_errors: 0 });
      });
      await this.end('final', summary);
      return true;
    }

    // 合法的工具调用：先落「待执行」再执行，崩溃后从这里继续
    const pending: PendingTool = { stepNo, block, stage: 'new' };
    await this.tx(async (tx) => {
      await this.insertStep(tx, { stepNo, kind: 'tool_use', block, rawResponse: res.body, status: 'executing' });
      this.run = await this.saveRun(tx, {
        history: [...this.run.history, assistant],
        step_count: stepNo,
        consecutive_protocol_errors: 0,
        pending,
      });
    });
    return false;
  }

  private usedToolUseIds(): Set<string> {
    const ids = new Set<string>();
    for (const m of this.run.history) {
      if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
      for (const b of m.content) if (b?.type === 'tool_use' && typeof b.id === 'string') ids.add(b.id);
    }
    return ids;
  }

  /** 坏响应 / 重复 id / 超时：不追加 assistant 块，追加一条 PROTOCOL_ERROR 文本 */
  private async protocolError(stepNo: number, code: string, reason: string, raw: string): Promise<void> {
    const consecutive = this.run.consecutive_protocol_errors + 1;
    await this.tx(async (tx) => {
      await this.insertStep(tx, {
        stepNo,
        kind: 'protocol_error',
        isError: true,
        errorCode: code,
        resultSummary: summarize(`${code}: ${reason}`),
        rawResponse: raw,
      });
      const history = [...this.run.history, { role: 'user', content: [{ type: 'text', text: `PROTOCOL_ERROR ${code}: ${reason}` }] }];
      this.run = await this.saveRun(tx, { history, step_count: stepNo, consecutive_protocol_errors: consecutive });
    });
    if (consecutive >= this.ctx.config.agentMaxConsecutiveProtocolErrors) await this.end('protocol_errors', null);
  }

  /** 未知工具 / 入参不合 schema：正常追加 assistant 块，再追加 is_error 的 tool_result；计入连续协议错误 */
  private async toolProtocolError(
    stepNo: number,
    block: ToolUseBlock,
    code: string,
    message: string,
    raw: string,
    extra: { hint?: string },
  ): Promise<void> {
    const consecutive = this.run.consecutive_protocol_errors + 1;
    const content = JSON.stringify({ code, message, ...(extra.hint ? { hint: extra.hint } : {}) });
    await this.tx(async (tx) => {
      await this.insertStep(tx, {
        stepNo,
        kind: 'tool_use',
        block,
        isError: true,
        errorCode: code,
        resultSummary: summarize(`${code}: ${message}`),
        rawResponse: raw,
      });
      const history = [
        ...this.run.history,
        { role: 'assistant', content: [block] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, is_error: true, content }] },
      ];
      this.run = await this.saveRun(tx, { history, step_count: stepNo, consecutive_protocol_errors: consecutive });
    });
    if (consecutive >= this.ctx.config.agentMaxConsecutiveProtocolErrors) await this.end('protocol_errors', null);
  }

  private async executePending(pending: PendingTool): Promise<void> {
    let outcome: ToolOutcome;
    switch (pending.block.name) {
      case 'get_recent_messages':
        outcome = await this.getRecentMessages(pending);
        break;
      case 'send_message':
        outcome = await this.sendMessage(pending);
        break;
      case 'kick_user':
        outcome = await this.kickUser(pending);
        break;
      default:
        outcome = toolError('UNKNOWN_TOOL', `unknown tool ${pending.block.name}`);
    }
    this.ensure();

    if (outcome.kind === 'blocked') {
      // 审计 3 次都拿不到结论：工具不执行，run blocked，推事件通知操作员
      await this.end('audit_blocked', null, async (tx) => {
        await this.finishStep(tx, pending.stepNo, {
          resultSummary: 'audit unavailable after 3 attempts; tool not executed',
          isError: true,
          errorCode: 'AUDIT_UNAVAILABLE',
          auditVerdict: 'unavailable',
        });
      });
      return;
    }
    if (outcome.kind === 'wall_clock') {
      await this.end('wall_clock', null, async (tx) => {
        await this.finishStep(tx, pending.stepNo, {
          resultSummary: 'wall clock exhausted before the tool completed',
          isError: true,
          errorCode: 'WALL_CLOCK',
          auditVerdict: null,
        });
      });
      return;
    }

    const content = limitResultContent(outcome.content);
    const toolResult: Record<string, unknown> = { type: 'tool_result', tool_use_id: pending.block.id, content };
    if (outcome.isError) toolResult.is_error = true;
    const memo = this.nextMemo(pending.block.name);
    await this.tx(async (tx) => {
      await this.finishStep(tx, pending.stepNo, {
        resultSummary: summarize(outcome.isError ? `${outcome.errorCode}: ${String(outcome.content.message ?? '')}` : content),
        isError: outcome.isError,
        errorCode: outcome.errorCode ?? null,
        auditVerdict: outcome.auditVerdict ?? null,
      });
      this.run = await this.saveRun(tx, {
        history: [...this.run.history, { role: 'user', content: [toolResult] }],
        pending: null,
        memo,
      });
    });
  }

  private nextMemo(toolName: string): RunMemo {
    const memo = { ...(this.run.memo ?? {}) };
    if (toolName !== 'get_recent_messages') {
      memo.lastRecentKey = null;
      memo.recentRepeats = 0;
    }
    memo.lastToolName = toolName;
    return memo;
  }

  private async finishStep(
    tx: Tx,
    stepNo: number,
    r: { resultSummary: string; isError: boolean; errorCode: string | null; auditVerdict: string | null },
  ): Promise<void> {
    await tx.query(
      `UPDATE agent_steps SET result_summary = $3, is_error = $4, error_code = $5, audit_verdict = $6, status = 'done', updated_at = now()
        WHERE run_id = $1 AND step_no = $2`,
      [this.run.id, stepNo, summarize(r.resultSummary), r.isError, r.errorCode, r.auditVerdict],
    );
    tx.emit('agent_step', { runId: this.run.id, groupId: this.run.group_id, stepNo });
  }

  private async savePending(pending: PendingTool): Promise<void> {
    await this.tx(async (tx) => {
      this.run = await this.saveRun(tx, { pending });
    });
  }

  // ---------------- get_recent_messages ----------------

  private async getRecentMessages(pending: PendingTool): Promise<ToolOutcome> {
    const requested = Number((pending.block.input as { limit: number }).limit);
    const limit = Math.max(1, Math.min(MAX_RECENT, Math.floor(requested)));
    const rows = await this.ctx.db.query<MessageRow>(
      `SELECT * FROM messages WHERE group_id = $1 AND msg_id IS NOT NULL ORDER BY sent_at DESC, id DESC LIMIT $2`,
      [this.run.group_id, limit],
    );
    let truncated = false;
    const messages = rows.rows.reverse().map((m) => {
      const text = truncateChars(m.text, TEXT_LIMIT);
      if (text !== m.text) truncated = true;
      return { msgId: m.msg_id, senderPlatformUserId: m.sender_platform_user_id, isOwn: m.is_own, text, sentAt: m.sent_at.toISOString() };
    });
    const content: Record<string, unknown> = { messages, truncated };

    // 连续用同样入参调用、且期间没有新消息：先提示，第三次起拒绝，引导模型结束
    const key = JSON.stringify({ limit });
    const maxId = rows.rows.reduce((acc, m) => Math.max(acc, m.id), 0);
    const memo = this.run.memo ?? {};
    const repeated = memo.lastToolName === 'get_recent_messages' && memo.lastRecentKey === key && memo.lastRecentMaxId === maxId;
    const repeats = repeated ? (memo.recentRepeats ?? 0) + 1 : 0;
    this.run.memo = { ...memo, lastRecentKey: key, lastRecentMaxId: maxId, recentRepeats: repeats };
    if (repeats >= 2) {
      return toolError(
        'POLICY_DENIED',
        'get_recent_messages was called repeatedly with the same input and nothing changed',
        'You already have the latest messages. Call finish now.',
      );
    }
    if (repeats === 1) content.hint = 'No new messages since your previous identical call. Call finish if you are done.';
    return ok(content);
  }

  // ---------------- 审计 ----------------

  /** 同一次工具调用最多尝试 3 次；单次失败不返回给 agent、不计步；耗时计入 60 秒 */
  private async audit(pending: PendingTool, text: string): Promise<'pass' | 'fail' | 'blocked' | 'wall_clock'> {
    let attempts = pending.auditAttempts ?? 0;
    while (attempts < this.ctx.config.agentAuditAttempts) {
      if (this.remaining() <= 0) return 'wall_clock';
      attempts += 1;
      await this.savePending({ ...pending, stage: 'audit', auditAttempts: attempts });
      const timeout = Math.max(1, Math.min(this.ctx.config.agentAuditTimeoutMs, this.remaining()));
      const res = await this.ctx.agent.audit({ text, groupId: this.run.group_id }, timeout, this.signal);
      this.ensure();
      const parsed = parseAuditResponse(res.status, res.body);
      if (parsed.verdict) return parsed.verdict;
      if (this.remaining() <= 0) return 'wall_clock';
      await sleep(Math.min(200, Math.max(0, this.remaining())), this.signal);
    }
    return 'blocked';
  }

  // ---------------- send_message ----------------

  private async pickSendAccount(): Promise<{ id: string; platform_user_id: string } | null> {
    return this.ctx.db.one(
      `SELECT a.id, a.platform_user_id
         FROM group_members gm JOIN accounts a ON a.id = gm.account_id
        WHERE gm.group_id = $1 AND gm.state = 'in' AND a.status = 'online'
        ORDER BY CASE gm.role WHEN 'admin' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, a.id
        LIMIT 1`,
      [this.run.group_id],
    );
  }

  private async sendMessage(pending: PendingTool): Promise<ToolOutcome> {
    const { text, idempotency_key: key } = pending.block.input as { text: string; idempotency_key: string };

    // 已经入队（含崩溃前入队）的同一次调用：只等结果，不重复发送
    if (pending.stage === 'sending' && pending.messageId) return this.waitForDelivery(pending.messageId, 'pass');

    // 幂等：同一 run 里相同 key 的第二次及以后调用不再发送、不再审计，返回那条消息的当前状态
    const prior = await this.ctx.db.one<{ message_id: number }>(
      'SELECT message_id FROM agent_idempotency WHERE run_id = $1 AND idempotency_key = $2',
      [this.run.id, key],
    );
    if (prior) return this.waitForDelivery(prior.message_id, null);

    if (!(await this.pickSendAccount())) {
      return toolError('NO_AVAILABLE_ACCOUNT', 'no online service account in this group can send');
    }
    const verdict = await this.audit(pending, text);
    if (verdict === 'blocked') return { kind: 'blocked' };
    if (verdict === 'wall_clock') return { kind: 'wall_clock' };
    if (verdict === 'fail') return toolError('AUDIT_REJECTED', 'the message was rejected by audit', undefined, 'fail');

    const account = await this.pickSendAccount();
    if (!account) return toolError('NO_AVAILABLE_ACCOUNT', 'no online service account in this group can send', undefined, 'pass');

    let messageId = 0;
    await this.tx(async (tx) => {
      const existing = await tx.query<{ message_id: number }>(
        'SELECT message_id FROM agent_idempotency WHERE run_id = $1 AND idempotency_key = $2 FOR UPDATE',
        [this.run.id, key],
      );
      if (existing.rows[0]) {
        messageId = existing.rows[0].message_id;
      } else {
        const msg = await enqueueOwnMessage(
          tx,
          {
            groupId: this.run.group_id,
            accountId: account.id,
            platformUserId: account.platform_user_id,
            text,
            source: 'agent',
            agentRunId: this.run.id,
          },
          this.ctx.signals,
        );
        messageId = msg.id;
        await tx.query('INSERT INTO agent_idempotency (run_id, idempotency_key, message_id) VALUES ($1, $2, $3)', [
          this.run.id,
          key,
          msg.id,
        ]);
      }
      // 入队与「已对外产生效果」的标记同一事务提交：恢复时不会再发一次
      this.run = await this.saveRun(tx, { pending: { ...pending, stage: 'sending', messageId } });
    });
    return this.waitForDelivery(messageId, 'pass');
  }

  /** 等消息变为 accepted / sent（最多 5 秒）；failed → GROUP_UNREACHABLE / SEND_FAILED；超时 → SEND_TIMEOUT */
  private async waitForDelivery(messageId: number, auditVerdict: string | null): Promise<ToolOutcome> {
    const deadline = Date.now() + Math.max(0, Math.min(this.ctx.config.agentSendWaitMs, this.remaining()));
    for (;;) {
      const m = await this.ctx.db.one<MessageRow>('SELECT * FROM messages WHERE id = $1', [messageId]);
      if (!m) return toolError('SEND_FAILED', 'message record not found', undefined, auditVerdict);
      switch (m.delivery_status) {
        case 'accepted':
        case 'sent':
          return ok({ clientMsgId: m.client_msg_id, deliveryStatus: m.delivery_status }, auditVerdict);
        case 'failed':
        case 'cancelled':
          if (m.fail_code === 'GROUP_WRITE_FORBIDDEN' || m.fail_code === 'GROUP_UNREACHABLE') {
            return toolError('GROUP_UNREACHABLE', `the group is not writable (${m.fail_code})`, undefined, auditVerdict);
          }
          return toolError('SEND_FAILED', `message ${m.delivery_status}: ${m.fail_code ?? 'unknown'}`, undefined, auditVerdict);
      }
      if (Date.now() >= deadline) {
        return toolError(
          'SEND_TIMEOUT',
          `delivery could not be confirmed within ${this.ctx.config.agentSendWaitMs}ms (status ${m.delivery_status})`,
          'Do not resend with a new idempotency_key; reuse the same key to check its status.',
          auditVerdict,
        );
      }
      await sleep(100, this.signal);
      this.ensure();
    }
  }

  // ---------------- kick_user ----------------

  private async kickUser(pending: PendingTool): Promise<ToolOutcome> {
    const { platform_user_id: target, reason } = pending.block.input as { platform_user_id: string; reason: string };
    const group = await this.ctx.db.one<{ gateway_group_id: string; auto_kick_enabled: boolean }>(
      'SELECT gateway_group_id, auto_kick_enabled FROM groups WHERE id = $1',
      [this.run.group_id],
    );
    if (!group) return toolError('GROUP_UNREACHABLE', 'group not found');

    // 崩溃前已经发出 kick：先看成员列表，已移除即视为成功，绝不记成失败
    if (pending.stage === 'kicking' && pending.kickAccountId) {
      const present = await this.isGatewayMember(group.gateway_group_id, target);
      if (present === false) return ok({ kicked: true }, 'pass');
      return this.doKick(pending, group.gateway_group_id, pending.kickAccountId, target);
    }

    if (!group.auto_kick_enabled) return toolError('POLICY_DENIED', 'autoKickEnabled is false for this group');
    const own = await ownPlatformUserIds(this.ctx.db);
    if (own.includes(target)) return toolError('POLICY_DENIED', 'cannot kick one of our own service accounts');

    const pick = () =>
      this.ctx.db.one<{ id: string }>(
        `SELECT a.id FROM group_members gm JOIN accounts a ON a.id = gm.account_id
          WHERE gm.group_id = $1 AND gm.state = 'in' AND a.status = 'online' AND gm.role IN ('creator', 'admin')
          ORDER BY CASE gm.role WHEN 'creator' THEN 0 ELSE 1 END, a.id LIMIT 1`,
        [this.run.group_id],
      );
    if (!(await pick())) return toolError('NO_AVAILABLE_ACCOUNT', 'no online creator/admin account in this group');

    const verdict = await this.audit(pending, JSON.stringify({ action: 'kick', platform_user_id: target, reason }));
    if (verdict === 'blocked') return { kind: 'blocked' };
    if (verdict === 'wall_clock') return { kind: 'wall_clock' };
    if (verdict === 'fail') return toolError('AUDIT_REJECTED', 'the kick was rejected by audit', undefined, 'fail');

    const account = await pick();
    if (!account) return toolError('NO_AVAILABLE_ACCOUNT', 'no online creator/admin account in this group', undefined, 'pass');
    if ((await this.isGatewayMember(group.gateway_group_id, target)) === false) {
      return toolError('INVALID_INPUT', `${target} is not a member of the group`, undefined, 'pass');
    }
    const next: PendingTool = { ...pending, stage: 'kicking', kickAccountId: account.id };
    await this.savePending(next);
    return this.doKick(next, group.gateway_group_id, account.id, target);
  }

  private async isGatewayMember(gatewayGroupId: string, platformUserId: string): Promise<boolean | null> {
    try {
      const list = await this.ctx.gateway.members(gatewayGroupId);
      return list.some((m) => m.platformUserId === platformUserId);
    } catch {
      return null;
    }
  }

  private async doKick(pending: PendingTool, gatewayGroupId: string, accountId: string, target: string): Promise<ToolOutcome> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.ctx.gateway.kick(gatewayGroupId, accountId, target);
        return ok({ kicked: true }, 'pass');
      } catch (err) {
        this.ensure();
        const e = err instanceof GatewayError ? err : new GatewayError('network', 0, 'NETWORK_ERROR', null, String(err));
        if (e.code === 'OWNER_LEFT' || e.code === 'NO_PERMISSION') return toolError(e.code, `gateway refused the kick: ${e.code}`, undefined, 'pass');
        const terminal = terminalStatusForGatewayCode(e.code);
        if (terminal) {
          await this.ctx.db.tx((tx) => enterTerminal(tx, accountId, terminal as 'suspended' | 'session_expired'));
          return toolError('SEND_FAILED', `the executing account became ${terminal}`, undefined, 'pass');
        }
        if (e.code === 'ACCOUNT_OFFLINE') return toolError('NO_AVAILABLE_ACCOUNT', 'the executing account went offline', undefined, 'pass');
        if (e.code === 'NOT_MEMBER') return toolError('INVALID_INPUT', `${target} is not a member of the group`, undefined, 'pass');
        if (e.outcomeUnknown || e.notProcessed || (e.kind === 'http' && e.status >= 500)) {
          // 结果未知：网关保证 2 秒内收敛，用成员列表判断
          const until = Date.now() + 2_500;
          while (Date.now() < until) {
            if ((await this.isGatewayMember(gatewayGroupId, target)) === false) return ok({ kicked: true }, 'pass');
            await sleep(250, this.signal);
            this.ensure();
          }
          continue;
        }
        return toolError('SEND_FAILED', `kick failed: ${e.code}`, undefined, 'pass');
      }
    }
    return toolError('SEND_TIMEOUT', 'kick could not be confirmed', undefined, 'pass');
  }
}

/** 认领 running 且租约过期（或新建）的 run 并执行 */
export class AgentRunner {
  private readonly active = new Map<string, { exec: RunExecution; done: Promise<void> }>();

  constructor(private readonly ctx: AppContext) {}

  async runOnce(): Promise<boolean> {
    const claimed = await this.ctx.db.query<AgentRunRow>(
      `UPDATE agent_runs SET lease_owner = $1, lease_until = now() + make_interval(secs => $2)
        WHERE id IN (
          SELECT id FROM agent_runs
           WHERE status = 'running' AND (lease_until IS NULL OR lease_until < now())
           ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [this.ctx.config.instanceId, this.ctx.config.leaseMs / 1000],
    );
    for (const run of claimed.rows) if (!this.active.has(run.id)) this.start(run);
    return false;
  }

  get activeCount(): number {
    return this.active.size;
  }

  async stop(): Promise<void> {
    const all = [...this.active.values()];
    for (const a of all) a.exec.controller.abort();
    await Promise.all(all.map((a) => a.done));
    await this.ctx.db
      .query(`UPDATE agent_runs SET lease_until = now() WHERE lease_owner = $1 AND status = 'running'`, [this.ctx.config.instanceId])
      .catch(() => undefined);
  }

  private start(run: AgentRunRow): void {
    const exec = new RunExecution(this.ctx, run, this.ctx.config.instanceId, new AbortController());
    const heartbeat = setInterval(() => void exec.heartbeat().catch(() => undefined), Math.max(200, this.ctx.config.leaseMs / 3));
    const done = (async () => {
      try {
        await exec.execute();
      } catch (err) {
        if (!(err instanceof LeaseLost) && !exec.signal.aborted) {
          this.ctx.log.warn({ err, runId: run.id }, 'agent run iteration failed; will resume after lease expiry');
        }
      } finally {
        clearInterval(heartbeat);
        // 停机前把累计时长写回（停机期间不计时）
        if (exec.signal.aborted) {
          await this.ctx.db
            .query(`UPDATE agent_runs SET active_ms = $3 WHERE id = $1 AND lease_owner = $2 AND status = 'running'`, [
              run.id,
              this.ctx.config.instanceId,
              Math.round(exec.elapsed()),
            ])
            .catch(() => undefined);
        }
        this.active.delete(run.id);
      }
    })();
    this.active.set(run.id, { exec, done });
  }
}
