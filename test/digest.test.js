import { describe, expect, it } from 'vitest';

import { clusterChunks, storyPrompt } from '../src/digest/digest.js';

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
