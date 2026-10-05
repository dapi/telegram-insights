import { Long, Message, PeersIndex } from '@mtcute/core';

import TelegramClient, { extractTopicId, summarizeMedia } from './client.js';

// The gateway is the only place that talks MTProto. Everything above it works
// with plain normalized objects, which keeps the archiver testable with a fake.

export function peerKind(peer, selfId = null) {
  if (!peer) return 'unknown';
  if (peer.type === 'user') {
    if (peer.isSelf || (selfId && String(peer.id) === String(selfId))) return 'saved';
    return peer.isBot ? 'bot' : 'user';
  }
  if (peer.type === 'chat') {
    switch (peer.chatType) {
      case 'group':
        return 'group';
      case 'channel':
        return 'channel';
      default:
        return 'supergroup';
    }
  }
  return 'unknown';
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value * 1000);
  return null;
}

function forwardInfo(message) {
  try {
    const fwd = message.forward;
    if (!fwd) return null;
    const sender = fwd.sender;
    return {
      date: toDate(fwd.date)?.toISOString() ?? null,
      from_id: sender && typeof sender === 'object' && 'id' in sender ? String(sender.id) : null,
      from_name: sender && typeof sender === 'object'
        ? (sender.displayName ?? sender.title ?? null)
        : (typeof sender === 'string' ? sender : null),
      from_message_id: fwd.fromMessageId ?? null,
    };
  } catch {
    return null;
  }
}

export function normalizeMessage(message, chatId) {
  const id = Number(message.id);
  const date = toDate(message.date);
  if (!Number.isFinite(id) || !date) return null;
  let text = '';
  if (typeof message.text === 'string') text = message.text;
  const sender = (() => {
    try { return message.sender; } catch { return null; }
  })();
  const media = (() => {
    try { return summarizeMedia(message.media); } catch { return null; }
  })();
  let replyTo = null;
  try { replyTo = message.replyToMessage?.id ?? null; } catch { replyTo = null; }
  let isService = false;
  try { isService = Boolean(message.isService); } catch { isService = false; }
  let groupedId = null;
  try { groupedId = message.groupedIdUnique ?? null; } catch { groupedId = null; }
  let senderName = null;
  if (sender) {
    senderName = sender.displayName ?? ([sender.firstName, sender.lastName].filter(Boolean).join(' ') || null);
  }
  return {
    chatId: String(chatId ?? message.chat?.id),
    messageId: id,
    topicId: extractTopicId(message),
    sentAt: date,
    senderId: sender?.id != null ? String(sender.id) : null,
    senderName,
    senderUsername: typeof sender?.username === 'string' ? sender.username : null,
    text,
    mediaType: media?.type ?? null,
    media,
    replyToId: replyTo,
    forward: forwardInfo(message),
    groupedId,
    isService,
  };
}

export class TelegramError extends Error {
  constructor(code, message, { waitSeconds = null } = {}) {
    super(message || code);
    this.code = code;
    this.waitSeconds = waitSeconds;
  }
}

export function classifyTelegramError(error) {
  const text = String(error?.text ?? error?.errorMessage ?? error?.message ?? error ?? '');
  const flood = /FLOOD_(?:PREMIUM_)?WAIT_(\d+)/i.exec(text) ?? /wait of (\d+) seconds is required/i.exec(text);
  if (flood) {
    return new TelegramError('FLOOD_WAIT', `FLOOD_WAIT_${flood[1]}`, { waitSeconds: Number(flood[1]) });
  }
  const name = typeof error?.name === 'string' && error.name !== 'Error' ? error.name : null;
  const code = (/([A-Z][A-Z0-9_]{3,})/.exec(text)?.[1]) ?? name ?? 'UNKNOWN';
  const result = new TelegramError(code, code);
  // Technical hint without identifiers; never contains message text.
  result.hint = text.replace(/\d+/g, '#').slice(0, 120);
  return result;
}

export class MtcuteGateway {
  constructor({ apiId, apiHash, phoneNumber, sessionPath, proxy, log = console, loginOptions = {} }) {
    this.log = log;
    this.client = new TelegramClient(apiId, apiHash, phoneNumber, sessionPath, {
      proxy: proxy || undefined,
      updates: { catchUp: true },
      ...loginOptions,
    });
    this.mt = this.client.client;
    this.self = null;
    this.messageListeners = new Set();
    this.channelTooLongListeners = new Set();
  }

