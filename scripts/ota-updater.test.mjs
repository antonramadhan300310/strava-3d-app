#!/usr/bin/env node
/**
 * Integration test for the OTA download path in `src/lib/otaUpdater.ts`.
 *
 * Only the Capacitor bridge (the native boundary that cannot exist in Node) is
 * replaced; the module under test is the real source, transpiled on the fly.
 * The scenarios mirror what `@capgo/capacitor-updater` 6.53.0 enforces on
 * Android: `CapgoUpdater.requireBundleChecksum` rejects an empty checksum, so
 * `downloadOtaBundle` must always hand `CapacitorUpdater.download()` a SHA-256.
 *
 * Usage: node scripts/ota-updater.test.mjs
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { Capacitor } from '@capacitor/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const tempDir = await mkdtemp(path.join(root, 'scripts', '.ota-test-'));
const modulePath = path.join(tempDir, 'otaUpdater.mjs');
const source = await readFile(path.join(root, 'src/lib/otaUpdater.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
await writeFile(modulePath, outputText);

const bundleBytes = Buffer.from('allmova-ota-bundle-payload-'.repeat(64));
const checksum = createHash('sha256').update(bundleBytes).digest('hex');

let bundleHits = 0;
let bundleStatus = 200;
const server = createServer((request, response) => {
  if (request.url?.startsWith('/bundle.zip')) {
    bundleHits += 1;
    if (bundleStatus !== 200) {
      response.writeHead(bundleStatus).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': String(bundleBytes.length),
    });
    response.end(request.method === 'HEAD' ? undefined : bundleBytes);
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const downloads = [];
let downloadError = null;
// The plugin proxy routes to the native bridge whenever a plugin header is
// registered, so faking that header is the seam that exercises the real
// `CapacitorUpdater.download()` call site without an Android runtime.
Capacitor.isNativePlatform = () => true;
Capacitor.PluginHeaders = [
  {
    name: 'CapacitorUpdater',
    methods: [
      { name: 'download', rtype: 'promise' },
      { name: 'addListener', rtype: 'promise' },
      { name: 'removeListener', rtype: 'promise' },
    ],
  },
];
Capacitor.nativePromise = async (_plugin, method, options) => {
  if (method === 'download') {
    downloads.push(options);
    if (downloadError) throw downloadError;
    return { id: `bundle-${downloads.length}`, version: options.version };
  }
  return {};
};

const originalError = console.error;
console.error = () => {};

const release = (overrides = {}) => ({
  otaVersion: '1.3.41',
  buildNumber: 41,
  commitSha: 'abc123',
  builtAt: '2026-11-26T00:00:00Z',
  minNativeVersion: '1.2.0',
  bundleUrl: `${base}/bundle.zip`,
  bundleChecksum: checksum,
  apkUrl: '',
  releaseNotes: '',
  ...overrides,
});

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

try {
  const { downloadOtaBundle, normalizeOtaChecksum } = await import(
    pathToFileURL(modulePath).href
  );

  check('normalizeOtaChecksum lowercases a valid digest', () =>
    assert.equal(normalizeOtaChecksum(checksum.toUpperCase()), checksum),
  );
  check('normalizeOtaChecksum rejects empty/short values', () => {
    assert.equal(normalizeOtaChecksum(''), '');
    assert.equal(normalizeOtaChecksum('abc'), '');
    assert.equal(normalizeOtaChecksum(undefined), '');
  });

  bundleHits = 0;
  const published = await downloadOtaBundle(release());
  check('manifest checksum is forwarded to capgo download()', () => {
    assert.equal(published.ok, true);
    assert.equal(downloads.at(-1).checksum, checksum);
    assert.equal(downloads.at(-1).version, '1.3.41');
    assert.equal(downloads.at(-1).url, `${base}/bundle.zip`);
  });
  check('published checksum avoids re-downloading the zip', () => assert.equal(bundleHits, 0));

  bundleHits = 0;
  const derived = await downloadOtaBundle(release({ otaVersion: '1.3.42', bundleChecksum: '' }));
  check('missing manifest checksum is derived from the published zip', () => {
    assert.equal(derived.ok, true);
    assert.equal(downloads.at(-1).checksum, checksum);
    assert.equal(bundleHits, 1);
  });

  downloadError = new Error(`Failed to download from: ${base}/bundle.zip`);
  const failed = await downloadOtaBundle(release({ otaVersion: '1.3.43' }));
  check('plugin rejection carries URL, checksum and probe detail', () => {
    assert.equal(failed.ok, false);
    assert.match(failed.detail, /Failed to download from/);
    assert.ok(failed.detail.includes(checksum.slice(0, 12)));
    assert.match(failed.detail, /HEAD 200/);
    assert.match(failed.detail, /sha256 cocok/);
  });
  downloadError = null;

  bundleStatus = 404;
  const before = downloads.length;
  const unreachable = await downloadOtaBundle(release({ otaVersion: '1.3.44', bundleChecksum: '' }));
  check('download() is never called without a checksum', () => {
    assert.equal(unreachable.ok, false);
    assert.match(unreachable.detail, /Checksum SHA-256/);
    assert.equal(downloads.length, before);
  });
  bundleStatus = 200;

  const mismatch = await downloadOtaBundle(
    release({ otaVersion: '1.3.45', bundleChecksum: 'f'.repeat(64) }),
  );
  check('mismatched manifest checksum is reported, not silently retried', () => {
    assert.equal(mismatch.ok, true);
    assert.equal(downloads.at(-1).checksum, 'f'.repeat(64));
  });
} finally {
  console.error = originalError;
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}

for (const line of results) console.log(line);
console.log(process.exitCode ? 'OTA updater tests FAILED' : 'OTA updater tests passed');
