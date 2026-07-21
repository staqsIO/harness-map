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

// --- prototype safety -------------------------------------------------------
// The map emitters build keys from input, so a crafted key must not be able to
// reach an object's prototype.
const polluted = gate(
  JSON.parse('{"layers":{"agents":{"status":"ok","byModel":{"__proto__":1,"constructor":2,"sonnet":3}}}}'),
  DOCUMENT, {},
);
check(Object.getPrototypeOf({}) === Object.prototype, 'a crafted map key does not touch Object.prototype');
// `'__proto__' in obj` is true for every ordinary object via inheritance, so the
// question is whether it is an OWN property.
check(!Object.prototype.hasOwnProperty.call(polluted.layers.agents.byModel, '__proto__'),
  'a __proto__ key never becomes an own member');
check(polluted.layers.agents.byModel.sonnet === 3, 'ordinary keys alongside it still pass');

// Recursion follows the schema, not the input, so nesting cannot exhaust the stack.
let deep = {};
let cur = deep;
for (let i = 0; i < 100000; i += 1) { cur.layers = {}; cur = cur.layers; }
let survived = true;
try { gate(deep, DOCUMENT, {}); } catch { survived = false; }
check(survived, 'a 100k-deep input terminates at the declared depth');

const cyclic = { layers: { agents: { status: 'ok', items: [] } } };
cyclic.self = cyclic;
let cycOk = true;
try { gate(cyclic, DOCUMENT, {}); } catch { cycOk = false; }
check(cycOk, 'a self-referential document does not recurse forever');

// --- emitter tightness (review round 7) ------------------------------------
// The architecture held — one write path, undeclared fields dropped — but three
// emitters were individually loose enough to pass authored text through a
// DECLARED position. An emitter must carry its own guarantee and never rely on
// the scanner having already collapsed the value.
const em = (doc) => gate(doc, DOCUMENT, { prose: false });

check(em({ layers: { environment: { status: 'ok', model: 'claudeAcmeSecret' } } })
  .layers.environment.model === '<custom>',
  'a claude-prefixed non-model-id does not pass modelName');
check(em({ layers: { environment: { status: 'ok', model: 'claude-opus-4-8[1m]' } } })
  .layers.environment.model === 'claude-opus-4-8[1m]',
  'a real published model id still passes');
check(em({ layers: { hooks: { status: 'ok', items: [{ matcher: 'AcmeInternalTool' }] } } })
  .layers.hooks.items[0].matcher === '<custom>',
  'the gate rejects an unknown matcher even if the scanner did not');
check(em({ layers: { hooks: { status: 'ok', items: [{ matcher: 'Write|Edit' }] } } })
  .layers.hooks.items[0].matcher === 'Write|Edit',
  'an alternation of built-in tool names still passes');
check(em({ layers: { agents: { status: 'ok', reason: "duplicate key 'AcmeSecret'" } } })
  .layers.agents.reason === null,
  'a generated message that quotes an authored key is withheld');

// CLAUDE.md is a filename Claude Code defines, and the audit matches on it by
// name — collapsing it made the audit report that no CLAUDE.md existed.
check(em({ layers: { rules: { status: 'ok', items: [{ name: 'CLAUDE.md' }] } } })
  .layers.rules.items[0].name === 'CLAUDE.md',
  'a published filename survives so consumers can match on it');
check(em({ layers: { plugins: { status: 'ok', marketplaces: [{ name: 'marketplace-01' }] } } })
  .layers.plugins.marketplaces[0].name === 'marketplace-01',
  'the tool\'s own generated marketplace label is accepted');

// --- cardinality and inherited properties -----------------------------------
const wide = em({
  layers: { agents: { status: 'ok', items: Array.from({ length: 9000 }, () => ({ name: 'agent-01' })) } },
});
check(wide.layers.agents.items.length === 5000, 'a list is capped rather than mirroring input width');

const inherited = Object.create({ schemaVersion: 99 });
inherited.prose = false;
check(em(inherited).schemaVersion === undefined,
  'a declared field inherited from the input prototype is not accepted');

// --- emitters that were still loose in round 8 ------------------------------
check(em({ layers: { agents: { status: 'ok', items: [{ file: 'user:ACME_INTERNAL_TOKEN_VALUE' }] } } })
  .layers.agents.items[0].file === '<file>',
  'a scope prefix followed by non-path text does not pass as a path');
// In default mode the policy has already replaced the basename with a generated
// label, so `user:agents/foo.md` — an authored basename — must NOT pass.
check(em({ layers: { agents: { status: 'ok', items: [{ file: 'user:agents/agent-07.md' }] } } })
  .layers.agents.items[0].file === 'user:agents/agent-07.md',
  'a generated root-relative path still passes');
check(em({ layers: { agents: { status: 'ok', items: [{ file: 'user:agents/foo.md' }] } } })
  .layers.agents.items[0].file === '<file>',
  'a path carrying an authored basename is replaced');
check(em({ layers: { agents: { status: 'ok', items: [{ file: 'user:settings.json' }] } } })
  .layers.agents.items[0].file === 'user:settings.json',
  'a published config filename still passes');
check(em({ layers: { environment: { status: 'ok', model: 'CLAUDE-ACME-SECRET' } } })
  .layers.environment.model === '<custom>',
  'an uppercase claude-prefixed string is not treated as a model id');
check(em({ layers: { agents: { status: 'ok', reason: 'ACME internal note about a customer' } } })
  .layers.agents.reason === null,
  'note is a closed set: arbitrary quote-free prose does not pass');
check(em({ layers: { agents: { status: 'unconfigured', reason: 'no agents/*.md with frontmatter found' } } })
  .layers.agents.reason === 'no agents/*.md with frontmatter found',
  'a reason this tool generates does pass');
check(em({ layers: { agents: { status: 'error', reason: 'failed to scan agents (EACCES)' } } })
  .layers.agents.reason === 'failed to scan agents (EACCES)',
  'a scan error carries the layer and errno');
check(em({ layers: { agents: { status: 'error',
  reason: "failed to scan agents: ENOENT: no such file or directory, open /Users/me/secret" } } })
  .layers.agents.reason === null,
  'an fs error message carrying an absolute path is withheld');
check(em({ layers: { agents: { status: 'ok', items: [{ name: 'agent-10000' }] } } })
  .layers.agents.items[0].name === 'agent-10000',
  'a generated label past four digits is still recognised');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
