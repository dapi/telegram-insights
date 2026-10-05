import crypto from 'node:crypto';

import { STATE_LABELS, coverageReport, resolveAccountId } from '../archive/status.js';
import { markdownLink, messageLink } from '../links.js';
import { EDITS_LIMITATION } from '../search/search.js';
import { DEFAULT_TZ, dayRange, formatLocal, formatTime } from '../time.js';

const STORY_SYSTEM = `Ты готовишь черновик ежедневной сводки по перепискам пользователя в Telegram.
Тебе дан один сюжет: сообщения из одного или нескольких чатов. Верни JSON:
{"title": "короткий заголовок сюжета", "summary": "2–4 предложения: что произошло", "open_questions": ["вопрос или расхождение, которое нельзя разрешить по сообщениям"]}
Правила: опирайся только на сообщения; не додумывай; если сообщения противоречат друг другу — опиши это в open_questions; пиши по-русски.`;

const OVERVIEW_SYSTEM = `По заголовкам и кратким описаниям сюжетов дня напиши общую картину дня: 2–4 предложения по-русски,
только из приведённого текста, без новых фактов.`;

function parseVector(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  return String(value).slice(1, -1).split(',').map(Number);
}

function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function normalizedHash(text) {
  const norm = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (norm.length < 40) return null;
  return crypto.createHash('sha1').update(norm).digest('hex');
}

function chatTopic(chunk) {
  return `${chunk.chatId}|${chunk.topicKey ?? 0}`;
}

function addInto(sum, v) {
  for (let i = 0; i < v.length; i += 1) sum[i] += v[i];
  return sum;
}

// Groups chunks into stories: identical long texts (reposts, forwards) always
// merge; otherwise a chunk joins the closest story centroid (running mean of
// member embeddings) — at `sameChatThreshold` when the story already holds
// the same chat thread, at the stricter `threshold` across chats. Each member
// gets `centrality`: cosine to its story centroid, used to pick what the model reads.
export function clusterChunks(chunks, { threshold = 0.8, sameChatThreshold = 0.7, maxPerCluster = 12 } = {}) {
  const parent = chunks.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  const byHash = new Map();
  chunks.forEach((chunk, i) => {
    for (const m of chunk.messages) {
      const h = normalizedHash(m.text);
      if (!h) continue;
      if (byHash.has(h)) union(i, byHash.get(h));
      else byHash.set(h, i);
    }
  });
  const order = chunks.map((_, i) => i).sort((a, b) => chunks[b].messages.length - chunks[a].messages.length);
  const centroids = [];
  for (const i of order) {
    const v = chunks[i].vector;
    if (!v) continue;
    const key = chatTopic(chunks[i]);
    let best = null;
    for (const c of centroids) {
      if (c.members.length >= maxPerCluster) continue;
      const sim = cosine(v, c.vector);
      const needed = c.threads.has(key) ? sameChatThreshold : threshold;
      if (sim >= needed && (!best || sim > best.sim)) best = { c, sim };
    }
    if (best) {
      union(i, best.c.members[0]);
      best.c.members.push(i);
      best.c.threads.add(key);
      addInto(best.c.vector, v);
    } else {
      centroids.push({ vector: [...v], members: [i], threads: new Set([key]) });
    }
  }
  const groups = new Map();
  chunks.forEach((chunk, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(chunk);
  });
  return [...groups.values()].map((members) => {
    const vectors = members.map((m) => m.vector).filter(Boolean);
    const centroid = vectors.length ? vectors.reduce((sum, v) => addInto(sum, v), new Array(vectors[0].length).fill(0)) : null;
    const ranked = members.map((m) => ({ ...m, centrality: centroid && m.vector ? cosine(m.vector, centroid) : 0 }));
    const chats = new Set(ranked.map((m) => m.chatId));
    const messages = ranked.flatMap((m) => m.messages);
    const channelPosts = ranked.filter((m) => m.peerKind === 'channel').length;
    return {
      members: ranked,
      chats,
      messages,
      score: 2 * chats.size + Math.log2(1 + messages.length) + 0.5 * Math.min(channelPosts, 3),
    };
  }).sort((a, b) => b.score - a.score);
}

function renderChunk(chunk) {
  const lines = [`Чат «${chunk.title ?? chunk.chatId}»:`];
  for (const m of chunk.messages.slice(0, 15)) {
    lines.push(`[${formatTime(m.sentAt)}] ${m.sender ?? 'неизвестный'}: ${(m.text ?? '').slice(0, 500)}`);
  }
  return lines.join('\n');
}

