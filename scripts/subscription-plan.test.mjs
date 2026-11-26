#!/usr/bin/env node
/**
 * Regression test for the ALLMOVA plan state.
 *
 * Reproduces the live account that still rendered "AKUN FREE" while the
 * database said `pro`:
 *
 *   profiles.id      8253b8aa-6487-42fc-9fe4-625292b2e65f
 *   profiles.tier            'pro'
 *   profiles.plan_tier       'pro'
 *   profiles.plan            'pro'
 *   profiles.is_owner        false
 *   profiles.pro_expires_at  '2026-12-09 23:32:40.194014+00'
 *
 * `pro_expires_at` is Postgres text, not ISO-8601 (space separator, six
 * fractional digits, `+00` offset). `Date.parse` only tolerates it on V8, and
 * the plan state used to be re-derived from the device clock, so a phone with a
 * wrong date turned an active plan into Free.
 *
 * It also covers the follow-up report: the same account (dated 30 Nov 2026, 4
 * days left) rendered "Pro aktif selamanya (tanpa kadaluarsa)" because a `null`
 * expiry from one Pro source erased the dated one, because the *later* of two
 * dates was always kept (so an admin shortening the plan never landed), and
 * because a `lifetime` tier alias discarded the date the server actually had.
 *
 * Only the Supabase client factory is stubbed (the network boundary); every
 * module under test is the real source, transpiled on the fly.
 *
 * Usage: node scripts/subscription-plan.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const LIVE_ROW = {
  id: '8253b8aa-6487-42fc-9fe4-625292b2e65f',
  email: 'arz.fom@gmail.com',
  display_name: 'Anton',
  tier: 'pro',
  plan_tier: 'pro',
  plan: 'pro',
  is_owner: false,
  pro_expires_at: '2026-12-09 23:32:40.194014+00',
  active_device_id: null,
  rider_profile: null,
  personal_goals: null,
};

/** The RPC returns the same columns plus its own verdict. */
const LIVE_RPC = {
  tier: 'pro',
  plan_tier: 'pro',
  pro_expires_at: '2026-12-09T23:32:40.194014+00:00',
  plan_expires_at: '2026-12-09T23:32:40.194014+00:00',
  is_owner: false,
  active_device_id: null,
  downgraded: false,
  server_now: '2026-11-26T04:14:00.123456+00:00',
};

const LIVE_NOW = Date.parse('2026-11-26T04:14:00Z');
const LIVE_EXPIRY_MS = Date.parse('2026-12-09T23:32:40.194Z');

/**
 * The reported account: `tier`/`plan_tier` = pro, `is_owner` = false and a
 * `pro_expires_at` of 30 Nov 2026 05:00 UTC — four days out, not lifetime.
 */
const FOUR_DAY_TEXT = '2026-11-30 05:00:00+00';
const FOUR_DAY_ISO = '2026-11-30T05:00:00.000Z';
const FOUR_DAY_NOW = Date.parse('2026-11-26T05:00:00Z');

const DATED_ROW = {
  id: '8253b8aa-6487-42fc-9fe4-625292b2e65f',
  email: 'newgatessystem@gmail.com',
  display_name: 'New Gates',
  tier: 'pro',
  plan_tier: 'pro',
  is_owner: false,
  pro_expires_at: FOUR_DAY_TEXT,
  active_device_id: null,
  rider_profile: null,
  personal_goals: null,
};

const DATED_RPC = {
  tier: 'pro',
  plan_tier: 'pro',
  pro_expires_at: FOUR_DAY_ISO,
  plan_expires_at: FOUR_DAY_ISO,
  is_owner: false,
  active_device_id: null,
  downgraded: false,
  server_now: '2026-11-26T05:00:00.123456+00:00',
};

const tempDir = await mkdtemp(path.join(tmpdir(), 'allmova-plan-test-'));
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

