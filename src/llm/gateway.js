// Models through the private LiteLLM gateway (OpenAI-compatible API). Approved
// by Danil on 2026-10-05 for message text, embeddings and digests. The gateway
// owns provider credentials; consumers only name an alias.

async function post(url, body, { timeoutMs, apiKey = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`LLM gateway ${new URL(url).pathname} returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const endpoint = (base, p) => `${base.replace(/\/+$/, '')}/${p}`;

export class GatewayEmbedder {
  constructor({ baseUrl, apiKey = null, model = 'telegram-insights-embedding', dimensions = 1024, timeoutMs = 120_000, batchSize = 64 }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.timeoutMs = timeoutMs;
    this.batchSize = batchSize;
  }

  get id() {
    return `gateway:${this.model}`;
  }

  async embed(texts) {
    const data = await post(endpoint(this.baseUrl, 'embeddings'), { model: this.model, input: texts }, { timeoutMs: this.timeoutMs, apiKey: this.apiKey });
    const vectors = [...(data.data ?? [])].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== this.dimensions)) {
      throw new Error(`Embedding alias ${this.model} returned unexpected shape`);
    }
    return vectors;
  }

  async embedQuery(text) {
    const [vector] = await this.embed([text]);
    return vector;
  }
}

export class GatewayChat {
  constructor({ baseUrl, apiKey = null, model = 'telegram-insights-chat', timeoutMs = 600_000 }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  get id() {
    return `gateway:${this.model}`;
  }

  async complete({ system, prompt, json = false, temperature = 0.2 }) {
    const data = await post(endpoint(this.baseUrl, 'chat/completions'), {
      model: this.model,
      temperature,
      response_format: json ? { type: 'json_object' } : undefined,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }, { timeoutMs: this.timeoutMs, apiKey: this.apiKey });
    let text = data.choices?.[0]?.message?.content ?? '';
    if (json) text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    return text.trim();
  }
}
