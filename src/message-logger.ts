import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export interface MessageLogEntry {
  id: string;
  chat_jid: string;
  thread_id: string | null;
  sender: string;
  sender_name: string;
  channel: string;          // 'whatsapp' | 'google-chat'
  direction: 'inbound' | 'outbound';
  content: string;
  timestamp: string;        // ISO 8601
}

export class MessageLogger {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.createSchema();
    this.insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages
        (id, chat_jid, thread_id, sender, sender_name, channel, direction, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT NOT NULL,
        chat_jid    TEXT NOT NULL,
        thread_id   TEXT,
        sender      TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        channel     TEXT NOT NULL,
        direction   TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        content     TEXT NOT NULL,
        timestamp   TEXT NOT NULL,
        PRIMARY KEY (id, chat_jid)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_timestamp  ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_jid   ON messages(chat_jid);
      CREATE INDEX IF NOT EXISTS idx_messages_thread_id  ON messages(thread_id);
    `);
  }

  logMessage(entry: MessageLogEntry): void {
    try {
      this.insertStmt.run(
        entry.id,
        entry.chat_jid,
        entry.thread_id ?? null,
        entry.sender,
        entry.sender_name,
        entry.channel,
        entry.direction,
        entry.content,
        entry.timestamp,
      );
    } catch (err) {
      logger.warn({ err, messageId: entry.id }, 'MessageLogger: failed to log message');
    }
  }

  close(): void {
    this.db.close();
  }
}
