#!/usr/bin/env node
/**
 * Regression test for the recording pipeline in `src/lib/gpsFilter.ts`:
 *
 * - the accuracy gate drops fixes worse than 25 m (cell/Wi-Fi positions taken
 *   under a flyover used to drag the drawn line off the road),
 * - a coordinate spike is rejected for the sport's plausible top speed,
 * - light EMA smoothing calms the jitter without cutting a sharp corner,
 * - the elevation gain ignores altitude noise through a deadband,
 * - auto-pause pauses after five seconds below the sport threshold and resumes
 *   on its own once the athlete moves again.
 *
 * Only the real source modules are exercised; nothing is mocked.
 *
 * Usage: node scripts/gps-filter.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { distance as turfDistance } from '@turf/turf';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const BASE_LAT = -6.9175;
const BASE_LNG = 107.6191;
const METERS_PER_DEG_LAT = 111320;
const METERS_PER_DEG_LNG = METERS_PER_DEG_LAT * Math.cos((BASE_LAT * Math.PI) / 180);
const T0 = Date.parse('2026-11-27T05:00:00Z');

/** A fix `north`/`east` metres away from the base point. */
function fixAt({ north = 0, east = 0, accuracy = 5, altitude = null, speed = null, time }) {
  return {
    lat: BASE_LAT + north / METERS_PER_DEG_LAT,
    lng: BASE_LNG + east / METERS_PER_DEG_LNG,
    accuracy,
    altitude,
    speed,
    time,
  };
}

const eastMeters = (point) => Math.abs((point.lng - BASE_LNG) * METERS_PER_DEG_LNG);

function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += turfDistance(
      [points[i - 1].lng, points[i - 1].lat],
      [points[i].lng, points[i].lat],
      { units: 'meters' },
    );
  }
  return total;
}

