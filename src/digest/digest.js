import crypto from 'node:crypto';

import { STATE_LABELS, coverageReport, resolveAccountId } from '../archive/status.js';
import { markdownLink, messageLink } from '../links.js';
import { EDITS_LIMITATION } from '../search/search.js';
import { DEFAULT_TZ, dayRange, formatLocal, formatTime } from '../time.js';
import { alarmingNotifications, classifyAwaiting, extractPromises, loadAwaitingCandidates, loadOwnMessages } from './actions.js';

const STORY_SYSTEM = `Ты готовишь сводку непрочитанного в Telegram: владелец аккаунта не читал эти сообщения.
Тебе дан один сюжет: сообщения из одной или нескольких групп и каналов. Верни JSON:
{"title": "короткий заголовок сюжета", "summary": "1–3 предложения: что нового и важного, без пересказа очевидного"}
Опирайся только на сообщения, не додумывай, пиши по-русски.`;

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

const firstAt = (chunk) => new Date(chunk.messages[0]?.sentAt ?? 0).getTime();

// Bots post alerts, reminders and cron reports: a fragment is automated when
// every message in it comes from a bot (Telegram bot usernames end in "bot")
// or it is a bot chat where the owner did not write.
export function isAutomated(chunk) {
  const texts = chunk.messages.filter((m) => m.text);
  if (!texts.length) return false;
  if (texts.some((m) => m.own)) return false;
  if (chunk.peerKind === 'bot') return true;
  return texts.every((m) => /bot$/i.test(m.senderUsername ?? ''));
}

