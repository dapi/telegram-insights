import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { coverageNote, coverageReport, resolveAccountId } from './archive/status.js';
import { messageLink, parseArchiveRef } from './links.js';
import { EDITS_LIMITATION } from './search/search.js';
import { formatLocal } from './time.js';

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date ${value}`);
  return d;
}

// Read-only MCP surface over the archive and its search index (reader role).
export function buildMcpServer({ pool, search, windowDays = 14 }) {
  const server = new McpServer({ name: 'telegram-insights', version: '0.1.0' });

  server.tool(
    'search_messages',
    'Semantic + full-text search over the archived Telegram messages of all chats (private, groups, channels). Returns matching fragments with the exact messages, senders, times and links/refs. Use get_message_context with a ref to read around a message.',
    {
      query: z.string().min(1).describe('What to look for, in natural language or keywords'),
      limit: z.number().int().min(1).max(30).optional().describe('Number of fragments (default 8)'),
      from: z.string().optional().describe('Only messages on/after this date (YYYY-MM-DD or ISO)'),
      to: z.string().optional().describe('Only messages before this date (exclusive)'),
      chat_id: z.string().optional().describe('Restrict to one chat (id from find_chats)'),
    },
    async ({ query, limit, from, to, chat_id: chatId }) => {
      const found = await search.search(query, { limit: limit ?? 8, from: parseDate(from), to: parseDate(to), chatId: chatId ?? null });
      return json({
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
      });
    },
  );

  server.tool(
    'get_message_context',
    'Read an archived message and its neighbours by ref (tgi:<chat_id>/<message_id>).',
    {
      ref: z.string().describe('Message ref, e.g. tgi:-1001234567890/42'),
      before: z.number().int().min(0).max(50).optional(),
      after: z.number().int().min(0).max(50).optional(),
    },
    async ({ ref, before, after }) => {
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
        [account, chatId, target.sent_at, messageId, before ?? 5, after ?? 5],
      );
      return json({
        chat: chat.title,
        chat_id: chat.chat_id,
        chat_kind: chat.peer_kind,
        messages: rows.map((m) => {
          const link = messageLink({ chatId, messageId: Number(m.message_id), topicId: m.topic_id, peerKind: chat.peer_kind, username: chat.username });
          return {
            ref: link.ref, url: link.url, at: formatLocal(m.sent_at), sender: m.sender_name,
            text: m.text || (m.media_type ? `[${m.media_type}]` : ''), target: Number(m.message_id) === messageId || undefined,
          };
        }),
        note: EDITS_LIMITATION,
      });
    },
  );

  server.tool(
    'find_chats',
    'Find archived chats by title or username; returns chat ids for filtering search_messages.',
    { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
    async ({ query, limit }) => {
      const account = await resolveAccountId(pool);
      const { rows } = await pool.query(
        `SELECT c.chat_id, c.title, c.username, c.peer_kind, s.state,
                (SELECT max(sent_at) FROM archive.messages m WHERE m.account_id = c.account_id AND m.chat_id = c.chat_id) AS newest
         FROM archive.chats c LEFT JOIN archive.chat_sync s USING (account_id, chat_id)
         WHERE c.account_id = $1 AND (c.title ILIKE $2 OR c.username ILIKE $2)
         ORDER BY c.dialog_rank NULLS LAST LIMIT $3`,
        [account, `%${query}%`, limit ?? 20],
      );
      return json(rows.map((r) => ({ chat_id: r.chat_id, title: r.title, username: r.username, kind: r.peer_kind, state: r.state, newest: r.newest ? formatLocal(r.newest) : null })));
    },
  );

  server.tool(
    'archive_status',
    'Coverage of the archive: how many chats are fully loaded for the window, message counts, index freshness, service heartbeat.',
    {},
    async () => {
      const { summary } = await coverageReport(pool, { windowDays });
      return json({ coverage: coverageNote(summary), summary });
    },
  );

  return server;
}

export async function runMcpStdio(deps) {
  const server = buildMcpServer(deps);
  await server.connect(new StdioServerTransport());
}
