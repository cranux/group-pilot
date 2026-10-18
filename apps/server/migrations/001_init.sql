-- 认证
CREATE TABLE users (
  id            serial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'viewer')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id            uuid PRIMARY KEY,
  user_id       int NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoke_reason text
);

CREATE TABLE refresh_tokens (
  token_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES auth_sessions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX refresh_tokens_session ON refresh_tokens(session_id);

-- 账号
CREATE TABLE accounts (
  id                 text PRIMARY KEY,
  status             text NOT NULL DEFAULT 'idle'
                     CHECK (status IN ('idle', 'online', 'rate_limited', 'disconnected', 'suspended', 'session_expired')),
  platform_user_id   text UNIQUE,
  rate_limited_until timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounts_rate_limited ON accounts(rate_limited_until) WHERE status = 'rate_limited';

-- 群与成员
CREATE TABLE groups (
  id                 uuid PRIMARY KEY,
  gateway_group_id   text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unreachable', 'left')),
  creator_account_id text NOT NULL REFERENCES accounts(id),
  agent_enabled      boolean NOT NULL DEFAULT false,
  auto_kick_enabled  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- 保留墓碑行（state = 'out'）与 last_event_id，用来抵御成员事件乱序
CREATE TABLE group_members (
  group_id         uuid NOT NULL REFERENCES groups(id),
  platform_user_id text NOT NULL,
  account_id       text REFERENCES accounts(id),
  role             text NOT NULL DEFAULT 'member' CHECK (role IN ('creator', 'admin', 'member')),
  state            text NOT NULL CHECK (state IN ('in', 'out')),
  last_event_id    bigint NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, platform_user_id)
);
CREATE INDEX group_members_account ON group_members(account_id) WHERE state = 'in';

-- 网关事件收件箱：原文用 text 保存，保证任何内容都能先落下来
CREATE TABLE gateway_inbox (
  event_id        bigint PRIMARY KEY,
  type            text NOT NULL,
  raw             text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'dead', 'ignored')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  received_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at    timestamptz
);
CREATE INDEX gateway_inbox_todo ON gateway_inbox(event_id) WHERE status IN ('pending', 'failed');
CREATE INDEX gateway_inbox_received ON gateway_inbox(received_at);

-- 消息时间线（入站 + 出站）
CREATE TABLE messages (
  id                      bigserial PRIMARY KEY,
  group_id                uuid NOT NULL REFERENCES groups(id),
  msg_id                  text,
  client_msg_id           text UNIQUE,
  sender_account_id       text REFERENCES accounts(id),
  sender_platform_user_id text,
  is_own                  boolean NOT NULL,
  text                    text NOT NULL,
  sent_at                 timestamptz NOT NULL,
  delivery_status         text CHECK (delivery_status IN ('queued', 'accepted', 'sent', 'failed', 'unknown', 'cancelled')),
  fail_code               text,
  source                  text NOT NULL CHECK (source IN ('inbound', 'operator', 'agent', 'sequence')),
  -- 出站状态机
  attempt_count           int NOT NULL DEFAULT 0,
  resend_used             boolean NOT NULL DEFAULT false,
  in_flight_at            timestamptz,
  unknown_since           timestamptz,
  next_attempt_at         timestamptz,
  accepted_at             timestamptz,
  -- 关联
  agent_run_id            uuid,
  sequence_run_id         uuid,
  sequence_step_pos       int,
  -- 媒体（C1）
  media_url               text,
  local_file_path         text,
  media_status            text CHECK (media_status IN ('pending', 'downloaded', 'failed', 'gone', 'deleted')),
  media_attempts          int NOT NULL DEFAULT 0,
  media_downloaded_at     timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, msg_id)
);
CREATE INDEX messages_timeline ON messages(group_id, sent_at DESC, id DESC);
CREATE INDEX messages_outbox ON messages(sender_account_id, id) WHERE delivery_status = 'queued';
CREATE INDEX messages_unknown ON messages(id) WHERE delivery_status = 'unknown';
CREATE INDEX messages_accepted ON messages(accepted_at) WHERE delivery_status = 'accepted';
CREATE INDEX messages_in_flight ON messages(in_flight_at) WHERE in_flight_at IS NOT NULL;
CREATE INDEX messages_media_pending ON messages(id) WHERE media_status = 'pending';
CREATE INDEX messages_media_downloaded ON messages(media_downloaded_at) WHERE media_status = 'downloaded';

