import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MessageLogEntry, MessageLogger } from './message-logger.js';

function tmpDbPath(): string {
  return `/tmp/test-memory-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`;
}

function makeEntry(overrides: Partial<MessageLogEntry> = {}): MessageLogEntry {
  return {
    id: `test-msg-${Date.now()}`,
    chat_jid: 'spaces/ABC123',
    thread_id: 'spaces/ABC123/threads/xyz',
    sender: 'craig@gorillahub.co.uk',
    sender_name: 'Craig',
    channel: 'google-chat',
    direction: 'inbound',
    content: 'Hello Holly',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('MessageLogger', () => {
  const dbPaths: string[] = [];

  afterEach(() => {
    for (const p of dbPaths) {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(p + suffix);
        } catch {
          /* ignore */
        }
      }
    }
    dbPaths.length = 0;
  });

  function openLogger(): { logger: MessageLogger; dbPath: string } {
    const dbPath = tmpDbPath();
    dbPaths.push(dbPath);
    const logger = new MessageLogger(dbPath);
    return { logger, dbPath };
  }

  // Test 1 (INGEST-01): logMessage() inserts a row retrievable by SELECT
  it('INGEST-01: logMessage inserts a row that can be retrieved', () => {
    const { logger, dbPath } = openLogger();
    const entry = makeEntry();
    logger.logMessage(entry);

    // Re-open to query
    import('better-sqlite3').then(({ default: Database }) => {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare('SELECT * FROM messages WHERE id = ?')
        .get(entry.id) as Record<string, unknown> | undefined;
      db.close();
      expect(row).toBeDefined();
      expect(row!.id).toBe(entry.id);
    });

    // Synchronous verification via a second logger instance
    logger.close();
    const logger2 = new MessageLogger(dbPath);
    // Use internal access via a read query — we test via the DB directly
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(entry.id) as Record<string, unknown> | undefined;
    db.close();
    logger2.close();

    expect(row).toBeDefined();
    expect(row!.id).toBe(entry.id);
  });

  // Test 2 (INGEST-02): Inserted row has all required fields
  it('INGEST-02: logged row contains all required fields with correct values', () => {
    const { logger, dbPath } = openLogger();
    const entry = makeEntry({
      id: 'msg-ingest-02',
      chat_jid: 'spaces/DEF456',
      thread_id: 'spaces/DEF456/threads/t1',
      sender: 'craig@gorillahub.co.uk',
      sender_name: 'Craig H',
      channel: 'google-chat',
      direction: 'inbound',
      content: 'Test content for INGEST-02',
      timestamp: '2026-03-18T08:00:00.000Z',
    });
    logger.logMessage(entry);
    logger.close();

    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(entry.id) as Record<string, unknown>;
    db.close();

    expect(row.id).toBe('msg-ingest-02');
    expect(row.chat_jid).toBe('spaces/DEF456');
    expect(row.thread_id).toBe('spaces/DEF456/threads/t1');
    expect(row.sender).toBe('craig@gorillahub.co.uk');
    expect(row.sender_name).toBe('Craig H');
    expect(row.channel).toBe('google-chat');
    expect(row.direction).toBe('inbound');
    expect(row.content).toBe('Test content for INGEST-02');
    expect(row.timestamp).toBe('2026-03-18T08:00:00.000Z');
  });

  // Test 3 (INGEST-03): Rows persist after close() and re-open
  it('INGEST-03: rows persist after close and re-open on same DB path', () => {
    const { logger, dbPath } = openLogger();
    const entry = makeEntry({
      id: 'persist-test-001',
      content: 'Persisted message',
    });
    logger.logMessage(entry);
    logger.close();

    // Re-open and verify
    const logger2 = new MessageLogger(dbPath);
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT content FROM messages WHERE id = ?')
      .get(entry.id) as Record<string, unknown> | undefined;
    db.close();
    logger2.close();

    expect(row).toBeDefined();
    expect(row!.content).toBe('Persisted message');
  });

  // Test 4 (INGEST-04): Query without chat_jid filter returns messages from multiple distinct chat_jids
  it('INGEST-04: query returns messages from multiple distinct chat_jids', () => {
    const { logger, dbPath } = openLogger();

    logger.logMessage(
      makeEntry({
        id: 'multi-1',
        chat_jid: 'spaces/THREAD1',
        content: 'From thread 1',
      }),
    );
    logger.logMessage(
      makeEntry({
        id: 'multi-2',
        chat_jid: '447700000001@s.whatsapp.net',
        channel: 'whatsapp',
        content: 'From WhatsApp',
      }),
    );
    logger.logMessage(
      makeEntry({
        id: 'multi-3',
        chat_jid: 'spaces/THREAD2',
        content: 'From thread 2',
      }),
    );
    logger.close();

    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare('SELECT DISTINCT chat_jid FROM messages')
      .all() as Array<{ chat_jid: string }>;
    db.close();

    expect(rows.length).toBeGreaterThanOrEqual(3);
    const jids = rows.map((r) => r.chat_jid);
    expect(jids).toContain('spaces/THREAD1');
    expect(jids).toContain('447700000001@s.whatsapp.net');
    expect(jids).toContain('spaces/THREAD2');
  });

  // Test 5 (error isolation): logMessage() does not throw on failure
  it('error isolation: logMessage does not throw when DB write would fail', () => {
    const { logger, dbPath } = openLogger();
    // Close the DB so writes will fail
    logger.close();

    // Attempt to log after close — should not throw
    expect(() => {
      logger.logMessage(makeEntry({ id: 'after-close-msg' }));
    }).not.toThrow();
  });

  // Test 6 (schema): DB created with WAL mode and correct table structure
  it('schema: DB created with journal_mode=WAL and correct table including direction CHECK constraint', () => {
    const { logger, dbPath } = openLogger();
    // Log one valid message to ensure table is created
    logger.logMessage(makeEntry({ id: 'schema-test-001' }));
    logger.close();

    const Database = require('better-sqlite3');
    const db = new Database(dbPath);

    // Verify WAL mode
    const journalMode = (
      db.pragma('journal_mode') as Array<{ journal_mode: string }>
    )[0]?.journal_mode;
    expect(journalMode).toBe('wal');

    // Verify table exists with correct schema
    const tableInfo = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'",
      )
      .get() as { sql: string } | undefined;
    expect(tableInfo).toBeDefined();
    expect(tableInfo!.sql).toContain('direction');
    expect(tableInfo!.sql.toLowerCase()).toContain('check');

    // Verify CHECK constraint works — invalid direction should throw
    expect(() => {
      db.prepare(
        'INSERT INTO messages (id, chat_jid, thread_id, sender, sender_name, channel, direction, content, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'bad-dir-id',
        'spaces/X',
        null,
        'test',
        'test',
        'google-chat',
        'invalid-direction',
        'content',
        new Date().toISOString(),
      );
    }).toThrow();

    // Verify indexes exist
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'",
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_messages_timestamp');
    expect(indexNames).toContain('idx_messages_chat_jid');
    expect(indexNames).toContain('idx_messages_thread_id');

    db.close();
  });
});
