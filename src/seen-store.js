/**
 * Deduplication store. Same as HotDrop's but simpler — anime quotes are
 * identified by a hash of the quote text, so the same line never publishes twice.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEN_FILE = join(__dirname, '..', '.seen-quotes.json');
const MAX_ENTRIES = 500;

export function loadSeen() {
  if (!existsSync(SEEN_FILE)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(SEEN_FILE, 'utf-8'));
  } catch {
    return { entries: [] };
  }
}

function writeSeen(entries) {
  writeFileSync(SEEN_FILE, JSON.stringify({ version: 1, entries: entries.slice(-MAX_ENTRIES) }, null, 2));
}

export function seenIds(store = loadSeen()) {
  return new Set((store.entries || []).map((e) => e.id));
}

export function isSeen(id, store = loadSeen()) {
  return seenIds(store).has(id);
}

export function markSeen(id, title = '') {
  const store = loadSeen();
  if (store.entries.some((e) => e.id === id)) return;
  store.entries.push({ id, title, at: new Date().toISOString() });
  writeSeen(store.entries);
}
