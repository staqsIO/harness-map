/**
 * Cross-check every reason/warning string the scanner can produce against the
 * closed set the gate accepts.
 *
 * note() is an enumeration, which is what makes it airtight — but it also means a
 * reason added to the scanner and not to KNOWN_NOTES is silently withheld, and an
 * unconfigured layer whose reason is null explains nothing to the user.
 *
 * The fixture suite only catches this for paths a fixture happens to exercise.
 * This reads the scanner's SOURCE, extracts every literal it passes to
 * unconfigured() / reject() / reason:, and asserts the gate accepts it — so a new
 * reason fails here the moment it is written, whether or not a fixture reaches it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gate, DOCUMENT } from '../scripts/emit-schema.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'scripts', 'scan-harness.mjs'), 'utf8');

let pass = 0;
let fail = 0;
const check = (cond, name) => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
};

console.log('[note coverage]');

// Literals passed to unconfigured('…') / reject('…') / reason: '…'.
const literals = new Set();
for (const re of [
  /unconfigured\(\s*'([^']+)'/g,
  /unconfigured\(\s*\n?\s*'([^']+)'/g,
  /reject\('([^']+)'\)/g,
  /reason:\s*'([^']+)'/g,
]) {
  for (const m of src.matchAll(re)) literals.add(m[1]);
}

// Template literals: `duplicate key '${key}'` → the stripKey'd form the gate sees.
for (const m of src.matchAll(/reject\(`([^`]+)`\)/g)) {
  literals.add(m[1].replace(/\s*\('\$\{[^}]+\}'\)/g, '').replace(/\s*'\$\{[^}]+\}'/g, '').trim());
}
// `non-scalar value for ${…}` → stripKey removes the trailing " for …".
for (const m of src.matchAll(/`(non-scalar value) for \$\{/g)) literals.add(m[1]);

check(literals.size >= 12, `extracted ${literals.size} reason strings from the scanner`);

const accepted = (s) => gate(
  { layers: { agents: { status: 'unconfigured', reason: s } } },
  DOCUMENT, { prose: false },
).layers.agents.reason === s;

const missing = [...literals].filter((s) => !accepted(s));
check(missing.length === 0, 'every reason the scanner can emit is accepted by note()');
for (const m of missing) console.log(`        not in KNOWN_NOTES: ${JSON.stringify(m)}`);

// The scan-error shape, which is generated rather than literal.
check(accepted('failed to scan agents (EACCES)'), 'a scan error with an errno is accepted');
check(accepted('failed to scan mcp (unknown error)'), 'a scan error with no errno code is accepted');
check(!accepted('failed to scan agents: ENOENT: open /Users/me/x'),
  'a scan error carrying a filesystem path is still withheld');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
