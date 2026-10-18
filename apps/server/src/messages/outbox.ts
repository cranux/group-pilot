import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/db.js';
import { sanitizeText } from '../lib/json.js';
import type { Signals } from '../lib/signals.js';
import { emitMessage, type MessageRow, type MessageSource } from './model.js';

export interface EnqueueInput {
  groupId: string;
  accountId: string;
  platformUserId: string | null;
  text: string;
  source: Exclude<MessageSource, 'inbound'>;
  agentRunId?: string;
  sequenceRunId?: string;
  sequenceStepPos?: number;
}

/**
 * 出站消息先落库（queued），再由发送器发往网关。sentAt 先用受理时刻，发出后改为网关的 sentAt。
 */
export async function enqueueOwnMessage(tx: Tx, input: EnqueueInput, signals?: Signals): Promise<MessageRow> {
  const res = await tx.query<MessageRow>(
    `INSERT INTO messages (group_id, client_msg_id, sender_account_id, sender_platform_user_id, is_own, text, sent_at,
                           delivery_status, source, agent_run_id, sequence_run_id, sequence_step_pos)
     VALUES ($1, $2, $3, $4, true, $5, date_trunc('milliseconds', now()), 'queued', $6, $7, $8, $9)
     RETURNING *`,
    [
      input.groupId,
      randomUUID(),
      input.accountId,
      input.platformUserId,
      sanitizeText(input.text),
      input.source,
      input.agentRunId ?? null,
      input.sequenceRunId ?? null,
      input.sequenceStepPos ?? null,
    ],
  );
  const row = res.rows[0];
  emitMessage(tx, row);
  if (signals) tx.afterCommit(() => signals.wake('outbox'));
  return row;
}
