import {
  TelegramClient as MtCuteClient,
  proxyTransportFromUrl,
} from '@mtcute/node';
import EventEmitter from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import qrcode from 'qrcode-terminal';
import readline from 'readline';
import { resolveStoreDir, resolveStorePaths } from '../store.js';

const timeoutPatchKey = Symbol.for('telegram-insights.timeoutPatch');
if (!globalThis[timeoutPatchKey]) {
  const originalSetTimeout = globalThis.setTimeout;
  if (typeof originalSetTimeout === 'function') {
    const wrapped = (handler, delay, ...args) => {
      const safeDelay = Number.isFinite(delay) ? Math.max(0, delay) : 0;
      return originalSetTimeout(handler, safeDelay, ...args);
    };
    globalThis.setTimeout = wrapped;
  }
  globalThis[timeoutPatchKey] = true;
}

const DEFAULT_STORE_DIR = resolveStoreDir();
const { sessionPath: DEFAULT_SESSION_PATH } = resolveStorePaths(DEFAULT_STORE_DIR);

const IS_TTY = typeof process === 'object' && Boolean(process.stdout?.isTTY);
const LOG_BASE_FORMAT = IS_TTY ? '%s [%s] [%s%s\x1B[0m] ' : '%s [%s] [%s] ';
const LOG_LEVEL_NAMES = IS_TTY
  ? [
      '',
      '\x1B[31mERR\x1B[0m',
      '\x1B[33mWRN\x1B[0m',
      '\x1B[34mINF\x1B[0m',
      '\x1B[36mDBG\x1B[0m',
      '\x1B[35mVRB\x1B[0m',
    ]
  : ['', 'ERR', 'WRN', 'INF', 'DBG', 'VRB'];
const LOG_TAG_COLORS = [6, 2, 3, 4, 5, 1].map((i) => `\x1B[3${i};1m`);
const LOG_HANDLER = IS_TTY
  ? (color, level, tag, fmt, args) => {
      console.log(
        LOG_BASE_FORMAT + fmt,
        new Date().toISOString(),
        LOG_LEVEL_NAMES[level],
        LOG_TAG_COLORS[color],
        tag,
        ...args,
      );
    }
  : (color, level, tag, fmt, args) => {
      console.log(
        LOG_BASE_FORMAT + fmt,
        new Date().toISOString(),
        LOG_LEVEL_NAMES[level],
        tag,
        ...args,
      );
    };
function createPlatform() {
  return {
    beforeExit: (callback) => {
      if (typeof process === 'undefined') {
        return () => {};
      }
      const handler = () => {
        callback();
      };
      process.on('exit', handler);
      return () => {
        process.off('exit', handler);
      };
    },
    log: LOG_HANDLER,
    getDefaultLogLevel: () => {
      const envLogLevel = Number.parseInt(process.env.MTCUTE_LOG_LEVEL ?? '', 10);
      if (!Number.isNaN(envLogLevel)) {
        return envLogLevel;
      }
      return null;
    },
    getDeviceModel: () => `Node.js/${process.version} (${os.type()} ${os.arch()})`,
  };
}

function sanitizeString(value) {
  return typeof value === 'string' ? value : '';
}
function coerceApiId(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  throw new Error('TELEGRAM_API_ID must be a number');
}

function normalizeTelegramProxyUrl(proxyUrl) {
  let url;
  try {
    url = new URL(proxyUrl);
  } catch {
    return proxyUrl;
  }

  const isTelegramMtProxy = url.hostname === 't.me'
    && (url.pathname === '/proxy' || url.pathname === '/socks');
  const secret = url.searchParams.get('secret');
  if (!isTelegramMtProxy || !secret?.match(/^ee[0-9a-f]+$/i) || secret.length % 2 !== 0) {
    return proxyUrl;
  }

  // Telegram share links encode the entire FakeTLS payload as hexadecimal
  // bytes: `ee`, the 16-byte key, and the domain bytes. mtcute accepts the
  // same payload in URL-safe base64.
  const normalizedSecret = Buffer.from(secret, 'hex').toString('base64url');
  url.searchParams.set('secret', normalizedSecret);
  return url.toString();
}

