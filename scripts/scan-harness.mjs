#!/usr/bin/env node
/**
 * scan-harness.mjs — deterministic Claude Code harness scanner.
 *
 * Reads a Claude Code configuration (user-level ~/.claude and optionally a
 * project-level .claude) and emits a single JSON document describing the
 * harness topology: agents and their model bindings, hooks, commands, skills,
 * plugins, MCP servers, and pointers to prose rule files.
 *
 * Zero dependencies. Read-only. Never throws on a malformed or missing input —
 * each layer independently degrades to {status: "unconfigured" | "error"} so a
 * minimal config produces a valid (mostly empty) document rather than a crash.
 *
 * Output is REDACTED by default; see redact() below. Pass --include-values to
 * emit raw values, in which case the output may contain secrets and must not
 * be shared.
 *
 * Usage:
 *   node scan-harness.mjs [--pretty] [--include-values]
 *                         [--root <dir>] [--project <dir>]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname, extname, relative, sep } from 'node:path';

const SCHEMA_VERSION = 1;
const HOME = homedir();

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { pretty: false, includeValues: false, root: null, project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pretty') opts.pretty = true;
    else if (a === '--include-values') opts.includeValues = true;
    else if (a === '--json') opts.pretty = false; // accepted, default behaviour
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

const HELP = `scan-harness — emit a JSON map of a Claude Code harness config

  --pretty           indent the JSON output
  --include-values   do not redact paths/secrets (output is unsafe to share)
  --root <dir>       config root to scan (default: ~/.claude)
  --project <dir>    additional project dir containing .claude/ and CLAUDE.md
  --help             show this message
`;

// ---------------------------------------------------------------------------
// safe fs helpers — every one returns a fallback instead of throwing
// ---------------------------------------------------------------------------

const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const listDir = (p) => { try { return readdirSync(p); } catch { return []; } };

/** Recursively collect files matching an extension, depth-limited. */
function walk(dir, ext, maxDepth = 3, depth = 0, out = []) {
  if (depth > maxDepth || !isDir(dir)) return out;
  for (const entry of listDir(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (isDir(full)) walk(full, ext, maxDepth, depth + 1, out);
    else if (extname(entry) === ext) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

const SECRET_KEY_RE = /(?:api[_-]?key|secret|token|password|passwd|bearer|credential|auth)/i;
const SECRET_VALUE_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

let REDACT = true;

/** Collapse the real home directory to `~` and strip obvious secret literals. */
function scrub(str) {
  if (typeof str !== 'string') return str;
  if (!REDACT) return str;
  let s = str.split(HOME).join('~');
  s = s.replace(SECRET_VALUE_RE, '<redacted>');
  return s;
}

/** Redact a value whose *key* suggests it is sensitive. */
function scrubPair(key, value) {
  if (!REDACT) return value;
  if (SECRET_KEY_RE.test(key)) return '<redacted>';
  return typeof value === 'string' ? scrub(value) : value;
}

/** Shorten a shell command to a summary: leading words + referenced script. */
function summarizeCommand(cmd, limit = 80) {
  if (typeof cmd !== 'string') return null;
  const cleaned = scrub(cmd).replace(/\s+/g, ' ').trim();
  const scriptMatch = cleaned.match(/[\w.-]+\.(mjs|js|sh|py|ts)\b/);
  const out = { preview: cleaned.length > limit ? cleaned.slice(0, limit) + '…' : cleaned };
  if (scriptMatch) out.script = scriptMatch[0];
  return out;
}

// ---------------------------------------------------------------------------
// frontmatter (a deliberately small YAML subset: top-level scalars only)
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  if (typeof text !== 'string') return null;
  // Tolerate a leading BOM / blank lines before the opening fence.
  const m = text.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const fm = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    // Skip list items, nested keys, comments and blanks — we only want scalars.
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    if (/^\s/.test(rawLine) || rawLine.trimStart().startsWith('-')) continue;
    const kv = rawLine.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let [, key, value] = kv;
    value = value.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return fm;
}

const truncate = (s, n) =>
  typeof s === 'string' && s.length > n ? s.slice(0, n).trimEnd() + '…' : s;

// ---------------------------------------------------------------------------
// layer helpers
// ---------------------------------------------------------------------------

const ok = (items, extra = {}) => ({ status: 'ok', count: items.length, items, ...extra });
const unconfigured = (reason, extra = {}) => ({ status: 'unconfigured', count: 0, items: [], reason, ...extra });

/** Run a layer builder, converting any unexpected throw into status:"error". */
function layer(fn, label) {
  try {
    return fn();
  } catch (err) {
    return { status: 'error', count: 0, items: [], reason: `failed to scan ${label}: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// settings (merged across user + local + project, precedence recorded)
// ---------------------------------------------------------------------------

function collectSettings(roots) {
  const files = [];
  for (const { label, dir } of roots) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const p = join(dir, name);
      const data = readJson(p);
      if (data) files.push({ scope: label, file: scrub(p), data });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------

function scanAgents(roots) {
  const items = [];
  for (const { label, dir } of roots) {
    const agentsDir = join(dir, 'agents');
    if (!isDir(agentsDir)) continue;
    for (const file of walk(agentsDir, '.md', 2)) {
      const fm = parseFrontmatter(readText(file));
      if (!fm) continue;
      items.push({
        name: fm.name || basename(file, '.md'),
        model: fm.model || null,
        modelExplicit: Boolean(fm.model) && fm.model !== 'inherit',
        description: truncate(scrub(fm.description || ''), 160) || null,
        tools: fm.tools ? truncate(fm.tools, 80) : null,
        scope: label,
        file: scrub(file),
      });
    }
  }
  if (!items.length) return unconfigured('no agents/*.md with frontmatter found');

  // Tier summary: how many agents sit on each model binding.
  const byModel = {};
  for (const a of items) {
    const key = a.model || '(unset)';
    byModel[key] = (byModel[key] || 0) + 1;
  }
  const bareInherit = items.filter((a) => a.model === 'inherit').map((a) => a.name);
  const unpinned = items.filter((a) => !a.model).map((a) => a.name);
  return ok(items.sort((a, b) => a.name.localeCompare(b.name)), {
    byModel,
    bareInherit,
    unpinned,
  });
}

function scanHooks(settingsFiles) {
  const items = [];
  for (const { scope, file, data } of settingsFiles) {
    const hooks = data?.hooks;
    if (!hooks || typeof hooks !== 'object') continue;
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const defs = Array.isArray(entry?.hooks) ? entry.hooks : [];
        for (const def of defs) {
          items.push({
            event,
            matcher: entry?.matcher === '' ? '(all)' : entry?.matcher ?? '(all)',
            type: def?.type ?? null,
            timeout: def?.timeout ?? null,
            command: summarizeCommand(def?.command),
            scope,
            source: file,
          });
        }
      }
    }
  }
  if (!items.length) return unconfigured('no hooks configured in settings.json');

  const byEvent = {};
  for (const h of items) byEvent[h.event] = (byEvent[h.event] || 0) + 1;
  return ok(items, { byEvent, events: Object.keys(byEvent).sort() });
}

function scanCommands(roots) {
  const items = [];
  for (const { label, dir } of roots) {
    const cmdDir = join(dir, 'commands');
    if (!isDir(cmdDir)) continue;
    for (const file of walk(cmdDir, '.md', 3)) {
      const fm = parseFrontmatter(readText(file)) || {};
      const rel = relative(cmdDir, file).replace(/\.md$/, '');
      // Nested dirs namespace the command: commands/codex/review.md -> /codex:review
      const parts = rel.split(sep);
      const name = parts.length > 1 ? `${parts.slice(0, -1).join(':')}:${parts.at(-1)}` : parts[0];
      items.push({
        name: `/${name}`,
        description: truncate(scrub(fm.description || ''), 140) || null,
        argumentHint: fm['argument-hint'] ? truncate(fm['argument-hint'], 80) : null,
        scope: label,
        file: scrub(file),
      });
    }
  }
  return items.length ? ok(items.sort((a, b) => a.name.localeCompare(b.name))) : unconfigured('no commands/*.md found');
}

function scanSkills(roots) {
  const items = [];
  for (const { label, dir } of roots) {
    const skillsDir = join(dir, 'skills');
    if (!isDir(skillsDir)) continue;
    for (const entry of listDir(skillsDir)) {
      const skillFile = join(skillsDir, entry, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const fm = parseFrontmatter(readText(skillFile)) || {};
      items.push({
        name: fm.name || entry,
        description: truncate(scrub(fm.description || ''), 160) || null,
        userInvocable: fm.user_invocable === 'true' || fm.user_invocable === true || null,
        scope: label,
      });
    }
  }
  return items.length ? ok(items.sort((a, b) => a.name.localeCompare(b.name))) : unconfigured('no skills/*/SKILL.md found');
}

function scanPlugins(userDir, settingsFiles) {
  const installed = readJson(join(userDir, 'plugins', 'installed_plugins.json'));
  const known = readJson(join(userDir, 'plugins', 'known_marketplaces.json'));
  const items = [];

  // enabledPlugins maps "name@marketplace" -> boolean. A plugin can be installed
  // but switched off, in which case its commands/skills/MCP servers are inert.
  const enabledMap = {};
  for (const { data } of settingsFiles) {
    const ep = data?.enabledPlugins;
    if (ep && typeof ep === 'object' && !Array.isArray(ep)) Object.assign(enabledMap, ep);
  }

  const plugins = installed?.plugins;
  if (plugins && typeof plugins === 'object') {
    for (const [key, entries] of Object.entries(plugins)) {
      const [name, marketplace] = key.split('@');
      const first = Array.isArray(entries) ? entries[0] : entries;
      items.push({
        name,
        marketplace: marketplace ?? null,
        scope: first?.scope ?? null,
        version: first?.version ?? null,
        enabled: key in enabledMap ? Boolean(enabledMap[key]) : null,
      });
    }
  }

  const marketplaces = [];
  if (known && typeof known === 'object') {
    for (const [name, meta] of Object.entries(known)) {
      const src = meta?.source ?? {};
      marketplaces.push({
        name,
        type: src.source ?? null,
        repo: src.repo ?? (src.path ? scrub(src.path) : null),
      });
    }
  }

  if (!items.length && !marketplaces.length) return unconfigured('no installed plugins or marketplaces found');
  const disabled = items.filter((p) => p.enabled === false).map((p) => p.name);
  return ok(items.sort((a, b) => a.name.localeCompare(b.name)), { marketplaces, disabled });
}

/**
 * MCP servers are declared in four different places. Reading only settings.json
 * (the obvious one) undercounts badly — most servers live in ~/.claude.json or
 * are bundled with a plugin.
 *
 *   1. settings.json / settings.local.json  -> mcpServers
 *   2. ~/.claude.json                       -> mcpServers          (global)
 *   3. ~/.claude.json                       -> projects[path].mcpServers
 *   4. a plugin's own .mcp.json             (inert if plugin disabled)
 *   5. <root>/.mcp.json, <project>/.mcp.json
 *
 * Account-level connectors (Gmail, Drive, Figma, …) are provisioned server-side
 * and are NOT discoverable from disk; they are reported as a caveat, not a count.
 */
function scanMcp(settingsFiles, roots, userDir, projectPath) {
  const items = [];
  const push = (name, cfg, origin, source, extra = {}) => {
    items.push({
      name,
      transport: cfg?.type ?? (cfg?.url ? 'http' : cfg?.command ? 'stdio' : null),
      command: cfg?.command ? scrub(String(cfg.command)) : null,
      // Args and env routinely carry tokens — never emit them raw when redacting.
      argsCount: Array.isArray(cfg?.args) ? cfg.args.length : 0,
      envKeys: cfg?.env && typeof cfg.env === 'object'
        ? Object.keys(cfg.env).map((k) => (REDACT ? k : `${k}=${cfg.env[k]}`))
        : [],
      url: cfg?.url ? (REDACT ? scrub(String(cfg.url)).replace(/\?.*$/, '?<redacted>') : String(cfg.url)) : null,
      origin,
      source,
      ...extra,
    });
  };

  const eachServer = (obj, fn) => {
    if (obj && typeof obj === 'object') for (const [n, c] of Object.entries(obj)) fn(n, c);
  };

  // (1) settings files
  for (const { scope, file, data } of settingsFiles) {
    eachServer(data?.mcpServers, (n, c) => push(n, c, `settings (${scope})`, file));
  }

  // (2)+(3) claude.json — global and per-project.
  // It sits beside the config dir (~/.claude.json next to ~/.claude/), so derive
  // it from the root's parent. That keeps --root scans hermetic for fixtures.
  const claudeJsonPath = join(dirname(userDir), '.claude.json');
  const claudeJson = readJson(claudeJsonPath);
  if (claudeJson) {
    eachServer(claudeJson.mcpServers, (n, c) => push(n, c, 'global', scrub(claudeJsonPath)));
    const projects = claudeJson.projects;
    if (projects && typeof projects === 'object') {
      const active = projectPath || process.cwd();
      for (const [path, cfg] of Object.entries(projects)) {
        eachServer(cfg?.mcpServers, (n, c) =>
          push(n, c, 'project', scrub(claudeJsonPath), {
            projectPath: scrub(path),
            active: path === active,
          }));
      }
    }
  }

  // (4) plugin-bundled servers — only meaningful when the plugin is enabled
  const enabledMap = {};
  for (const { data } of settingsFiles) {
    const ep = data?.enabledPlugins;
    if (ep && typeof ep === 'object' && !Array.isArray(ep)) Object.assign(enabledMap, ep);
  }
  const pluginEnabled = (owner) => {
    const hit = Object.keys(enabledMap).find((k) => k.split('@')[0] === owner || k.split('@')[1] === owner);
    return hit ? Boolean(enabledMap[hit]) : null;
  };
  for (const base of ['marketplaces', 'cache']) {
    const dir = join(userDir, 'plugins', base);
    for (const entry of listDir(dir)) {
      for (const candidate of [join(dir, entry, '.mcp.json'), ...listDir(join(dir, entry)).map((sub) => join(dir, entry, sub, '.mcp.json'))]) {
        const data = readJson(candidate);
        if (!data) continue;
        const owner = basename(candidate.replace(/\/.mcp\.json$/, ''));
        const enabled = pluginEnabled(owner);
        eachServer(data.mcpServers, (n, c) =>
          push(n, c, 'plugin', scrub(candidate), { plugin: owner, enabled }));
      }
    }
  }

  // (5) explicit .mcp.json next to a config root
  for (const { label, dir } of roots) {
    const mcpFile = join(dir, '.mcp.json');
    const data = readJson(mcpFile);
    eachServer(data?.mcpServers, (n, c) => push(n, c, `file (${label})`, scrub(mcpFile)));
  }

  // Same server can be declared in more than one place; keep the first, note the rest.
  const seen = new Map();
  for (const it of items) {
    const prev = seen.get(it.name);
    if (!prev) seen.set(it.name, it);
    else (prev.alsoDeclaredIn ||= []).push(it.origin);
  }
  const unique = [...seen.values()];

  const caveat = 'Account-level connectors (for example Gmail, Drive, Figma, Slack) are provisioned server-side and cannot be detected from configuration files.';
  if (!unique.length) return unconfigured('no MCP servers found in settings, ~/.claude.json, or plugins', { caveat });

  const byOrigin = {};
  for (const m of unique) byOrigin[m.origin] = (byOrigin[m.origin] || 0) + 1;
  const inactive = unique.filter((m) => m.enabled === false || (m.origin === 'project' && m.active === false)).length;
  return ok(unique, { byOrigin, inactive, caveat });
}

function scanEnvironment(settingsFiles) {
  const env = {};
  const permissions = { allow: 0, deny: 0, ask: 0, defaultMode: null, toolBreakdown: {} };
  let model = null;
  let statusLine = null;

  for (const { data } of settingsFiles) {
    if (!data) continue;
    if (data.model) model = data.model;
    if (data.statusLine) {
      statusLine = { type: data.statusLine.type ?? null, command: summarizeCommand(data.statusLine.command) };
    }
    if (data.env && typeof data.env === 'object') {
      for (const [k, v] of Object.entries(data.env)) env[k] = scrubPair(k, String(v));
    }
    const p = data.permissions;
    if (p && typeof p === 'object') {
      if (p.defaultMode) permissions.defaultMode = p.defaultMode;
      for (const bucket of ['allow', 'deny', 'ask']) {
        const list = p[bucket];
        if (!Array.isArray(list)) continue;
        permissions[bucket] += list.length;
        if (bucket !== 'allow') continue;
        // Coarse breakdown only: the tool name, never the full rule argument.
        for (const rule of list) {
          const tool = String(rule).split('(')[0].trim() || '(unknown)';
          permissions.toolBreakdown[tool] = (permissions.toolBreakdown[tool] || 0) + 1;
        }
      }
    }
  }

  const hasAny = model || statusLine || Object.keys(env).length || permissions.allow;
  if (!hasAny) return { status: 'unconfigured', reason: 'no model/env/permissions/statusLine in settings' };
  return { status: 'ok', model, statusLine, env, permissions };
}

function scanRules(roots) {
  const items = [];
  for (const { label, dir } of roots) {
    const rulesDir = join(dir, 'rules');
    if (!isDir(rulesDir)) continue;
    for (const file of walk(rulesDir, '.md', 1)) {
      const text = readText(file) || '';
      const headings = text
        .split(/\r?\n/)
        .filter((l) => /^#{1,3}\s/.test(l))
        .map((l) => l.replace(/^#+\s*/, '').trim())
        .slice(0, 12);
      items.push({ name: basename(file, '.md'), file: scrub(file), headings, scope: label });
    }
  }
  // CLAUDE.md files are the other prose source.
  for (const { label, dir, claudeMd } of roots) {
    const p = claudeMd || join(dir, 'CLAUDE.md');
    const text = readText(p);
    if (!text) continue;
    const headings = text
      .split(/\r?\n/)
      .filter((l) => /^#{1,3}\s/.test(l))
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .slice(0, 20);
    items.push({ name: 'CLAUDE.md', file: scrub(p), headings, scope: label });
  }
  return items.length ? ok(items) : unconfigured('no rules/*.md or CLAUDE.md found');
}

// --- prose-backed layers: detect deterministic signals, point at the prose ----

const ORCHESTRATOR_NAMES = ['goal', 'loop', 'supergoal', 'ultrawork', 'improve', 'gsd', 'ship-issue', 'foreman'];
const REVIEWER_HINTS = ['review', 'linus', 'codex', 'gemini', 'neo', 'verifier', 'critic', 'audit'];

/**
 * Bundled skill packs (Google Workspace recipes, personas) contain names like
 * "recipe-review-overdue-tasks" that substring-match a reviewer hint without
 * being code reviewers. Exclude those namespaces from prose-layer detection.
 */
const PACK_PREFIXES = ['recipe-', 'persona-', 'gws-'];
const inSkillPack = (n) => PACK_PREFIXES.some((p) => String(n).toLowerCase().startsWith(p));

/**
 * Prose layers cannot be parsed deterministically, but their *presence* can be
 * detected: known orchestrator skills/commands and rule files that discuss them.
 * Status "ok" here means "there is something to interpret", and proseRefs tells
 * the renderer which files to read. It never means the tree was parsed.
 */
function scanProseLayer(kind, { skills, commands, agents, rules }) {
  const names = kind === 'orchestrators' ? ORCHESTRATOR_NAMES : REVIEWER_HINTS;
  const match = (n) => {
    if (inSkillPack(n)) return false;
    const lower = String(n).toLowerCase();
    // Orchestrators are matched exactly (a skill IS the orchestrator); reviewer
    // detection is looser because names vary (linus-code-review, neo-review…).
    return names.some((k) => (kind === 'orchestrators' ? lower === k : lower.includes(k)));
  };

  const found = [];
  for (const s of skills.items ?? []) if (match(s.name)) found.push({ kind: 'skill', name: s.name });
  for (const c of commands.items ?? []) if (match(c.name.replace(/^\//, '').split(':').pop())) found.push({ kind: 'command', name: c.name });
  if (kind === 'review') for (const a of agents.items ?? []) if (match(a.name)) found.push({ kind: 'agent', name: a.name });
  if (kind === 'orchestrators') for (const a of agents.items ?? []) if (match(a.name)) found.push({ kind: 'agent', name: a.name });

  const wanted = kind === 'orchestrators'
    ? ['agent-routing', 'context-hygiene', 'CLAUDE.md']
    : ['verifier-protocol', 'agent-routing', 'safety', 'CLAUDE.md'];
  const proseRefs = (rules.items ?? [])
    .filter((r) => wanted.some((w) => r.name.includes(w)))
    .map((r) => ({ name: r.name, file: r.file, headings: r.headings }));

  // Dedupe by kind+name — a skill and its command often share a name.
  const seen = new Set();
  const items = found.filter((f) => {
    const key = `${f.kind}:${f.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // A bare CLAUDE.md is not evidence of a configured orchestrator/review layer —
  // nearly every project has one. Require either a detected skill/command/agent,
  // or a *dedicated* rule file (agent-routing.md, verifier-protocol.md, …).
  const dedicatedRefs = proseRefs.filter((r) => r.name !== 'CLAUDE.md');
  if (!items.length && !dedicatedRefs.length) {
    return unconfigured(
      kind === 'orchestrators'
        ? 'no orchestrator skills/commands and no routing rules found — Claude Code built-in defaults apply'
        : 'no reviewer agents/commands and no review or verifier rules found',
      { proseRefs },
    );
  }
  return ok(items, { proseRefs, interpretation: 'required' });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  REDACT = !opts.includeValues;

  const userDir = opts.root ? opts.root : join(HOME, '.claude');
  const roots = [{ label: 'user', dir: userDir, claudeMd: join(userDir, 'CLAUDE.md') }];
  if (opts.project) {
    roots.push({ label: 'project', dir: join(opts.project, '.claude'), claudeMd: join(opts.project, 'CLAUDE.md') });
  }

  const sources = roots.map((r) => ({ scope: r.label, path: scrub(r.dir), exists: isDir(r.dir) }));
  const settingsFiles = collectSettings(roots);

  const agents = layer(() => scanAgents(roots), 'agents');
  const commands = layer(() => scanCommands(roots), 'commands');
  const skills = layer(() => scanSkills(roots), 'skills');
  const rules = layer(() => scanRules(roots), 'rules');

  const doc = {
    schemaVersion: SCHEMA_VERSION,
    tool: 'harness-map',
    redacted: REDACT,
    sources,
    settingsFiles: settingsFiles.map((s) => ({ scope: s.scope, file: s.file })),
    layers: {
      agents,
      hooks: layer(() => scanHooks(settingsFiles), 'hooks'),
      environment: layer(() => scanEnvironment(settingsFiles), 'environment'),
      commands,
      skills,
      plugins: layer(() => scanPlugins(userDir, settingsFiles), 'plugins'),
      mcp: layer(() => scanMcp(settingsFiles, roots, userDir, opts.project), 'mcp'),
      rules,
      orchestrators: layer(() => scanProseLayer('orchestrators', { skills, commands, agents, rules }), 'orchestrators'),
      review: layer(() => scanProseLayer('review', { skills, commands, agents, rules }), 'review'),
    },
  };

  process.stdout.write(JSON.stringify(doc, null, opts.pretty ? 2 : 0) + '\n');
  return 0;
}

process.exit(main());
