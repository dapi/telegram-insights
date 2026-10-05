import { Long, Message, PeersIndex } from '@mtcute/core';
import { describe, expect, it } from 'vitest';

import { classifyTelegramError, normalizeMessage, peerKind } from '../src/telegram/gateway.js';

const users = [{ _: 'user', id: 42, accessHash: Long.fromNumber(1), firstName: 'Синтетический', lastName: 'Автор', username: 'synthetic_author' }];
const chats = [
  { _: 'channel', id: 1000000003, accessHash: Long.fromNumber(2), title: 'Синтетический канал', broadcast: true, date: 0, photo: { _: 'chatPhotoEmpty' } },
  { _: 'channel', id: 1000000004, accessHash: Long.fromNumber(3), title: 'Синтетическая супергруппа', megagroup: true, forum: true, date: 0, photo: { _: 'chatPhotoEmpty' } },
];

function raw(extra) {
  return { _: 'message', id: 77, date: 1_791_000_000, message: 'Синтетический текст', ...extra };
}

describe('mtcute gateway normalization', () => {
  it('normalizes a channel post', () => {
    const msg = new Message(raw({ peerId: { _: 'peerChannel', channelId: 1000000003 }, post: true }), PeersIndex.from({ users, chats }));
    const n = normalizeMessage(msg, '-1001000000003');
    expect(n).toMatchObject({ chatId: '-1001000000003', messageId: 77, text: 'Синтетический текст', isService: false });
    expect(n.sentAt.toISOString()).toBe(new Date(1_791_000_000_000).toISOString());
    expect(peerKind(msg.chat)).toBe('channel');
  });

  it('keeps the forum topic and sender of a supergroup message', () => {
    const msg = new Message(raw({
      peerId: { _: 'peerChannel', channelId: 1000000004 },
      fromId: { _: 'peerUser', userId: 42 },
      replyTo: { _: 'messageReplyHeader', forumTopic: true, replyToMsgId: 5, replyToTopId: 5 },
    }), PeersIndex.from({ users, chats }));
    const n = normalizeMessage(msg, '-1001000000004');
    expect(n.senderId).toBe('42');
    expect(n.senderName).toBe('Синтетический Автор');
    expect(n.topicId).toBe(5);
    expect(peerKind(msg.chat)).toBe('supergroup');
  });

  it('classifies private dialogs, bots and saved messages', () => {
    expect(peerKind({ type: 'user', id: 1, isBot: false })).toBe('user');
    expect(peerKind({ type: 'user', id: 2, isBot: true })).toBe('bot');
    expect(peerKind({ type: 'user', id: 3, isSelf: true })).toBe('saved');
    expect(peerKind({ type: 'chat', chatType: 'group' })).toBe('group');
    expect(peerKind({ type: 'chat', chatType: 'gigagroup' })).toBe('supergroup');
  });

  it('extracts FLOOD_WAIT seconds and access error codes', () => {
    const flood = classifyTelegramError({ text: 'FLOOD_WAIT_37' });
    expect(flood).toMatchObject({ code: 'FLOOD_WAIT', waitSeconds: 37 });
    expect(classifyTelegramError(new Error('A wait of 12 seconds is required')).waitSeconds).toBe(12);
    expect(classifyTelegramError({ text: 'CHANNEL_PRIVATE' }).code).toBe('CHANNEL_PRIVATE');
  });
});