export function normalizePeerType(peer) {
  if (!peer) return 'chat';
  if (peer.type === 'user' || peer.type === 'bot') return 'user';
  if (peer.type === 'channel') return 'channel';
  if (peer.type === 'chat' && peer.chatType && peer.chatType !== 'group') return 'channel';
  return 'chat';
}

export function isGroupPeer(peer) {
  if (!peer) return false;
  if (typeof peer.isGroup === 'boolean') {
    return peer.isGroup;
  }
  if (peer.type === 'chat') {
    return true;
  }
  if (peer.type === 'channel' && typeof peer.chatType === 'string') {
    return peer.chatType !== 'channel';
  }
  return false;
}

export function extractTopicId(message) {
  if (!message) return null;
  if (typeof message.replyToMessage?.threadId === 'number') {
    return message.replyToMessage.threadId;
  }
  if (message.action?.type === 'topic_created' && typeof message.id === 'number') {
    return message.id;
  }
  const raw = message.raw ?? message;
  const replyTo = raw?.replyTo;
  if (replyTo?.replyToTopId) {
    return replyTo.replyToTopId;
  }
  return null;
}

function normalizeMediaText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

function normalizeMediaNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readMediaProperty(media, prop) {
  if (!media) {
    return null;
  }
  try {
    return media[prop];
  } catch (error) {
    return null;
  }
}

function buildWebpageExtras(media) {
  if (!media || media.type !== 'webpage' || !media.preview) {
    return null;
  }
  const preview = media.preview;
  const previewData = {
    url: preview.url ?? null,
    displayUrl: preview.displayUrl ?? null,
    siteName: preview.siteName ?? null,
    title: preview.title ?? null,
    description: preview.description ?? null,
    author: preview.author ?? null,
    previewType: preview.previewType ?? null,
  };
  const hasPreview = Object.values(previewData).some((value) => value);
  const extras = {};
  if (hasPreview) {
    extras.preview = previewData;
  }
  if (typeof media.displaySize === 'string') {
    extras.displaySize = media.displaySize;
  }
  if (typeof media.manual === 'boolean') {
    extras.manual = media.manual;
  }
  return Object.keys(extras).length ? extras : null;
}

export function summarizeMedia(media) {
  if (!media || typeof media !== 'object') {
    return null;
  }
  const type = normalizeMediaText(media.type);
  if (!type) {
    return null;
  }

  const summary = {
    type,
    fileId: normalizeMediaText(readMediaProperty(media, 'fileId') ?? media.file_id),
    uniqueFileId: normalizeMediaText(readMediaProperty(media, 'uniqueFileId') ?? media.unique_file_id),
    fileName: normalizeMediaText(readMediaProperty(media, 'fileName') ?? media.file_name),
    mimeType: normalizeMediaText(readMediaProperty(media, 'mimeType') ?? media.mime_type),
    fileSize: normalizeMediaNumber(readMediaProperty(media, 'fileSize') ?? media.file_size),
    width: normalizeMediaNumber(readMediaProperty(media, 'width') ?? media.width),
    height: normalizeMediaNumber(readMediaProperty(media, 'height') ?? media.height),
    duration: normalizeMediaNumber(readMediaProperty(media, 'duration') ?? media.duration),
    extras: null,
  };

  if (!summary.mimeType && type === 'photo') {
    summary.mimeType = 'image/jpeg';
  }

  if (media.extras && typeof media.extras === 'object') {
    summary.extras = media.extras;
  } else {
    summary.extras = buildWebpageExtras(media);
  }

  if (type === 'webpage' && media.preview) {
    const previewMedia = media.preview.document ?? media.preview.photo ?? null;
    if (previewMedia) {
      const previewSummary = summarizeMedia(previewMedia);
      if (previewSummary) {
        summary.fileId = summary.fileId ?? previewSummary.fileId;
        summary.uniqueFileId = summary.uniqueFileId ?? previewSummary.uniqueFileId;
        summary.fileName = summary.fileName ?? previewSummary.fileName;
        summary.mimeType = summary.mimeType ?? previewSummary.mimeType;
        summary.fileSize = summary.fileSize ?? previewSummary.fileSize;
        summary.width = summary.width ?? previewSummary.width;
        summary.height = summary.height ?? previewSummary.height;
        summary.duration = summary.duration ?? previewSummary.duration;
      }
    }
  }

  return summary;
}

