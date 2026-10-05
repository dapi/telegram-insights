import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_REMOTE_COMMAND, resolveSettings } from '../src/client/settings.js';

function withConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

describe('connection settings precedence', () => {
  it('uses the config file when nothing else is given', () => {
    const file = withConfig({ remote: 'office3' });
    const s = resolveSettings({}, { TELEGRAM_INSIGHTS_CONFIG: file });
    expect(s.mode).toBe('mcp');
    expect(s.command).toEqual(['ssh', '-o', 'BatchMode=yes', 'office3', DEFAULT_REMOTE_COMMAND]);
  });

  it('env overrides the config file and options override env', () => {
    const file = withConfig({ remote: 'office3' });
    expect(resolveSettings({}, { TELEGRAM_INSIGHTS_CONFIG: file, TI_REMOTE: 'other' }).command[3]).toBe('other');
    expect(resolveSettings({ remote: 'cli-host' }, { TELEGRAM_INSIGHTS_CONFIG: file, TI_REMOTE: 'other' }).command[3]).toBe('cli-host');
  });

  it('prefers an explicit MCP command over SSH', () => {
    const s = resolveSettings({ mcpCommand: 'node server.js mcp' }, { TI_REMOTE: 'office3', TELEGRAM_INSIGHTS_CONFIG: '/nonexistent' });
    expect(s.command).toEqual(['sh', '-c', 'node server.js mcp']);
  });

  it('falls back to direct mode and reads the DSN from pass', () => {
    const file = withConfig({ remote: 'office3', databaseUrlPass: 'entry/reader-url' });
    const s = resolveSettings({ direct: true }, { TELEGRAM_INSIGHTS_CONFIG: file }, { readPass: (e) => `postgres://u:p@h/db#${e}` });
    expect(s.mode).toBe('direct');
    expect(s.databaseUrl).toBe('postgres://u:p@h/db#entry/reader-url');
  });
});
