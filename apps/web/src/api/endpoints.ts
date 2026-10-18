import { apiClient } from './instance';
import type {
  Account,
  AgentRunDetail,
  AgentRunSummary,
  AuthPayload,
  AuthUser,
  ConnectResult,
  CreateGroupRequest,
  CreateSequenceResult,
  Group,
  Job,
  JobAccepted,
  MessagesPage,
  PatchGroupRequest,
  PreflightResult,
  SendMessageAccepted,
  SendMessageRequest,
  Sequence,
  SequenceRunCreated,
  SequenceRunDetail,
  SequenceRunRequest,
  SequenceRunSummary,
  TransitionResult,
  AccountStatus,
} from './types';

const enc = encodeURIComponent;

export const api = {
  // ---- 认证 ----
  login: (username: string, password: string) =>
    apiClient.request<AuthPayload>('/api/auth/login', { method: 'POST', body: { username, password }, auth: false }),
  logout: () => apiClient.request<void>('/api/auth/logout', { method: 'POST' }),
  me: () => apiClient.get<AuthUser>('/api/auth/me'),
  refresh: () => apiClient.refresh(),

  // ---- 账号 ----
  listAccounts: () => apiClient.get<Account[]>('/api/accounts'),
  connectAccount: (id: string) => apiClient.post<ConnectResult>(`/api/accounts/${enc(id)}/connect`),
  transitionAccount: (id: string, to: AccountStatus, expectedFrom: AccountStatus) =>
    apiClient.post<TransitionResult>(`/api/accounts/${enc(id)}/transition`, { to, expectedFrom }),

  // ---- 群 ----
  listGroups: () => apiClient.get<Group[]>('/api/groups'),
  getGroup: (id: string) => apiClient.get<Group>(`/api/groups/${enc(id)}`),
  createGroup: (body: CreateGroupRequest) => apiClient.post<JobAccepted>('/api/groups', body),
  patchGroup: (id: string, body: PatchGroupRequest) => apiClient.patch<Group>(`/api/groups/${enc(id)}`, body),
  sendMessage: (id: string, body: SendMessageRequest) =>
    apiClient.post<SendMessageAccepted>(`/api/groups/${enc(id)}/send`, body),
  leaveAll: (id: string) => apiClient.post<JobAccepted>(`/api/groups/${enc(id)}/leave-all`),
  getMessages: (id: string, params: { before?: string | null; limit?: number } = {}) =>
    apiClient.get<MessagesPage>(`/api/groups/${enc(id)}/messages`, {
      before: params.before ?? undefined,
      limit: params.limit ?? 50,
    }),
  listAgentRuns: (groupId: string) => apiClient.get<AgentRunSummary[]>(`/api/groups/${enc(groupId)}/agent-runs`),
  listSequenceRuns: (groupId: string) =>
    apiClient.get<SequenceRunSummary[]>(`/api/groups/${enc(groupId)}/sequence-runs`),
  preflightSequence: (groupId: string, body: SequenceRunRequest) =>
    apiClient.post<PreflightResult>(`/api/groups/${enc(groupId)}/sequence-runs/preflight`, body),
  startSequenceRun: (groupId: string, body: SequenceRunRequest) =>
    apiClient.post<SequenceRunCreated>(`/api/groups/${enc(groupId)}/sequence-runs`, body),

  // ---- Job ----
  getJob: (id: string) => apiClient.get<Job>(`/api/jobs/${enc(id)}`),

  // ---- Agent ----
  getAgentRun: (id: string) => apiClient.get<AgentRunDetail>(`/api/agent-runs/${enc(id)}`),

  // ---- 序列 ----
  listSequences: () => apiClient.get<Sequence[]>('/api/sequences'),
  createSequence: (body: unknown) => apiClient.post<CreateSequenceResult>('/api/sequences', body),
  getSequenceRun: (id: string) => apiClient.get<SequenceRunDetail>(`/api/sequence-runs/${enc(id)}`),
};
