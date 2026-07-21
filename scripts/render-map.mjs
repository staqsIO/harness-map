#!/usr/bin/env node
/**
 * render-map.mjs — turn a scan-harness.mjs document into a self-contained HTML page.
 *
 * Deterministic layers (agents, hooks, environment, inventory) render straight
 * from the scan JSON. The two prose-backed layers (orchestrators, review) render
 * from an optional interpretation file supplied by the model; without it they
 * fall back to the deterministic detections plus an explanatory empty state.
 *
 * Zero dependencies. Emits HTML on stdout (or to --out).
 *
 * Usage:
 *   node render-map.mjs --scan scan.json [--prose prose.json]
 *                       [--audit audit.json] [--out map.html]
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const scanPath = arg('--scan');
const prosePath = arg('--prose');
const auditPath = arg('--audit');
const outPath = arg('--out');

if (!scanPath || argv.includes('--help')) {
  process.stdout.write('usage: render-map.mjs --scan <scan.json> [--prose <prose.json>] [--out <file.html>]\n');
  process.exit(scanPath ? 0 : 1);
}

// Bounded: --scan/--prose/--audit are public entry points and may be handed a
// substituted or malformed artifact. An unbounded readFileSync on a 500MB file
// blocks the process before any validation runs.
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const readJson = (p, fallback = null) => {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > MAX_INPUT_BYTES) return fallback;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return fallback; }
};

const scan = readJson(scanPath);
if (!scan) {
  process.stderr.write(`render-map: could not read scan document at ${scanPath}\n`);
  process.exit(1);
}
const prose = prosePath ? readJson(prosePath, {}) : {};
const audit = auditPath ? readJson(auditPath, null) : null;
const L = scan.layers ?? {};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Numeric interpolation sink. The scan and audit documents are untrusted input —
 * they may be substituted or hand-edited — so a field that "should" be a count
 * cannot be interpolated raw. `summary.passed` reaching HTML unescaped was a
 * live injection path even though it is only ever written as a number.
 */
const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
/** Clamp for CSS numeric contexts (width, flex), where even a number needs bounds. */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, num(v, lo)));

// A layer only counts as present when its items are actually a list: a
// substituted document can set status:'ok' with items as a string or object.
const has = (layer) => layer?.status === 'ok' && (layer.items === undefined || Array.isArray(layer.items));
const statusOf = (layer) => layer?.status ?? 'unconfigured';

/**
 * Commands are described, never quoted — the scanner deliberately emits only an
 * executable and script name, because command text carries credentials.
 */
function cmdLabel(c) {
  if (!c) return '';
  if (c.raw) return c.raw; // only present when the scan ran --include-values
  const parts = [c.exe].filter(Boolean);
  if (c.script && c.script !== c.exe) parts.push(c.script);
  const label = esc(parts.join(' → ') || 'command');
  return c.length ? `${label}  (${num(c.length)} chars, hidden)` : label;
}

/** Empty state: says what's missing and what would populate it. Never invents. */
function emptyState(layer, { title, hint }) {
  const reason = layer?.reason || 'not configured';
  return `<div class="empty">
    <p class="empty-title">${esc(title)}</p>
    <p class="empty-reason">${esc(reason)}</p>
    ${hint ? `<p class="empty-hint">${hint}</p>` : ''}
  </div>`;
}

/** Tier ramp: deep teal = most capable/expensive, pale = bulk. */
const TIER_RANK = { opus: 0, 'claude-opus': 0, inherit: 1, sonnet: 2, 'claude-sonnet': 2, haiku: 3, fable: 1 };
function tierClass(model) {
  if (!model) return 't-unset';
  const key = String(model).toLowerCase();
  for (const [k, v] of Object.entries(TIER_RANK)) if (key.includes(k)) return `t-${v}`;
  return 't-unset';
}

// ---------------------------------------------------------------------------
// view: agents & model tiers
// ---------------------------------------------------------------------------

