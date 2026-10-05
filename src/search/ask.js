import { markdownLink } from '../links.js';
import { formatLocal, formatTime } from '../time.js';
import { EDITS_LIMITATION } from './search.js';

const SYSTEM = `Ты помощник, который отвечает на вопрос пользователя только по фрагментам его переписок в Telegram.
Правила:
- Используй только приведённые источники. Не добавляй факты от себя.
- После каждого утверждения ставь ссылку на источник в квадратных скобках, например [S2].
- Если источники противоречат друг другу, прямо укажи противоречие и оба источника.
- Источники бывают за разные годы. Если событие повторялось (день рождения, встреча, релиз), отвечай о самом свежем случае и называй даты; более старые упоминай отдельно и только если это важно.
- Если в источниках нет ответа, так и скажи: «В архиве нет достаточных данных».
- Пиши по-русски, кратко.`;

function sourceBlock(results, maxChars = 1800) {
  return results.map((r, i) => {
    const lines = r.messages
      .map((m) => `${m.context ? '(контекст) ' : ''}[${formatTime(m.sentAt)}] ${m.sender ?? 'неизвестный'}: ${(m.text ?? '').slice(0, 600)}`)
      .join('\n')
      .slice(0, maxChars);
    return `[S${i + 1}] Чат «${r.chatTitle ?? r.chatId}», ${formatLocal(r.firstSentAt)}–${formatTime(r.lastSentAt)}\n${lines}`;
  }).join('\n\n');
}

export function renderSources(results) {
  return results.map((r, i) => {
    const own = r.messages.filter((m) => !m.context);
    const links = own.slice(0, 5).map((m) => markdownLink(formatTime(m.sentAt), m.link)).join(', ');
    const more = own.length > 5 ? ` и ещё ${own.length - 5}` : '';
    return `- [S${i + 1}] «${r.chatTitle ?? r.chatId}», ${formatLocal(r.firstSentAt)}: ${links}${more}`;
  }).join('\n');
}

const RECENT_DAYS = 30;

// Without explicit dates the answer must see recent sources even when older
// history matches better: half of the slots go to the last RECENT_DAYS days.
async function findSources(search, question, { limit, from, to, now }) {
  if (from || to) return search.search(question, { limit, from, to });
  const since = new Date(now - RECENT_DAYS * 86_400_000);
  const [all, recent] = await Promise.all([
    search.search(question, { limit }),
    search.search(question, { limit: Math.ceil(limit / 2), from: since }),
  ]);
  const key = (r) => `${r.chatId}|${new Date(r.firstSentAt).toISOString()}`;
  const seen = new Set();
  const results = [];
  for (const r of [...recent.results, ...all.results]) {
    if (results.length >= limit || seen.has(key(r))) continue;
    seen.add(key(r));
    results.push(r);
  }
  return { ...all, results };
}

export async function answerQuestion({ search, llm, question, limit = 8, from = null, to = null, now = Date.now() }) {
  const found = await findSources(search, question, { limit, from, to, now });
  const footer = [
    '',
    '## Источники',
    found.results.length ? renderSources(found.results) : '- Подходящих фрагментов не найдено.',
    '',
    '## Ограничения',
    `- ${found.coverageNote}`,
    `- ${EDITS_LIMITATION}`,
    found.mode === 'text' ? `- Поиск по смыслу недоступен (${found.vectorError ?? 'нет embeddings'}); использован только полнотекстовый поиск.` : null,
  ].filter((line) => line !== null).join('\n');

  if (!found.results.length) {
    return { text: `В архиве нет данных по этому вопросу.\n${footer}`, found, model: null };
  }
  if (!llm) {
    return { text: `Модель ответа не настроена; ниже найденные источники.\n${footer}`, found, model: null };
  }
  const prompt = `Вопрос: ${question}\n\nИсточники:\n${sourceBlock(found.results)}\n\nОтветь на вопрос со ссылками [S#].`;
  const answer = await llm.complete({ system: SYSTEM, prompt });
  const cited = new Set([...answer.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])));
  const invalid = [...cited].filter((n) => n < 1 || n > found.results.length);
  const warning = invalid.length ? `\n\n> Модель сослалась на несуществующие источники: ${invalid.map((n) => `S${n}`).join(', ')}.` : '';
  const uncited = cited.size === 0 ? '\n\n> Ответ модели не содержит ссылок на источники; проверьте его по списку ниже.' : '';
  return { text: `${answer}${warning}${uncited}\n${footer}`, found, model: llm.id };
}
