-- The official "Telegram" service account (777000) sends login codes and new
-- login alerts. The archiver now always skips it; remove what was stored before.
UPDATE archive.chats SET excluded = true WHERE chat_id = 777000;
UPDATE archive.chat_sync SET state = 'excluded' WHERE chat_id = 777000;
DELETE FROM search.chunks WHERE chat_id = 777000;
DELETE FROM archive.messages WHERE chat_id = 777000;
