/**
 * Asset geometry guardrail — checks that `assets/manifest.ts` is an **exact copy** of
 * `geometry.json`.
 *
 * Why it's needed: the source of truth for the characters' measured values (sprite size, body
 * center, hitboxes, marker lengths) is the single file
 * `public/assets/characters/geometry.json`, but what the game code reads is the TypeScript
 * manifest. If the two drift apart, the types still pass — only the numbers changed. The result is
 * a silent detection bug like "the whip doesn't reach yet it lands". Hence this runs ahead of
 * CI/typecheck.
 *
 * This pair of files is now the only mirrored relationship left: the simulation's tick constants
 * are derived from the manifest too (SWING_TICKS and friends in game/simulation.ts).
 *
 * Run it with: `node scripts/check-geometry.mjs` (no dependencies — it imports the manifest
 * directly via Node >= 22.18's .ts type stripping. It breaks if the manifest uses syntax that
 * can't be stripped, such as enum).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const MANIFEST_URL = new URL('packages/client/src/assets/manifest.ts', ROOT);
const GEOMETRY_URL = new URL('packages/client/public/assets/characters/geometry.json', ROOT);

/**
 * Derived values that exist only in the manifest — they can't be found at the same path in
 * geometry.json and have to be computed.
 * (Marker length → tick constant. A marker in geometry.json is a `[startFrame, length]` pair.)
 *
 * The key is `character.field`, and the function receives **that character's** geometry object
 * (every derived value sits directly under a character).
 */
const DERIVED = {
  'player.swingTicks': (g) => g.markers.swing[1],
  'target.hitReactionTicks': (g) => g.markers.hit[1],
  'target.flinchTicks': (g) => g.markers.flinch[1],
};

/** Non-geometry fields — file paths and marker **names** are not compared here */
const SKIP_KEYS = new Set(['lottie', 'markers']);

const problems = [];

function fail(path, actual, expected) {
  problems.push(`${path}: manifest ${format(actual)} ≠ geometry ${format(expected)}`);
}

function format(value) {
  return value === undefined ? '(missing)' : JSON.stringify(value);
}

/**
 * Walks every numeric leaf of the manifest and compares it with the same path in geometry.json.
 *
 * ⚠️ The walk goes in **one direction only: manifest → geometry**. Values that exist only in
 * geometry.json say nothing (e.g. `tip` — a reference coordinate used while measuring the
 * hitboxes, which the code never reads). Conversely, **if you add a new number to the manifest,
 * the same path must exist in geometry.json**: if it derives from a marker length, add a rule to
 * DERIVED above; if it was measured from the asset but can't be derived from a marker length
 * (like walkLoopFrames — the walk cycle period measured via pixel diff), add it to geometry.json
 * under the same name. geometry.json is the source of truth for measured values.
 */
function compareNumbers(manifest, geometry, path) {
  for (const [key, value] of Object.entries(manifest)) {
    if (SKIP_KEYS.has(key)) continue;
    const childPath = path === '' ? key : `${path}.${key}`;

    if (typeof value === 'number') {
      const derive = DERIVED[childPath];
      const expected = derive ? derive(geometry) : geometry?.[key];
      if (value !== expected) fail(childPath, value, expected);
      continue;
    }
    if (value !== null && typeof value === 'object') {
      // A derived path can be an object too (like swingActive — if geometry has the same name we just descend into it)
      compareNumbers(value, geometry?.[key], childPath);
    }
  }
}

/** Marker mapping check: the name sets must match, and each manifest value must equal its key (= the real Lottie marker name) */
function compareMarkers(character, manifest, geometry) {
  const manifestNames = Object.keys(manifest);
  const geometryNames = Object.keys(geometry);

  for (const name of manifestNames) {
    if (!geometryNames.includes(name)) {
      problems.push(`${character}.markers.${name}: only in the manifest (a marker the asset does not have)`);
    }
    if (manifest[name] !== name) {
      problems.push(
        `${character}.markers.${name}: value is '${manifest[name]}' — it must equal the key (the Lottie marker name)`,
      );
    }
  }
  for (const name of geometryNames) {
    if (!manifestNames.includes(name)) {
      problems.push(`${character}.markers.${name}: only in geometry.json (no mapping in the manifest)`);
    }
  }
}

// The manifest is imported as .ts directly — this leans on Node's type stripping, so on an older
// runtime it blows up here with a syntax error. In that case we spell out the cause so it doesn't
// read as "the manifest is broken" (package.json engines declares the same lower bound).
let CHARACTER_ASSETS;
try {
  ({ CHARACTER_ASSETS } = await import(MANIFEST_URL.href));
} catch (error) {
  console.error('Could not read the manifest — Node >= 22.18 is required (.ts type stripping).');
  console.error(`  Node currently running: ${process.version}`);
  console.error(`  Original error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const geometry = JSON.parse(await readFile(GEOMETRY_URL, 'utf8'));

for (const character of Object.keys(CHARACTER_ASSETS)) {
  const manifest = CHARACTER_ASSETS[character];
  const expected = geometry[character];
  if (!expected) {
    problems.push(`${character}: this character is not in geometry.json`);
    continue;
  }
  compareNumbers(manifest, expected, character);
  compareMarkers(character, manifest.markers, expected.markers);
}

if (problems.length > 0) {
  console.error('Asset geometry mismatch — manifest.ts and geometry.json have drifted apart:');
  for (const problem of problems) console.error(`  · ${problem}`);
  console.error(
    `\nThe source of truth is ${fileURLToPath(GEOMETRY_URL)}. If you rebuilt the assets, update both.`,
  );
  process.exit(1);
}

console.log(
  `[check-geometry] ok — geometry/markers match for ${Object.keys(CHARACTER_ASSETS).join(', ')}`,
);
