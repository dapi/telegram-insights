import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Connection settings for the read commands. Precedence: command-line options,
// then environment variables, then the user config file, then defaults.
//
// Config file: $TELEGRAM_INSIGHTS_CONFIG or ~/.config/telegram-insights/config.json
// {
//   "remote": "office3",                       // SSH host: use MCP over SSH
//   "remoteCommand": "~/code/telegram-insights/ops/office3/telegram-insights-with-pass mcp",
//   "mcpCommand": null,                        // any command that speaks MCP on stdio
//   "databaseUrl": null,                       // direct mode; prefer databaseUrlPass
//   "databaseUrlPass": null,                   // pass entry holding the reader DSN
//   "ollamaUrl": "http://127.0.0.1:11434"
// }
// Secrets do not belong in the config file: use databaseUrlPass or env.

export const DEFAULT_REMOTE_COMMAND = '~/code/telegram-insights/ops/office3/telegram-insights-with-pass mcp';

export function configPath(env = process.env) {
  if (env.TELEGRAM_INSIGHTS_CONFIG) return env.TELEGRAM_INSIGHTS_CONFIG;
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'telegram-insights', 'config.json');
}

export function readConfigFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

const pick = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');

export function resolveSettings(opts = {}, env = process.env, { readPass = (entry) => execFileSync('pass', ['show', entry], { encoding: 'utf8' }).split('\n')[0] } = {}) {
  const file = opts.config ?? configPath(env);
  const cfg = readConfigFile(file);
  const settings = {
    configFile: file,
    remote: pick(opts.remote, env.TI_REMOTE, cfg.remote) ?? null,
    remoteCommand: pick(opts.remoteCommand, env.TI_REMOTE_COMMAND, cfg.remoteCommand) ?? DEFAULT_REMOTE_COMMAND,
    mcpCommand: pick(opts.mcpCommand, env.TI_MCP_COMMAND, cfg.mcpCommand) ?? null,
    databaseUrl: pick(opts.dbUrl, env.TI_READER_DATABASE_URL, env.TI_DATABASE_URL, cfg.databaseUrl) ?? null,
    databaseUrlPass: pick(opts.dbUrlPass, env.TI_READER_DATABASE_URL_PASS, cfg.databaseUrlPass) ?? null,
    ollamaUrl: pick(opts.ollamaUrl, env.TI_OLLAMA_URL, cfg.ollamaUrl) ?? 'http://127.0.0.1:11434',
    embedModel: pick(env.TI_EMBED_MODEL, cfg.embedModel) ?? 'qwen3-embedding:0.6b',
    windowDays: Number(pick(env.TI_WINDOW_DAYS, cfg.windowDays) ?? 14),
    disableEmbeddings: pick(env.TI_DISABLE_EMBEDDINGS, cfg.disableEmbeddings) === '1' || cfg.disableEmbeddings === true,
  };
  if (opts.direct) {
    settings.remote = null;
    settings.mcpCommand = null;
  }
  if (settings.mcpCommand) {
    settings.mode = 'mcp';
    settings.command = ['sh', '-c', settings.mcpCommand];
  } else if (settings.remote) {
    settings.mode = 'mcp';
    settings.command = ['ssh', '-o', 'BatchMode=yes', settings.remote, settings.remoteCommand];
  } else {
    settings.mode = 'direct';
    if (!settings.databaseUrl && settings.databaseUrlPass) settings.databaseUrl = readPass(settings.databaseUrlPass);
  }
  return settings;
}