// The model reads the most central fragments first (closest to the story
// centroid) within the budget, then sees them in chronological order.
export function storyPrompt(story, { budget = 9000 } = {}) {
  const picked = [];
  let used = 0;
  for (const chunk of [...story.members].sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0))) {
    const text = renderChunk(chunk);
    if (picked.length && used + text.length > budget) continue;
    picked.push({ chunk, text: text.slice(0, budget) });
    used += text.length + 1;
  }
  picked.sort((a, b) => new Date(a.chunk.messages[0]?.sentAt ?? 0) - new Date(b.chunk.messages[0]?.sentAt ?? 0));
  const body = picked.map((p) => p.text).join('\n');
  const skipped = story.members.length - picked.length;
  return skipped ? `${body}\n(ещё ${skipped} фрагм. сюжета не показано: менее характерные)` : body;
}

function excerpt(text, max = 220) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

async function loadChunks(pool, accountId, start, end) {
  const { rows } = await pool.query(
    `SELECT c.chat_id, c.topic_key, c.bucket_start, c.part, c.message_ids, c.first_sent_at, c.last_sent_at, c.embedding,
            ch.title, ch.peer_kind, ch.username
     FROM search.chunks c JOIN archive.chats ch ON ch.account_id = c.account_id AND ch.chat_id = c.chat_id
     WHERE c.account_id = $1 AND c.first_sent_at >= $2 AND c.first_sent_at < $3 AND NOT ch.excluded
     ORDER BY c.first_sent_at`,
    [accountId, start, end],
  );
  const chunks = [];
  for (const row of rows) {
    const { rows: messages } = await pool.query(
      `SELECT message_id, topic_id, sent_at, sender_name, text FROM archive.messages
       WHERE account_id = $1 AND chat_id = $2 AND message_id = ANY($3::bigint[]) ORDER BY sent_at, message_id`,
      [accountId, row.chat_id, row.message_ids],
    );
    chunks.push({
      chatId: row.chat_id,
      topicKey: Number(row.topic_key),
      title: row.title,
      peerKind: row.peer_kind,
      vector: parseVector(row.embedding),
      messages: messages.map((m) => ({
        messageId: Number(m.message_id),
        sentAt: m.sent_at,
        sender: m.sender_name,
        text: m.text,
        link: messageLink({ chatId: row.chat_id, messageId: Number(m.message_id), topicId: m.topic_id, peerKind: row.peer_kind, username: row.username }),
      })),
    });
  }
  return chunks;
}

async function summarizeStory(llm, story) {
  const fallback = {
    title: excerpt(story.messages[0]?.text, 80) || 'Сюжет без текста',
    summary: null,
    openQuestions: [],
    generated: false,
  };
  if (!llm) return fallback;
  try {
    const raw = await llm.complete({ system: STORY_SYSTEM, prompt: storyPrompt(story), json: true });
    const parsed = JSON.parse(raw);
    return {
      title: String(parsed.title ?? fallback.title).slice(0, 160),
      summary: parsed.summary ? String(parsed.summary) : null,
      openQuestions: Array.isArray(parsed.open_questions) ? parsed.open_questions.map(String).filter(Boolean).slice(0, 5) : [],
      generated: true,
    };
  } catch (error) {
    return { ...fallback, error: error.message };
  }
}