  async login() {
    const ok = await this.client.login();
    if (!ok) throw new Error('Telegram login failed');
    return this.getSelf();
  }

  async connect() {
    const authorized = await this.client.isAuthorized();
    if (!authorized) {
      throw new Error('Telegram Insights session is not authorized; run `telegram-insights login` interactively');
    }
    return this.getSelf();
  }

  async getSelf() {
    if (!this.self) {
      const me = await this.mt.getMe();
      this.self = { id: String(me.id), username: me.username ?? null };
    }
    return this.self;
  }

  async startUpdates() {
    this.mt.onNewMessage.add((message) => {
      const normalized = normalizeMessage(message, message.chat?.id);
      if (!normalized) return;
      const chat = {
        chatId: String(message.chat.id),
        peerKind: peerKind(message.chat, this.self?.id),
        title: message.chat.displayName ?? null,
        username: message.chat.username ?? null,
      };
      for (const listener of this.messageListeners) listener(normalized, chat);
    });
    this.client.onChannelTooLong(({ channelId }) => {
      for (const listener of this.channelTooLongListeners) listener(String(channelId));
    });
    await this.client.startUpdates();
  }

  onMessage(listener) {
    this.messageListeners.add(listener);
  }

  onChannelTooLong(listener) {
    this.channelTooLongListeners.add(listener);
  }

  // Returns every dialog including archived chats. `beforeChunk` lets the caller
  // pace the underlying messages.getDialogs requests.
  async listDialogs({ beforeChunk = async () => {}, chunkSize = 100 } = {}) {
    const result = [];
    let index = 0;
    try {
      await beforeChunk();
      for await (const dialog of this.mt.iterDialogs({ archived: 'keep', pinned: 'include', chunkSize })) {
        index += 1;
        if (index % chunkSize === 0) await beforeChunk();
        const peer = dialog.peer;
        if (!peer) continue;
        let last = null;
        try { last = dialog.lastMessage; } catch { last = null; }
        result.push({
          chatId: String(peer.id),
          peerKind: peerKind(peer, this.self?.id),
          title: peer.displayName ?? null,
          username: peer.username ?? null,
          isForum: Boolean(peer.isForum),
          rank: result.length,
          topMessageId: last ? Number(last.id) : null,
          topMessageAt: last ? toDate(last.date) : null,
        });
      }
    } catch (error) {
      throw classifyTelegramError(error);
    }
    return result;
  }

  // One messages.getHistory call, newest first. FLOOD_WAIT is never retried here:
  // the archiver's limiter owns waiting so the pause is persisted and visible.
  // A user whose access hash is missing from the session cache fails with
  // PEER_ID_INVALID; resolving the public username restores it. The resolved
  // peer must be the same user, otherwise the original error stands.
  async resolveChat(chatId, username) {
    try {
      return await this.mt.resolvePeer(Number(chatId));
    } catch (error) {
      if (!username) throw error;
      const peer = await this.mt.resolvePeer(username);
      if (peer._ !== 'inputPeerUser' || String(peer.userId) !== String(chatId)) throw error;
      return peer;
    }
  }

  async getHistoryPage(chatId, { offsetId = 0, minId = 0, limit = 100, username = null }) {
    try {
      const peer = await this.resolveChat(chatId, username);
      const res = await this.mt.call({
        _: 'messages.getHistory',
        peer,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit,
        maxId: 0,
        minId,
        hash: Long.ZERO,
      }, { floodSleepThreshold: 0 });
      if (res._ === 'messages.messagesNotModified') {
        return { messages: [], complete: false };
      }
      const peers = PeersIndex.from(res);
      const messages = [];
      for (const raw of res.messages) {
        if (raw._ === 'messageEmpty') continue;
        const normalized = normalizeMessage(new Message(raw, peers), chatId);
        if (normalized) messages.push(normalized);
      }
      // messages.messages (not a slice) means the whole history fitted in this response.
      return { messages, complete: res._ === 'messages.messages' };
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }

  async destroy() {
    await this.client.destroy();
  }
}
