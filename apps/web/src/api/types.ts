// 前后端接口契约（docs/需求分析.md 第 5 节）对应的 DTO 类型。

export type Role = 'admin' | 'viewer';

export interface AuthUser {
  username: string;
  role: Role;
}

export interface AuthPayload {
  accessToken: string;
  user: AuthUser;
}

// ---- 账号 ----

export type AccountStatus =
  | 'idle'
  | 'online'
  | 'rate_limited'
  | 'disconnected'
  | 'suspended'
  | 'session_expired';

export interface Account {
  id: string;
  status: AccountStatus;
  platformUserId: string | null;
  rateLimitedUntil: string | null;
  allowedTransitions?: AccountStatus[];
}

export interface ConnectResult {
  status: AccountStatus;
  platformUserId: string | null;
}

export interface TransitionResult {
  status: AccountStatus;
}

// ---- 群 ----

export type GroupStatus = 'active' | 'unreachable' | 'left';
export type MemberRole = 'creator' | 'admin' | 'member';

export interface GroupMember {
  accountId: string;
  platformUserId: string | null;
  role: MemberRole;
}

export interface ExternalMember {
  platformUserId: string;
}

export interface Group {
  id: string;
  gatewayGroupId: string | null;
  status: GroupStatus;
  creatorAccountId: string;
  agentEnabled: boolean;
  autoKickEnabled: boolean;
  members: GroupMember[];
  externalMembers?: ExternalMember[];
  activeSequenceRunId: string | null;
  activeAgentRunId: string | null;
  createdAt?: string | null;
}

export interface CreateGroupRequest {
  creatorAccountId: string;
  memberAccountIds: string[];
}

export interface PatchGroupRequest {
  agentEnabled?: boolean;
  autoKickEnabled?: boolean;
}

export interface JobAccepted {
  jobId: string;
}

export type JobType = 'create_group' | 'leave_all';
export type JobStatus = 'running' | 'finished' | 'failed';

export interface JobError {
  step: string;
  code: string;
}

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  errors: JobError[];
  groupId: string | null;
}

// ---- 消息 ----

export type DeliveryStatus = 'queued' | 'accepted' | 'sent' | 'failed' | 'unknown' | 'cancelled';
export type MessageSource = 'inbound' | 'operator' | 'agent' | 'sequence';

export interface MessageItem {
  id: string;
  msgId: string | null;
  clientMsgId: string | null;
  senderPlatformUserId: string | null;
  senderAccountId: string | null;
  isOwn: boolean;
  text: string;
  sentAt: string;
  deliveryStatus: DeliveryStatus | null;
  failCode: string | null;
  mediaUrl: string | null;
  localFilePath: string | null;
  source: MessageSource;
}

export interface MessagesPage {
  items: MessageItem[];
  nextCursor: string | null;
}

export interface SendMessageRequest {
  accountId: string;
  text: string;
}

export interface SendMessageAccepted {
  clientMsgId: string;
}

// ---- Agent ----

export type AgentRunStatus = 'running' | 'finished' | 'failed' | 'blocked' | 'cancelled';
export type AgentEndReason =
  | 'final'
  | 'budget_exhausted'
  | 'wall_clock'
  | 'protocol_errors'
  | 'audit_blocked'
  | 'cancelled';

export interface AgentRunSummary {
  id: string;
  groupId: string;
  status: AgentRunStatus;
  endReason: AgentEndReason | string | null;
  summary: string | null;
  stepCount: number;
  createdAt: string;
  endedAt: string | null;
}

export interface TriggerMessage {
  msgId: string;
  senderPlatformUserId: string | null;
  text: string;
  sentAt: string;
}

export type AgentStepKind = 'tool_use' | 'final' | 'protocol_error';
export type AuditVerdict = 'pass' | 'fail' | 'unavailable';

export interface AgentStep {
  stepNo: number;
  kind: AgentStepKind;
  toolUseId: string | null;
  name: string | null;
  input: unknown;
  resultSummary: string | null;
  isError: boolean;
  errorCode: string | null;
  auditVerdict: AuditVerdict | null;
  rawResponse: string | null;
  createdAt: string | null;
}

export interface AgentRunDetail extends AgentRunSummary {
  triggerMessages: TriggerMessage[];
  steps: AgentStep[];
}

// ---- 序列 ----

export type SequenceAccountRole = 'admin' | 'member';

export interface SequenceStepDef {
  index: number;
  accountRole: SequenceAccountRole;
  text: string;
  delaySeconds: number;
}

export interface Sequence {
  id: string;
  name: string;
  steps: SequenceStepDef[];
  createdAt: string | null;
}

export interface CreateSequenceResult {
  id: string;
}

export type VarRecord = Record<string, string>;
export type StepVarRecord = Record<string, VarRecord>;

export interface SequenceRunRequest {
  sequenceId: string;
  vars: VarRecord;
  stepVars: StepVarRecord;
}

export interface PreflightStep {
  index: number;
  accountRole: SequenceAccountRole;
  text: string;
  resolvedText: string;
  resolvedVars: VarRecord;
  varSources: VarRecord;
}

export interface PreflightResult {
  steps: PreflightStep[];
}

export interface SequenceRunCreated {
  runId: string;
}

export type SequenceRunStatus = 'running' | 'finished' | 'failed' | 'stopped';
export type SequenceStepStatus = 'pending' | 'accepted' | 'sent' | 'skipped' | 'failed';

export interface SequenceRunSummary {
  id: string;
  sequenceId: string;
  sequenceName: string | null;
  status: SequenceRunStatus;
  currentStepIndex: number | null;
  createdAt: string;
  endedAt: string | null;
}

export interface SequenceRunStep {
  index: number;
  status: SequenceStepStatus;
  scheduledAt: string | null;
  sentAt: string | null;
  skippedAt: string | null;
  clientMsgId: string | null;
  resolvedVars: VarRecord | null;
  varSources: VarRecord | null;
  accountRole: SequenceAccountRole;
  text: string;
  resolvedText: string | null;
  accountId: string | null;
}

export interface SequenceRunDetail extends SequenceRunSummary {
  groupId: string;
  steps: SequenceRunStep[];
}
