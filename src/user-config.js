import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// User-level config shared by the service and the CLI:
// $TELEGRAM_INSIGHTS_CONFIG or ~/.config/telegram-insights/config.json (no secrets).
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