// The guard module talks to Supabase; the tests only need its clock maths.
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
await transpile('planState');
await transpile('subscriptionAndDeviceGuard');

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
    parseTimestamp,
    toIsoTimestamp,
    toAthleteProfile,
    isProfilePro,
    isTrialPro,
    isLifetimePro,
    readProfileTier,
    readProfileExpiry,
  } = await import(pathToFileURL(path.join(tempDir, 'subscription.mjs')).href);
  const { describePlan, mergePlanSignal, pickPlanSignal, resolvePlanProfile } = await import(
    pathToFileURL(path.join(tempDir, 'planState.mjs')).href
  );
  const { getTrustedCurrentTimeMs, recordServerNow } = await import(
    pathToFileURL(path.join(tempDir, 'subscriptionAndDeviceGuard.mjs')).href
  );

  const profile = toAthleteProfile(LIVE_ROW, LIVE_ROW.email, 'Anton');

  await check('Postgres text timestamp parses to the right instant', () => {
    assert.equal(parseTimestamp('2026-12-09 23:32:40.194014+00'), LIVE_EXPIRY_MS);
    assert.equal(toIsoTimestamp('2026-12-09 23:32:40.194014+00'), '2026-12-09T23:32:40.194Z');
  });

  await check('every timestamp shape the server can send is accepted', () => {
    for (const value of [
      '2026-12-09T23:32:40.194014+00:00',
      '2026-12-09T23:32:40.194Z',
      '2026-12-09 23:32:40.194014+0000',
      '2026-12-09 23:32:40.194014',
      LIVE_EXPIRY_MS,
    ]) {
      assert.equal(parseTimestamp(value), LIVE_EXPIRY_MS, `failed for ${value}`);
    }
    // A whole-second Postgres timestamp has no fractional part at all.
    assert.equal(parseTimestamp('2026-12-09 23:32:40+00'), LIVE_EXPIRY_MS - 194);
    assert.equal(parseTimestamp(''), null);
    assert.equal(parseTimestamp('bukan tanggal'), null);
    assert.equal(parseTimestamp(null), null);
    assert.equal(parseTimestamp(Number.NaN), null);
  });

  await check('a Postgres timestamp without seconds still parses', () => {
    assert.equal(parseTimestamp('2026-11-30 12:00+00'), Date.parse('2026-11-30T12:00:00Z'));
    assert.equal(parseTimestamp('2026-11-30T12:00'), Date.parse('2026-11-30T12:00:00Z'));
  });

  await check('a date the admin panel typed by hand is read, not dropped', () => {
    const localNoon = new Date(2026, 10, 30, 12, 0, 0, 0).getTime();
    assert.equal(parseTimestamp('30/11/2026, 12.00'), localNoon);
    assert.equal(parseTimestamp('30/11/2026 12:00'), localNoon);
    assert.equal(
      parseTimestamp('30/11/2026'),
      new Date(2026, 10, 30, 23, 59, 59, 999).getTime(),
    );
    assert.equal(parseTimestamp('31/02/2026'), null);
    assert.equal(toIsoTimestamp('30/11/2026, 12.00'), new Date(localNoon).toISOString());
  });

  await check('the live profiles row reads as Pro', () => {
    assert.equal(readProfileTier(LIVE_ROW), 'pro');
    assert.equal(readProfileExpiry(LIVE_ROW), LIVE_ROW.pro_expires_at);
    assert.equal(profile.tier, 'pro');
    assert.equal(profile.isOwner, false);
    assert.equal(profile.proExpiresAt, '2026-12-09T23:32:40.194Z');
    assert.equal(isProfilePro(profile, LIVE_NOW), true);
    assert.equal(isTrialPro(profile, LIVE_NOW), true);
  });

  await check('describePlan reports isPro === true for the live payload', () => {
    const status = describePlan(profile, LIVE_NOW);
    assert.equal(status.tier, 'pro');
    assert.equal(status.isPro, true);
    assert.equal(status.isTrial, true);
    assert.equal(status.isLifetime, false);
    assert.equal(status.daysLeft, 14);
    assert.equal(status.expired, false);
  });

  await check('the live RPC payload reads as Pro', () => {
    const signal = {
      tier: readProfileTier(LIVE_RPC) === 'pro' ? 'pro' : 'free',
      proExpiresAt: toIsoTimestamp(readProfileExpiry(LIVE_RPC)),
      isOwner: LIVE_RPC.is_owner === true,
      activeDeviceId: null,
      downgraded: LIVE_RPC.downgraded,
    };
    assert.equal(signal.tier, 'pro');
    assert.equal(signal.proExpiresAt, '2026-12-09T23:32:40.194Z');

    const resolved = resolvePlanProfile(
      { profile: { ...profile, tier: 'free', proExpiresAt: null }, cloud: false, error: 'offline' },
      signal,
      LIVE_NOW,
    );
    assert.equal(resolved.tier, 'pro');
    assert.equal(describePlan(resolved, LIVE_NOW).isPro, true);
  });

  await check('a failed profiles read still promotes from the RPC verdict', () => {
    const offline = {
      profile: {
        ...profile,
        tier: 'free',
        proExpiresAt: null,
        isOwner: false,
      },
      cloud: false,
      error: 'Gagal membaca status langganan dari server.',
    };
    const signal = { tier: 'pro', proExpiresAt: null, isOwner: false, activeDeviceId: null };
    const resolved = resolvePlanProfile(offline, signal, LIVE_NOW);
    assert.equal(resolved.tier, 'pro');
    assert.equal(describePlan(resolved, LIVE_NOW).isPro, true);
  });

  await check('a stale RPC "free" never demotes a fresh Pro row', () => {
    const stale = { tier: 'free', proExpiresAt: null, isOwner: false, activeDeviceId: null };
    const resolved = resolvePlanProfile({ profile, cloud: true, error: null }, stale, LIVE_NOW);
    assert.equal(resolved.tier, 'pro');
    assert.equal(describePlan(resolved, LIVE_NOW).isPro, true);
  });

  await check('a server Pro verdict outranks a device clock set months ahead', () => {
    const skewed = Date.parse('2027-06-01T00:00:00Z');
    const signal = {
      tier: 'pro',
      proExpiresAt: profile.proExpiresAt,
      isOwner: false,
      activeDeviceId: null,
      downgraded: false,
    };
    const resolved = mergePlanSignal(profile, signal, skewed);
    assert.equal(resolved.tier, 'pro');
    assert.equal(describePlan(resolved, skewed).isPro, true);
  });

  await check('an expired plan still downgrades to Free', () => {
    const expired = { ...profile, proExpiresAt: '2026-11-01T00:00:00.000Z' };
    assert.equal(isProfilePro(expired, LIVE_NOW), false);
    assert.equal(describePlan(expired, LIVE_NOW).isPro, false);
    const resolved = resolvePlanProfile({ profile: expired, cloud: true, error: null }, null, LIVE_NOW);
    assert.equal(resolved.tier, 'free');
  });

  await check('a server-side downgrade wins over the leftover plan_tier value', () => {
    const downgraded = { tier: 'free', proExpiresAt: profile.proExpiresAt, isOwner: false, activeDeviceId: null, downgraded: true };
    const resolved = resolvePlanProfile({ profile, cloud: true, error: null }, downgraded, LIVE_NOW);
    assert.equal(resolved.tier, 'free');
  });

  await check('the server clock, not the device clock, decides expiry', () => {
    recordServerNow(LIVE_RPC.server_now);
    const deviceClockAhead = Date.parse('2027-06-01T00:00:00Z');
    const trusted = getTrustedCurrentTimeMs(deviceClockAhead);
    assert.ok(trusted < Date.parse('2026-11-28T00:00:00Z'), `trusted clock jumped to ${new Date(trusted).toISOString()}`);
    assert.equal(describePlan(profile, trusted).isPro, true);

    // A rolled-back clock must not extend the trial either.
    const deviceClockBehind = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(
      getTrustedCurrentTimeMs(deviceClockBehind),
      Date.parse(LIVE_RPC.server_now),
    );
  });

  // ---------------------------------------------------------------------------
  // Reported bug: a Pro account dated 30 Nov 2026 (4 days left) rendered as
  // "Pro aktif selamanya (tanpa kadaluarsa)".
  // ---------------------------------------------------------------------------
  const datedProfile = toAthleteProfile(DATED_ROW, DATED_ROW.email, 'New Gates');
  const datedSignal = {
    tier: 'pro',
    proExpiresAt: toIsoTimestamp(readProfileExpiry(DATED_RPC)),
    isOwner: false,
    activeDeviceId: null,
    downgraded: false,
  };
  const datedFetch = { profile: datedProfile, cloud: true, error: null };

  await check('a Pro account dated 30 Nov 2026 is dated, not lifetime (Postgres text)', () => {
    assert.equal(readProfileExpiry(DATED_ROW), FOUR_DAY_TEXT);
    assert.equal(datedProfile.tier, 'pro');
    assert.equal(datedProfile.proExpiresAt, FOUR_DAY_ISO);
    assert.equal(isLifetimePro(datedProfile), false);

    const status = describePlan(datedProfile, FOUR_DAY_NOW);
    assert.equal(status.isPro, true);
    assert.equal(status.isLifetime, false);
    assert.equal(status.isTrial, true);
    assert.equal(status.daysLeft, 4);
  });

  await check('the ISO form of the same date reads identically', () => {
    const isoProfile = toAthleteProfile(
      { ...DATED_ROW, pro_expires_at: FOUR_DAY_ISO },
      DATED_ROW.email,
      'New Gates',
    );
    assert.equal(isoProfile.proExpiresAt, FOUR_DAY_ISO);
    const status = describePlan(isoProfile, FOUR_DAY_NOW);
    assert.equal(status.isLifetime, false);
    assert.equal(status.daysLeft, 4);
  });

  await check('a hand-typed id-ID date still reads as a dated plan', () => {
    const dmyProfile = toAthleteProfile(
      { ...DATED_ROW, pro_expires_at: '30/11/2026, 12.00' },
      DATED_ROW.email,
      'New Gates',
    );
    assert.notEqual(dmyProfile.proExpiresAt, null);
    const status = describePlan(dmyProfile, FOUR_DAY_NOW);
    assert.equal(status.isLifetime, false);
    assert.ok(status.daysLeft >= 4, `daysLeft was ${status.daysLeft}`);
  });

  await check('a null expiry from the RPC never erases the dated row', () => {
    const resolved = resolvePlanProfile(
      datedFetch,
      { ...datedSignal, proExpiresAt: null },
      FOUR_DAY_NOW,
    );
    assert.equal(resolved.tier, 'pro');
    assert.equal(resolved.proExpiresAt, FOUR_DAY_ISO);
    const status = describePlan(resolved, FOUR_DAY_NOW);
    assert.equal(status.isLifetime, false);
    assert.equal(status.daysLeft, 4);
  });

  await check('an admin shortening 30 days to 4 days lands immediately', () => {
    const thirtyDays = {
      ...datedProfile,
      proExpiresAt: '2026-12-26T05:00:00.000Z',
      serverVerifiedAt: FOUR_DAY_NOW,
    };
    assert.equal(describePlan(thirtyDays, FOUR_DAY_NOW).daysLeft, 30);

    const shortened = resolvePlanProfile(datedFetch, datedSignal, FOUR_DAY_NOW);
    assert.equal(shortened.proExpiresAt, FOUR_DAY_ISO);
    assert.equal(describePlan(shortened, FOUR_DAY_NOW).daysLeft, 4);

    // The same holds when the verdict is merged onto the profile on screen.
    const merged = mergePlanSignal(thirtyDays, datedSignal, FOUR_DAY_NOW);
    assert.equal(merged.proExpiresAt, FOUR_DAY_ISO);
    assert.equal(describePlan(merged, FOUR_DAY_NOW).daysLeft, 4);
  });

  await check('lifetime turned into a dated plan replaces the local lifetime state', () => {
    const lifetime = { ...datedProfile, proExpiresAt: null, serverVerifiedAt: FOUR_DAY_NOW };
    assert.equal(describePlan(lifetime, FOUR_DAY_NOW).isLifetime, true);

    const resolved = resolvePlanProfile(
      { profile: lifetime, cloud: true, error: null },
      datedSignal,
      FOUR_DAY_NOW,
    );
    assert.equal(resolved.proExpiresAt, FOUR_DAY_ISO);
    const status = describePlan(resolved, FOUR_DAY_NOW);
    assert.equal(status.isLifetime, false);
    assert.equal(status.daysLeft, 4);
  });

  await check('only a real owner reads as lifetime', () => {
    const owner = toAthleteProfile(
      { ...DATED_ROW, is_owner: true, pro_expires_at: FOUR_DAY_TEXT },
      DATED_ROW.email,
      'Owner',
    );
    assert.equal(owner.proExpiresAt, null);
    assert.equal(describePlan(owner, FOUR_DAY_NOW).isLifetime, true);

    // A `lifetime` tier alias must not throw the server date away.
    const lifetimeTier = toAthleteProfile(
      { ...DATED_ROW, plan_tier: 'lifetime' },
      DATED_ROW.email,
      'New Gates',
    );
    assert.equal(lifetimeTier.tier, 'pro');
    assert.equal(lifetimeTier.proExpiresAt, FOUR_DAY_ISO);
    assert.equal(describePlan(lifetimeTier, FOUR_DAY_NOW).isLifetime, false);
  });

  await check('a cached verdict cannot override the row the server just returned', () => {
    const cachedThirtyDays = { ...datedSignal, proExpiresAt: '2026-12-26T05:00:00.000Z' };
    assert.equal(pickPlanSignal(datedFetch, null, cachedThirtyDays), null);
    assert.equal(pickPlanSignal(datedFetch, datedSignal, cachedThirtyDays), datedSignal);

    // Offline, the cached verdict is still the only plan signal there is.
    const offline = { profile: datedProfile, cloud: false, error: 'offline' };
    assert.equal(pickPlanSignal(offline, null, cachedThirtyDays), cachedThirtyDays);
  });
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

for (const line of results) console.log(line);
console.log(process.exitCode ? 'Subscription plan tests FAILED' : 'Subscription plan tests passed');
