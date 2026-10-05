import crypto from 'node:crypto';

// Deterministic local stand-ins for the embedding and chat models.
export class FakeEmbedder {
  constructor(dimensions = 1024) {
    this.dimensions = dimensions;
    this.calls = 0;
  }

  get id() {
    return 'fake:bow';
  }

  vector(text) {
    const v = new Array(this.dimensions).fill(0);
    for (const word of String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
      const stem = word.slice(0, 6);
      const h = crypto.createHash('md5').update(stem).digest();
      v[h.readUInt16BE(0) % this.dimensions] += 1;
    }
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }

  async embed(texts) {
    this.calls += 1;
    return texts.map((t) => this.vector(t));
  }

  async embedQuery(text) {
    return this.vector(text);
  }
}

export class FakeChat {
  constructor() {
    this.prompts = [];
  }

  get id() {
    return 'fake:chat';
  }

  async complete({ prompt, json }) {
    this.prompts.push(prompt);
    if (json) {
      const first = /\] [^:]+: (.{0,40})/.exec(prompt)?.[1] ?? 'сюжет';
      return JSON.stringify({ title: `Сюжет: ${first}`, summary: 'Синтетический пересказ сюжета.', open_questions: [] });
    }
    if (prompt.startsWith('Вопрос:')) return 'По источникам бюджет утверждён [S1], обсуждение также шло в другом чате [S2].';
    return 'Синтетическая общая картина дня.';
  }
}
