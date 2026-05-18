/**
 * Telegram channel adapter for NanoClaw.
 *
 * Receives messages via trigger-writer webhook (no polling needed).
 * Sends replies via the Telegram Bot API sendMessage endpoint.
 *
 * Multi-bot + reply-to-inbound (2026-05):
 *  - Trigger-writer encodes inbound chat id into the JID:
 *      telegram:<agent>:<chatId>[:<threadId>]
 *  - NanoClaw replies to that chatId.
 *  - Bot token is resolved per agent from group env:
 *      /opt/nanoclaw/groups/telegram_<agent>/.env (TELEGRAM_BOT_TOKEN)
 *
 * This avoids using a single global token from /opt/nanoclaw/.env.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const GROUPS_DIR = '/opt/nanoclaw/groups';
const MAX_MESSAGE_LENGTH = 4096;

function readEnvFileValue(envPath: string, key: string): string | undefined {
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('='))
        continue;
      const eqIdx = trimmed.indexOf('=');
      const k = trimmed.substring(0, eqIdx).trim();
      const v = trimmed.substring(eqIdx + 1).trim();
      if (k === key) return v;
    }
  } catch {
    // ignore missing files
  }
  return undefined;
}

function parseThreadId(
  value: string | number | undefined | null,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function resolveThreadId(jid: string, threadId?: string): number | undefined {
  const explicit = parseThreadId(threadId);
  if (explicit !== undefined) return explicit;

  // jid may be telegram:<agent>:<chatId>:<threadId>
  const parts = jid.split(':');
  return parseThreadId(parts[3]);
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
    if (splitIdx <= 0) splitIdx = MAX_MESSAGE_LENGTH;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

function parseTelegramJid(
  jid: string,
): { agent: string; chatId: string; threadIdFromJid?: string } | null {
  // telegram:<agent>:<chatId>[:<threadId>]
  const parts = String(jid).split(':');
  if (parts[0] !== 'telegram') return null;
  const agent = parts[1];
  const chatId = parts[2];
  const threadIdFromJid = parts[3];
  if (!agent || !chatId) return null;
  return { agent, chatId, threadIdFromJid };
}

function getBotTokenForAgent(agent: string): string | undefined {
  const envPath = path.join(GROUPS_DIR, `telegram_${agent}`, '.env');
  const token = readEnvFileValue(envPath, 'TELEGRAM_BOT_TOKEN');
  if (!token) {
    logger.error(
      { agent, envPath },
      'TELEGRAM_BOT_TOKEN missing for telegram agent group',
    );
    return undefined;
  }
  return token;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private connected = false;

  async connect(): Promise<void> {
    // Resolve bot token per-message from group env.
    this.connected = true;
    logger.info('Telegram channel connected (webhook mode — per-agent tokens)');
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid }, 'Telegram channel not connected, dropping message');
      return;
    }

    const parsed = parseTelegramJid(jid);
    if (!parsed) {
      logger.warn({ jid }, 'Telegram invalid jid; dropping message');
      return;
    }

    const botToken = getBotTokenForAgent(parsed.agent);
    if (!botToken) return;

    const resolvedThreadId = resolveThreadId(jid, threadId);
    const chunks = splitMessage(text);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const body: Record<string, unknown> = {
        chat_id: parsed.chatId,
        text: chunk,
      };
      if (resolvedThreadId !== undefined)
        body.message_thread_id = resolvedThreadId;

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          logger.error(
            {
              status: res.status,
              error: errBody,
              jid,
              agentSlug: parsed.agent,
            },
            'Telegram sendMessage failed',
          );
          return;
        }

        logger.info(
          {
            jid,
            threadId: resolvedThreadId ?? 'general',
            chunk: i + 1,
            total: chunks.length,
          },
          'Telegram message sent',
        );
      } catch (err) {
        logger.error(
          { err, jid, agentSlug: parsed.agent },
          'Telegram sendMessage fetch error',
        );
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

registerChannel('telegram', (_opts: ChannelOpts) => {
  const channel = new TelegramChannel();
  return channel;
});
