#!/usr/bin/env node
/**
 * audit-harness.mjs — grade a harness scan against falsifiable checks.
 *
 * Every check is a named assertion that returns pass, fail, or n/a with concrete
 * evidence. There is no composite score and no weighting: the headline is simply
 * "N of M applicable checks pass", because any weighted 0-100 number would be
 * this author's judgment dressed up as measurement.
 *
 * A check that cannot apply (no agents defined, so no agent checks) is n/a, not a
 * failure — that is what keeps the ratio honest across very different configs.
 *
 * Consumes only the scan document; it does no filesystem work of its own, so the
 * scanner's redaction holds.
 *
 * Usage: node audit-harness.mjs --scan scan.json [--json] [--quiet]
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const scanPath = arg('--scan');
const asJson = argv.includes('--json');

if (!scanPath) {
  process.stdout.write('usage: audit-harness.mjs --scan <scan.json> [--json]\n');
  process.exit(1);
}

let scan;
try { scan = JSON.parse(readFileSync(scanPath, 'utf8')); }
catch (e) { process.stderr.write(`audit: cannot read scan: ${e.message}\n`); process.exit(1); }

const L = scan.layers ?? {};
const okLayer = (n) => L[n]?.status === 'ok';

const PASS = 'pass', FAIL = 'fail', NA = 'n/a';

/**
 * A check declares:
 *   id       stable identifier, namespaced by area
 *   severity high | medium | low  (of a FAILURE; passing checks have no severity)
 *   title    the assertion, phrased so that "pass" means the assertion holds
 *   applies  false -> n/a, with a reason
 *   run      -> { status, detail, evidence[] }
 */
