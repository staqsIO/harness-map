/**
 * Unit tests for the emit schema — the property the rest of the suite cannot
 * check by fixture, because it is about fields that do NOT exist yet.
 *
 * The scanner's own tests can only assert on fields the scanner currently emits.
 * The whole point of the gate is what happens to a field added LATER, so these
 * tests feed the gate documents containing fields no scanner produces and assert
 * they are absent from the result.
 */
import { gate, DOCUMENT } from '../scripts/emit-schema.mjs';

let pass = 0;
let fail = 0;
const check = (cond, name) => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
};

console.log('[emit schema]');

// --- deny by default -------------------------------------------------------
const withUnknowns = {
  schemaVersion: 2,
  CLIENT_TOP_LEVEL_SECRET: 'leak',
  layers: {
    agents: {
      status: 'ok',
      count: 1,
      CLIENT_LAYER_SECRET: 'leak',
      items: [{ name: 'agent-01', model: 'sonnet', CLIENT_ITEM_SECRET: 'leak' }],
    },
    CLIENT_LAYER_NAME_SECRET: { status: 'ok', items: [] },
  },
};
const gated = gate(withUnknowns, DOCUMENT, { prose: false });
const asText = JSON.stringify(gated);

check(!asText.includes('CLIENT_TOP_LEVEL_SECRET'), 'an undeclared top-level field is dropped');
check(!asText.includes('CLIENT_LAYER_SECRET'), 'an undeclared field inside a layer is dropped');
check(!asText.includes('CLIENT_ITEM_SECRET'), 'an undeclared field inside a list item is dropped');
check(!asText.includes('CLIENT_LAYER_NAME_SECRET'), 'an undeclared whole layer is dropped');
check(!asText.includes('leak'), 'no undeclared value survives anywhere');
check(gated.layers.agents.items[0].name === 'agent-01', 'declared fields still pass through');

// --- each emitter refuses the wrong shape ----------------------------------
const hostile = gate({
  schemaVersion: 'not-a-number',
  redacted: 'yes',
  layers: {
    agents: {
      status: 'CLIENT_STATUS',
      count: 'CLIENT_COUNT',
      items: [{
        name: 'CLIENT_NAME', model: 'CLIENT_MODEL', description: 'CLIENT_DESC',
        scope: 'CLIENT_SCOPE', file: '/Users/someone/secret/path.md',
      }],
      byModel: { CLIENT_MODEL_KEY: 3 },
    },
    hooks: {
      status: 'ok',
      items: [{ event: 'CLIENT_EVENT', matcher: 'CLIENT MATCHER!', type: 'CLIENT_TYPE' }],
      byEvent: { CLIENT_EVENT_KEY: 1 },
    },
    environment: {
      status: 'ok',
      model: 'CLIENT_MODEL',
      env: { CLIENT_ENV_KEY: 'CLIENT_ENV_VALUE', DISABLE_TELEMETRY: 'CLIENT_VALUE' },
      permissions: { toolBreakdown: { CLIENT_TOOL: 2 } },
    },
  },
}, DOCUMENT, { prose: false });
const hostileText = JSON.stringify(hostile);

check(!/CLIENT/.test(hostileText), 'no authored string survives any declared position');
check(hostile.schemaVersion === null, 'a non-numeric count becomes null, not the string');
check(hostile.layers.agents.status === '<custom>', 'an unknown status collapses to a placeholder');
check(hostile.layers.agents.items[0].file === '<file>', 'an absolute path is replaced');
check(hostile.layers.agents.items[0].description === null, 'authored description is withheld by default');
check(hostile.layers.environment.env.DISABLE_TELEMETRY === '<hidden>',
  'an allowlisted env key still hides a non-numeric value');

// --- prose mode restores names but not the shape rules ---------------------
const prosed = gate({
  layers: { agents: { status: 'ok', items: [{ name: 'my-agent', description: 'text' }] } },
}, DOCUMENT, { prose: true });
check(prosed.layers.agents.items[0].name === 'my-agent', '--include-prose restores authored names');
check(prosed.layers.agents.items[0].description === 'text', '--include-prose restores descriptions');

const prosedUnknown = gate({ CLIENT_SECRET: 'x', layers: {} }, DOCUMENT, { prose: true });
check(!JSON.stringify(prosedUnknown).includes('CLIENT_SECRET'),
  'even --include-prose cannot introduce an undeclared field');

// --- structural robustness --------------------------------------------------
check(JSON.stringify(gate(null, DOCUMENT, {})) === 'null', 'a null document does not throw');
check(Array.isArray(gate({ sources: 'nope' }, DOCUMENT, {}).sources),
  'a scalar where a list is declared becomes an empty list');
check(gate({ layers: { agents: { status: 'ok', items: [null, { name: 'agent-01' }] } } },
  DOCUMENT, {}).layers.agents.items.length === 1, 'null list elements are dropped');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
