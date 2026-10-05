// How to open an archived message. Channels and supergroups have t.me links
// (private ones only work for members); other chats are opened through the
// archive with `telegram-insights show`.

const CHANNEL_OFFSET = 1_000_000_000_000n;

export function archiveRef(chatId, messageId) {
  return `tgi:${chatId}/${messageId}`;
}

export function parseArchiveRef(ref) {
  const m = /^tgi:(-?\d+)\/(\d+)$/.exec(String(ref).trim());
  if (!m) throw new Error(`Invalid archive reference ${ref}; expected tgi:<chat_id>/<message_id>`);
  return { chatId: m[1], messageId: Number(m[2]) };
}

export function messageLink({ chatId, messageId, topicId = null, peerKind, username = null }) {
  const id = BigInt(chatId);
  const channelLike = peerKind === 'channel' || peerKind === 'supergroup';
  if (channelLike && username) {
    return { url: `https://t.me/${username}/${messageId}`, ref: archiveRef(chatId, messageId) };
  }
  if (channelLike && id < -CHANNEL_OFFSET) {
    const internal = -id - CHANNEL_OFFSET;
    const path = topicId ? `${internal}/${topicId}/${messageId}` : `${internal}/${messageId}`;
    return { url: `https://t.me/c/${path}`, ref: archiveRef(chatId, messageId) };
  }
  return { url: null, ref: archiveRef(chatId, messageId) };
}

export function markdownLink(label, link) {
  return link.url ? `[${label}](${link.url})` : `${label} \`${link.ref}\``;
}
