import type { Tx } from '../db/db.js';
import { iso } from '../lib/time.js';
import type { ToolUseBlock } from './protocol.js';

export type RunStatus = 'running' | 'finished' | 'failed' | 'blocked' | 'cancelled';
export type EndReason = 'final' | 'budget_exhausted' | 'wall_clock' | 'protocol_errors' | 'audit_blocked' | 'cancelled';

export interface PendingTool {
  stepNo: number;
  block: ToolUseBlock;
  /** new → audit（审计中）→ sending / kicking（已对外产生效果，恢复时不能重做） */
  stage: 'new' | 'audit' | 'sending' | 'kicking';
  auditAttempts?: number;
  messageId?: number;
  kickAccountId?: string;
}

export interface RunMemo {
  lastToolName?: string;
  lastRecentKey?: string | null;
  lastRecentMaxId?: number | null;
  recentRepeats?: number;
}

export interface AgentRunRow {
  id: string;
  group_id: string;
  status: RunStatus;
  end_reason: EndReason | null;
  summary: string | null;
  trigger_message_ids: number[];
  trigger_messages: unknown[];
  history: any[];
  step_count: number;
  consecutive_protocol_errors: number;
  active_ms: number;
  pending: PendingTool | null;
  memo: RunMemo;
  lease_owner: string | null;
  lease_until: Date | null;
  created_at: Date;
  updated_at: Date;
  ended_at: Date | null;
}

export interface AgentStepRow {
  run_id: string;
  step_no: number;
  kind: 'tool_use' | 'final' | 'protocol_error';
  tool_use_id: string | null;
  name: string | null;
  input: unknown;
  result_summary: string | null;
  is_error: boolean;
  error_code: string | null;
  audit_verdict: string | null;
  raw_response: string | null;
  status: 'executing' | 'done';
  created_at: Date;
}

export function runSummaryDto(row: AgentRunRow) {
  return {
    id: row.id,
    groupId: row.group_id,
    status: row.status,
    endReason: row.status === 'running' ? null : row.end_reason,
    summary: row.summary,
    stepCount: row.step_count,
    createdAt: iso(row.created_at),
    endedAt: iso(row.ended_at),
  };
}

export function stepDto(row: AgentStepRow) {
  return {
    stepNo: row.step_no,
    kind: row.kind,
    toolUseId: row.tool_use_id,
    name: row.name,
    input: row.input ?? null,
    resultSummary: row.result_summary,
    isError: row.is_error,
    errorCode: row.error_code,
    auditVerdict: row.audit_verdict,
    rawResponse: row.raw_response,
    status: row.status,
    createdAt: iso(row.created_at),
  };
}

export function emitRun(tx: Tx, row: Pick<AgentRunRow, 'id' | 'group_id' | 'status' | 'end_reason'>): void {
  tx.emit('agent_run', {
    runId: row.id,
    groupId: row.group_id,
    status: row.status,
    endReason: row.status === 'running' ? null : row.end_reason,
  });
}

/** 结束状态与 endReason 的对应关系（题目 2.3） */
export const END_STATUS: Record<EndReason, RunStatus> = {
  final: 'finished',
  budget_exhausted: 'failed',
  wall_clock: 'failed',
  protocol_errors: 'failed',
  audit_blocked: 'blocked',
  cancelled: 'cancelled',
};
