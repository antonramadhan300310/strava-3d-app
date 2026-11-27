#!/usr/bin/env node
/**
 * Regression test for the admin announcement bell (`src/lib/announcements.ts`).
 *
 * The bell reads `public.announcements` written by the admin panel, so the
 * mapper has to survive the column aliases that panel uses (`message`,
 * `published_at`, …), drop inactive/empty rows, sort newest first and count
 * what arrived after the last time the sheet was opened.
 *
 * Only the Supabase client factory is stubbed (the network boundary); every
 * module under test is the real source, transpiled on the fly.
 *
 * Usage: node scripts/announcements.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const tempDir = await mkdtemp(path.join(tmpdir(), 'allmova-announcements-test-'));
const transpile = async (name) => {
  const source = await readFile(path.join(root, 'src/lib', `${name}.ts`), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  await writeFile(
    path.join(tempDir, `${name}.mjs`),
    outputText.replace(/from '\.\/([a-zA-Z]+)'/g, "from './$1.mjs'"),
  );
};

// The test only reads; an unconfigured project is the offline path.
await writeFile(
  path.join(tempDir, 'supabase.mjs'),
  'export const getSupabaseClientOrNull = () => null;\nexport const isSupabaseConfigured = false;\n',
);

const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    get length() {
      return store.size;
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
  },
};

await transpile('subscription');
await transpile('userStorage');
await transpile('announcements');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

try {
  const {
    ANNOUNCEMENT_LIMIT,
    toAnnouncement,
    toAnnouncements,
    countUnseen,
    newestAnnouncementAt,
    readLastSeenAnnouncementAt,
    writeLastSeenAnnouncementAt,
    formatAnnouncementTime,
    fetchAnnouncements,
  } = await import(pathToFileURL(path.join(tempDir, 'announcements.mjs')).href);

  const NEWER = Date.parse('2026-11-27T04:00:00.123Z');
  const OLDER = Date.parse('2026-11-20T09:30:00Z');

  await check('the admin row maps to a notification', () => {
    const entry = toAnnouncement({
      id: 'a1',
      title: 'Selamat datang',
      body: 'Filter GPS baru sudah aktif.',
      created_at: '2026-11-27 04:00:00.123456+00',
      is_active: true,
    });
    assert.equal(entry.id, 'a1');
    assert.equal(entry.title, 'Selamat datang');
    assert.equal(entry.body, 'Filter GPS baru sudah aktif.');
    assert.equal(entry.createdAtMs, NEWER);
    assert.equal(entry.kind, 'info');
  });

  await check('column aliases from the panel are accepted', () => {
    const entry = toAnnouncement({
      id: 7,
      heading: 'Promo Pro',
      message: 'Diskon 30% minggu ini.',
      level: 'promo',
      published_at: '2026-11-20T09:30:00+00:00',
    });
    assert.equal(entry.id, '7');
    assert.equal(entry.title, 'Promo Pro');
    assert.equal(entry.body, 'Diskon 30% minggu ini.');
    assert.equal(entry.createdAtMs, OLDER);
    assert.equal(entry.kind, 'promo');
  });

  await check('an unknown level falls back to info', () => {
    const entry = toAnnouncement({ title: 'Halo', level: 'urgent' });
    assert.equal(entry.kind, 'info');
  });

  await check('inactive and empty rows are dropped', () => {
    assert.equal(toAnnouncement({ title: 'Lama', is_active: false }), null);
    assert.equal(toAnnouncement({ is_active: true }), null);
    assert.equal(toAnnouncement({ title: '   ', body: '  ' }), null);
  });

  await check('a row without a title borrows the start of the body', () => {
    const entry = toAnnouncement({ body: 'Pesan penting dari admin.' });
    assert.equal(entry.title, 'Pesan penting dari admin.');
  });

  await check('the list is newest first and capped', () => {
    const rows = Array.from({ length: ANNOUNCEMENT_LIMIT + 5 }, (_, index) => ({
      id: `row-${index}`,
      title: `Pengumuman ${index}`,
      created_at: new Date(Date.parse('2026-11-01T00:00:00Z') + index * 3600_000).toISOString(),
    }));
    const list = toAnnouncements(rows);
    assert.equal(list.length, ANNOUNCEMENT_LIMIT);
    assert.equal(list[0].id, `row-${ANNOUNCEMENT_LIMIT + 4}`);
    for (let index = 1; index < list.length; index += 1) {
      assert.ok(list[index - 1].createdAtMs >= list[index].createdAtMs);
    }
  });

  await check('unseen counts only what arrived after the last visit', () => {
    const list = [
      { id: 'new', title: 'Baru', body: '', createdAtMs: NEWER, kind: 'info' },
      { id: 'old', title: 'Lama', body: '', createdAtMs: OLDER, kind: 'info' },
      { id: 'undated', title: 'Tanpa tanggal', body: '', createdAtMs: null, kind: 'info' },
    ];
    assert.equal(countUnseen(list, null), 3);
    assert.equal(countUnseen(list, OLDER), 1);
    assert.equal(countUnseen(list, NEWER), 0);
    assert.equal(newestAnnouncementAt(list), NEWER);
    assert.equal(newestAnnouncementAt([{ createdAtMs: null }]), null);
  });

  await check('the last seen timestamp is stored per account', () => {
    writeLastSeenAnnouncementAt('user-a', NEWER);
    assert.equal(readLastSeenAnnouncementAt('user-a'), NEWER);
    assert.equal(readLastSeenAnnouncementAt('user-b'), null);

    // A value that is not a timestamp must not hide the badge forever.
    writeLastSeenAnnouncementAt('user-c', Number.NaN);
    assert.equal(readLastSeenAnnouncementAt('user-c'), null);
    assert.equal(readLastSeenAnnouncementAt(null), null);
  });

  await check('the relative time reads naturally in Indonesian', () => {
    const now = NEWER;
    assert.equal(formatAnnouncementTime(now - 10_000, now), 'Baru saja');
    assert.equal(formatAnnouncementTime(now - 5 * 60_000, now), '5 menit lalu');
    assert.equal(formatAnnouncementTime(now - 3 * 3600_000, now), '3 jam lalu');
    assert.equal(formatAnnouncementTime(now - 30 * 3600_000, now), 'Kemarin');
    assert.match(formatAnnouncementTime(now - 90 * 24 * 3600_000, now), /2026/);
    assert.equal(formatAnnouncementTime(null, now), '');
  });

  await check('an unconfigured project shows an empty inbox, not an error', async () => {
    assert.deepEqual(await fetchAnnouncements(), []);
  });
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

for (const line of results) console.log(line);
console.log(process.exitCode ? 'Announcement tests FAILED' : 'Announcement tests passed');
