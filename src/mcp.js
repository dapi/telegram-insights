import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { archiveStatus, findChats, messageContext, searchMessages } from './query.js';

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });

// Read-only MCP surface over the archive and its search index (reader role).
export function buildMcpServer({ pool, search, windowDays = 14, windowMonths = null }) {
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
      recent: z.boolean().optional().describe('Prefer recent messages; set when the question is about lately/now and gives no dates'),
    },
    async (args) => json(await searchMessages(search, args)),
  );

  server.tool(
    'get_message_context',
    'Read an archived message and its neighbours by ref (tgi:<chat_id>/<message_id>).',
    {
      ref: z.string().describe('Message ref, e.g. tgi:-1001234567890/42'),
      before: z.number().int().min(0).max(50).optional(),
      after: z.number().int().min(0).max(50).optional(),
    },
    async (args) => json(await messageContext(pool, args)),
  );

  server.tool(
    'find_chats',
    'Find archived chats by title or username; returns chat ids for filtering search_messages.',
    { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
    async (args) => json(await findChats(pool, args)),
  );

  server.tool(
    'archive_status',
    'Coverage of the archive: how many chats are fully loaded for the window, message counts, index freshness, service heartbeat.',
    {},
    async () => json(await archiveStatus(pool, { windowDays, windowMonths })),
  );

  return server;
}

export async function runMcpStdio(deps) {
  const server = buildMcpServer(deps);
  await server.connect(new StdioServerTransport());
}
