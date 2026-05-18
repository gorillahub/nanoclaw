/**
 * Trigger Writer: accepts inbound webhook events and writes IPC task files for NanoClaw.
 *
 *  - GET /health
 *  - POST /telegram-event/<agent> routes to group folder telegram_<agent>
 *
 * Behaviour (reply-to-inbound):
 *  - Encode inbound Telegram chat id into the task targetJid so NanoClaw replies to the
 *    same chat the user messaged from.
 *    JID format: telegram:<agent>:<chatId>
 *
 * Observability (2026-05):
 *  - Log one line per request with method, url, and response status.
 *    Never logs payload or secrets.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT ?? '9876', 10);

const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

function respondJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeIpcTask({ sourceGroup, task }) {
  const baseDir = `/opt/nanoclaw/data/ipc/${sourceGroup}/tasks`;
  ensureDir(baseDir);

  const file = `${Date.now()}-${task.taskId}.json`;
  const fullPath = path.join(baseDir, file);

  fs.writeFileSync(fullPath, JSON.stringify(task, null, 2), 'utf-8');
  return { file, fullPath };
}

function buildTelegramPrompt({ chatId, threadId, messageText, senderName }) {
  const threadLabel = threadId ? `Topic ${threadId}` : 'General chat';
  return (
    `TELEGRAM MESSAGE from ${senderName ?? 'Unknown'}:\n` +
    `[${threadLabel}]\n` +
    `[Chat ID: ${chatId ?? 'unknown'}]\n\n` +
    `${JSON.stringify(messageText ?? '')}\n\n` +
    `Respond to this message. Your output text will be sent back to Telegram automatically by NanoClaw.\n` +
    `Do NOT call send_telegram_message — your output IS the response.`
  );
}

function toStringOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length ? s : null;
}

function normaliseTelegramUpdate(body) {
  const update = body ?? {};
  const message =
    update.message ??
    update.edited_message ??
    update.channel_post ??
    update.callback_query?.message;
  if (!message) throw new Error('telegram payload missing message');

  const chatId = message.chat?.id;
  const threadId = message.message_thread_id;
  const text = message.text ?? message.caption ?? '';
  const senderName = message.from?.first_name ?? message.from?.username ?? 'unknown';

  return { chatId, threadId, text, senderName };
}

function validateTelegramSecret(req) {
  if (!TELEGRAM_WEBHOOK_SECRET) {
    return { ok: false, status: 500, error: 'TELEGRAM_WEBHOOK_SECRET not configured' };
  }
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== TELEGRAM_WEBHOOK_SECRET) {
    return { ok: false, status: 401, error: 'invalid webhook secret' };
  }
  return { ok: true };
}

function groupFolderForAgent(agentSlug) {
  // allow telegram_holly or just holly
  if (!agentSlug) return null;
  const cleaned = agentSlug.trim().replace(/^telegram_/, '');
  if (!cleaned) return null;
  return `telegram_${cleaned}`;
}

const server = http.createServer(async (req, res) => {
  const method = req.method ?? 'UNKNOWN';
  const url = req.url ?? '/';

  const done = (status, body) => {
    try {
      // one line, no payload
      console.log(`[trigger-writer] ${method} ${url} -> ${status}`);
    } catch {}
    return respondJson(res, status, body);
  };

  try {
    if (method === 'GET' && url === '/health') {
      return done(200, { ok: true });
    }

    if (method !== 'POST') {
      return done(405, { ok: false, error: 'method not allowed' });
    }

    const bodyRaw = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(bodyRaw || '{}');
    } catch {
      return done(400, { ok: false, error: 'invalid json' });
    }

    if (url === '/telegram-event' || url.startsWith('/telegram-event/')) {
      const secretVerdict = validateTelegramSecret(req);
      if (!secretVerdict.ok) {
        return done(secretVerdict.status, { ok: false, error: secretVerdict.error });
      }

      const agentSlug = url.startsWith('/telegram-event/')
        ? url.slice('/telegram-event/'.length)
        : null;

      const groupFolder = agentSlug ? groupFolderForAgent(agentSlug) : null;
      if (!groupFolder) {
        return done(400, {
          ok: false,
          error: 'Missing agent slug. Use /telegram-event/<agent> (e.g. /telegram-event/holly).',
        });
      }

      const { chatId, threadId, text, senderName } = normaliseTelegramUpdate(payload);

      const taskId = `tg-msg-${Date.now()}`;
      const prompt = buildTelegramPrompt({ chatId, threadId, messageText: text, senderName });

      const bare = groupFolder.replace(/^telegram_/, '');
      const targetJid = `telegram:${bare}:${chatId}`;

      const out = writeIpcTask({
        sourceGroup: groupFolder,
        task: {
          type: 'schedule_task',
          taskId,
          targetJid,
          prompt,
          schedule_type: 'once',
          schedule_value: new Date().toISOString(),
          context_mode: 'group',
          senderName,
          messageText: text,
          threadId: toStringOrNull(threadId),
        },
      });

      return done(200, { ok: true, written: out.file, group: groupFolder });
    }

    return done(404, { ok: false, error: 'not found' });
  } catch (err) {
    return done(500, { ok: false, error: String(err?.message ?? err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[trigger-writer] listening on http://${HOST}:${PORT}`);
});