export function normalizeChannelId(channelId) {
  if (typeof channelId === 'number') {
    return channelId;
  }
  if (typeof channelId === 'bigint') {
    return Number(channelId);
  }
  if (typeof channelId === 'string') {
    const trimmed = channelId.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isNaN(numeric)) {
        return numeric;
      }
    }
    return trimmed;
  }
  throw new Error('Invalid channel ID provided');
}

class TelegramClient {
  constructor(apiId, apiHash, phoneNumber, sessionPath = DEFAULT_SESSION_PATH, options = {}) {
    this.apiId = coerceApiId(apiId);
    this.apiHash = sanitizeString(apiHash);
    this.phoneNumber = sanitizeString(phoneNumber);
    this.sessionPath = path.resolve(sessionPath);
    this.options = options;

    const dataDir = path.dirname(this.sessionPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.updateEmitter = new EventEmitter();
    this.updatesRunning = false;
    this.rawUpdateHandler = null;
    const userUpdates = options.updates ?? {};
    const updatesConfig = {
      ...userUpdates,
      catchUp: userUpdates.catchUp ?? true,
      onChannelTooLong: (channelId, diff) => {
        if (typeof userUpdates.onChannelTooLong === 'function') {
          userUpdates.onChannelTooLong(channelId, diff);
        }
        this.updateEmitter.emit('channelTooLong', { channelId, diff });
      },
    };
    this.updatesConfig = updatesConfig;
    this.client = this._createClient();
  }

  _createClient() {
    const clientOptions = {
      apiId: this.apiId,
      apiHash: this.apiHash,
      storage: this.sessionPath,
      platform: createPlatform(),
    };
    if (this.options.proxy) {
      clientOptions.transport = proxyTransportFromUrl(normalizeTelegramProxyUrl(this.options.proxy));
    }
    if (this.options.disableUpdates) {
      clientOptions.disableUpdates = true;
    } else {
      clientOptions.updates = this.updatesConfig;
    }
    return new MtCuteClient(clientOptions);
  }

  _isAuthKeyUnregisteredError(error) {
    if (!error) return false;
    const code = error.code || error.status || error.errorCode;
    const message = (error.errorMessage || error.text || error.message || '').toUpperCase();
    return code === 401 && message.includes('AUTH_KEY_UNREGISTERED');
  }

  _isSessionResetError(error) {
    if (!error) return false;
    const message = (error.errorMessage || error.text || error.message || '').toUpperCase();
    return message.includes('SESSION IS RESET');
  }

  async _recreateClient() {
    try {
      await this.client.destroy();
    } catch (error) {
      console.warn('[warning] failed to destroy MTProto client during reset:', error?.message || error);
    }
    this.client = this._createClient();
    this.updatesRunning = false;
    this.rawUpdateHandler = null;
  }

  async _resetSessionAndClient() {
    const sessionFiles = [this.sessionPath, `${this.sessionPath}-wal`, `${this.sessionPath}-shm`];
    for (const filePath of sessionFiles) {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      }
    }
    await this._recreateClient();
  }

