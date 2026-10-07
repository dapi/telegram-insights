import { execFileSync } from 'node:child_process';

import { modelSettings } from '../telegram/config.js';
import { configPath, readConfigFile } from '../user-config.js';

// Connection settings for the read commands. Precedence: command-line options,
// then environment variables, then the user config file, then defaults.
//
// Config file: $TELEGRAM_INSIGHTS_CONFIG or ~/.config/telegram-insights/config.json
// {
//   "remote": "<ssh-host>",                    // SSH host: use MCP over SSH
//   "remoteCommand": "<checkout>/ops/telegram-insights-with-pass mcp",
//   "mcpCommand": null,                        // any command that speaks MCP on stdio
//   "databaseUrl": null,                       // direct mode; prefer databaseUrlPass
//   "databaseUrlPass": null,                   // pass entry holding the reader DSN
//   "modelProvider": "gateway",               // or "ollama"
//   "llmRouterUrl": "http://<llm-router>/v1"    // or env LLM_ROUTER_BASE_URL
// }
// Secrets do not belong in the config file: use databaseUrlPass or env.

export const DEFAULT_REMOTE_COMMAND = 'telegram-insights mcp';

export { configPath, readConfigFile };

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
    models: modelSettings({
      ...env,
      ...(opts.ollamaUrl ? { TI_OLLAMA_URL: opts.ollamaUrl } : {}),
      ...(opts.llmRouterUrl ? { LLM_ROUTER_BASE_URL: opts.llmRouterUrl } : {}),
    }, cfg),
    windowDays: Number(pick(env.TI_WINDOW_DAYS, cfg.windowDays) ?? 14),
    windowMonths: pick(env.TI_WINDOW_MONTHS, cfg.windowMonths) == null ? null : Number(pick(env.TI_WINDOW_MONTHS, cfg.windowMonths)),
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
