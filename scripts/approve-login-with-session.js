#!/usr/bin/env node
// Approves a pending Telegram Insights QR login from another, already authorized
// session (like scanning the QR code in the app). Usage:
//   TELEGRAM_API_ID=.. TELEGRAM_API_HASH=.. node approve-login-with-session.js <session-copy> <url-file>
// Use a *copy* of the other client's session: the copy is only used for this
// single call, without updates, and should be deleted afterwards.
import fs from 'node:fs';
import { TelegramClient, proxyTransportFromUrl } from '@mtcute/node';

const [sessionPath, urlFile] = process.argv.slice(2);
if (!sessionPath || !urlFile) {
  console.error('usage: approve-login-with-session.js <session-copy> <url-file>');
  process.exit(2);
}
const url = new URL(fs.readFileSync(urlFile, 'utf8').trim());
const token = Buffer.from(url.searchParams.get('token') ?? '', 'base64url');
if (!token.length) throw new Error('No login token in the URL file');

const options = {
  apiId: Number(process.env.TELEGRAM_API_ID),
  apiHash: process.env.TELEGRAM_API_HASH,
  storage: sessionPath,
  disableUpdates: true,
};
if (process.env.TELEGRAM_PROXY) options.transport = proxyTransportFromUrl(process.env.TELEGRAM_PROXY);
const client = new TelegramClient(options);
try {
  const me = await client.getMe();
  const auth = await client.call({ _: 'auth.acceptLoginToken', token });
  console.log(JSON.stringify({ approvedBy: String(me.id), newAuthorization: auth.deviceModel ? 'accepted' : 'unknown' }));
} finally {
  await client.destroy();
}
