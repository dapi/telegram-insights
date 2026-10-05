// What the owner has to act on or has missed, instead of retelling
// conversations they took part in: requests still waiting for their reply,
// their own promises, and alarming bot notifications.
import { messageLink } from '../links.js';

const AWAITING_SYSTEM = `Тебе даны сообщения, пришедшие владельцу аккаунта Telegram после его последнего ответа в этом чате.
Реши, ждут ли они от него ответа или действия. Верни JSON:
{"needs_reply": true или false, "ask": "одна короткая строка: что от него хотят"}
needs_reply = true, только если есть вопрос, просьба, приглашение, согласование или решение, которое ждёт владельца.
needs_reply = false для благодарностей, «ок», реакций, рассылок, поздравлений без вопроса и сообщений, где ответ не нужен.
Пиши по-русски, только по сообщениям.`;

const PROMISES_SYSTEM = `Тебе даны сообщения владельца аккаунта Telegram за сутки, каждое с номером [n].
Выпиши всё, что владелец взялся сделать для других: обещания и заявленные намерения
(«пришлю», «посмотрю», «напишу», «добавлю», «закину в календарь», «сделаю к пятнице», «созвонимся», «оплачу», «постараюсь»).
Верни JSON: {"promises": [{"i": номер сообщения, "text": "что взялся сделать и для кого, коротко", "due": "срок, если назван, иначе null"}]}
Не включай вопросы, мнения, благодарности и то, что сделано в том же сообщении (например, уже отправленная ссылка).
Если обещаний нет — {"promises": []}. Пиши по-русски.`;

const ALARM = /(critical|crit\b|error|fail|down\b|firing|alert|panic|timeout|unreachable|lag|отста|ошибк|авари|недоступ|упал|сбой|не работает|превышен)/i;
const RESOLVED = /(resolved|recovered|back to normal|\bok\b|восстановлен|снова доступ|решено)/i;

function excerpt(text, max = 220) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const iso = (value) => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

// `stats` counts model calls and unusable answers, so a silent model failure
// shows up in the digest diagnostics instead of looking like "nothing found".
async function askJson(llm, system, prompt, stats = {}) {
  if (!llm) return null;
  stats.modelCalls = (stats.modelCalls ?? 0) + 1;
  try {
    return JSON.parse(await llm.complete({ system, prompt, json: true }));
  } catch {
    stats.modelFailures = (stats.modelFailures ?? 0) + 1;
    return null;
  }
}

// Incoming messages after the owner's last message in the same thread, from
// personal chats or addressed to the owner (mention or reply) in groups.
export async function loadAwaitingCandidates(pool, accountId, { since, end, maxThreads = 30 }) {
  const { rows: [account] } = await pool.query('SELECT username FROM archive.accounts WHERE account_id = $1', [accountId]);
  const mention = account?.username ? `@${account.username.toLowerCase()}` : null;
  const { rows } = await pool.query(
    `WITH last_own AS (
       SELECT chat_id, COALESCE(topic_id, 0) AS topic_key, max(sent_at) AS at
       FROM archive.messages WHERE account_id = $1 AND sender_id = account_id AND sent_at < $3
       GROUP BY 1, 2
     )
     SELECT m.chat_id, COALESCE(m.topic_id, 0) AS topic_key, m.topic_id, m.message_id, m.sent_at, m.sender_name, m.text,
            ch.title, ch.peer_kind, ch.username, ch.read_inbox_max_id
     FROM archive.messages m
     JOIN archive.chats ch ON ch.account_id = m.account_id AND ch.chat_id = m.chat_id
     LEFT JOIN last_own lo ON lo.chat_id = m.chat_id AND lo.topic_key = COALESCE(m.topic_id, 0)
     LEFT JOIN archive.messages r ON r.account_id = m.account_id AND r.chat_id = m.chat_id AND r.message_id = m.reply_to_id
     WHERE m.account_id = $1 AND m.sent_at >= $2 AND m.sent_at < $3 AND NOT ch.excluded
       AND m.sender_id IS DISTINCT FROM m.account_id AND m.text <> '' AND NOT m.is_service
       AND (lo.at IS NULL OR m.sent_at > lo.at)
       AND (ch.peer_kind = 'user'
            OR r.sender_id = m.account_id
            OR ($4::text IS NOT NULL AND position($4 IN lower(m.text)) > 0))
     ORDER BY m.chat_id, topic_key, m.sent_at, m.message_id`,
    [accountId, since, end, mention],
  );
  const threads = new Map();
  for (const row of rows) {
    const key = `${row.chat_id}|${row.topic_key}`;
    if (!threads.has(key)) threads.set(key, { chatId: String(row.chat_id), title: row.title, peerKind: row.peer_kind, messages: [] });
    threads.get(key).messages.push({
      messageId: Number(row.message_id),
      sentAt: row.sent_at,
      sender: row.sender_name,
      text: row.text,
      unread: row.read_inbox_max_id === null ? null : Number(row.message_id) > Number(row.read_inbox_max_id),
      link: messageLink({ chatId: row.chat_id, messageId: Number(row.message_id), topicId: row.topic_id, peerKind: row.peer_kind, username: row.username }),
    });
  }
  // Newest threads first: a long-forgotten request matters, but the cap must
  // not hide what arrived today.
  return [...threads.values()]
    .sort((a, b) => new Date(b.messages.at(-1).sentAt) - new Date(a.messages.at(-1).sentAt))
    .slice(0, maxThreads);
}