// Automated fragments do not become stories; each chat collapses into one line
// with its most frequent message kinds (digits ignored, so "CPU 0.77" and
// "CPU 0.81" count as one kind).
export function summarizeAutomated(chunks, { maxChats = 6, maxKinds = 3 } = {}) {
  const byChat = new Map();
  for (const chunk of chunks) {
    const entry = byChat.get(chunk.chatId) ?? { chat: chunk.title ?? String(chunk.chatId), messages: 0, lastAt: null, kinds: new Map() };
    for (const m of chunk.messages) {
      if (!m.text) continue;
      entry.messages += 1;
      const at = new Date(m.sentAt);
      if (!entry.lastAt || at > entry.lastAt) entry.lastAt = at;
      const line = String(m.text).split('\n').find((l) => l.trim()) ?? '';
      const key = line.toLowerCase().replace(/\d+([.,]\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 120);
      const kind = entry.kinds.get(key) ?? { text: excerpt(line, 120), count: 0 };
      kind.count += 1;
      entry.kinds.set(key, kind);
    }
    byChat.set(chunk.chatId, entry);
  }
  return [...byChat.values()]
    .filter((e) => e.messages > 0)
    .sort((a, b) => b.messages - a.messages)
    .slice(0, maxChats)
    .map((e) => ({
      chat: e.chat,
      messages: e.messages,
      lastAt: e.lastAt.toISOString(),
      kinds: [...e.kinds.values()].sort((a, b) => b.count - a.count).slice(0, maxKinds),
    }));
}

function chatTopic(chunk) {
  return `${chunk.chatId}|${chunk.topicKey ?? 0}`;
}

function addInto(sum, v) {
  for (let i = 0; i < v.length; i += 1) sum[i] += v[i];
  return sum;
}

// Story importance: breadth across chats and volume, plus what concerns the
// account owner — a personal chat, their own messages, a mention or reply to them.
export function storyScore({ chats, messages, personal = false, own = false, mentioned = false }) {
  return 2 * chats + Math.log2(1 + messages) + (personal ? 3 : 0) + (own ? 3 : 0) + (mentioned ? 3 : 0);
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
  // A reply belongs to the story of the message it answers.
  const byMessage = new Map();
  chunks.forEach((chunk, i) => chunk.messages.forEach((m) => byMessage.set(`${chunk.chatId}|${m.messageId}`, i)));
  chunks.forEach((chunk, i) => {
    for (const m of chunk.messages) {
      const target = m.replyToId ? byMessage.get(`${chunk.chatId}|${m.replyToId}`) : undefined;
      if (target !== undefined && target !== i) union(i, target);
    }
  });
  // A fragment of only the owner's messages is a reaction (thanks, ok, answers
  // later in the day): it joins the previous fragment of the same thread.
  const lastByThread = new Map();
  chunks.map((_, i) => i)
    .sort((a, b) => firstAt(chunks[a]) - firstAt(chunks[b]))
    .forEach((i) => {
      const key = chatTopic(chunks[i]);
      if (lastByThread.has(key) && chunks[i].messages.every((m) => m.own)) union(i, lastByThread.get(key));
      lastByThread.set(key, i);
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
    const signals = {
      personal: ranked.some((m) => m.peerKind === 'user'),
      own: messages.some((m) => m.own),
      mentioned: messages.some((m) => m.mentionsMe || m.replyToMe),
    };
    return {
      members: ranked,
      chats,
      messages,
      signals,
      score: storyScore({ chats: chats.size, messages: messages.length, ...signals }),
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
  const { rows: [account] } = await pool.query('SELECT username FROM archive.accounts WHERE account_id = $1', [accountId]);
  const mention = account?.username ? `@${account.username.toLowerCase()}` : null;
  const { rows } = await pool.query(
    `SELECT c.chat_id, c.topic_key, c.bucket_start, c.part, c.message_ids, c.first_sent_at, c.last_sent_at, c.embedding,
            ch.title, ch.peer_kind, ch.username, ch.read_inbox_max_id
     FROM search.chunks c JOIN archive.chats ch ON ch.account_id = c.account_id AND ch.chat_id = c.chat_id
     WHERE c.account_id = $1 AND c.first_sent_at >= $2 AND c.first_sent_at < $3 AND NOT ch.excluded
     ORDER BY c.first_sent_at`,
    [accountId, start, end],
  );
  const chunks = [];
  for (const row of rows) {
    const { rows: messages } = await pool.query(
      `SELECT m.message_id, m.topic_id, m.sent_at, m.sender_name, m.sender_username, m.reply_to_id, m.text,
              m.sender_id = m.account_id AS own, r.sender_id = m.account_id AS reply_to_me
       FROM archive.messages m
       LEFT JOIN archive.messages r ON r.account_id = m.account_id AND r.chat_id = m.chat_id AND r.message_id = m.reply_to_id
       WHERE m.account_id = $1 AND m.chat_id = $2 AND m.message_id = ANY($3::bigint[]) ORDER BY m.sent_at, m.message_id`,
      [accountId, row.chat_id, row.message_ids],
    );
    chunks.push({
      chatId: row.chat_id,
      topicKey: Number(row.topic_key),
      title: row.title,
      peerKind: row.peer_kind,
      readInboxMaxId: row.read_inbox_max_id === null ? null : Number(row.read_inbox_max_id),
      vector: parseVector(row.embedding),
      messages: messages.map((m) => ({
        messageId: Number(m.message_id),
        sentAt: m.sent_at,
        sender: m.sender_name,
        senderUsername: m.sender_username,
        replyToId: m.reply_to_id === null ? null : Number(m.reply_to_id),
        text: m.text,
        own: Boolean(m.own),
        replyToMe: Boolean(m.reply_to_me),
        mentionsMe: Boolean(mention && String(m.text ?? '').toLowerCase().includes(mention)),
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
    generated: false,
  };
  if (!llm) return fallback;
  try {
    const raw = await llm.complete({ system: STORY_SYSTEM, prompt: storyPrompt(story), json: true });
    const parsed = JSON.parse(raw);
    return {
      title: String(parsed.title ?? fallback.title).slice(0, 160),
      summary: parsed.summary ? String(parsed.summary) : null,
      generated: true,
    };
  } catch (error) {
    return { ...fallback, error: error.message };
  }
}

// Unread = incoming messages above the chat's read marker. Without a marker
// yet (before the first dialogs pass) a chat counts as unread only where the
// owner did not write in the period.
export function unreadChunks(chunks) {
  const ownChats = new Set(chunks.filter((c) => c.messages.some((m) => m.own)).map((c) => c.chatId));
  return chunks
    .filter((c) => c.peerKind !== 'user' && c.peerKind !== 'saved')
    .map((c) => ({
      ...c,
      messages: c.messages.filter((m) => !m.own && (c.readInboxMaxId === null || c.readInboxMaxId === undefined
        ? !ownChats.has(c.chatId)
        : m.messageId > c.readInboxMaxId)),
    }))
    .filter((c) => c.messages.some((m) => m.text));
}

export async function buildDigest({ pool, llm = null, day, timeZone = DEFAULT_TZ, accountId = null, maxUnread = 6, awaitingLookbackHours = 72, windowDays = 14, windowMonths = null, now = new Date(), range = null }) {
  const account = await resolveAccountId(pool, accountId);
  if (!account) throw new Error('Archive is empty: no account has been archived yet');
  const { start, end } = range ?? dayRange(day, timeZone);
  const { summary, chats } = await coverageReport(pool, { accountId: account, windowDays, windowMonths, now });

  const { rows: perChat } = await pool.query(
    `SELECT chat_id, count(*)::int AS messages FROM archive.messages
     WHERE account_id = $1 AND sent_at >= $2 AND sent_at < $3 GROUP BY chat_id`,
    [account, start, end],
  );
  const periodMessages = perChat.reduce((acc, r) => acc + r.messages, 0);
  const { rows: [readState] } = await pool.query(
    `SELECT count(*) FILTER (WHERE read_state_at IS NOT NULL)::int AS known, count(*)::int AS total
     FROM archive.chats WHERE account_id = $1 AND in_dialogs AND NOT excluded`,
    [account],
  );

  // 1. Waiting for the owner's reply (a longer lookback: an old request still counts).
  const since = new Date(end.getTime() - awaitingLookbackHours * 3_600_000);
  const stats = {};
  const candidates = await loadAwaitingCandidates(pool, account, { since, end });
  const awaiting = await classifyAwaiting(llm, candidates, { now: Math.min(end.getTime(), now.getTime()), stats });
  // 2. The owner's own promises in the period.
  const ownMessages = await loadOwnMessages(pool, account, { start, end });
  const promises = await extractPromises(llm, ownMessages, { stats });
  // 3. Unread groups and channels, 4. alarming bot notifications.
  const chunks = await loadChunks(pool, account, start, end);
  const alerts = alarmingNotifications(summarizeAutomated(chunks.filter(isAutomated)));
  const unread = unreadChunks(chunks.filter((c) => !isAutomated(c)));
  const stories = clusterChunks(unread).slice(0, maxUnread);
  for (const story of stories) story.text = await summarizeStory(llm, story);
  const unreadChats = new Set(unread.map((c) => c.chatId)).size;
  const unreadMessages = unread.reduce((n, c) => n + c.messages.length, 0);

  // A period that reaches into the last hour is covered by live updates there;
  // history reconciliation is only expected up to an hour ago.
  const verifyBy = new Date(Math.min(end.getTime(), now.getTime() - 3_600_000));
  const incomplete = chats.filter((c) => !['left', 'excluded', 'unavailable'].includes(c.state)
    && (c.state !== 'loaded' || c.gapPending || !c.verifiedTo || new Date(c.verifiedTo) < verifyBy));
  const partialReasons = [];
  if (!summary.complete) partialReasons.push('историческая загрузка не завершена для всех доступных чатов');
  if (incomplete.length) partialReasons.push(`${incomplete.length} чатов не сверены до конца периода`);
  if (summary.indexer?.lag) partialReasons.push(`индекс отстаёт от архива на ${summary.indexer.lag} записей`);
  if (readState.known < readState.total) partialReasons.push(`отметки прочтения есть для ${readState.known} из ${readState.total} чатов`);
  if (!llm) partialReasons.push('модель не использовалась: обещания не извлечены, ответы отобраны по вопросительным знакам');
  if (stats.modelFailures) partialReasons.push(`модель не дала разборчивого ответа в ${stats.modelFailures} из ${stats.modelCalls} запросов`);

  const link = (item) => markdownLink(formatLocal(item.lastAt ?? item.at, timeZone), { url: item.url, ref: item.ref });
  const md = [];
  md.push(`# Telegram: что требует внимания — ${day ?? `${formatLocal(start, timeZone)} — ${formatLocal(end, timeZone)}`}`);
  md.push('');
  md.push(`- Период: ${formatLocal(start, timeZone)} — ${formatLocal(end, timeZone)} (${timeZone}); ответы ищутся за ${awaitingLookbackHours} ч.`);
  md.push(`- Сформировано: ${formatLocal(now, timeZone)}. Модель: ${llm ? llm.id : 'не использовалась'}.`);
  md.push(`- Статус: ${partialReasons.length ? `**частичный** — ${partialReasons.join('; ')}` : 'полный по данным архива'}.`);
  md.push('');
  md.push(`## Ждут твоего ответа (${awaiting.length})`);
  md.push('');
  if (!awaiting.length) md.push('Ничего не ждёт.');
  for (const a of awaiting) md.push(`- «${a.chat}»${a.from && a.from !== a.chat ? `, ${a.from}` : ''} — ${a.ask} (ждёт ${a.waitingHours} ч${a.unread ? ', не прочитано' : ''}; ${link(a)})`);
  md.push('');
  md.push(`## Ты обещал (${promises.length})`);
  md.push('');
  if (!promises.length) md.push(llm ? 'Обещаний не найдено.' : 'Без модели обещания не извлекаются.');
  for (const p of promises) md.push(`- «${p.chat}» — ${p.text}${p.due ? `; срок: ${p.due}` : ''} (${link(p)})`);
  md.push('');
  md.push(`## Непрочитанное (${unreadChats} чат., ${unreadMessages} сообщ.)`);
  for (const [i, story] of stories.entries()) {
    md.push('');
    md.push(`### ${i + 1}. ${story.text.title}`);
    md.push('');
    if (story.text.summary) md.push(story.text.summary);
    md.push('');
    for (const chunk of story.members) {
      for (const m of chunk.messages.filter((x) => x.text).slice(0, 2)) {
        md.push(`- «${chunk.title ?? chunk.chatId}», ${markdownLink(formatTime(m.sentAt, timeZone), m.link)} — ${m.sender ?? 'неизвестный'}: «${excerpt(m.text)}»`);
      }
    }
  }
  if (!stories.length) md.push('', 'Непрочитанного в группах и каналах нет.');
  md.push('');
  md.push(`## Тревожные уведомления (${alerts.length})`);
  md.push('');
  if (!alerts.length) md.push('Тревожных уведомлений ботов нет.');
  for (const a of alerts) {
    md.push(`- «${a.chat}», последнее ${formatLocal(a.lastAt, timeZone)}`);
    for (const k of a.kinds) md.push(`  - ${k.count > 1 ? `×${k.count} ` : ''}${k.text}`);
  }
  md.push('');
  md.push('## Покрытие и ограничения');
  md.push('');
  md.push(`- Сообщений за период: ${periodMessages} в ${perChat.length} чатах. Архив: покрыто ${summary.chats.covered} из ${summary.chats.available} доступных чатов; недоступно ${summary.chats.unavailable}.`);
  if (incomplete.length) md.push(`- Не сверены до конца периода: ${incomplete.slice(0, 10).map((c) => `«${c.title ?? c.chatId}» (${STATE_LABELS[c.state] ?? c.state}${c.errorCode ? `, ${c.errorCode}` : ''})`).join(', ')}${incomplete.length > 10 ? ` и ещё ${incomplete.length - 10}` : ''}.`);
  md.push(`- ${EDITS_LIMITATION}`);
  md.push('- Секретные чаты не входят в архив. Отметки прочтения обновляются при перечитывании диалогов (раз в 30 минут).');
  md.push('');

  const sourceOf = (chunk, m) => ({
    chat: chunk.title ?? String(chunk.chatId),
    at: m.sentAt instanceof Date ? m.sentAt.toISOString() : m.sentAt,
    sender: m.sender ?? null,
    excerpt: excerpt(m.text),
    url: m.link?.url ?? null,
    ref: m.link?.ref ?? null,
  });
  const data = {
    version: 2,
    period: { start: start.toISOString(), end: end.toISOString(), timeZone, day: day ?? null, awaitingSince: since.toISOString() },
    generatedAt: now.toISOString(),
    model: llm?.id ?? null,
    partial: partialReasons.length > 0,
    partialReasons,
    awaiting,
    promises,
    unread: {
      chats: unreadChats,
      messages: unreadMessages,
      stories: stories.map((story, i) => ({
        n: i + 1,
        title: story.text.title,
        summary: story.text.summary,
        chats: [...new Set(story.members.map((c) => c.title ?? String(c.chatId)))],
        messages: story.messages.length,
        sources: story.members.flatMap((c) => c.messages.filter((m) => m.text).slice(0, 2).map((m) => sourceOf(c, m))).slice(0, 6),
      })),
    },
    alerts,
    readState,
    diagnostics: { awaitingCandidates: candidates.length, ownMessages: ownMessages.length, modelCalls: stats.modelCalls ?? 0, modelFailures: stats.modelFailures ?? 0 },
    coverage: {
      chatsInPeriod: perChat.length,
      periodMessages,
      archiveChatsCovered: summary.chats.covered,
      archiveChatsAvailable: summary.chats.available,
      incompleteChats: incomplete.length,
    },
    limitations: [EDITS_LIMITATION, 'Секретные чаты не входят в архив.'],
  };
  return {
    markdown: md.join('\n'),
    data,
    meta: {
      day,
      account,
      awaiting: awaiting.length,
      promises: promises.length,
      unreadStories: stories.length,
      alerts: alerts.length,
      periodMessages,
      chatsInPeriod: perChat.length,
      partial: partialReasons.length > 0,
      partialReasons,
      model: llm?.id ?? null,
    },
  };
}