const CHECKS = [
  // --- model tier discipline ------------------------------------------------
  {
    id: 'agents.no-bare-inherit',
    severity: 'high',
    title: 'No agent binds to a bare `inherit` model',
    why: 'An agent on `inherit` silently adopts the session model, so a subagent written to be cheap can run at the top tier\'s price without any config change making it visible.',
    applies: () => okLayer('agents'),
    run: () => {
      const bad = L.agents.bareInherit ?? [];
      return bad.length
        ? { status: FAIL, detail: `${bad.length} agent(s) on bare inherit`, evidence: bad }
        : { status: PASS, detail: `${L.agents.count} agents, none on bare inherit` };
    },
  },
  {
    id: 'agents.model-pinned',
    severity: 'medium',
    title: 'Every agent declares a model',
    why: 'An agent with no `model:` field falls back to a default you did not choose.',
    applies: () => okLayer('agents'),
    run: () => {
      const bad = L.agents.unpinned ?? [];
      return bad.length
        ? { status: FAIL, detail: `${bad.length} agent(s) with no model field`, evidence: bad }
        : { status: PASS, detail: `all ${L.agents.count} agents pinned` };
    },
  },
  {
    id: 'agents.description-present',
    severity: 'medium',
    title: 'Every agent has a description',
    why: 'Agent selection is driven by the description; without one the agent is effectively unroutable.',
    applies: () => okLayer('agents'),
    run: () => {
      const bad = L.agents.items.filter((a) => !a.description).map((a) => a.name);
      return bad.length
        ? { status: FAIL, detail: `${bad.length} agent(s) without a description`, evidence: bad }
        : { status: PASS, detail: `all ${L.agents.count} agents described` };
    },
  },

  // --- safety ---------------------------------------------------------------
  ...[
    ['rm -rf', 'safety.guard-rm-rf', 'high', 'Recursive delete is guarded by a PreToolUse hook'],
    ['drop table', 'safety.guard-drop-table', 'high', 'DROP TABLE is guarded by a PreToolUse hook'],
    ['drop database', 'safety.guard-drop-database', 'high', 'DROP DATABASE is guarded by a PreToolUse hook'],
    ['reset --hard', 'safety.guard-reset-hard', 'medium', 'git reset --hard is guarded by a PreToolUse hook'],
    ['force push', 'safety.guard-force-push', 'high', 'Force-push is guarded by a PreToolUse hook'],
    ['secret files', 'safety.guard-secret-files', 'high', 'Writes to .env / credentials / .pem are guarded by a PreToolUse hook'],
  ].map(([key, id, severity, title]) => ({
    id, severity, title,
    why: 'A destructive operation blocked only by a written rule depends on the model remembering it. A PreToolUse hook cannot be forgotten.',
    applies: () => okLayer('hooks') && L.hooks.guards && key in L.hooks.guards,
    run: () => (L.hooks.guards[key]
      ? { status: PASS, detail: 'a PreToolUse hook matches this pattern' }
      : { status: FAIL, detail: 'no PreToolUse hook matches this pattern', evidence: ['settings.json → hooks.PreToolUse'] }),
  })),

  // --- config integrity -----------------------------------------------------
  {
    id: 'hooks.scripts-resolve',
    severity: 'high',
    title: 'Every script referenced by a hook exists on disk',
    why: 'A hook pointing at a missing script fails silently: the guard appears configured but never runs.',
    applies: () => okLayer('hooks') && (L.hooks.scriptRefs ?? []).length > 0,
    run: () => {
      const refs = L.hooks.scriptRefs;
      const missing = refs.filter((r) => !r.exists).map((r) => r.path);
      return missing.length
        ? { status: FAIL, detail: `${missing.length} of ${refs.length} hook script(s) missing`, evidence: missing }
        : { status: PASS, detail: `all ${refs.length} hook scripts resolve` };
    },
  },
  {
    id: 'statusline.script-resolves',
    severity: 'low',
    title: 'The status line script exists on disk',
    why: 'A missing status line script degrades the prompt silently.',
    applies: () => L.environment?.status === 'ok' && Boolean(L.environment.statusLine?.script),
    run: () => {
      const s = L.environment.statusLine.script;
      return s.exists
        ? { status: PASS, detail: s.path }
        : { status: FAIL, detail: 'referenced script not found', evidence: [s.path] };
    },
  },
  {
    id: 'hooks.declare-timeout',
    severity: 'low',
    title: 'Every hook declares a timeout',
    why: 'A hook without a timeout can stall a turn indefinitely.',
    applies: () => okLayer('hooks'),
    run: () => {
      const n = L.hooks.missingTimeout ?? 0;
      return n
        ? { status: FAIL, detail: `${n} of ${L.hooks.count} hooks have no timeout` }
        : { status: PASS, detail: `all ${L.hooks.count} hooks bounded` };
    },
  },

  // --- skills / routing surface ---------------------------------------------
  {
    id: 'skills.description-present',
    severity: 'medium',
    title: 'Every skill has a description',
    why: 'Skills are selected by description. One without a description can only be invoked by exact name.',
    applies: () => okLayer('skills'),
    run: () => {
      const bad = L.skills.items.filter((s) => !s.descriptionLength).map((s) => s.name);
      return bad.length
        ? { status: FAIL, detail: `${bad.length} of ${L.skills.count} skills have no description`, evidence: bad.slice(0, 12) }
        : { status: PASS, detail: `all ${L.skills.count} skills described` };
    },
  },
  {
    id: 'skills.description-substantive',
    severity: 'low',
    title: 'Skill descriptions are long enough to carry trigger phrases',
    why: 'A very short description gives the router almost nothing to match on, so the skill fires inconsistently.',
    applies: () => okLayer('skills'),
    run: () => {
      const bad = L.skills.items.filter((s) => s.descriptionLength > 0 && s.descriptionLength < 40).map((s) => s.name);
      return bad.length
        ? { status: FAIL, detail: `${bad.length} description(s) under 40 characters`, evidence: bad.slice(0, 12) }
        : { status: PASS, detail: 'all descriptions are substantive' };
    },
  },

  // --- context management ---------------------------------------------------
  {
    id: 'context.autocompact-configured',
    severity: 'low',
    title: 'An auto-compact window is set explicitly',
    why: 'Leaving it at the default means long runs compact at a point you did not choose.',
    applies: () => L.environment?.status === 'ok',
    run: () => {
      const v = L.environment.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      return v
        ? { status: PASS, detail: `set to ${v} (fires near ${Math.round(Number(v) * 0.84 / 1000)}k)` }
        : { status: FAIL, detail: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW not set' };
    },
  },

  // --- dead configuration ---------------------------------------------------
  {
    id: 'plugins.no-dead-mcp',
    severity: 'low',
    title: 'No MCP servers are stranded behind a disabled plugin',
    why: 'Servers bundled with a disabled plugin are inert. They read as available in config but never start.',
    applies: () => okLayer('mcp'),
    run: () => {
      const dead = L.mcp.items.filter((m) => m.enabled === false).map((m) => `${m.name} (${m.plugin})`);
      return dead.length
        ? { status: FAIL, detail: `${dead.length} server(s) behind a disabled plugin`, evidence: dead }
        : { status: PASS, detail: 'no stranded servers' };
    },
  },
  {
    id: 'mcp.no-duplicate-declarations',
    severity: 'low',
    title: 'No MCP server is declared in more than one place',
    why: 'Duplicate declarations make precedence ambiguous and one copy silently wins.',
    applies: () => okLayer('mcp'),
    run: () => {
      const dup = L.mcp.items.filter((m) => m.alsoDeclaredIn?.length)
        .map((m) => `${m.name}: ${[m.origin, ...m.alsoDeclaredIn].join(' + ')}`);
      return dup.length
        ? { status: FAIL, detail: `${dup.length} server(s) declared more than once`, evidence: dup }
        : { status: PASS, detail: 'each server declared once' };
    },
  },

  // --- instructions ---------------------------------------------------------
  {
    id: 'instructions.claudemd-present',
    severity: 'medium',
    title: 'A CLAUDE.md instruction file exists',
    why: 'Without one, every session starts with no project or user standing instructions.',
    applies: () => true,
    run: () => {
      const found = (L.rules?.items ?? []).some((r) => r.name === 'CLAUDE.md');
      return found
        ? { status: PASS, detail: 'CLAUDE.md found' }
        : { status: FAIL, detail: 'no CLAUDE.md found in any scanned root' };
    },
  },
];

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const results = CHECKS.map((c) => {
  let applies = false;
  try { applies = Boolean(c.applies()); } catch { applies = false; }
  if (!applies) {
    return { id: c.id, severity: c.severity, title: c.title, why: c.why, status: NA, detail: 'not applicable to this configuration' };
  }
  let r;
  try { r = c.run(); } catch (e) { r = { status: FAIL, detail: `check errored: ${e.message}` }; }
  return { id: c.id, severity: c.severity, title: c.title, why: c.why, ...r };
});

const applicable = results.filter((r) => r.status !== NA);
const passed = applicable.filter((r) => r.status === PASS);
const failed = applicable.filter((r) => r.status === FAIL);
const RANK = { high: 0, medium: 1, low: 2 };
failed.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

const report = {
  schemaVersion: 1,
  summary: {
    passed: passed.length,
    applicable: applicable.length,
    notApplicable: results.length - applicable.length,
    failedBySeverity: {
      high: failed.filter((f) => f.severity === 'high').length,
      medium: failed.filter((f) => f.severity === 'medium').length,
      low: failed.filter((f) => f.severity === 'low').length,
    },
  },
  findings: failed,
  passing: passed,
  notApplicable: results.filter((r) => r.status === NA),
};

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  const { passed: p, applicable: a } = report.summary;
  const s = report.summary.failedBySeverity;
  process.stdout.write(`\nHARNESS AUDIT   ${p}/${a} applicable checks pass\n`);
  process.stdout.write(`                ${s.high} high · ${s.medium} medium · ${s.low} low\n\n`);
  for (const f of failed) {
    process.stdout.write(`● ${f.severity.toUpperCase().padEnd(6)} ${f.id}\n`);
    process.stdout.write(`         ${f.title}\n`);
    process.stdout.write(`         ${f.detail}\n`);
    if (f.evidence?.length) process.stdout.write(`         → ${f.evidence.slice(0, 6).join(', ')}\n`);
    process.stdout.write('\n');
  }
  process.stdout.write(`${passed.length} passing, ${report.summary.notApplicable} not applicable\n`);
}

// Exit non-zero only on a high-severity failure, so CI can gate on it.
process.exit(report.summary.failedBySeverity.high > 0 ? 1 : 0);