function viewAgents() {
  const layer = L.agents;
  if (!has(layer)) {
    return emptyState(layer, {
      title: 'No agents defined',
      hint: 'Add <code>agents/*.md</code> files with <code>name:</code> and <code>model:</code> frontmatter to map your subagent tiers.',
    });
  }

  const proseNote = scan.prose ? '' :
    `<p class="note dim">Names appear as stable labels and descriptions are withheld, because
     authored text can contain anything and no scan can vet it. Re-run with
     <code>--include-prose</code> to read them; that output is no longer safe to share unreviewed.</p>`;

  const byModel = layer.byModel ?? {};
  const declaredTiers = Array.isArray(prose?.tiers) ? prose.tiers : null;

  const tierCards = declaredTiers
    ? `<div class="tier-strip">${declaredTiers.map((t) => `
        <div class="tier-card ${tierClass(t.model)}">
          <span class="tier-name">${esc(t.name)}</span>
          <span class="tier-model">${esc(t.model ?? '—')}</span>
          <span class="tier-role">${esc(t.role ?? '')}</span>
        </div>`).join('')}</div>`
    : '';

  const ramp = `<div class="ramp">${Object.entries(byModel)
    .sort((a, b) => (TIER_RANK[a[0]] ?? 9) - (TIER_RANK[b[0]] ?? 9))
    .map(([model, n]) => `<div class="ramp-seg ${tierClass(model)}" style="flex:${clamp(n, 0, 1000)}">
        <span class="ramp-label">${esc(model)}</span><span class="ramp-n">${num(n)}</span>
      </div>`).join('')}</div>`;

  const warnings = [];
  if (layer.bareInherit?.length) {
    warnings.push(`<p class="warn"><strong>${num(layer.bareInherit.length)}</strong> agent(s) on bare <code>inherit</code> — they silently bind to the session model: ${layer.bareInherit.map(esc).join(', ')}</p>`);
  }
  if (layer.unpinned?.length) {
    warnings.push(`<p class="warn"><strong>${num(layer.unpinned.length)}</strong> agent(s) with no <code>model:</code> field: ${layer.unpinned.map(esc).join(', ')}</p>`);
  }

  const showDesc = layer.items.some((a) => a.description);
  const rows = layer.items.map((a) => `<tr>
      <td class="mono strong">${esc(a.name)}</td>
      <td><span class="chip ${tierClass(a.model)}">${esc(a.model ?? 'unset')}</span></td>
      ${showDesc ? `<td class="desc">${esc(a.description ?? '')}</td>` : ''}
      <td class="mono dim">${esc(a.scope)}</td>
    </tr>`).join('');

  return `${proseNote}${tierCards}${ramp}${warnings.join('')}
    <div class="scroll"><table>
      <thead><tr><th>Agent</th><th>Model</th>${showDesc ? '<th>Purpose</th>' : ''}<th>Scope</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// ---------------------------------------------------------------------------
// view: hooks & context flow (the lifecycle "steps")
// ---------------------------------------------------------------------------

// Ordered by when they fire in a session, so the panel reads as a sequence.
const LIFECYCLE = [
  ['SessionStart', 'Session begins — context injected'],
  ['UserPromptSubmit', 'Prompt submitted'],
  ['PreToolUse', 'Before each tool call — can block'],
  ['PostToolUse', 'After each tool call'],
  ['Notification', 'Harness notifications'],
  ['Stop', 'Turn ends'],
  ['SubagentStop', 'Subagent finishes'],
  ['PreCompact', 'Before context compaction'],
  ['SessionEnd', 'Session ends'],
];

function viewHooks() {
  const hooks = L.hooks;
  const envLayer = L.environment;
  const envOk = envLayer?.status === 'ok';

  let envPanel = '';
  if (envOk) {
    const env = envLayer.env ?? {};
    const perms = envLayer.permissions ?? {};
    const compact = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const compactNote = compact
      ? `<p class="note">Auto-compact fires at roughly <strong>84%</strong> of this value — about <strong>${Math.round(num(compact) * 0.84 / 1000)}k</strong> tokens.</p>`
      : '';
    const topTools = Object.entries(perms.toolBreakdown ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    envPanel = `<section class="block">
      <h3>Session environment</h3>
      <dl class="kv">
        <dt>Model</dt><dd class="mono">${esc(envLayer.model ?? '—')}</dd>
        <dt>Permission mode</dt><dd class="mono">${esc(perms.defaultMode ?? '—')}</dd>
        <dt>Allow rules</dt><dd class="mono">${num(perms.allow)}</dd>
        ${envLayer.statusLine ? `<dt>Status line</dt><dd class="mono dim">${esc(cmdLabel(envLayer.statusLine.command))}</dd>` : ''}
      </dl>
      ${Object.keys(env).length ? `<div class="scroll"><table><thead><tr><th>Env var</th><th>Value</th></tr></thead><tbody>
        ${Object.entries(env).map(([k, v]) => `<tr><td class="mono strong">${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
      ${compactNote}
      ${topTools.length ? `<h4>Pre-approved tools</h4><div class="pills">${topTools.map(([t, n]) =>
        `<span class="pill"><span class="mono">${esc(t)}</span><span class="pill-n">${num(n)}</span></span>`).join('')}</div>` : ''}
    </section>`;
  }

  if (!has(hooks)) {
    return `${envPanel}${emptyState(hooks, {
      title: 'No hooks configured',
      hint: 'Hooks live under <code>hooks</code> in <code>settings.json</code> and fire around tool calls, compaction, and session boundaries.',
    })}`;
  }

  const byEvent = {};
  for (const h of hooks.items) (byEvent[h.event] ||= []).push(h);

  const known = new Set(LIFECYCLE.map(([e]) => e));
  const ordered = [
    ...LIFECYCLE.filter(([e]) => byEvent[e]),
    ...Object.keys(byEvent).filter((e) => !known.has(e)).map((e) => [e, '']),
  ];

  const steps = ordered.map(([event, caption], i) => {
    const list = byEvent[event] ?? [];
    return `<li class="step">
      <div class="step-head">
        <span class="step-n mono">${String(i + 1).padStart(2, '0')}</span>
        <span class="step-name mono">${esc(event)}</span>
        <span class="step-count">${num(list.length)}</span>
      </div>
      ${caption ? `<p class="step-caption">${esc(caption)}</p>` : ''}
      <ul class="hook-list">
        ${list.map((h) => `<li class="hook">
          <span class="matcher mono">${esc(h.matcher)}</span>
          <code class="cmd">${esc(cmdLabel(h.command))}</code>
          ${h.timeout ? `<span class="tag mono">${num(h.timeout)}ms</span>` : '<span class="tag mono dim">no timeout</span>'}
        </li>`).join('')}
      </ul>
    </li>`;
  }).join('');

  return `${envPanel}
    <section class="block">
      <h3>Hook lifecycle <span class="dim mono">${num(hooks.count)} hooks across ${Object.keys(byEvent).length} events</span></h3>
      <ol class="steps">${steps}</ol>
    </section>`;
}

// ---------------------------------------------------------------------------
// views: orchestrators & review (prose-backed)
// ---------------------------------------------------------------------------

function detectedList(layer) {
  if (!layer?.items?.length) return '';
  const groups = {};
  for (const i of layer.items) (groups[i.kind] ||= []).push(i.name);
  return `<div class="pills">${Object.entries(groups).flatMap(([kind, names]) =>
    names.map((n) => `<span class="pill"><span class="pill-kind">${esc(kind)}</span><span class="mono">${esc(n)}</span></span>`)
  ).join('')}</div>`;
}

function proseRefs(layer) {
  const refs = layer?.proseRefs ?? [];
  if (!refs.length) return '';
  return `<p class="note">Interpreted from ${refs.map((r) => `<code>${esc(r.name)}</code>`).join(', ')}.</p>`;
}

function viewOrchestrators() {
  const layer = L.orchestrators;
  if (!has(layer)) {
    return emptyState(layer, {
      title: 'No orchestrators configured',
      hint: 'Claude Code built-in defaults apply: the Agent tool for subagents, and Task/Workflow for multi-step runs. Define skills such as <code>goal</code>, <code>loop</code>, or a routing rule in <code>rules/</code> to map your own.',
    });
  }
  const rows = Array.isArray(prose?.orchestrators?.items) ? prose.orchestrators.items : null;
  const table = rows
    ? `<div class="scroll"><table>
        <thead><tr><th>Orchestrator</th><th>Use when</th><th>Loop type</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="mono strong">${esc(r.name)}</td>
          <td class="desc">${esc(r.when ?? '')}</td>
          <td><span class="chip neutral">${esc(r.kind ?? '')}</span></td>
        </tr>`).join('')}</tbody></table></div>`
    : `<p class="note">Detected below, but no interpretation was supplied — run the skill to build the decision tree.</p>`;
  return `${detectedList(layer)}${table}${proseRefs(layer)}`;
}

function viewReview() {
  const layer = L.review;
  if (!has(layer)) {
    return emptyState(layer, {
      title: 'No review pipeline configured',
      hint: 'Add reviewer agents (for example a code-review agent) or a rule file describing when reviews run, and this view will map the escalation tiers.',
    });
  }
  const rows = Array.isArray(prose?.review?.rows) ? prose.review.rows : null;
  const cap = prose?.review?.cap;
  const table = rows
    ? `<div class="scroll"><table>
        <thead><tr><th>Trigger</th><th>Reviewers</th><th>Why</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="desc strong">${esc(r.trigger)}</td>
          <td>${(r.reviewers ?? []).map((v) => `<span class="chip neutral mono">${esc(v)}</span>`).join(' ')}</td>
          <td class="desc dim">${esc(r.note ?? '')}</td>
        </tr>`).join('')}</tbody></table></div>`
    : `<p class="note">Reviewers detected below, but no interpretation was supplied — run the skill to build the escalation table.</p>`;
  return `${detectedList(layer)}${table}
    ${cap ? `<p class="note strong">${esc(cap)}</p>` : ''}${proseRefs(layer)}`;
}

// ---------------------------------------------------------------------------
// view: inventory
// ---------------------------------------------------------------------------

function inventoryBlock(title, layer, render) {
  if (!has(layer)) return `<section class="block"><h3>${esc(title)}</h3>${emptyState(layer, { title: `No ${title.toLowerCase()}` })}</section>`;
  return `<section class="block"><h3>${esc(title)} <span class="dim mono">${num(layer.count)}</span></h3>${render(layer)}</section>`;
}

function viewInventory() {
  const cmds = inventoryBlock('Commands', L.commands, (l) =>
    `<div class="pills">${l.items.map((c) => `<span class="pill"><span class="mono">${esc(c.name)}</span></span>`).join('')}</div>`);

  const plugins = inventoryBlock('Plugins', L.plugins, (l) => `
    ${l.disabled?.length ? `<p class="note"><strong>${num(l.disabled.length)}</strong> installed but disabled: ${l.disabled.map((d) => `<code>${esc(d)}</code>`).join(' ')} — their commands, skills and MCP servers are inert.</p>` : ''}
    <div class="pills">${l.items.map((p) => `<span class="pill${p.enabled === false ? ' off' : ''}">
      <span class="mono">${esc(p.name)}</span><span class="pill-kind">${esc(p.marketplace ?? '')}</span></span>`).join('')}</div>
    ${l.marketplaces?.length ? `<h4>Marketplaces</h4><div class="scroll"><table><thead><tr><th>Name</th><th>Type</th><th>Source</th></tr></thead><tbody>
      ${l.marketplaces.map((m) => `<tr><td class="mono strong">${esc(m.name)}</td><td class="mono dim">${esc(m.type ?? '')}</td><td class="mono">${esc(m.repo ?? '')}</td></tr>`).join('')}
    </tbody></table></div>` : ''}`);

  const mcpOrigin = (m) => {
    if (m.origin === 'plugin') return `plugin: ${m.plugin}`;
    return m.origin;
  };
  const mcp = inventoryBlock('MCP servers', L.mcp, (l) => `
    ${l.byOrigin ? `<div class="pills">${Object.entries(l.byOrigin).map(([o, n]) =>
      `<span class="pill"><span class="pill-kind">${esc(o)}</span><span class="pill-n">${num(n)}</span></span>`).join('')}</div>` : ''}
    <div class="scroll"><table><thead><tr><th>Server</th><th>Resolved from</th><th>Transport</th><th>State</th></tr></thead><tbody>
      ${l.items.map((m) => {
        const off = m.active === false;
        return `<tr${off ? ' class="row-off"' : ''}>
          <td class="mono strong">${esc(m.name)}</td>
          <td class="mono dim">${esc(mcpOrigin(m))}${m.shadowed?.length ? ` <span class="dim">(shadows ${esc(m.shadowed.join(', '))})</span>` : ''}</td>
          <td class="mono dim">${esc(m.transport ?? '')}</td>
          <td>${off ? '<span class="chip neutral">inactive</span>' : '<span class="chip t-2">active</span>'}</td>
        </tr>`;
      }).join('')}
    </tbody></table></div>
    ${l.otherProjectServers ? `<p class="note">${num(l.otherProjectServers)} further server(s) are configured for ${num(l.otherProjects)} other project(s). Those paths are not shown, and those servers do not load here.</p>` : ''}
    ${l.caveat ? `<p class="note dim">${esc(l.caveat)}</p>` : ''}`);

  const rules = inventoryBlock('Rules & instructions', L.rules, (l) =>
    `<div class="rule-grid">${l.items.map((r) => `<div class="rule-card">
      <p class="mono strong">${esc(r.name)}</p>
      <ul class="rule-heads">${(r.headings ?? []).slice(0, 6).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
    </div>`).join('')}</div>`);

  const skills = has(L.skills)
    ? `<section class="block"><h3>Skills <span class="dim mono">${num(L.skills.count)}</span></h3>
       <p class="note">${esc(L.skills.items.slice(0, 40).map((s) => s.name).join(' · '))}${L.skills.count > 40 ? ` … and ${L.skills.count - 40} more` : ''}</p></section>`
    : inventoryBlock('Skills', L.skills, () => '');

  return cmds + plugins + mcp + rules + skills;
}

// ---------------------------------------------------------------------------
// view: audit
// ---------------------------------------------------------------------------

function viewAudit() {
  if (!audit) {
    return `<div class="empty">
      <p class="empty-title">Audit not run</p>
      <p class="empty-reason">no audit document was supplied</p>
      <p class="empty-hint">Run <code>audit-harness.mjs --scan scan.json --json</code> and pass it with <code>--audit</code>.</p>
    </div>`;
  }
  const s = audit.summary ?? {};
  const sPassed = num(s.passed);
  const sApplicable = num(s.applicable);
  const sNa = num(s.notApplicable);
  const pct = sApplicable ? clamp(Math.round((sPassed / sApplicable) * 100), 0, 100) : 0;

  const finding = (f) => `<li class="finding sev-${esc(f.severity)}">
      <div class="finding-head">
        <span class="sev mono">${esc(f.severity)}</span>
        <span class="mono strong">${esc(f.id)}</span>
      </div>
      <p class="finding-title">${esc(f.title)}</p>
      <p class="finding-detail">${esc(f.detail)}</p>
      ${f.evidence?.length ? `<p class="finding-eq mono">${esc(f.evidence.slice(0, 8).join(' · '))}${f.evidence.length > 8 ? ` … +${f.evidence.length - 8}` : ''}</p>` : ''}
      ${f.why ? `<p class="finding-why">${esc(f.why)}</p>` : ''}
    </li>`;

  const findings = (audit.findings ?? []).map(finding).join('');

  return `<section class="block">
      <h3>Result</h3>
      <div class="audit-head">
        <div class="audit-score">
          <span class="audit-n mono">${sPassed}<span class="audit-of">/${sApplicable}</span></span>
          <span class="audit-cap">applicable checks pass</span>
        </div>
        <div class="audit-bar" role="img" aria-label="${pct} percent of applicable checks pass">
          <div class="audit-fill" style="width:${pct}%"></div>
        </div>
        <div class="pills">
          <span class="pill sev-chip sev-high"><span class="pill-kind">high</span><span class="pill-n">${num(s.failedBySeverity?.high)}</span></span>
          <span class="pill sev-chip sev-medium"><span class="pill-kind">medium</span><span class="pill-n">${num(s.failedBySeverity?.medium)}</span></span>
          <span class="pill sev-chip sev-low"><span class="pill-kind">low</span><span class="pill-n">${num(s.failedBySeverity?.low)}</span></span>
          ${sNa ? `<span class="pill"><span class="pill-kind">n/a</span><span class="pill-n">${sNa}</span></span>` : ''}
        </div>
      </div>
      <p class="note dim">There is no weighted score. Each check is a named assertion that passes, fails, or does not apply, so the ratio means exactly what it says and nothing more.</p>
    </section>
    ${findings ? `<section class="block"><h3>Findings</h3><ul class="findings">${findings}</ul></section>`
               : `<section class="block"><h3>Findings</h3><p class="note">Every applicable check passes.</p></section>`}
    ${audit.passing?.length ? `<section class="block"><h3>Passing <span class="dim mono">${num(audit.passing.length)}</span></h3>
      <ul class="passlist">${audit.passing.map((p) => `<li><span class="mono">${esc(p.id)}</span> <span class="dim">${esc(p.detail ?? '')}</span></li>`).join('')}</ul></section>` : ''}`;
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

const TABS = [
  { id: 'agents', label: 'Agents & tiers', layer: L.agents, body: viewAgents() },
  { id: 'hooks', label: 'Hooks & flow', layer: L.hooks, body: viewHooks() },
  { id: 'orch', label: 'Orchestrators', layer: L.orchestrators, body: viewOrchestrators() },
  { id: 'review', label: 'Review pipeline', layer: L.review, body: viewReview() },
  { id: 'inv', label: 'Inventory', layer: L.commands, body: viewInventory() },
  {
    id: 'audit', label: 'Audit', body: viewAudit(),
    layer: audit ? { status: (audit.summary?.failedBySeverity?.high ?? 0) > 0 ? 'error' : 'ok' } : { status: 'unconfigured' },
  },
];

const summaryChips = [
  ['Agents', L.agents], ['Hooks', L.hooks], ['Commands', L.commands],
  ['Skills', L.skills], ['Plugins', L.plugins], ['MCP', L.mcp],
].map(([label, layer]) => {
  // `status` reaches a class attribute and `count` reaches text, both from an
  // untrusted document — map status through a closed enum and coerce the count.
  const raw = statusOf(layer);
  const s = ['ok', 'unconfigured', 'error'].includes(raw) ? raw : 'unconfigured';
  return `<div class="stat s-${s}">
    <span class="stat-n mono">${s === 'ok' ? num(layer?.count) : '—'}</span>
    <span class="stat-l">${esc(label)}</span>
  </div>`;
}).join('');

const firstOk = TABS.findIndex((t) => statusOf(t.layer) === 'ok');
const activeIdx = firstOk === -1 ? 0 : firstOk;

const html = `<title>Harness Map</title>
<style>
:root{
  --bg:#F4F5F3; --surface:#FFFFFF; --surface-2:#EDEFEC; --line:#DCDFDA;
  --ink:#1A1F23; --ink-2:#5C6670; --ink-3:#8A939C;
  --accent:#B87A1F; --accent-ink:#FFFFFF;
  --ok:#2F7D62; --none:#9AA3AB; --err:#B0453C;
  --t0:#134E4A; --t1:#2A7F72; --t2:#6FB3A4; --t3:#B4D8CF; --tu:#C3C8C4;
  --radius:3px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#15181B; --surface:#1C2024; --surface-2:#22272B; --line:#2E343A;
    --ink:#E4E8EA; --ink-2:#9BA5AE; --ink-3:#6E7982;
    --accent:#DDA544; --accent-ink:#15181B;
    --ok:#4FA987; --none:#6E7982; --err:#D2685E;
    --t0:#7FD8C6; --t1:#4FA893; --t2:#2F7566; --t3:#24473F; --tu:#3A4147;
  }
}
:root[data-theme="dark"]{
  --bg:#15181B; --surface:#1C2024; --surface-2:#22272B; --line:#2E343A;
  --ink:#E4E8EA; --ink-2:#9BA5AE; --ink-3:#6E7982;
  --accent:#DDA544; --accent-ink:#15181B;
  --ok:#4FA987; --none:#6E7982; --err:#D2685E;
  --t0:#7FD8C6; --t1:#4FA893; --t2:#2F7566; --t3:#24473F; --tu:#3A4147;
}
:root[data-theme="light"]{
  --bg:#F4F5F3; --surface:#FFFFFF; --surface-2:#EDEFEC; --line:#DCDFDA;
  --ink:#1A1F23; --ink-2:#5C6670; --ink-3:#8A939C;
  --accent:#B87A1F; --accent-ink:#FFFFFF;
  --ok:#2F7D62; --none:#9AA3AB; --err:#B0453C;
  --t0:#134E4A; --t1:#2A7F72; --t2:#6FB3A4; --t3:#B4D8CF; --tu:#C3C8C4;
}