const tempDir = await mkdtemp(path.join(tmpdir(), 'allmova-gps-test-'));
// The transpiled copy lives in /tmp, where a bare package specifier cannot be
// resolved; pin the dependency to the copy installed in this repository.
const turfUrl = import.meta.resolve('@turf/turf');
const transpile = async (name) => {
  const source = await readFile(path.join(root, 'src/lib', `${name}.ts`), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  await writeFile(
    path.join(tempDir, `${name}.mjs`),
    outputText
      .replace(/from '\.\/([a-zA-Z]+)'/g, "from './$1.mjs'")
      .replace(/from '@turf\/turf'/g, `from '${turfUrl}'`),
  );
};

await transpile('metrics');
await transpile('gpsFilter');

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
    GPS_ACCURACY_LIMIT_METERS,
    AUTO_PAUSE_HOLD_MS,
    autoPauseSpeedKmh,
    spikeSpeedLimitKmh,
    smoothingAlpha,
    smoothedElevationGain,
    createGpsFilter,
    createAutoPauseTracker,
  } = await import(pathToFileURL(path.join(tempDir, 'gpsFilter.mjs')).href);

  await check('accuracy gate drops fixes worse than 25 m', () => {
    assert.equal(GPS_ACCURACY_LIMIT_METERS, 25);

    const filter = createGpsFilter('cycling');
    const cell = filter.push(fixAt({ accuracy: 30, time: T0 }));
    assert.equal(cell.accepted, false);
    assert.equal(cell.reason, 'accuracy');

    const wifi = filter.push(fixAt({ north: 5, accuracy: 41, time: T0 + 1000 }));
    assert.equal(wifi.accepted, false);
    assert.equal(wifi.reason, 'accuracy');

    const satellite = filter.push(fixAt({ north: 10, accuracy: 8, time: T0 + 2000 }));
    assert.equal(satellite.accepted, true);
    assert.equal(satellite.reason, null);
    assert.equal(filter.points.length, 1);
  });

  await check('a teleported fix is rejected as a spike', () => {
    const filter = createGpsFilter('cycling');
    filter.push(fixAt({ time: T0 }));

    // 40 m in one second is 144 km/h: a spike, not a ride.
    const spike = filter.push(fixAt({ north: 40, time: T0 + 1000 }));
    assert.equal(spike.accepted, false);
    assert.equal(spike.reason, 'spike');

    // 10 m in one second is 36 km/h: normal cycling.
    const ride = filter.push(fixAt({ north: 10, time: T0 + 2000 }));
    assert.equal(ride.accepted, true);
  });

  await check('spike limits follow the sport', () => {
    assert.equal(spikeSpeedLimitKmh('cycling'), 90);
    assert.equal(spikeSpeedLimitKmh('run'), 35);

    const runner = createGpsFilter('run');
    runner.push(fixAt({ time: T0 }));
    // 15 m in one second is 54 km/h, far above a run.
    const sprint = runner.push(fixAt({ north: 15, time: T0 + 1000 }));
    assert.equal(sprint.reason, 'spike');

    // 5 m in one second is 18 km/h: a fast downhill run.
    const jog = runner.push(fixAt({ north: 5, time: T0 + 2000 }));
    assert.equal(jog.accepted, true);
  });

  await check('a cell-tower fix does not poison the next speed reading', () => {
    const filter = createGpsFilter('cycling');
    filter.push(fixAt({ time: T0 }));

    // 300 m away with a 120 m uncertainty: dropped without becoming the
    // reference for the next speed reading.
    assert.equal(filter.push(fixAt({ north: 300, accuracy: 120, time: T0 + 1000 })).reason, 'accuracy');

    const back = filter.push(fixAt({ north: 10, time: T0 + 2000 }));
    assert.equal(back.accepted, true);
    assert.ok(back.speedKmh < 40, `speed ${back.speedKmh} km/h must stay near the ride`);
  });

  await check('drift while standing still is not recorded', () => {
    const filter = createGpsFilter('run');
    filter.push(fixAt({ time: T0 }));

    for (let i = 1; i <= 5; i += 1) {
      const drift = filter.push(fixAt({ north: 0.4 * (i % 2), time: T0 + i * 1000 }));
      assert.equal(drift.reason, 'distance');
    }
    assert.equal(filter.points.length, 1);
  });

  await check('a repeated or backwards timestamp is dropped', () => {
    const filter = createGpsFilter('cycling');
    filter.push(fixAt({ time: T0 }));
    assert.equal(filter.push(fixAt({ north: 8, time: T0 })).reason, 'stale');
    assert.equal(filter.push(fixAt({ north: 8, time: T0 - 500 })).reason, 'stale');
  });

  await check('smoothing calms the jitter of a straight line', () => {
    const filter = createGpsFilter('run');
    const raw = [fixAt({ north: 0, time: T0 })];
    filter.push(raw[0]);

    for (let i = 1; i <= 10; i += 1) {
      const fix = fixAt({ north: i * 4, east: i % 2 === 0 ? 1.6 : -1.6, time: T0 + i * 1000 });
      raw.push(fix);
      assert.equal(filter.push(fix).accepted, true);
    }

    const smoothedLateral = Math.max(...filter.points.map(eastMeters));
    const rawLateral = Math.max(...raw.map(eastMeters));
    assert.ok(
      smoothedLateral < rawLateral * 0.7,
      `smoothed ${smoothedLateral.toFixed(2)} m should be well under raw ${rawLateral.toFixed(2)} m`,
    );
    assert.ok(smoothedLateral > 0, 'the smoothing should not flatten the line into a single axis');

    const smoothedLength = pathLength(filter.points);
    assert.ok(
      smoothedLength <= pathLength(raw) + 0.5,
      `smoothed ${smoothedLength.toFixed(1)} m must not be longer than raw ${pathLength(raw).toFixed(1)} m`,
    );
  });

  await check('a sharp corner is followed instead of being cut', () => {
    const filter = createGpsFilter('cycling');
    filter.push(fixAt({ time: T0 }));
    for (let i = 1; i <= 5; i += 1) {
      filter.push(fixAt({ north: i * 10, time: T0 + i * 1000 }));
    }

    // 36 km/h up the road, then a 90° turn onto the cross street.
    const turn = fixAt({ north: 60, east: 10, time: T0 + 6000 });
    const result = filter.push(turn);
    assert.equal(result.accepted, true);

    const covered = turfDistance(
      [result.point.lng, result.point.lat],
      [turn.lng, turn.lat],
      { units: 'meters' },
    );
    assert.ok(covered < 14.2 * 0.25, `the corner was cut by ${covered.toFixed(1)} m`);
  });

  await check('smoothing weight grows with the offset from the last fix', () => {
    assert.ok(smoothingAlpha(1, 5) < smoothingAlpha(10, 5));
    assert.ok(smoothingAlpha(10, 5) <= smoothingAlpha(60, 5));
    assert.ok(smoothingAlpha(0, 0) > 0 && smoothingAlpha(0, 0) < 0.5);
  });

  await check('elevation noise on a flat road adds no climb', () => {
    const flat = [100, 101, 99.5, 100.5, 99.8, 100.2, 100.1, 99.9, 100.4, 99.6];
    assert.equal(smoothedElevationGain(flat), 0);
  });

  await check('a real climb is still counted through the deadband', () => {
    const climb = Array.from({ length: 51 }, (_, index) => 100 + index);
    const gain = smoothedElevationGain(climb);
    assert.ok(gain >= 45 && gain <= 51, `climb gain ${gain} should be close to 50 m`);

    const noisyClimb = Array.from(
      { length: 41 },
      (_, index) => 100 + index * 0.5 + (index % 2 === 0 ? 3 : -3),
    );
    const noisyGain = smoothedElevationGain(noisyClimb);
    assert.ok(
      noisyGain >= 12 && noisyGain <= 22,
      `noisy 20 m climb gain ${noisyGain} should stay near 20 m`,
    );
  });

  await check('the recorded elevation gain uses the smoothed sum', () => {
    const filter = createGpsFilter('hike');
    for (let i = 0; i <= 20; i += 1) {
      filter.push(
        fixAt({
          north: i * 5,
          altitude: 500 + i * 2 + (i % 2 === 0 ? 1.5 : -1.5),
          time: T0 + i * 1000,
        }),
      );
    }
    const gain = filter.elevationGainMeters;
    assert.ok(gain >= 30 && gain <= 42, `filter gain ${gain} should be close to 40 m`);
  });

  await check('auto-pause thresholds match the sport', () => {
    assert.equal(autoPauseSpeedKmh('cycling'), 2.5);
    assert.equal(autoPauseSpeedKmh('run'), 1.5);
    assert.equal(autoPauseSpeedKmh('walking'), 1.5);
    assert.equal(AUTO_PAUSE_HOLD_MS, 5000);
  });

  await check('auto-pause triggers after five seconds below the threshold', () => {
    const tracker = createAutoPauseTracker('cycling');
    assert.equal(tracker.update(18, T0).state, 'moving');
    assert.equal(tracker.update(0.8, T0 + 1000).state, 'holding');
    assert.equal(tracker.update(0.8, T0 + 4000).paused, false);

    const paused = tracker.update(0.8, T0 + 6000);
    assert.equal(paused.paused, true);
    assert.equal(paused.changed, true);
    assert.equal(tracker.paused, true);
  });

  await check('auto-pause resumes once the speed passes the resume threshold', () => {
    const tracker = createAutoPauseTracker('cycling');
    tracker.update(0.5, T0);
    assert.equal(tracker.update(0.5, T0 + 5000).paused, true);

    // 2.0 km/h is still inside the hysteresis band, so the pause holds.
    assert.equal(tracker.update(2.0, T0 + 6000).paused, true);
    assert.equal(tracker.update(3.0, T0 + 7000).paused, true);

    const resumed = tracker.update(3.6, T0 + 8000);
    assert.equal(resumed.paused, false);
    assert.equal(resumed.changed, true);
    assert.equal(tracker.state, 'moving');
  });

  await check('a short burst above the threshold resets the hold timer', () => {
    const tracker = createAutoPauseTracker('run');
    assert.equal(tracker.update(0.5, T0).state, 'holding');
    assert.equal(tracker.update(5, T0 + 1000).state, 'moving');
    assert.equal(tracker.update(0.5, T0 + 2000).state, 'holding');
    assert.equal(tracker.update(0.5, T0 + 6500).paused, false);
    assert.equal(tracker.update(0.5, T0 + 7000).paused, true);
  });

  await check('a stationary session pauses and records no drift', () => {
    const filter = createGpsFilter('run');
    const tracker = createAutoPauseTracker('run');

    filter.push(fixAt({ time: T0, speed: 0 }));
    let pausedAt = null;

    for (let i = 1; i <= 8; i += 1) {
      const time = T0 + i * 1000;
      const result = filter.push(fixAt({ north: 0.2 * (i % 2), speed: 0.1, time }));
      const update = tracker.update(result.speedKmh, time);
      if (update.paused && pausedAt === null) pausedAt = time;
    }

    assert.equal(pausedAt, T0 + 6000);
    assert.equal(filter.points.length, 1, 'drift fixes must not be appended');
  });

  await check('movement after an auto-pause resumes the session', () => {
    const filter = createGpsFilter('cycling');
    const tracker = createAutoPauseTracker('cycling');

    filter.push(fixAt({ time: T0, speed: 0 }));
    assert.equal(tracker.update(0, T0 + 1000).state, 'holding');
    assert.equal(tracker.update(0, T0 + 6000).paused, true);

    // The athlete starts pedalling again; the next fixes carry real speed.
    let resumed = false;
    for (let i = 7; i <= 10; i += 1) {
      const time = T0 + i * 1000;
      const result = filter.push(fixAt({ north: (i - 6) * 6, speed: 6, time }));
      const update = tracker.update(result.speedKmh, time);
      if (!update.paused) resumed = true;
    }

    assert.equal(resumed, true);
    assert.ok(filter.points.length >= 2, 'the moving fixes are recorded again');
  });
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

for (const line of results) console.log(line);
console.log(process.exitCode ? 'GPS filter tests FAILED' : 'GPS filter tests passed');
