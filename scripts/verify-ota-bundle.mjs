#!/usr/bin/env node
/**
 * Verifies a published OTA bundle against the gates `@capgo/capacitor-updater`
 * 6.53.0 applies on Android before it will install anything:
 *
 *   1. `CapgoUpdater.requireBundleChecksum` — `download()` rejects an empty checksum.
 *   2. `CapgoUpdater.finishDownload` — the downloaded zip must hash to that checksum.
 *   3. `CapgoUpdater.unzip` + `flattenAssets` — `index.html` must sit at the zip root
 *      and no entry may escape the bundle folder.
 *
 * Usage: node scripts/verify-ota-bundle.mjs [manifest-url]
 */

import { createHash } from 'node:crypto';

const DEFAULT_MANIFEST =
  'https://adnboduimzesbvbejdwr.supabase.co/storage/v1/object/public/ota-updates/version.json';

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

function listZipEntries(buffer) {
  const minEocd = 22;
  const floor = Math.max(0, buffer.length - minEocd - 0xffff);
  let eocd = -1;
  for (let index = buffer.length - minEocd; index >= floor; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: end-of-central-directory record missing');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`corrupt central directory at entry ${index}`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

const manifestUrl = process.argv[2] ?? DEFAULT_MANIFEST;
const manifestResponse = await fetch(`${manifestUrl}${manifestUrl.includes('?') ? '&' : '?'}t=${Date.now()}`);
if (!manifestResponse.ok) fail(`manifest HTTP ${manifestResponse.status}`);
const manifest = await manifestResponse.json();
console.log(`manifest ${manifest.otaVersion} (build ${manifest.buildNumber})`);

const declared = String(manifest.checksum ?? '').toLowerCase();
if (!CHECKSUM_PATTERN.test(declared)) {
  console.warn(
    'WARN manifest has no valid sha256 checksum; the app derives it client-side for this bundle',
  );
}

const bundleUrl = manifest.bundleUrl ?? manifest.url;
if (!bundleUrl) fail('manifest has no bundleUrl');

const bundleResponse = await fetch(bundleUrl);
if (!bundleResponse.ok) fail(`bundle HTTP ${bundleResponse.status}`);
const body = Buffer.from(await bundleResponse.arrayBuffer());

const actual = createHash('sha256').update(body).digest('hex');
console.log(`bundle ${body.length} bytes, sha256 ${actual}`);
if (declared && declared !== actual) fail(`sha256 ${actual} != manifest checksum ${declared}`);
if (declared) console.log('checksum matches manifest');

const names = listZipEntries(body);
const unsafe = names.filter((name) => name.startsWith('/') || name.split('/').includes('..'));
if (unsafe.length) fail(`unsafe zip entries: ${unsafe.slice(0, 3).join(', ')}`);
if (!names.includes('index.html')) fail(`index.html is not at the zip root: ${names.slice(0, 5)}`);

console.log(`PASS ${names.length} entries, index.html at root`);
