#!/usr/bin/env node
/**
 * Unit tests for the GPX import parser and the GPX export generator
 * (`src/lib/gpx.ts`).
 *
 * The real source is transpiled on the fly; nothing is mocked, because the
 * parser is deliberately DOM-free so the same code runs in the Android WebView
 * and in Node.
 *
 * Usage: node scripts/gpx.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// Inside the project so the bare `@turf/turf` import in valhalla.ts resolves.
const tempDir = await mkdtemp(path.join(root, 'scripts', '.gpx-test-'));

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

await transpile('polyline');
await transpile('routeCoordinates');
await transpile('valhalla');
await transpile('gpx');

const {
  parseGpx,
  buildGpx,
  gpxFileName,
  readGpxFile,
  looksLikeGpx,
  isGpxFileName,
} = await import(pathToFileURL(path.join(tempDir, 'gpx.mjs')).href);

const TRACK_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garmin Connect"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata>
    <name>Bukit Cinta Loop &amp; Ridge</name>
  </metadata>
  <trk>
    <name>Track name</name>
    <trkseg>
      <trkpt lat="-7.250445" lon="112.768845">
        <ele>12.5</ele>
        <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>142</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>
      </trkpt>
      <trkpt lat="-7.251000" lon="112.769000"><ele>18</ele></trkpt>
      <trkpt lat="-7.252000" lon="112.770000" />
    </trkseg>
  </trk>
</gpx>`;

const NAMESPACED_ROUTE_GPX = `<?xml version="1.0"?>
<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1" version="1.1">
  <gpx:rte>
    <gpx:name>Rute Bersama</gpx:name>
    <gpx:rtept lat="-6.914744" lon="107.609810"><gpx:ele>768</gpx:ele></gpx:rtept>
    <gpx:rtept lat="-6.920000" lon="107.615000"><gpx:ele>800</gpx:ele></gpx:rtept>
  </gpx:rte>
</gpx:gpx>`;

const WAYPOINT_GPX = `<gpx version="1.1"><wpt lat="1.5" lon="2.5"/><wpt lat="1.6" lon="2.6"/></gpx>`;

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

const closeTo = (actual, expected, epsilon = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} ≈ ${expected}`,
  );

try {
  await check('parses trkpt points into [lng, lat, ele] with the metadata name', () => {
    const parsed = parseGpx(TRACK_GPX);
    assert.equal(parsed.coordinates.length, 3);
    assert.equal(parsed.name, 'Bukit Cinta Loop & Ridge');

    const [lng, lat, ele] = parsed.coordinates[0];
    closeTo(lng, 112.768845);
    closeTo(lat, -7.250445);
    closeTo(ele, 12.5);
    assert.deepEqual(parsed.coordinates[2], [112.77, -7.252, 0]);
  });

  await check('accepts namespace-prefixed gpx/rtept elements', () => {
    const parsed = parseGpx(NAMESPACED_ROUTE_GPX);
    assert.equal(parsed.coordinates.length, 2);
    assert.equal(parsed.name, 'Rute Bersama');
    closeTo(parsed.coordinates[1][0], 107.615);
    closeTo(parsed.coordinates[1][1], -6.92);
    closeTo(parsed.coordinates[1][2], 800);
  });

  await check('falls back to wpt when there is no track or route', () => {
    const parsed = parseGpx(WAYPOINT_GPX);
    assert.equal(parsed.coordinates.length, 2);
    assert.equal(parsed.name, null);
    assert.deepEqual(parsed.coordinates[0], [2.5, 1.5, 0]);
  });

  await check('prefers trkpt over waypoints in the same document', () => {
    const parsed = parseGpx(`<gpx>
      <wpt lat="1.1" lon="2.1"/>
      <wpt lat="1.2" lon="2.2"/>
      <trk><trkseg>
        <trkpt lat="-7.1" lon="112.1"/>
        <trkpt lat="-7.2" lon="112.2"/>
        <trkpt lat="-7.3" lon="112.3"/>
      </trkseg></trk>
    </gpx>`);
    assert.equal(parsed.coordinates.length, 3);
    assert.deepEqual(parsed.coordinates[0], [112.1, -7.1, 0]);
  });

  await check('rejects a file without a <gpx> root', () => {
    assert.throws(() => parseGpx('<html><body>Bukan rute</body></html>'), /bukan GPX/i);
    assert.throws(() => parseGpx('   '), /kosong/i);
  });

  await check('reports a GPX without any coordinate point', () => {
    assert.throws(
      () => parseGpx('<gpx version="1.1"><metadata><name>Kosong</name></metadata></gpx>'),
      /tidak memiliki titik koordinat/i,
    );
  });

  await check('reports a GPX whose points are all out of range', () => {
    assert.throws(
      () =>
        parseGpx(
          '<gpx><trkpt lat="120" lon="10"/><trkpt lat="130" lon="11"/></gpx>',
        ),
      /minimal 2 titik/i,
    );
  });

  await check('looksLikeGpx / isGpxFileName accept namespaced roots and .gpx', () => {
    assert.equal(looksLikeGpx(TRACK_GPX), true);
    assert.equal(looksLikeGpx('<gpx:gpx xmlns:gpx="x"/>'), true);
    assert.equal(looksLikeGpx('<kml/>'), false);
    assert.equal(isGpxFileName('Rute Pagi.GPX'), true);
    assert.equal(isGpxFileName('rute.kml'), false);
  });

  await check('buildGpx writes a GPX 1.1 track with escaped name and metadata', () => {
    const xml = buildGpx(
      'Rute <Pagi> & Sore',
      [
        [112.768845, -7.250445, 12.5],
        [112.77, -7.252, 18],
      ],
      {
        sportType: 'cycling',
        distanceMeters: 1520.4,
        elevationGainMeters: 42.2,
        durationSeconds: 900,
      },
    );

    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<gpx version="1\.1"/);
    assert.match(xml, /xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1"/);
    assert.match(xml, /<name>Rute &lt;Pagi&gt; &amp; Sore<\/name>/);
    assert.match(xml, /<type>cycling<\/type>/);
    assert.match(xml, /<allmova:distance_meters>1520<\/allmova:distance_meters>/);
    assert.match(xml, /<allmova:elevation_gain_meters>42<\/allmova:elevation_gain_meters>/);
    assert.match(xml, /<allmova:duration_seconds>900<\/allmova:duration_seconds>/);
    assert.match(xml, /<trkpt lat="-7\.2504450" lon="112\.7688450"><ele>12\.5<\/ele><\/trkpt>/);
  });

  await check('buildGpx drops invalid coordinates and keeps elevations finite', () => {
    const xml = buildGpx('Uji', [
      [112.7, -7.2, Number.NaN],
      [Number.NaN, -7.3, 10],
      [112.8, -7.4, 20],
    ]);
    const points = xml.match(/<trkpt /g) ?? [];
    assert.equal(points.length, 2);
    assert.match(xml, /<ele>0\.0<\/ele>/);
    assert.match(xml, /<ele>20\.0<\/ele>/);
  });

  await check('buildGpx → parseGpx round-trips the track', () => {
    // `<ele>` is written with one decimal, so the fixtures use one decimal too.
    const coordinates = [
      [112.768845, -7.250445, 12.5],
      [112.7691, -7.2509, 18.3],
      [112.7702, -7.2521, 24.8],
    ];
    const parsed = parseGpx(buildGpx('Rute Uji', coordinates));
    assert.equal(parsed.coordinates.length, 3);
    assert.equal(parsed.name, 'Rute Uji');
    coordinates.forEach((expected, index) => {
      const actual = parsed.coordinates[index];
      closeTo(actual[0], expected[0], 1e-6);
      closeTo(actual[1], expected[1], 1e-6);
      closeTo(actual[2], expected[2], 1e-6);
    });
  });

  await check('gpxFileName slugs the title and never returns an empty name', () => {
    assert.equal(gpxFileName('Rute Pagi  Senin!'), 'rute-pagi-senin.gpx');
    assert.equal(gpxFileName('   '), 'route.gpx');
    assert.equal(gpxFileName('Bukit Cinta / Ridge'), 'bukit-cinta-ridge.gpx');
  });

  await check('readGpxFile rejects a non-GPX file with a clear message', async () => {
    const file = new File(['{"type":"FeatureCollection"}'], 'rute.json', {
      type: 'application/json',
    });
    await assert.rejects(() => readGpxFile(file), /bukan file GPX/i);
  });

  await check('readGpxFile accepts a GPX picked with a generic MIME type', async () => {
    const file = new File([TRACK_GPX], 'track.gpx', {
      type: 'application/octet-stream',
    });
    const parsed = await readGpxFile(file);
    assert.equal(parsed.coordinates.length, 3);
  });

  await check('readGpxFile accepts a valid GPX renamed to .xml', async () => {
    const file = new File([WAYPOINT_GPX], 'track.xml', { type: 'text/xml' });
    const parsed = await readGpxFile(file);
    assert.equal(parsed.coordinates.length, 2);
  });
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log(results.join('\n'));
console.log(`\n${results.length} checks, ${results.filter((line) => line.startsWith('FAIL')).length} failed`);