  _isUnauthorizedError(error) {
    if (!error) return false;
    const code = error.code || error.status || error.errorCode;
    if (code === 401) {
      return true;
    }
    const message = (error.errorMessage || error.message || '').toUpperCase();
    return message.includes('AUTH_KEY') || message.includes('AUTHORIZATION') || message.includes('SESSION_PASSWORD_NEEDED');
  }

  async _verifyIdentity(user) {
    if (typeof this.options.identityVerifier === 'function') {
      await this.options.identityVerifier(user);
    }
    return user;
  }

  async _isAuthorized() {
    try {
      const user = await this.client.getMe();
      await this._verifyIdentity(user);
      return true;
    } catch (error) {
      if (this._isUnauthorizedError(error)) {
        return false;
      }
      throw error;
    }
  }

  async isAuthorized() {
    return this._isAuthorized();
  }

  async getCurrentUser() {
    try {
      const user = await this.client.getMe();
      return await this._verifyIdentity(user);
    } catch (error) {
      if (this._isUnauthorizedError(error)) {
        return null;
      }
      throw error;
    }
  }

  async _askQuestion(prompt) {
    const ask = () => {
      if (process.stdin.isPaused()) {
        process.stdin.resume();
      }
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      return new Promise(resolve => {
        rl.question(prompt, answer => {
          rl.close();
          resolve(answer.trim());
        });
      });
    };

    let answer = await ask();
    if (!answer) {
      answer = await ask();
    }
    return answer;
  }

  async _askHiddenQuestion(prompt) {
    if (!process.stdin.isTTY) {
      return this._askQuestion(prompt);
    }

    if (process.stdin.isPaused()) {
      process.stdin.resume();
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.stdoutMuted = false;
    const writeOutput = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (stringToWrite) => {
      if (!rl.stdoutMuted) {
        writeOutput(stringToWrite);
      }
    };

    return new Promise(resolve => {
      rl.question(prompt, answer => {
        rl.output.write('\n');
        rl.close();
        resolve(answer.trim());
      });
      rl.stdoutMuted = true;
    });
  }

  _buildStartParams() {
    const startParams = {
      password: this.options.passwordProvider ?? (async () => {
        const value = await this._askHiddenQuestion('Enter your 2FA password (leave empty if not enabled): ');
        return value.length ? value : undefined;
      }),
    };

    if (this.options.useQr) {
      startParams.qrCodeHandler = this.options.qrUrlHandler ?? ((url, expiresAt) => {
        const expiresLabel = expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime())
          ? expiresAt.toISOString()
          : 'unknown';
        console.log('\nScan this QR code in Telegram: Settings -> Devices -> Link Desktop Device');
        qrcode.generate(url, { small: true }, (rendered) => {
          console.log(rendered);
        });
        console.log(`QR login URL: ${url}`);
        console.log(`QR expires at: ${expiresLabel}`);
      });
    } else {
      startParams.phone = this.phoneNumber;
      startParams.code = this.options.codeProvider ?? (async () => await this._askQuestion('Enter the code you received: '));
      startParams.codeSentCallback = async (sentCode) => {
        if (this.options.forceSms && (sentCode.type === 'app' || sentCode.type === 'email')) {
          try {
            await this.client.resendCode({ phone: this.phoneNumber, phoneCodeHash: sentCode.phoneCodeHash });
            console.log('Code re-sent via SMS.');
          } catch (e) {
            const msg = (e.text || e.message || '').toUpperCase();
            if (msg.includes('SEND_CODE_UNAVAILABLE')) {
              console.log('SMS unavailable for this number. Please use the code sent via app.');
            } else {
              console.log(`Could not request SMS (${e.text || e.message}). Using code sent via ${sentCode.type}.`);
            }
          }
        } else {
          console.log(`The confirmation code has been sent via ${sentCode.type}.`);
        }
      };
    }

    return startParams;
  }

