// Removes stored messages and index chunks of chats marked excluded (by the
// built-in list or TI_EXCLUDED_CHATS). Returns counts only, never content.
export async function purgeExcluded(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const chunks = await client.query(
      `DELETE FROM search.chunks c USING archive.chats ch
       WHERE ch.account_id = c.account_id AND ch.chat_id = c.chat_id AND ch.excluded`,
    );
    const messages = await client.query(
      `DELETE FROM archive.messages m USING archive.chats ch
       WHERE ch.account_id = m.account_id AND ch.chat_id = m.chat_id AND ch.excluded`,
    );
    await client.query('COMMIT');
    return { messages: messages.rowCount, chunks: chunks.rowCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