export async function buildDigest({ pool, llm = null, day, timeZone = DEFAULT_TZ, accountId = null, maxStories = 8, windowDays = 14, now = new Date() }) {
  const account = await resolveAccountId(pool, accountId);
  if (!account) throw new Error('Archive is empty: no account has been archived yet');
  const { start, end } = dayRange(day, timeZone);
  const { summary, chats } = await coverageReport(pool, { accountId: account, windowDays, now });

  const { rows: perChat } = await pool.query(
    `SELECT chat_id, count(*)::int AS messages, count(*) FILTER (WHERE text <> '')::int AS with_text
     FROM archive.messages WHERE account_id = $1 AND sent_at >= $2 AND sent_at < $3 GROUP BY chat_id`,
    [account, start, end],
  );
  const periodMessages = perChat.reduce((acc, r) => acc + r.messages, 0);
  const { rows: [pending] } = await pool.query(
    `SELECT count(*)::int AS n FROM search.chunks WHERE account_id = $1 AND embedding IS NULL AND first_sent_at >= $2 AND first_sent_at < $3`,
    [account, start, end],
  );

  const chunks = await loadChunks(pool, account, start, end);
  const stories = clusterChunks(chunks).slice(0, maxStories);
  for (const story of stories) story.text = await summarizeStory(llm, story);

  let overview = null;
  if (llm && stories.some((s) => s.text.generated)) {
    try {
      overview = await llm.complete({
        system: OVERVIEW_SYSTEM,
        prompt: stories.map((s, i) => `${i + 1}. ${s.text.title}: ${s.text.summary ?? ''}`).join('\n'),
      });
    } catch {
      overview = null;
    }
  }

  // Sources that cannot be trusted to be complete for this day.
  const incomplete = chats.filter((c) => !['left', 'excluded'].includes(c.state)
    && (c.state !== 'loaded' || c.gapPending || !c.verifiedTo || new Date(c.verifiedTo) < end));
  const partialReasons = [];
  if (!summary.complete) partialReasons.push('историческая загрузка не завершена для всех доступных чатов');
  if (incomplete.length) partialReasons.push(`${incomplete.length} чатов не сверены до конца периода`);
  if (summary.indexer?.lag) partialReasons.push(`индекс отстаёт от архива на ${summary.indexer.lag} записей`);
  if (pending.n) partialReasons.push(`${pending.n} фрагментов периода ещё без embeddings (сюжеты могли не объединиться)`);
  if (!llm) partialReasons.push('локальная модель не использовалась: сюжеты не пересказаны');

  const md = [];
  md.push(`# Сводка Telegram за ${day} — черновик`);
  md.push('');
  md.push(`- Период: ${formatLocal(start, timeZone)} — ${formatLocal(end, timeZone)} (${timeZone}).`);
  md.push(`- Сформировано: ${formatLocal(now, timeZone)}; индекс: позиция архива ${summary.indexer?.lastSeq ?? 0}, отставание ${summary.indexer?.lag ?? 'неизвестно'}.`);
  md.push(`- Статус выпуска: ${partialReasons.length ? `**частичный** — ${partialReasons.join('; ')}` : 'полный по данным архива'}.`);
  md.push(`- Модель: ${llm ? llm.id : 'не использовалась'}. Текст «Вывод системы» создан моделью; цитаты ниже — исходные сообщения авторов.`);
  md.push('');
  md.push('## Общая картина');
  md.push('');
  if (!stories.length) md.push('За период в архиве нет сообщений с текстом.');
  else if (overview) md.push(`*Вывод системы:* ${overview}`);
  md.push('');
  for (const [i, s] of stories.entries()) md.push(`${i + 1}. ${s.text.title}`);
  md.push('');
  md.push('## Сюжеты');
  for (const [i, story] of stories.entries()) {
    md.push('');
    md.push(`### ${i + 1}. ${story.text.title}`);
    md.push('');
    if (story.text.summary) md.push(`*Вывод системы:* ${story.text.summary}`);
    else md.push('*Вывод системы отсутствует:* приведены исходные сообщения.');
    md.push('');
    md.push(`Источники (${story.chats.size} чат., ${story.messages.length} сообщ.):`);
    for (const chunk of story.members) {
      for (const m of chunk.messages.filter((x) => x.text).slice(0, 3)) {
        md.push(`- «${chunk.title ?? chunk.chatId}», ${markdownLink(formatTime(m.sentAt, timeZone), m.link)} — ${m.sender ?? 'неизвестный'}: «${excerpt(m.text)}»`);
      }
      if (chunk.messages.length > 3) md.push(`  - ещё ${chunk.messages.length - 3} сообщ. в этом фрагменте`);
    }
  }
  md.push('');
  md.push('## Открытые вопросы и расхождения');
  md.push('');
  const questions = stories.flatMap((s, i) => s.text.openQuestions.map((q) => `- (${i + 1}) ${q}`));
  md.push(questions.length ? questions.join('\n') : '- Не выявлено моделью; это не гарантирует их отсутствия.');
  md.push('');
  md.push('## Покрытие');
  md.push('');
  md.push(`- Чатов с сообщениями за период: ${perChat.length}; сообщений: ${periodMessages}; во фрагментах сводки: ${chunks.length} фрагм.; в сюжеты вошло ${stories.length}.`);
  md.push(`- Архив (окно ${summary.windowDays} сут.): покрыто ${summary.chats.covered} из ${summary.chats.available} доступных чатов; недоступно ${summary.chats.unavailable}.`);
  if (incomplete.length) {
    md.push('- Неполные или не сверенные источники:');
    for (const c of incomplete.slice(0, 40)) {
      const reason = c.errorCode ? `${STATE_LABELS[c.state] ?? c.state}, ${c.errorCode}` : (STATE_LABELS[c.state] ?? c.state);
      md.push(`  - «${c.title ?? c.chatId}» — ${reason}${c.verifiedTo ? `, сверено до ${formatLocal(c.verifiedTo, timeZone)}` : ''}`);
    }
    if (incomplete.length > 40) md.push(`  - и ещё ${incomplete.length - 40}`);
  }
  md.push('- Числа покрытия не заменяют проверку содержания.');
  md.push('');
  md.push('## Ограничения');
  md.push('');
  md.push(`- ${EDITS_LIMITATION}`);
  md.push('- Черновик не обновляется автоматически после создания.');
  md.push('- Секретные чаты не входят в архив.');
  md.push('');
  return {
    markdown: md.join('\n'),
    meta: {
      day,
      account,
      stories: stories.length,
      chunks: chunks.length,
      periodMessages,
      chatsInPeriod: perChat.length,
      partial: partialReasons.length > 0,
      partialReasons,
      model: llm?.id ?? null,
    },
  };
}
