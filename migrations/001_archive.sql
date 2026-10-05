-- Telegram Insights archive: the exact record owned by this product.
-- Edits and deletions are not synchronised in v1; the first archived version wins.

CREATE SCHEMA IF NOT EXISTS archive;

CREATE TABLE archive.accounts (
  account_id     bigint PRIMARY KEY,
  username       text,
  generation     integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Every dialog the account can see. peer_kind: user, bot, saved, group, supergroup, channel.
CREATE TABLE archive.chats (
  account_id        bigint NOT NULL REFERENCES archive.accounts,
  chat_id           bigint NOT NULL,
  peer_kind         text NOT NULL,
  title             text,
  username          text,
  is_forum          boolean NOT NULL DEFAULT false,
  dialog_rank       integer,
  top_message_id    bigint,
  top_message_at    timestamptz,
  in_dialogs        boolean NOT NULL DEFAULT true,
  excluded          boolean NOT NULL DEFAULT false,
  discovered_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_id)
);

CREATE SEQUENCE archive.archive_seq;

CREATE TABLE archive.messages (
  account_id     bigint NOT NULL,
  chat_id        bigint NOT NULL,
  message_id     bigint NOT NULL,
  topic_id       bigint,
  sent_at        timestamptz NOT NULL,
  archived_at    timestamptz NOT NULL DEFAULT now(),
  archive_seq    bigint NOT NULL UNIQUE,
  source         text NOT NULL,
  sender_id      bigint,
  sender_name    text,
  sender_username text,
  text           text NOT NULL DEFAULT '',
  media_type     text,
  media          jsonb,
  reply_to_id    bigint,
  forward        jsonb,
  grouped_id     text,
  is_service     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (account_id, chat_id, message_id),
  FOREIGN KEY (account_id, chat_id) REFERENCES archive.chats
);

CREATE INDEX messages_chat_sent_idx ON archive.messages (account_id, chat_id, sent_at DESC);
CREATE INDEX messages_sent_idx ON archive.messages (account_id, sent_at);

-- Per-chat coverage and checkpoint. Message ids are compared only inside one chat.
--  state: not_checked, loading, loaded, rate_limited, error, unavailable, excluded
--  backfill_*: initial/extended pass from newest pages to older ones.
--  covered_*: contiguous verified range [covered_min_id, covered_max_id];
--    covered_from is the date of the oldest verified message or window_start
--    when the chat history ended before the window boundary.
CREATE TABLE archive.chat_sync (
  account_id           bigint NOT NULL,
  chat_id              bigint NOT NULL,
  state                text NOT NULL DEFAULT 'not_checked',
  window_start         timestamptz NOT NULL,
  backfill_done        boolean NOT NULL DEFAULT false,
  backfill_anchor_id   bigint,
  backfill_offset_id   bigint,
  covered_min_id       bigint,
  covered_max_id       bigint,
  covered_from         timestamptz,
  history_exhausted    boolean NOT NULL DEFAULT false,
  gap_min_id           bigint,
  gap_offset_id        bigint,
  gap_target_id        bigint,
  pages_fetched        integer NOT NULL DEFAULT 0,
  messages_fetched     bigint NOT NULL DEFAULT 0,
  last_page_at         timestamptz,
  last_reconciled_at   timestamptz,
  flood_wait_until     timestamptz,
  error_code           text,
  error_count          integer NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_id),
  FOREIGN KEY (account_id, chat_id) REFERENCES archive.chats
);

CREATE INDEX chat_sync_state_idx ON archive.chat_sync (account_id, state);

-- Account-wide runtime state: limiter pace, flood waits, service heartbeat.
CREATE TABLE archive.runtime_state (
  account_id      bigint NOT NULL,
  key             text NOT NULL,
  value           jsonb NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);

-- Append-only log of technical events (no message content).
CREATE TABLE archive.events (
  id          bigserial PRIMARY KEY,
  account_id  bigint,
  chat_id     bigint,
  kind        text NOT NULL,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_created_idx ON archive.events (created_at DESC);
