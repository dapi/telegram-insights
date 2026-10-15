-- A fixed, explicit lower bound for a single chat; independent of the global window.
ALTER TABLE archive.chat_sync ADD COLUMN requested_from timestamptz;
