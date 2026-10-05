import os from 'node:os';
import path from 'node:path';

import { resolveStoreDir, resolveStorePaths } from '../store.js';
import { configPath, readConfigFile } from '../user-config.js';

// Telegram Insights reads configuration from the environment only. Secrets
// (API hash, database passwords) are injected from `pass` by the launcher and
// are never written to the store or the repository.

function normalizeValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function intValue(env, name, fallback) {
  const raw = normalizeValue(env[name]);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function list(value) {
  return normalizeValue(value).split(',').map((s) => s.trim()).filter(Boolean);
}

export function modelSettings(env = process.env, fileConfig = {}) {
  const pick = (...v) => v.find((x) => x !== undefined && x !== null && x !== '');
  const provider = pick(normalizeValue(env.TI_MODEL_PROVIDER), fileConfig.modelProvider) || 'gateway';
  const local = provider === 'ollama';
  return {
    provider,
    llmRouterUrl: pick(normalizeValue(env.LLM_ROUTER_BASE_URL), fileConfig.llmRouterUrl) || null,
    llmRouterApiKey: normalizeValue(env.LLM_ROUTER_API_KEY) || null,
    ollamaUrl: pick(normalizeValue(env.TI_OLLAMA_URL), fileConfig.ollamaUrl) || 'http://127.0.0.1:11434',
    embedModel: pick(normalizeValue(env.TI_EMBED_MODEL), fileConfig.embedModel) || (local ? 'qwen3-embedding:0.6b' : 'telegram-insights-embedding'),
    chatModel: pick(normalizeValue(env.TI_LLM_MODEL), fileConfig.chatModel) || (local ? 'qwen3:8b' : 'telegram-insights-chat'),
    approvedHosts: list(env.TI_APPROVED_MODEL_HOSTS),
    embeddingsEnabled: normalizeValue(env.TI_DISABLE_EMBEDDINGS) !== '1' && fileConfig.disableEmbeddings !== true,
  };
}

export function loadConfig(env = process.env) {
  const storeDir = resolveStoreDir(normalizeValue(env.TELEGRAM_INSIGHTS_STORE) || undefined);
  const { sessionPath } = resolveStorePaths(storeDir, { sessionFile: 'session.db' });
  const defaultUrl = normalizeValue(env.TI_DATABASE_URL);
  return {
    storeDir,
    sessionPath,
    digestDir: normalizeValue(env.TI_DIGEST_DIR) || path.join(storeDir, 'digests'),
    telegram: {
      apiId: normalizeValue(env.TELEGRAM_API_ID),
      apiHash: normalizeValue(env.TELEGRAM_API_HASH),
      phoneNumber: normalizeValue(env.TELEGRAM_PHONE_NUMBER),
      proxy: normalizeValue(env.TELEGRAM_PROXY),
    },
    db: {
      owner: normalizeValue(env.TI_OWNER_DATABASE_URL) || defaultUrl,
      archiver: normalizeValue(env.TI_ARCHIVER_DATABASE_URL) || defaultUrl,
      indexer: normalizeValue(env.TI_INDEXER_DATABASE_URL) || defaultUrl,
      reader: normalizeValue(env.TI_READER_DATABASE_URL) || defaultUrl,
    },
    archive: {
      windowDays: intValue(env, 'TI_WINDOW_DAYS', 14),
      pageSize: intValue(env, 'TI_PAGE_SIZE', 100),
      dialogsIntervalMs: intValue(env, 'TI_DIALOGS_INTERVAL_MINUTES', 30) * 60_000,
      excludedChats: list(env.TI_EXCLUDED_CHATS),
    },
    limiter: {
      minIntervalMs: intValue(env, 'TI_MIN_INTERVAL_MS', 1500),
      initialIntervalMs: intValue(env, 'TI_INITIAL_INTERVAL_MS', 3000),
      maxIntervalMs: intValue(env, 'TI_MAX_INTERVAL_MS', 60_000),
      maxRequestsPerHour: intValue(env, 'TI_MAX_REQUESTS_PER_HOUR', 1200),
    },
    models: modelSettings(env, readConfigFile(configPath(env))),
    timeZone: normalizeValue(env.TI_TIMEZONE) || 'Europe/Moscow',
    home: os.homedir(),
  };
}

export function validateTelegramConfig(config, { forLogin = false } = {}) {
  const missing = [];
  if (!config.telegram.apiId) missing.push('TELEGRAM_API_ID');
  if (!config.telegram.apiHash) missing.push('TELEGRAM_API_HASH');
  if (forLogin && !config.telegram.phoneNumber && !forLogin.qr) missing.push('TELEGRAM_PHONE_NUMBER');
  return missing;
}