  async login(retriedAfterReset = false, retriedAfterSessionReset = false) {
    try {
      const hasExistingSession = await this._isAuthorized();

      if (!hasExistingSession && !this.options.useQr && !this.phoneNumber) {
        throw new Error('TELEGRAM_PHONE_NUMBER is not configured.');
      }

      await this.client.start(this._buildStartParams());
      if (typeof this.options.identityVerifier === 'function') {
        const authenticatedUser = await this.client.getMe();
        await this._verifyIdentity(authenticatedUser);
      }

      this._restrictSessionFileMode();
      console.log(hasExistingSession ? 'Existing session is valid.' : 'Logged in successfully!');
      return true;
    } catch (error) {
      if (!retriedAfterReset && this._isAuthKeyUnregisteredError(error)) {
        console.log('Detected AUTH_KEY_UNREGISTERED. Resetting local session and retrying login once...');
        try {
          await this._resetSessionAndClient();
          return await this.login(true, retriedAfterSessionReset);
        } catch (resetError) {
          console.error('Failed to recover from AUTH_KEY_UNREGISTERED:', resetError);
          return false;
        }
      }
      if (!retriedAfterSessionReset && this._isSessionResetError(error)) {
        console.log('Detected session reset during login. Recreating MTProto client and retrying once...');
        try {
          await this._recreateClient();
          return await this.login(retriedAfterReset, true);
        } catch (resetError) {
          console.error('Failed to recover from session reset:', resetError);
          return false;
        }
      }
      console.error('Error during login:', error);
      return false;
    }
  }

  // The session file is the account credential, so it gets the same 0600 the store
  // already gives config.json and account.json. mtcute writes it with the default umask.
  _restrictSessionFileMode() {
    try {
      fs.chmodSync(this.sessionPath, 0o600);
    } catch {
      // A missing or foreign-owned session file is not a reason to fail the login
    }
  }

  async ensureLogin() {
    if (!(await this._isAuthorized())) {
      throw new Error('Not logged in to Telegram. Please restart the server.');
    }
    return true;
  }

  async initializeDialogCache() {
    console.log('Initializing dialog list...');
    const loginSuccess = await this.login();
    if (!loginSuccess) {
      throw new Error('Failed to login to Telegram. Cannot proceed.');
    }
    await this.startUpdates();
    console.log('Dialogs ready.');
    return true;
  }

  async listDialogs(limit = 50, retriedAfterSessionReset = false) {
    try {
      await this.ensureLogin();
      const effectiveLimit = limit && limit > 0 ? limit : Infinity;
      const results = [];

      for await (const dialog of this.client.iterDialogs({})) {
        const peer = dialog.peer;
        if (!peer) continue;

        const id = peer.id.toString();
        const username = 'username' in peer ? peer.username ?? null : null;
        const chatType = typeof peer.chatType === 'string' ? peer.chatType : null;
        const isForum = typeof peer.isForum === 'boolean' ? peer.isForum : null;
        const isGroup = typeof peer.isGroup === 'boolean' ? peer.isGroup : null;
        results.push({
          id,
          type: normalizePeerType(peer),
          title: peer.displayName || 'Unknown',
          username,
          chatType,
          isForum,
          isGroup,
        });

        if (results.length >= effectiveLimit) {
          break;
        }
      }

      return results;
    } catch (error) {
      if (!retriedAfterSessionReset && this._isSessionResetError(error)) {
        console.log('Detected session reset while listing dialogs. Recreating MTProto client and retrying once...');
        await this._recreateClient();
        const loginSuccess = await this.login();
        if (!loginSuccess) {
          throw new Error('Failed to restore session after dialog fetch reset.');
        }
        return this.listDialogs(limit, true);
      }
      throw error;
    }
  }


