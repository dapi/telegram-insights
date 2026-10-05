import { TelegramError } from '../../src/telegram/gateway.js';

const HOUR = 3_600_000;

// In-memory Telegram account with synthetic chats. It mimics the parts of
// messages.getHistory the archiver relies on: newest-first pages, offset_id,
// min_id, holes left by deleted messages and FLOOD_WAIT / access errors.
export class FakeTelegram {
  constructor({ now = () => Date.now(), self = { id: '777000111', username: 'synthetic_owner' } } = {}) {
    this.now = now;
    this.self = self;
    this.chats = new Map();
    this.calls = [];
    this.failures = [];
    this.listeners = new Set();
    this.tooLongListeners = new Set();
    this.beforeHistory = null;
    this.updatesStarted = false;
  }

  addChat({ chatId, peerKind = 'user', title = `Chat ${chatId}`, username = null, isForum = false }) {
    this.chats.set(String(chatId), {
      chatId: String(chatId), peerKind, title, username, isForum, messages: [], nextId: 1, unavailable: null,
    });
    return this.chats.get(String(chatId));
  }

  // Adds messages spread evenly over the last `hours` hours, oldest first.
  seed(chatId, count, { hours = 24 * 20, text = (i) => `synthetic message ${i}`, sender = 'Синтетический автор' } = {}) {
    const start = this.now() - hours * HOUR;
    const step = (hours * HOUR) / Math.max(1, count);
    for (let i = 0; i < count; i += 1) {
      this.addMessage(chatId, { text: text(i), sentAt: new Date(start + i * step), senderName: sender }, { live: false });
    }
  }

  addMessage(chatId, { text, sentAt = new Date(this.now()), senderId = '42', senderName = 'Синтетический автор', topicId = null }, { live = true } = {}) {
    const chat = this.chats.get(String(chatId));
    const message = {
      chatId: chat.chatId,
      messageId: chat.nextId++,
      topicId,
      sentAt,
      senderId,
      senderName,
      senderUsername: null,
      text,
      mediaType: null,
      media: null,
      replyToId: null,
      forward: null,
      groupedId: null,
      isService: false,
    };
    chat.messages.push(message);
    if (live && this.updatesStarted) {
      for (const listener of this.listeners) listener({ ...message }, this._chatInfo(chat));
    }
    return message;
  }

  deleteMessages(chatId, predicate) {
    const chat = this.chats.get(String(chatId));
    chat.messages = chat.messages.filter((m) => !predicate(m));
  }

  failNext(method, error, { chatId = null, times = 1 } = {}) {
    this.failures.push({ method, error, chatId: chatId === null ? null : String(chatId), times });
  }

  _maybeFail(method, chatId = null) {
    const rule = this.failures.find((f) => f.method === method && (f.chatId === null || f.chatId === String(chatId)) && f.times > 0);
    if (rule) {
      rule.times -= 1;
      throw rule.error;
    }
  }

  _chatInfo(chat) {
    return { chatId: chat.chatId, peerKind: chat.peerKind, title: chat.title, username: chat.username };
  }

  async getSelf() {
    return this.self;
  }

  onMessage(listener) {
    this.listeners.add(listener);
  }

  onChannelTooLong(listener) {
    this.tooLongListeners.add(listener);
  }

  async startUpdates() {
    this.updatesStarted = true;
  }

  async listDialogs({ beforeChunk = async () => {} } = {}) {
    await beforeChunk();
    this.calls.push({ method: 'listDialogs', at: this.now() });
    this._maybeFail('listDialogs');
    const dialogs = [...this.chats.values()].map((chat) => {
      const top = chat.messages[chat.messages.length - 1] ?? null;
      return {
        chatId: chat.chatId,
        peerKind: chat.peerKind,
        title: chat.title,
        username: chat.username,
        isForum: chat.isForum,
        topMessageId: top?.messageId ?? null,
        topMessageAt: top?.sentAt ?? null,
      };
    });
    dialogs.sort((a, b) => (b.topMessageAt?.getTime() ?? 0) - (a.topMessageAt?.getTime() ?? 0));
    return dialogs.map((d, rank) => ({ ...d, rank }));
  }

  async getHistoryPage(chatId, { offsetId = 0, minId = 0, limit = 100, username = null }) {
    this.calls.push({ method: 'getHistory', chatId: String(chatId), offsetId, minId, limit, username, at: this.now() });
    if (this.beforeHistory) await this.beforeHistory({ chatId: String(chatId), offsetId, minId });
    this._maybeFail('getHistory', chatId);
    const chat = this.chats.get(String(chatId));
    if (!chat) throw new TelegramError('PEER_ID_INVALID', 'PEER_ID_INVALID');
    if (chat.unavailable) throw new TelegramError(chat.unavailable, chat.unavailable);
    const matching = chat.messages
      .filter((m) => (offsetId ? m.messageId < offsetId : true) && m.messageId > minId)
      .sort((a, b) => b.messageId - a.messageId);
    const page = matching.slice(0, limit).map((m) => ({ ...m }));
    const isChannelLike = chat.peerKind === 'channel' || chat.peerKind === 'supergroup';
    return { messages: page, complete: !isChannelLike && offsetId === 0 && matching.length <= limit };
  }

  historyCalls(chatId = null) {
    return this.calls.filter((c) => c.method === 'getHistory' && (chatId === null || c.chatId === String(chatId)));
  }
}

export const floodWait = (seconds) => new TelegramError('FLOOD_WAIT', `FLOOD_WAIT_${seconds}`, { waitSeconds: seconds });
export const telegramError = (code) => new TelegramError(code, code);
