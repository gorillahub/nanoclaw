/**
 * Telegram channel adapter for NanoClaw.
 *
 * Receives messages via trigger-writer webhook (no polling needed).
 * Sends replies via the Telegram Bot API sendMessage endpoint.
 * Topic-aware: uses explicit threadId when provided, or parses from JID.
 *
 * Reads bot token and chat ID from /opt/nanoclaw/.env directly
 * (NanoClaw's main process doesn't inherit container env vars).
 *
 * JID format:
 *   "telegram:mygroup"        → general group (no thread)
 *   "telegram:mygroup:42"     → topic with thread ID 42
 */

import fs from 'fs';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const ENV_PATH = '/opt/nanoclaw/.env';
const MAX_MESSAGE_LENGTH = 4096;

function readEnvValue(key: string): string | undefined {
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eqIdx = trimmed.indexOf('=');
      const k = trimmed.substring(0, eqIdx).trim();
      const v = trimmed.substring(eqIdx + 1).trim();
      if (k === key) return v;
    }
  } catch {
    // .env not found
  }
  return process.env[key];
}

function parseThreadId(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function resolveThreadId(jid: string, threadId?: string): number | undefined {
  const explicit = parseThreadId(threadId);
  if (explicit !== undefined) return explicit;

  const parts = jid.split(':');
  return parseThreadId(parts[2]);
}

/**
 * Split a message into chunks that fit within Telegram's 4096-char limit.
 * Tries to split on newlines to keep formatting intact.
 */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitIdx <= 0 || splitIdx < MAX_MESSAGE_LENGTH * 0.5) {
      splitIdx = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    }
    if (splitIdx <= 0) {
      splitIdx = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private connected = false;
  private botToken: string | undefined;
  private chatId: string | undefined;

  async connect(): Promise<void> {
    this.botToken = readEnvValue('TELEGRAM_BOT_TOKEN');
    this.chatId = readEnvValue('TELEGRAM_CHAT_ID');

    if (!this.botToken) {
      logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram channel disabled');
      return;
    }
    this.connected = true;
    logger.info('Telegram channel connected (webhook mode — no polling)');
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.connected || !this.botToken || !this.chatId) {
      logger.warn({ jid }, 'Telegram channel not connected, dropping message');
      return;
    }

    const resolvedThreadId = resolveThreadId(jid, threadId);
    const chunks = splitMessage(text);

    for (const chunk of chunks) {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        text: chunk,
      };
      if (resolvedThreadId !== undefined) {
        body.message_thread_id = resolvedThreadId;
      }

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          logger.error(
            { status: res.status, error: errBody, jid },
            'Telegram sendMessage failed',
          );
          return;
        }

        logger.info(
          {
            jid,
            threadId: resolvedThreadId ?? 'general',
            chunk: chunks.indexOf(chunk) + 1,
            total: chunks.length,
          },
          'Telegram message sent',
        );
      } catch (err) {
        logger.error({ err, jid }, 'Telegram sendMessage fetch error');
        return;
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('telegram:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('Telegram channel disconnected');
  }
}

// Register at module level — import triggers registration
registerChannel('telegram', (_opts: ChannelOpts) => {
  const channel = new TelegramChannel();
  return channel;
});