  _serializeMessage(message, peer = null) {
    const resolvedPeer = peer ?? message?.chat ?? null;
    const id = typeof message.id === 'number' ? message.id : Number(message.id || 0);
    let dateSeconds = null;
    if (message.date instanceof Date) {
      dateSeconds = Math.floor(message.date.getTime() / 1000);
    } else if (typeof message.date === 'number') {
      dateSeconds = Math.floor(message.date);
    }

    let textContent = '';
    if (typeof message.text === 'string') {
      textContent = message.text;
    } else if (typeof message.message === 'string') {
      textContent = message.message;
    } else if (message.text && typeof message.text.toString === 'function') {
      textContent = message.text.toString();
    }

    // Extract URLs from message entities (text_link and url kinds)
    const urls = [];
    const entities = message.entities;
    if (Array.isArray(entities)) {
      for (const entity of entities) {
        try {
          const kind = entity.kind;
          if (kind === 'text_link') {
            const url = entity.params?.url;
            if (url) urls.push(url);
          } else if (kind === 'url') {
            const urlText = entity.text;
            if (urlText) urls.push(urlText);
          }
        } catch {}
      }
    }

    const sender = message.sender || message.from || message.author;
    let senderId = sender?.id ? sender.id.toString() : null;
    if (!senderId) {
      const rawFrom = message.fromId ?? message.raw?.fromId;
      if (rawFrom && typeof rawFrom === 'object') {
        senderId = (rawFrom.userId ?? rawFrom.channelId ?? rawFrom.chatId ?? 'unknown').toString();
      } else if (rawFrom) {
        senderId = rawFrom.toString();
      } else {
        senderId = 'unknown';
      }
    }
    const topicId = extractTopicId(message);
    const senderUsername = typeof sender?.username === 'string' && sender.username ? sender.username : null;
    let senderDisplayName = null;
    if (typeof sender?.displayName === 'string' && sender.displayName.trim()) {
      senderDisplayName = sender.displayName.trim();
    } else {
      const nameParts = [sender?.firstName, sender?.lastName].filter(Boolean);
      senderDisplayName = nameParts.length ? nameParts.join(' ') : null;
    }
    const senderPeerType = sender ? normalizePeerType(sender) : null;
    const senderIsBot = typeof sender?.isBot === 'boolean' ? sender.isBot : null;
    const mediaSummary = summarizeMedia(message.media);

    return {
      id,
      date: dateSeconds,
      message: textContent,
      text: textContent,
      urls: urls.length > 0 ? urls : null,
      from_id: senderId,
      from_username: senderUsername,
      from_display_name: senderDisplayName,
      from_peer_type: senderPeerType,
      from_is_bot: senderIsBot,
      peer_type: normalizePeerType(resolvedPeer),
      peer_id: resolvedPeer?.id?.toString?.() ?? 'unknown',
      topic_id: topicId,
      media: mediaSummary,
      raw: message.raw ?? null,
    };
  }

  async destroy() {
    if (this.updatesRunning) {
      try {
        await this.client.stopUpdatesLoop();
      } catch (error) {
        console.warn('[warning] failed to stop updates loop:', error?.message || error);
      }
      this.updatesRunning = false;
    }
    if (this.rawUpdateHandler) {
      this.client.onRawUpdate.remove(this.rawUpdateHandler);
      this.rawUpdateHandler = null;
    }
    await this.client.destroy();
  }

  onUpdate(listener) {
    this.updateEmitter.on('update', listener);
    return () => this.updateEmitter.off('update', listener);
  }

  onChannelTooLong(listener) {
    this.updateEmitter.on('channelTooLong', listener);
    return () => this.updateEmitter.off('channelTooLong', listener);
  }

  async startUpdates() {
    if (this.updatesRunning) {
      return;
    }
    try {
      if (!this.rawUpdateHandler) {
        this.rawUpdateHandler = (update) => {
          this.updateEmitter.emit('update', update);
        };
        this.client.onRawUpdate.add(this.rawUpdateHandler);
      }
      await this.client.startUpdatesLoop();
      this.updatesRunning = true;
    } catch (error) {
      console.warn('[warning] failed to start updates loop:', error?.message || error);
    }
  }

}

export default TelegramClient;
