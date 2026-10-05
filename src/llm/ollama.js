// Local model route. Message text, embeddings and digests must not leave the
// host unless Danil approves a specific route, so non-loopback endpoints are
// refused unless their host is listed in TI_APPROVED_MODEL_HOSTS.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function assertLocalRoute(baseUrl, approvedHosts = []) {
  const url = new URL(baseUrl);
  if (LOOPBACK.has(url.hostname) || approvedHosts.includes(url.hostname)) return url;
  throw new Error(`Model endpoint ${url.hostname} is not local; add it to TI_APPROVED_MODEL_HOSTS only after explicit approval`);
}

async function post(url, body, { timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Ollama ${new URL(url).pathname} returned HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class OllamaEmbedder {
  constructor({ baseUrl = 'http://127.0.0.1:11434', model = 'qwen3-embedding:0.6b', dimensions = 1024, approvedHosts = [], timeoutMs = 120_000 } = {}) {
    this.base = assertLocalRoute(baseUrl, approvedHosts);
    this.model = model;
    this.dimensions = dimensions;
    this.timeoutMs = timeoutMs;
  }

  get id() {
    return `ollama:${this.model}`;
  }

  async embed(texts) {
    const data = await post(new URL('/api/embed', this.base), { model: this.model, input: texts, truncate: true }, { timeoutMs: this.timeoutMs });
    const vectors = data.embeddings ?? [];
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== this.dimensions)) {
      throw new Error(`Embedding model ${this.model} returned unexpected shape`);
    }
    return vectors;
  }

  // qwen3-embedding expects an instruction on the query side only.
  async embedQuery(text) {
    const [vector] = await this.embed([`Instruct: Найди сообщения из переписок, которые отвечают на запрос\nQuery: ${text}`]);
    return vector;
  }
}

export class OllamaChat {
  constructor({ baseUrl = 'http://127.0.0.1:11434', model = 'qwen3:8b', approvedHosts = [], timeoutMs = 600_000, numCtx = 16_384 } = {}) {
    this.base = assertLocalRoute(baseUrl, approvedHosts);
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.numCtx = numCtx;
  }

  get id() {
    return `ollama:${this.model}`;
  }

  async complete({ system, prompt, json = false, temperature = 0.2 }) {
    const data = await post(new URL('/api/chat', this.base), {
      model: this.model,
      stream: false,
      think: false,
      format: json ? 'json' : undefined,
      options: { temperature, num_ctx: this.numCtx },
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }, { timeoutMs: this.timeoutMs });
    return (data.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
}
