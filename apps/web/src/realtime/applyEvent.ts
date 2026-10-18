import type { QueryClient } from '@tanstack/react-query';
import type { Account, MessageItem } from '../api/types';
import { qk } from '../api/queryKeys';
import { applyMessageEvent, applyMessageRemoved, type TimelineState } from '../lib/timeline';
import { ACCOUNT_STATUS, lookup } from '../lib/labels';
import type { RealtimeEvent } from './wsClient';
import type { PushInput } from '../notifications/store';

export interface Notifier {
  push(input: PushInput): unknown;
  recordInconsistency(input: { kind: string; ref: string; message: string }): void;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

/** 把一个 WS 事件应用到 React Query 缓存 / 通知区。 */
export function applyRealtimeEvent(qc: QueryClient, ev: RealtimeEvent, notifier: Notifier, now = Date.now()): void {
  const p = ev.payload;
  switch (ev.type) {
    case 'account_status_changed': {
      const accountId = str(p.accountId);
      const account = p.account as Account | undefined;
      const to = str(p.to);
      let updated = false;
      qc.setQueryData<Account[]>(qk.accounts(), (list) => {
        if (!list) return list;
        const idx = list.findIndex((a) => a.id === accountId);
        if (idx < 0) return list;
        const next = list.slice();
        if (account && typeof account === 'object') next[idx] = { ...list[idx], ...account };
        else if (to) next[idx] = { ...list[idx], status: to as Account['status'] };
        else return list;
        updated = true;
        return next;
      });
      if (!updated) void qc.invalidateQueries({ queryKey: qk.accounts() });
      break;
    }
    case 'account_terminal': {
      const accountId = str(p.accountId) ?? '?';
      notifier.push({
        level: 'warning',
        title: '账号进入终态',
        message: `账号 ${accountId} 已变为「${lookup(ACCOUNT_STATUS, str(p.status)).label}」（${str(p.status) ?? ''}），已移出所有群，排队消息已取消。`,
        sticky: true,
      });
      void qc.invalidateQueries({ queryKey: qk.accounts() });
      void qc.invalidateQueries({ queryKey: ['groups'] });
      break;
    }
    case 'inconsistency': {
      const rec = { kind: str(p.kind) ?? 'unknown', ref: str(p.ref) ?? '', message: str(p.message) ?? '' };
      notifier.recordInconsistency(rec);
      notifier.push({
        level: 'error',
        title: `数据不一致：${rec.kind}`,
        message: `${rec.ref ? `[${rec.ref}] ` : ''}${rec.message}`,
        sticky: true,
      });
      break;
    }
    case 'message': {
      const groupId = str(p.groupId);
      if (!groupId) break;
      const item = p.item as MessageItem | undefined;
      if (item && typeof item === 'object' && item.id !== undefined && item.id !== null) {
        const normalized: MessageItem = { ...item, id: String(item.id) };
        qc.setQueryData<TimelineState>(qk.timeline(groupId), (s) => (s ? applyMessageEvent(s, normalized, now) : s));
      } else {
        // 事件不带完整行：退化为重拉最新一页
        void qc.invalidateQueries({ queryKey: qk.timeline(groupId) });
      }
      break;
    }
    case 'message_removed': {
      const groupId = str(p.groupId);
      const id = str(p.id);
      if (!groupId || !id) break;
      qc.setQueryData<TimelineState>(qk.timeline(groupId), (s) => (s ? applyMessageRemoved(s, id, now) : s));
      break;
    }
    case 'agent_run': {
      const groupId = str(p.groupId);
      const runId = str(p.runId);
      if (groupId) {
        void qc.invalidateQueries({ queryKey: qk.agentRunsByGroup(groupId) });
        void qc.invalidateQueries({ queryKey: qk.group(groupId) });
      }
      if (runId) void qc.invalidateQueries({ queryKey: qk.agentRun(runId) });
      if (p.status === 'blocked') {
        notifier.push({
          level: 'error',
          title: 'Agent run 被审计阻断',
          message: `群 ${groupId ?? '?'} 的 run ${runId ?? '?'} 审计连续无结论，已 blocked（${str(p.endReason) ?? 'audit_blocked'}），需要人工处理。`,
          sticky: true,
        });
      }
      break;
    }
    case 'agent_step': {
      const runId = str(p.runId);
      if (runId) void qc.invalidateQueries({ queryKey: qk.agentRun(runId) });
      const groupId = str(p.groupId);
      if (groupId) void qc.invalidateQueries({ queryKey: qk.agentRunsByGroup(groupId) });
      break;
    }
    case 'sequence_run': {
      const runId = str(p.runId);
      const groupId = str(p.groupId);
      if (runId) void qc.invalidateQueries({ queryKey: qk.seqRun(runId) });
      if (groupId) {
        void qc.invalidateQueries({ queryKey: qk.seqRunsByGroup(groupId) });
        void qc.invalidateQueries({ queryKey: qk.group(groupId) });
      }
      break;
    }
    case 'group_updated': {
      const groupId = str(p.groupId);
      void qc.invalidateQueries({ queryKey: qk.groupsList() });
      if (groupId) void qc.invalidateQueries({ queryKey: qk.group(groupId) });
      break;
    }
    case 'job': {
      const jobId = str(p.jobId);
      if (jobId) void qc.invalidateQueries({ queryKey: qk.job(jobId) });
      void qc.invalidateQueries({ queryKey: qk.groupsList() });
      const groupId = str(p.groupId);
      if (groupId) void qc.invalidateQueries({ queryKey: qk.group(groupId) });
      break;
    }
    default:
      break;
  }
}