export async function classifyAwaiting(llm, threads, { now, stats = {} }) {
  const result = [];
  for (const thread of threads) {
    const last = thread.messages.at(-1);
    const prompt = thread.messages.slice(-12)
      .map((m) => `[${iso(m.sentAt).slice(11, 16)}] ${m.sender ?? 'неизвестный'}: ${String(m.text).slice(0, 600)}`)
      .join('\n');
    const parsed = await askJson(llm, AWAITING_SYSTEM, `Чат «${thread.title ?? thread.chatId}»:\n${prompt}`, stats);
    // Without a model only explicit questions count.
    const needsReply = parsed ? Boolean(parsed.needs_reply) : thread.messages.some((m) => m.text.includes('?'));
    if (!needsReply) continue;
    const first = thread.messages[0];
    result.push({
      chat: thread.title ?? thread.chatId,
      personal: thread.peerKind === 'user',
      from: last.sender ?? null,
      ask: parsed?.ask ? String(parsed.ask).slice(0, 200) : excerpt(last.text, 160),
      firstAt: iso(first.sentAt),
      lastAt: iso(last.sentAt),
      waitingHours: Math.max(0, Math.round((now - new Date(first.sentAt)) / 3_600_000)),
      messages: thread.messages.length,
      unread: thread.messages.some((m) => m.unread === true),
      url: last.link?.url ?? null,
      ref: last.link?.ref ?? null,
    });
  }
  return result.sort((a, b) => b.waitingHours - a.waitingHours);
}

export async function loadOwnMessages(pool, accountId, { start, end }) {
  const { rows } = await pool.query(
    `SELECT m.chat_id, m.message_id, m.topic_id, m.sent_at, m.text, ch.title, ch.peer_kind, ch.username
     FROM archive.messages m JOIN archive.chats ch ON ch.account_id = m.account_id AND ch.chat_id = m.chat_id
     WHERE m.account_id = $1 AND m.sender_id = m.account_id AND m.sent_at >= $2 AND m.sent_at < $3
       AND NOT ch.excluded AND ch.peer_kind <> 'saved' AND length(m.text) >= 15
     ORDER BY m.sent_at`,
    [accountId, start, end],
  );
  return rows.map((row) => ({
    chat: row.title ?? String(row.chat_id),
    sentAt: row.sent_at,
    text: row.text,
    link: messageLink({ chatId: row.chat_id, messageId: Number(row.message_id), topicId: row.topic_id, peerKind: row.peer_kind, username: row.username }),
  }));
}

export async function extractPromises(llm, messages, { budget = 24000, max = 12, stats = {} } = {}) {
  if (!llm || !messages.length) return [];
  const lines = [];
  let used = 0;
  // The newest messages matter most when the day does not fit the budget.
  const shown = [];
  for (const m of [...messages].reverse()) {
    const line = `«${m.chat}» ${iso(m.sentAt).slice(11, 16)}: ${String(m.text).slice(0, 400)}`;
    if (used + line.length > budget) break;
    shown.unshift(m);
    used += line.length + 8;
  }
  shown.forEach((m, i) => lines.push(`[${i + 1}] «${m.chat}» ${iso(m.sentAt).slice(11, 16)}: ${String(m.text).slice(0, 400)}`));
  const parsed = await askJson(llm, PROMISES_SYSTEM, lines.join('\n'), stats);
  if (!Array.isArray(parsed?.promises)) return [];
  return parsed.promises
    .map((p) => ({ p, m: shown[Number(p.i) - 1] }))
    .filter(({ p, m }) => m && p.text)
    .slice(0, max)
    .map(({ p, m }) => ({
      chat: m.chat,
      text: String(p.text).slice(0, 200),
      due: p.due ? String(p.due).slice(0, 60) : null,
      at: iso(m.sentAt),
      url: m.link?.url ?? null,
      ref: m.link?.ref ?? null,
    }));
}

// Keeps only alarming kinds of bot notifications; routine reports, vacancies
// and recoveries are dropped.
export function alarmingNotifications(automated) {
  return automated
    .map((entry) => ({ ...entry, kinds: entry.kinds.filter((k) => ALARM.test(k.text) && !RESOLVED.test(k.text)) }))
    .filter((entry) => entry.kinds.length);
}
