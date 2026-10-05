import { describe, expect, it } from 'vitest';

import { clusterChunks, isAutomated, selectStories, storyPrompt, storyScore, summarizeAutomated } from '../src/digest/digest.js';

const at = (hh, mm = 0) => new Date(Date.UTC(2026, 9, 4, hh, mm));

function chunk(chatId, vector, texts, { hour = 9, topicKey = 0, title = `Чат ${chatId}` } = {}) {
  return {
    chatId,
    topicKey,
    title,
    peerKind: 'supergroup',
    vector,
    messages: texts.map((text, i) => ({ messageId: hour * 100 + i, sentAt: at(hour, i), sender: 'Синтетик', text })),
  };
}

describe('clusterChunks', () => {
  it('merges close fragments of the same chat thread into one story', () => {
    const stories = clusterChunks([
      chunk('1', [1, 0, 0], ['созвоны по понедельникам'], { hour: 9 }),
      chunk('1', [0.75, 0.66, 0], ['анкета для участников'], { hour: 11 }),
      chunk('1', [0, 0, 1], ['печать на акт'], { hour: 13 }),
    ]);
    expect(stories).toHaveLength(2);
    expect(stories[0].members.map((m) => m.messages[0].text)).toEqual(['созвоны по понедельникам', 'анкета для участников']);
  });

  it('keeps the stricter threshold across chats', () => {
    const stories = clusterChunks([
      chunk('1', [1, 0, 0], ['тема']),
      chunk('2', [0.75, 0.66, 0], ['похожая тема']),
    ]);
    expect(stories).toHaveLength(2);
  });

  it('does not lower the threshold for another topic of the same forum', () => {
    const stories = clusterChunks([
      chunk('1', [1, 0, 0], ['тема'], { topicKey: 5 }),
      chunk('1', [0.75, 0.66, 0], ['похожая тема'], { topicKey: 7 }),
    ]);
    expect(stories).toHaveLength(2);
  });

  it('ranks members by closeness to the story centroid', () => {
    const [story] = clusterChunks([
      chunk('1', [1, 0, 0], ['центр 1']),
      chunk('2', [0.98, 0.2, 0], ['центр 2']),
      chunk('3', [0.85, 0, 0.53], ['край']),
    ]);
    expect(story.members).toHaveLength(3);
    const edge = story.members.find((m) => m.messages[0].text === 'край');
    const others = story.members.filter((m) => m !== edge);
    for (const m of others) expect(m.centrality).toBeGreaterThan(edge.centrality);
  });
});

describe('storyPrompt', () => {
  it('fills the budget with central fragments and keeps chronological order', () => {
    const long = 'x'.repeat(400);
    const story = {
      members: [
        { ...chunk('1', null, [`утро ${long}`], { hour: 8 }), centrality: 0.99 },
        { ...chunk('2', null, [`шум ${long}`], { hour: 9 }), centrality: 0.1 },
        { ...chunk('3', null, [`вечер ${long}`], { hour: 20 }), centrality: 0.95 },
      ],
    };
    const prompt = storyPrompt(story, { budget: 1000 });
    expect(prompt).toMatch(/утро/);
    expect(prompt).toMatch(/вечер/);
    expect(prompt).not.toMatch(/шум/);
    expect(prompt.indexOf('утро')).toBeLessThan(prompt.indexOf('вечер'));
    expect(prompt).toMatch(/ещё 1 фрагм\. сюжета не показано/);
  });
});

describe('storyScore', () => {
  it('puts a short personal conversation with the owner above a busy channel', () => {
    const channel = storyScore({ chats: 1, messages: 8 });
    const personal = storyScore({ chats: 1, messages: 3, personal: true, own: true });
    const mention = storyScore({ chats: 1, messages: 2, mentioned: true });
    expect(personal).toBeGreaterThan(channel);
    expect(mention).toBeGreaterThan(storyScore({ chats: 1, messages: 6 }));
  });

  it('exposes the signals on clustered stories', () => {
    const c = chunk('601', [1, 0], ['привет']);
    c.peerKind = 'user';
    c.messages[0].own = true;
    const [story] = clusterChunks([c]);
    expect(story.signals).toEqual({ personal: true, own: true, mentioned: false });
  });
});

describe('selectStories', () => {
  it('keeps separate quotas for the owner and for the rest', () => {
    const story = (own, n) => ({ n, signals: { personal: false, own, mentioned: false } });
    const ranked = [story(true, 1), story(true, 2), story(true, 3), story(false, 4), story(false, 5)];
    const { own, around } = selectStories(ranked, { maxOwn: 2, maxAround: 1 });
    expect(own.map((s) => s.n)).toEqual([1, 2]);
    expect(around.map((s) => s.n)).toEqual([4]);
  });
});

describe('story linking', () => {
  it('joins a reply to the story of the message it answers', () => {
    const congrats = chunk('1', [1, 0, 0], ['С днём рождения!'], { hour: 9 });
    const thanks = chunk('2', [0, 1, 0], ['спасибо'], { hour: 18 });
    const answer = chunk('1', [0, 0, 1], ['спасибо большое'], { hour: 20 });
    answer.messages[0].replyToId = congrats.messages[0].messageId;
    const stories = clusterChunks([congrats, thanks, answer]);
    const story = stories.find((s) => s.members.some((m) => m.messages[0].text === 'спасибо большое'));
    expect(story.members.map((m) => m.messages[0].text)).toContain('С днём рождения!');
  });

  it("attaches the owner's later reaction to the previous fragment of the thread", () => {
    const event = chunk('5', [1, 0, 0], ['Поздравляем с запуском!'], { hour: 9 });
    const reaction = chunk('5', [0, 1, 0], ['спасибо'], { hour: 21 });
    reaction.messages[0].own = true;
    const stories = clusterChunks([event, reaction]);
    expect(stories).toHaveLength(1);
  });
});

describe('automated fragments', () => {
  const alert = (text, hour) => {
    const c = chunk('-100', null, [text], { hour, title: 'Алерты' });
    c.messages[0].senderUsername = 'synthetic_alert_bot';
    return c;
  };

  it('recognises bot posts but not a conversation with a bot', () => {
    expect(isAutomated(alert('CPU 0.77', 9))).toBe(true);
    const dialog = chunk('9', null, ['напомни завтра', 'Напомню.'], { title: 'Бот' });
    dialog.peerKind = 'bot';
    dialog.messages[0].own = true;
    expect(isAutomated(dialog)).toBe(false);
    expect(isAutomated(chunk('3', null, ['обычное сообщение']))).toBe(false);
  });

  it('collapses a chat of alerts into counted kinds', () => {
    const [entry] = summarizeAutomated([alert('CPU 0.77 high\ndetails', 9), alert('CPU 0.81 high', 10), alert('MinIO replica lag', 11)]);
    expect(entry).toMatchObject({ chat: 'Алерты', messages: 3 });
    expect(entry.kinds[0]).toEqual({ text: 'CPU 0.77 high', count: 2 });
    expect(entry.kinds[1]).toEqual({ text: 'MinIO replica lag', count: 1 });
  });
});
