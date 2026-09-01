// Validates meta.json before it is ever uploaded.
//
//   node tools/check-meta.mjs
//
// The Creator Console is forgiving in the worst way: a missing title becomes a
// default and an over-long one is silently clamped to 50 characters rather than
// rejected, so a bad field shows up as a wrong-looking listing, not an error.
// This checks the things the backend will not tell you about, and cross-checks
// the declared config against the keys the game actually reads.
import { readFile } from 'node:fs/promises';

const VALUE_TYPES = new Set(['string', 'number', 'boolean', 'color']);
const SORTINGS = new Set(['highestScore', 'lowestScore']);
const TITLE_MAX = 50;
// The console composes controls + logic + description and clamps the result.
// Over the limit it truncates mid-sentence rather than rejecting, so the only
// symptom is a listing that stops in the middle of a word.
const DESCRIPTION_MAX = 2500;

const problems = [];
const notes = [];
const fail = (m) => problems.push(m);
const warn = (m) => notes.push(m);

const meta = JSON.parse(await readFile('meta.json', 'utf8'));

for (const key of ['schemaVersion', 'title', 'description', 'resultSorting']) {
  if (meta[key] === undefined) fail(`missing required field: ${key}`);
}
if (typeof meta.title === 'string' && meta.title.length > TITLE_MAX) {
  fail(`title is ${meta.title.length} chars; the backend clamps to ${TITLE_MAX} without telling you`);
}
const composed = [meta.controls, meta.logic, meta.description]
  .filter(Boolean).join('\n\n');
if (composed.length > DESCRIPTION_MAX) {
  fail(`controls + logic + description is ${composed.length} chars; the console clamps to ${DESCRIPTION_MAX} and truncates mid-sentence`);
} else if (composed.length > DESCRIPTION_MAX - 100) {
  warn(`composed description is ${composed.length} chars, close to the ${DESCRIPTION_MAX} clamp`);
}
if (meta.resultSorting && !SORTINGS.has(meta.resultSorting)) {
  fail(`resultSorting "${meta.resultSorting}" is not one of ${[...SORTINGS].join(', ')}`);
}

const declared = new Set();
for (const c of meta.config ?? []) {
  const at = `config["${c.key}"]`;
  if (!c.key) { fail('a config entry has no key'); continue; }
  if (declared.has(c.key)) fail(`${at} is declared twice`);
  declared.add(c.key);
  if (c.key === 'userData') fail(`${at} uses the reserved key "userData"`);
  if (!VALUE_TYPES.has(c.valueType)) fail(`${at} has valueType "${c.valueType}"`);
  if (c.value === undefined) fail(`${at} has no default value`);

  const t = typeof c.value;
  if (c.valueType === 'number' && t !== 'number') fail(`${at} default should be a number, got ${t}`);
  if (c.valueType === 'boolean' && t !== 'boolean') fail(`${at} default should be a boolean, got ${t}`);
  if ((c.valueType === 'string' || c.valueType === 'color') && t !== 'string') {
    fail(`${at} default should be a string, got ${t}`);
  }
  if (c.valueType === 'number') {
    if (c.min !== undefined && c.value < c.min) fail(`${at} default ${c.value} is below min ${c.min}`);
    if (c.max !== undefined && c.value > c.max) fail(`${at} default ${c.value} is above max ${c.max}`);
  }
  if (c.range && !c.range.includes(c.value)) {
    fail(`${at} default "${c.value}" is not in its range [${c.range.join(', ')}]`);
  }
  if (!c.description) warn(`${at} has no description; players configuring a post see nothing`);
}

// Cross-check: every key the game reads must be declared, and every declared key
// must be read. A key in only one place is silently ignored at runtime.
const source = await readFile('scripts/main.gd', 'utf8');
const read = new Set(
  [...source.matchAll(/get_config_value\(\s*"([^"]+)"/g)].map(m => m[1]));

for (const key of read) {
  if (!declared.has(key)) fail(`the game reads config "${key}" but meta.json does not declare it`);
}
for (const key of declared) {
  if (!read.has(key)) fail(`meta.json declares config "${key}" but the game never reads it`);
}

for (const n of notes) console.warn(`  warn: ${n}`);
if (problems.length) {
  for (const p of problems) console.error(`  FAIL: ${p}`);
  console.error(`\nmeta.json has ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`  meta.json ok - ${declared.size} config keys, all read by the game`);
