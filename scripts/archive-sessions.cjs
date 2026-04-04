#!/usr/bin/env node
// archive-sessions.js — prune active_sessions.json files older than 7 days to archived_sessions.json
// Preserves full audit trail. Safe to run while NanoClaw is live (atomic writes).
const fs = require('fs');
const path = require('path');

const IPC_DIR = '/opt/nanoclaw/data/ipc';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const now = Date.now();
let totalArchived = 0;
let totalKept = 0;

try {
  const groups = fs.readdirSync(IPC_DIR).filter(f => {
    try { return fs.statSync(path.join(IPC_DIR, f)).isDirectory(); } catch { return false; }
  });

  for (const group of groups) {
    const activePath = path.join(IPC_DIR, group, 'active_sessions.json');
    const archivePath = path.join(IPC_DIR, group, 'archived_sessions.json');
    if (!fs.existsSync(activePath)) continue;

    let active;
    try {
      active = JSON.parse(fs.readFileSync(activePath, 'utf-8'));
    } catch { continue; }

    if (!Array.isArray(active.sessions)) continue;

    const toArchive = active.sessions.filter(s => (now - new Date(s.started).getTime()) > SEVEN_DAYS_MS);
    const toKeep = active.sessions.filter(s => (now - new Date(s.started).getTime()) <= SEVEN_DAYS_MS);

    if (toArchive.length === 0) continue;

    // Load existing archive (or start fresh)
    let archive = { sessions: [], archivedAt: null };
    if (fs.existsSync(archivePath)) {
      try { archive = JSON.parse(fs.readFileSync(archivePath, 'utf-8')); } catch {}
    }
    if (!Array.isArray(archive.sessions)) archive.sessions = [];

    // Append to archive with timestamp
    const stamped = toArchive.map(s => ({ ...s, archivedAt: new Date().toISOString() }));
    archive.sessions.push(...stamped);
    archive.updatedAt = new Date().toISOString();

    // Atomic write archive
    const archiveTmp = archivePath + '.tmp';
    fs.writeFileSync(archiveTmp, JSON.stringify(archive, null, 2));
    fs.renameSync(archiveTmp, archivePath);

    // Atomic write pruned active
    active.sessions = toKeep;
    active.updatedAt = new Date().toISOString();
    const activeTmp = activePath + '.tmp';
    fs.writeFileSync(activeTmp, JSON.stringify(active, null, 2));
    fs.renameSync(activeTmp, activePath);

    console.log(group + ': archived=' + toArchive.length + ' kept=' + toKeep.length);
    totalArchived += toArchive.length;
    totalKept += toKeep.length;
  }

  console.log('Done. Total archived=' + totalArchived + ' kept=' + totalKept);
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
