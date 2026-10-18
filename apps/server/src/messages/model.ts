import type { Tx } from '../db/db.js';
import { iso } from '../lib/time.js';

export type DeliveryStatus = 'queued' | 'accepted' | 'sent' | 'failed' | 'unknown' | 'cancelled';
export type MessageSource = 'inbound' | 'operator' | 'agent' | 'sequence';

export interface MessageRow {
  id: number;
  group_id: string;
  msg_id: string | null;
  client_msg_id: string | null;
  sender_account_id: string | null;
  sender_platform_user_id: string | null;
  is_own: boolean;
  text: string;
  sent_at: Date;
  delivery_status: DeliveryStatus | null;
  fail_code: string | null;
  source: MessageSource;
  attempt_count: number;
  resend_used: boolean;
  in_flight_at: Date | null;
  unknown_since: Date | null;
  next_attempt_at: Date | null;
  accepted_at: Date | null;
  agent_run_id: string | null;
  sequence_run_id: string | null;
  sequence_step_pos: number | null;
  media_url: string | null;
  local_file_path: string | null;
  media_status: string | null;
  created_at: Date;
  updated_at: Date;
}

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

export function messageDto(row: MessageRow): MessageItem {
  return {
    id: String(row.id),
    msgId: row.msg_id,
    clientMsgId: row.client_msg_id,
    senderPlatformUserId: row.sender_platform_user_id,
    senderAccountId: row.sender_account_id,
    isOwn: row.is_own,
    text: row.text,
    sentAt: iso(row.sent_at)!,
    deliveryStatus: row.delivery_status,
    failCode: row.fail_code,
    mediaUrl: row.media_url,
    localFilePath: row.local_file_path,
    source: row.source,
  };
}

export function emitMessage(tx: Tx, row: MessageRow): void {
  tx.emit('message', {
    groupId: row.group_id,
    msgId: row.msg_id,
    isOwn: row.is_own,
    id: String(row.id),
    clientMsgId: row.client_msg_id,
    item: messageDto(row),
  });
}
