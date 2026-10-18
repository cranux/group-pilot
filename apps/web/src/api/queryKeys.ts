// React Query 的 key。各类资源使用不同的根，避免前缀失效时误伤（例如失效群详情不应重拉时间线）。

export const qk = {
  accounts: () => ['accounts'] as const,
  groupsList: () => ['groups', 'list'] as const,
  group: (id: string) => ['groups', 'detail', id] as const,
  groupDetails: () => ['groups', 'detail'] as const,
  timeline: (groupId: string) => ['timeline', groupId] as const,
  job: (id: string) => ['jobs', id] as const,
  agentRunsByGroup: (groupId: string) => ['agentRuns', 'byGroup', groupId] as const,
  agentRun: (id: string) => ['agentRuns', 'detail', id] as const,
  sequences: () => ['sequences'] as const,
  seqRunsByGroup: (groupId: string) => ['seqRuns', 'byGroup', groupId] as const,
  seqRun: (id: string) => ['seqRuns', 'detail', id] as const,
};
