import { coverageNote, coverageReport, resolveAccountId } from './archive/status.js';
import { messageLink, parseArchiveRef } from './links.js';
import { EDITS_LIMITATION } from './search/search.js';
import { formatLocal } from './time.js';

// Read-only queries shared by the MCP server and the direct CLI backend.
// Results are plain JSON-friendly objects.

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date ${value}`);
  return d;
}

export async function searchMessages(search, { query, limit = 8, from = null, to = null, chat_id: chatId = null }) {
  const found = await search.search(query, { limit, from: parseDate(from), to: parseDate(to), chatId });
  return {
    mode: found.mode,
    results: found.results.map((r) => ({
      chat: r.chatTitle,
      chat_id: r.chatId,
      chat_kind: r.peerKind,
      period: `${formatLocal(r.firstSentAt)} – ${formatLocal(r.lastSentAt)}`,
      matched_by: r.matchedBy,
      messages: r.messages.map((m) => ({
        ref: m.link.ref,
        url: m.link.url,
        at: formatLocal(m.sentAt),
        sender: m.sender,
        text: m.text,
        context_only: m.context || undefined,
      })),
    })),
    coverage: found.coverageNote,
    note: EDITS_LIMITATION,
  };
}

export async function messageContext(pool, { ref, before = 5, after = 5 }) {
  const { chatId, messageId } = parseArchiveRef(ref);
  const account = await resolveAccountId(pool);
  const { rows: [chat] } = await pool.query('SELECT * FROM archive.chats WHERE account_id = $1 AND chat_id = $2', [account, chatId]);
  if (!chat) throw new Error('Chat is not in the archive');
  const { rows: [target] } = await pool.query(
    'SELECT sent_at FROM archive.messages WHERE account_id = $1 AND chat_id = $2 AND message_id = $3', [account, chatId, messageId],
  );
  if (!target) throw new Error('Message is not in the archive');
  const { rows } = await pool.query(
    `(SELECT * FROM archive.messages WHERE account_id = $1 AND chat_id = $2 AND (sent_at, message_id) < ($3, $4) ORDER BY sent_at DESC, message_id DESC LIMIT $5)
     UNION ALL (SELECT * FROM archive.messages WHERE account_id = $1 AND chat_id = $2 AND message_id = $4)
     UNION ALL (SELECT * FROM archive.messages WHERE account_id = $1 AND chat_id = $2 AND (sent_at, message_id) > ($3, $4) ORDER BY sent_at, message_id LIMIT $6)
     ORDER BY sent_at, message_id`,
    [account, chatId, target.sent_at, messageId, before, after],
  );
  return {
    chat: chat.title,
    chat_id: chat.chat_id,
    chat_kind: chat.peer_kind,
    messages: rows.map((m) => {
      const link = messageLink({ chatId, messageId: Number(m.message_id), topicId: m.topic_id, peerKind: chat.peer_kind, username: chat.username });
      return {
        ref: link.ref,
        url: link.url,
        at: formatLocal(m.sent_at),
        sender: m.sender_name,
        text: m.text || (m.media_type ? `[${m.media_type}]` : ''),
        target: Number(m.message_id) === messageId || undefined,
      };
    }),
    note: EDITS_LIMITATION,
  };
}

export async function findChats(pool, { query, limit = 20 }) {
  const account = await resolveAccountId(pool);
  const { rows } = await pool.query(
    `SELECT c.chat_id, c.title, c.username, c.peer_kind, s.state,
            (SELECT max(sent_at) FROM archive.messages m WHERE m.account_id = c.account_id AND m.chat_id = c.chat_id) AS newest
     FROM archive.chats c LEFT JOIN archive.chat_sync s USING (account_id, chat_id)
     WHERE c.account_id = $1 AND (c.title ILIKE $2 OR c.username ILIKE $2)
     ORDER BY c.dialog_rank NULLS LAST LIMIT $3`,
    [account, `%${query}%`, limit],
  );
  return rows.map((r) => ({
    chat_id: r.chat_id, title: r.title, username: r.username, kind: r.peer_kind, state: r.state,
    newest: r.newest ? formatLocal(r.newest) : null,
  }));
}

export async function archiveStatus(pool, { windowDays = 14 } = {}) {
  const { summary } = await coverageReport(pool, { windowDays });
  return { coverage: coverageNote(summary), summary };
}