*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
  font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:32px 20px 80px;
  display:flex;flex-direction:column;gap:24px}
.mono{font-family:var(--mono)}
.dim{color:var(--ink-3)}
.strong{font-weight:600}
code{font-family:var(--mono);font-size:.85em;background:var(--surface-2);
  padding:1px 5px;border-radius:var(--radius);color:var(--ink-2)}

/* masthead */
header{display:flex;flex-direction:column;gap:6px;
  border-bottom:1px solid var(--line);padding-bottom:20px}
h1{font-family:var(--mono);font-size:24px;font-weight:600;letter-spacing:-.02em;
  margin:0;text-wrap:balance}
.sub{color:var(--ink-2);font-size:13.5px;margin:0}
.meta{display:flex;flex-wrap:wrap;gap:6px 14px;font-family:var(--mono);
  font-size:11.5px;color:var(--ink-3);margin-top:4px}

/* summary bar */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));
  gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--radius);
  overflow:hidden}
.stat{background:var(--surface);padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.stat-n{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}
.stat-l{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3)}
.s-ok .stat-n{color:var(--ok)}
.s-unconfigured .stat-n{color:var(--none)}
.s-error .stat-n{color:var(--err)}

/* tabs */
.tabs{display:flex;flex-wrap:wrap;gap:2px;border-bottom:1px solid var(--line)}
.tab{appearance:none;background:none;border:0;border-bottom:2px solid transparent;
  font-family:var(--mono);font-size:13px;color:var(--ink-2);padding:9px 13px;
  cursor:pointer;display:flex;align-items:center;gap:7px;margin-bottom:-1px}
