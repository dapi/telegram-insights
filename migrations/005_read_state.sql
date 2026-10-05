-- Read state from the dialogs list: the newest incoming message the owner has
-- read and the unread counter Telegram shows. Refreshed with every dialogs pass;
-- NULL until the first pass after this migration.
ALTER TABLE archive.chats
  ADD COLUMN read_inbox_max_id bigint,
  ADD COLUMN unread_count integer,
  ADD COLUMN read_state_at timestamptz;