-- 推送事件日志（seq 顺序 = 提交顺序，见 db/tx.ts）
CREATE TABLE ws_events (
  seq        bigserial PRIMARY KEY,
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 异步任务（建群 / 全员退群）
CREATE TABLE jobs (
  id          uuid PRIMARY KEY,
  type        text NOT NULL CHECK (type IN ('create_group', 'leave_all')),
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished', 'failed')),
  group_id    uuid,
  params      jsonb NOT NULL,
  state       jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors      jsonb NOT NULL DEFAULT '[]'::jsonb,
  lease_owner text,
  lease_until timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_running ON jobs(created_at) WHERE status = 'running';
CREATE UNIQUE INDEX jobs_one_leave_all ON jobs(group_id) WHERE type = 'leave_all' AND status = 'running';

-- Agent
CREATE TABLE agent_runs (
  id                          uuid PRIMARY KEY,
  group_id                    uuid NOT NULL REFERENCES groups(id),
  status                      text NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'finished', 'failed', 'blocked', 'cancelled')),
  end_reason                  text CHECK (end_reason IN ('final', 'budget_exhausted', 'wall_clock', 'protocol_errors', 'audit_blocked', 'cancelled')),
  summary                     text,
  trigger_message_ids         bigint[] NOT NULL,
  trigger_messages            jsonb NOT NULL,
  history                     jsonb NOT NULL,
  step_count                  int NOT NULL DEFAULT 0,
  consecutive_protocol_errors int NOT NULL DEFAULT 0,
  active_ms                   bigint NOT NULL DEFAULT 0,
  pending                     jsonb,
  memo                        jsonb NOT NULL DEFAULT '{}'::jsonb,
  lease_owner                 text,
  lease_until                 timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  ended_at                    timestamptz
);
CREATE UNIQUE INDEX agent_runs_one_running ON agent_runs(group_id) WHERE status = 'running';
CREATE INDEX agent_runs_group ON agent_runs(group_id, created_at DESC);

CREATE TABLE agent_steps (
  run_id         uuid NOT NULL REFERENCES agent_runs(id),
  step_no        int NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('tool_use', 'final', 'protocol_error')),
  tool_use_id    text,
  name           text,
  input          jsonb,
  result_summary text,
  is_error       boolean NOT NULL DEFAULT false,
  error_code     text,
  audit_verdict  text,
  raw_response   text,
  status         text NOT NULL DEFAULT 'done' CHECK (status IN ('executing', 'done')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_no)
);

CREATE TABLE agent_pending_triggers (
  group_id   uuid NOT NULL REFERENCES groups(id),
  message_id bigint NOT NULL REFERENCES messages(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, message_id)
);

CREATE TABLE agent_idempotency (
  run_id          uuid NOT NULL REFERENCES agent_runs(id),
  idempotency_key text NOT NULL,
  message_id      bigint NOT NULL REFERENCES messages(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, idempotency_key)
);

-- 定时序列
CREATE TABLE sequences (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  steps      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequence_runs (
  id                 uuid PRIMARY KEY,
  sequence_id        uuid NOT NULL REFERENCES sequences(id),
  group_id           uuid NOT NULL REFERENCES groups(id),
  status             text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished', 'failed', 'stopped')),
  vars               jsonb NOT NULL,
  step_vars          jsonb NOT NULL,
  current_step_index int,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz
);
CREATE UNIQUE INDEX sequence_runs_one_running ON sequence_runs(group_id) WHERE status = 'running';
CREATE INDEX sequence_runs_group ON sequence_runs(group_id, created_at DESC);

CREATE TABLE sequence_run_steps (
  run_id        uuid NOT NULL REFERENCES sequence_runs(id),
  pos           int NOT NULL,
  step_index    int NOT NULL,
  account_role  text NOT NULL CHECK (account_role IN ('admin', 'member')),
  text_template text NOT NULL,
  delay_seconds double precision NOT NULL,
  resolved_text text NOT NULL,
  resolved_vars jsonb NOT NULL,
  var_sources   jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'sent', 'skipped', 'failed')),
  scheduled_at  timestamptz,
  sent_at       timestamptz,
  skipped_at    timestamptz,
  account_id    text,
  message_id    bigint REFERENCES messages(id),
  client_msg_id text,
  fail_code     text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, pos)
);
CREATE INDEX sequence_steps_due ON sequence_run_steps(scheduled_at) WHERE status = 'pending' AND message_id IS NULL;