.tab:hover{color:var(--ink);background:var(--surface-2)}
.tab[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}
.tab:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--ok);flex:none}
.tab.is-none .dot{background:var(--none)}
.tab.is-none{color:var(--ink-3)}
.tab.is-error .dot{background:var(--err)}

.panel[hidden]{display:none}
.panel{display:flex;flex-direction:column;gap:20px}

/* blocks */
.block{display:flex;flex-direction:column;gap:12px;background:var(--surface);
  border:1px solid var(--line);border-radius:var(--radius);padding:18px}
h3{font-family:var(--mono);font-size:13px;font-weight:600;margin:0;
  text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);
  display:flex;align-items:baseline;gap:10px}
h4{font-family:var(--mono);font-size:12px;font-weight:600;margin:6px 0 0;
  color:var(--ink-3);text-transform:uppercase;letter-spacing:.05em}
.note{font-size:13px;color:var(--ink-2);margin:0}
.warn{font-size:13px;margin:0;padding:9px 12px;border-radius:var(--radius);
  background:var(--surface-2);border-left:2px solid var(--accent);color:var(--ink-2)}

/* tier ramp */
.tier-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.tier-card{border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;
  display:flex;flex-direction:column;gap:3px;background:var(--surface)}
.tier-card::before{content:"";height:3px;width:34px;border-radius:2px;background:var(--tu);margin-bottom:5px}
.tier-card.t-0::before{background:var(--t0)} .tier-card.t-1::before{background:var(--t1)}
.tier-card.t-2::before{background:var(--t2)} .tier-card.t-3::before{background:var(--t3)}
.tier-name{font-family:var(--mono);font-weight:600;font-size:13px;letter-spacing:.05em}
.tier-model{font-family:var(--mono);font-size:12px;color:var(--accent)}
.tier-role{font-size:12.5px;color:var(--ink-2)}
.ramp{display:flex;height:34px;border-radius:var(--radius);overflow:hidden;border:1px solid var(--line)}
.ramp-seg{display:flex;align-items:center;justify-content:center;gap:7px;min-width:0;
  font-family:var(--mono);font-size:11.5px;color:#fff;padding:0 8px}
.ramp-seg.t-0{background:var(--t0)} .ramp-seg.t-1{background:var(--t1)}
.ramp-seg.t-2{background:var(--t2);color:#0F2A25} .ramp-seg.t-3{background:var(--t3);color:#0F2A25}
.ramp-seg.t-unset{background:var(--tu);color:var(--ink)}
.ramp-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ramp-n{font-variant-numeric:tabular-nums;font-weight:600;opacity:.85}

/* tables */
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:13.5px;min-width:460px}
th{text-align:left;font-family:var(--mono);font-size:11px;text-transform:uppercase;
  letter-spacing:.06em;color:var(--ink-3);font-weight:600;
  padding:0 12px 7px 0;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:8px 12px 8px 0;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
td.desc{color:var(--ink-2);max-width:460px}

/* chips & pills */
.chip{display:inline-block;font-family:var(--mono);font-size:11px;padding:2px 7px;
  border-radius:var(--radius);background:var(--tu);color:var(--ink);white-space:nowrap}
.chip.t-0{background:var(--t0);color:#fff} .chip.t-1{background:var(--t1);color:#fff}
.chip.t-2{background:var(--t2);color:#0F2A25} .chip.t-3{background:var(--t3);color:#0F2A25}
.chip.neutral{background:var(--surface-2);color:var(--ink-2);border:1px solid var(--line)}
.pills{display:flex;flex-wrap:wrap;gap:6px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;
  border:1px solid var(--line);border-radius:var(--radius);padding:3px 8px;background:var(--surface-2)}
.pill-kind{font-family:var(--mono);font-size:10px;text-transform:uppercase;
  letter-spacing:.05em;color:var(--ink-3)}
.pill-n{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--accent);font-weight:600}
.pill.off{opacity:.5;text-decoration:line-through}
.row-off td{opacity:.55}

/* lifecycle steps */
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0}
.step{border-left:2px solid var(--line);padding:0 0 16px 16px;position:relative}
.step:last-child{padding-bottom:0}
.step::before{content:"";position:absolute;left:-5px;top:6px;width:8px;height:8px;
  border-radius:50%;background:var(--accent);border:2px solid var(--bg)}
.step-head{display:flex;align-items:center;gap:9px}
.step-n{font-size:11px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.step-name{font-size:13.5px;font-weight:600}
.step-count{font-family:var(--mono);font-size:11px;background:var(--surface-2);
  border:1px solid var(--line);border-radius:var(--radius);padding:0 6px;color:var(--ink-2);
  font-variant-numeric:tabular-nums}
.step-caption{font-size:12.5px;color:var(--ink-3);margin:1px 0 7px}
.hook-list{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:5px}
.hook{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12.5px}
.matcher{font-size:11px;background:var(--surface-2);border:1px solid var(--line);
  border-radius:var(--radius);padding:1px 6px;color:var(--ink-2);white-space:nowrap}
.cmd{font-size:11.5px;color:var(--ink-3);background:none;padding:0;
  overflow-wrap:anywhere;flex:1;min-width:180px}
.tag{font-size:10.5px;color:var(--accent);white-space:nowrap}

/* kv */
.kv{display:grid;grid-template-columns:auto 1fr;gap:5px 18px;margin:0;font-size:13px}
.kv dt{color:var(--ink-3);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;
  font-family:var(--mono);padding-top:2px}
.kv dd{margin:0;overflow-wrap:anywhere}

/* rules */
.rule-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
.rule-card{border:1px solid var(--line);border-radius:var(--radius);padding:11px 13px;
  background:var(--surface-2)}
.rule-card p{margin:0 0 6px;font-size:12.5px}
.rule-heads{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.rule-heads li{font-size:11.5px;color:var(--ink-3);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}

/* audit */
.audit-head{display:flex;flex-direction:column;gap:11px}
.audit-score{display:flex;align-items:baseline;gap:10px}
.audit-n{font-size:38px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1;color:var(--ok)}
.audit-of{font-size:20px;color:var(--ink-3);font-weight:400}
.audit-cap{font-size:12.5px;color:var(--ink-2);text-transform:uppercase;letter-spacing:.06em;
  font-family:var(--mono)}
.audit-bar{height:5px;background:var(--surface-2);border:1px solid var(--line);
  border-radius:3px;overflow:hidden}
.audit-fill{height:100%;background:var(--ok)}
.sev-chip.sev-high .pill-n{color:var(--err)}
.sev-chip.sev-medium .pill-n{color:var(--accent)}
.sev-chip.sev-low .pill-n{color:var(--ink-2)}
.findings,.passlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}
.passlist{gap:3px;font-size:12.5px}
.finding{border-left:2px solid var(--none);padding-left:13px;display:flex;
  flex-direction:column;gap:3px}
.finding.sev-high{border-left-color:var(--err)}
.finding.sev-medium{border-left-color:var(--accent)}
.finding-head{display:flex;align-items:center;gap:9px;font-size:12.5px}
.sev{font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:1px 6px;
  border-radius:var(--radius);background:var(--surface-2);border:1px solid var(--line);color:var(--ink-2)}
.sev-high .sev{background:var(--err);color:#fff;border-color:transparent}
.sev-medium .sev{background:var(--accent);color:var(--accent-ink);border-color:transparent}
.finding-title{margin:0;font-size:13.5px;font-weight:600}
.finding-detail{margin:0;font-size:13px;color:var(--ink-2)}
.finding-eq{margin:0;font-size:11.5px;color:var(--ink-3);overflow-wrap:anywhere}
.finding-why{margin:3px 0 0;font-size:12.5px;color:var(--ink-3);max-width:66ch}

/* empty state */
.empty{border:1px dashed var(--line);border-radius:var(--radius);padding:20px;
  background:var(--surface-2);display:flex;flex-direction:column;gap:5px}
.empty-title{margin:0;font-family:var(--mono);font-size:13px;font-weight:600;color:var(--ink-2)}
.empty-title::before{content:"○ ";color:var(--none)}
.empty-reason{margin:0;font-size:13px;color:var(--ink-3)}
.empty-hint{margin:4px 0 0;font-size:13px;color:var(--ink-2)}

footer{border-top:1px solid var(--line);padding-top:16px;font-size:12px;color:var(--ink-3);
  display:flex;flex-direction:column;gap:4px}

@media (max-width:560px){
  .wrap{padding:22px 14px 60px}
  h1{font-size:20px}
  td.desc{max-width:none}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>

<div class="wrap">
  <header>
    <h1>Harness Map</h1>
    <p class="sub">The agents, hooks, and routing that shape this Claude Code session.</p>
    <div class="meta">
      <span>${scan.redacted ? 'redacted' : '⚠ UNREDACTED — contains raw values'}</span>
      <span>${scan.prose ? '⚠ includes authored names — review before sharing' : 'names hidden'}</span>
      <span>schema v${esc(scan.schemaVersion)}</span>
      ${(scan.sources ?? []).map((s) => `<span>${esc(s.scope)}: ${esc(s.path)}${s.exists ? '' : ' (missing)'}</span>`).join('')}
    </div>
  </header>

  <div class="stats">${summaryChips}</div>

  <div class="tabs" role="tablist">
    ${TABS.map((t, i) => {
      const raw = statusOf(t.layer);
      const s = ['ok', 'unconfigured', 'error'].includes(raw) ? raw : 'unconfigured';
      const cls = s === 'ok' ? '' : s === 'error' ? ' is-error' : ' is-none';
      return `<button class="tab${cls}" role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}"
        aria-selected="${i === activeIdx}" tabindex="${i === activeIdx ? 0 : -1}">
        <span class="dot"></span>${esc(t.label)}</button>`;
    }).join('')}
  </div>

  ${TABS.map((t, i) => `<div class="panel" role="tabpanel" id="panel-${t.id}"
     aria-labelledby="tab-${t.id}"${i === activeIdx ? '' : ' hidden'}>${t.body}</div>`).join('')}

  <footer>
    <span>Generated by harness-map from ${esc((scan.settingsFiles ?? []).length)} settings file(s). Values are redacted by default.</span>
  </footer>
</div>

<script>
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  function select(idx) {
    tabs.forEach(function (tab, i) {
      var on = i === idx;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      document.getElementById('panel-' + tab.id.slice(4)).hidden = !on;
    });
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { select(i); });
    tab.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      var next = (i + d + tabs.length) % tabs.length;
      tabs[next].focus();
      select(next);
    });
  });
})();
</script>
`;

if (outPath) {
  writeFileSync(outPath, html, 'utf8');
  process.stderr.write(`wrote ${outPath} (${html.length} bytes)\n`);
} else {
  process.stdout.write(html);
}
