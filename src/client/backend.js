import { createPool } from '../db.js';
import { createEmbedder } from '../llm/models.js';
import { archiveStatus, findChats, messageContext, searchMessages } from '../query.js';
import { SearchService } from '../search/search.js';

// Same four read operations, either straight against PostgreSQL or through an
// MCP server (usually `ssh <host> telegram-insights mcp`).

export class DirectBackend {
  constructor(settings) {
    if (!settings.databaseUrl) {
      throw new Error('No connection configured: set --remote/TI_REMOTE (MCP over SSH) or a reader database URL (--db-url, TI_READER_DATABASE_URL, databaseUrlPass)');
    }
    this.settings = settings;
    this.pool = createPool(settings.databaseUrl, { max: 2, applicationName: 'telegram-insights-cli' });
    const embedder = createEmbedder(settings.models);
    this.search = new SearchService({ pool: this.pool, embedder, windowDays: settings.windowDays });
  }

  searchMessages(args) { return searchMessages(this.search, args); }

  messageContext(args) { return messageContext(this.pool, args); }

  findChats(args) { return findChats(this.pool, args); }

  archiveStatus() { return archiveStatus(this.pool, { windowDays: this.settings.windowDays }); }

  async close() { await this.pool.end(); }
}

export class McpBackend {
  constructor(settings) {
    this.settings = settings;
  }

  async connect() {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const [command, ...args] = this.settings.command;
    this.transport = new StdioClientTransport({ command, args, env: { ...process.env }, stderr: 'ignore' });
    this.client = new Client({ name: 'telegram-insights-cli', version: '0.1.0' });
    await this.client.connect(this.transport);
  }

  async call(name, args) {
    if (!this.client) await this.connect();
    const res = await this.client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? '';
    if (res.isError) throw new Error(text || `${name} failed`);
    return JSON.parse(text);
  }

  searchMessages(args) { return this.call('search_messages', args); }

  messageContext(args) { return this.call('get_message_context', args); }

  findChats(args) { return this.call('find_chats', args); }

  archiveStatus() { return this.call('archive_status', {}); }

  async close() { await this.client?.close(); }
}

export function createBackend(settings) {
  return settings.mode === 'mcp' ? new McpBackend(settings) : new DirectBackend(settings);
}
