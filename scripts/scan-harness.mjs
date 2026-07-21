#!/usr/bin/env node
/**
 * scan-harness.mjs — deterministic Claude Code harness scanner.
 *
 * Reads a Claude Code configuration and emits a JSON document describing the
 * harness topology: agents and their model bindings, hooks, commands, skills,
 * plugins, MCP servers, and pointers to prose rule files.
 *
 * PRIVACY MODEL — ALLOWLIST, NOT BLOCKLIST.
 * An earlier version tried to redact values that "looked like" secrets. That
 * cannot work: `SERVICE_URL=postgres://admin:pw@host` is neither a secret-shaped
 * key nor a branded token, and it leaked verbatim. The space of things that look
 * like a credential is unbounded, so a blocklist can never support a
 * "safe to share" guarantee.
 *
 * This version emits ONLY structurally safe shapes:
 *   - identifiers the user authored (agent/skill/command/server/plugin names)
 *   - enumerations (model, transport, scope, event, status)
 *   - counts and booleans
 *   - paths relative to a scanned root; never absolute paths
 * Free-form values are never emitted: no env values (outside a known-safe
 * allowlist of non-sensitive Claude Code variables), no hook or status-line
 * command text, no MCP URLs, no permission rule arguments.
 *
 * Descriptions ARE emitted. They are authored prose whose whole purpose is to be
 * read by a model for routing, and hiding them would defeat the tool. This is a
 * deliberate, documented exception — not an oversight.
 *
 * Zero dependencies. Read-only, except for the opt-in --probe-hooks mode, which
 * executes the user's own PreToolUse hooks against synthetic input in order to
 * verify (rather than assume) that a guard actually blocks.
 *
 * Usage:
 *   node scan-harness.mjs [--pretty] [--root <dir>] [--project <dir>]
 *                         [--include-values] [--probe-hooks]
 */

import { readFileSync, readdirSync, existsSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, basename, dirname, extname, relative, sep, isAbsolute } from 'node:path';

const SCHEMA_VERSION = 2;
const HOME = homedir();

// Resource budgets. Without these a 500MB claude.json blocks the host process.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIR_ENTRIES = 2000;
const MAX_WALK_DEPTH = 3;
const PROBE_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { pretty: false, includeValues: false, probeHooks: false, root: null, project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pretty') opts.pretty = true;
    else if (a === '--include-values') opts.includeValues = true;
    else if (a === '--probe-hooks') opts.probeHooks = true;
    else if (a === '--json') opts.pretty = false;
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

const HELP = `scan-harness — emit a JSON map of a Claude Code harness config

  --pretty           indent the JSON output
  --root <dir>       config root to scan (default: ~/.claude)
  --project <dir>    project dir containing .claude/, CLAUDE.md and .mcp.json
  --probe-hooks      EXECUTE this machine's PreToolUse hooks against synthetic
                     input to verify a guard actually blocks. Runs the user's own
                     shell commands: off by default, opt in deliberately.
  --include-values   emit raw values (UNSAFE TO SHARE)
  --help             show this message
`;

let REDACT = true;
const HIDDEN = '<hidden>';

// ---------------------------------------------------------------------------
// safe fs helpers — bounded, symlink-aware, never throw
// ---------------------------------------------------------------------------

function readTextBounded(p) {
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return readFileSync(p, 'utf8');
  } catch { return null; }
}
const readJson = (p) => { try { return JSON.parse(readTextBounded(p) ?? ''); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const listDir = (p) => { try { return readdirSync(p).slice(0, MAX_DIR_ENTRIES); } catch { return []; } };

/**
 * Recursively collect files with an extension. Skips symlinked directories and
 * tracks visited inodes, so a symlink loop or a fan-out farm cannot spin here.
 */
function walk(dir, ext, maxDepth = MAX_WALK_DEPTH, depth = 0, out = [], seen = new Set()) {
  if (depth > maxDepth || out.length > MAX_DIR_ENTRIES) return out;
  let key;
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) return out;
    key = `${st.dev}:${st.ino}`;
    if (seen.has(key)) return out;
    seen.add(key);
  } catch { return out; }

  for (const entry of listDir(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) continue; // never follow links out of the config tree
    if (st.isDirectory()) walk(full, ext, maxDepth, depth + 1, out, seen);
    else if (st.isFile() && extname(entry) === ext) out.push(full);
  }
  return out;
}

/** True when `p` resolves to a location inside `root` (symlink escapes rejected). */
function containedIn(p, root) {
  try {
    const rp = realpathSync(p);
    const rr = realpathSync(root);
    return rp === rr || rp.startsWith(rr + sep);
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// emission policy (the allowlist)
// ---------------------------------------------------------------------------

let ROOTS = [];

/**
 * Paths are emitted relative to the scanned root, scope-prefixed. Absolute paths
 * are never emitted: an earlier build leaked `/Volumes/Clients/Acme-Secret/...`
 * because it only knew how to collapse the current user's home directory.
 */
function pathOf(abs) {
  if (!REDACT) return abs;
  if (typeof abs !== 'string') return null;
  for (const { label, dir } of ROOTS) {
    if (abs === dir) return `${label}:.`;
    if (abs.startsWith(dir + sep)) return `${label}:${relative(dir, abs)}`;
  }
  const parent = dirname(abs);
  for (const { label, dir } of ROOTS) {
    if (parent === dirname(dir)) return `${label}:../${basename(abs)}`;
  }
  return '<external path>';
}

/** Identifiers are emitted, but bounded so a pathological name cannot dominate. */
const ident = (s, n = 80) => {
  if (s == null) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
};

const truncate = (s, n) =>
  typeof s === 'string' && s.length > n ? s.slice(0, n).trimEnd() + '…' : s;

/**
 * Environment values are hidden by default. Only variables on this list have
 * their value emitted, because the map needs them and they are non-sensitive by
 * construction (numeric or boolean Claude Code settings).
 */
const SAFE_ENV_VALUES = new Set([
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'DISABLE_AUTO_COMPACT',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_TIMEOUT_MS',
  'MAX_THINKING_TOKENS',
  'DISABLE_TELEMETRY',
  'DISABLE_COST_WARNINGS',
]);
function envValue(key, value) {
  if (!REDACT) return String(value);
  if (!SAFE_ENV_VALUES.has(key)) return HIDDEN;
  const v = String(value);
  // Even allowlisted keys only pass through if the value is a simple scalar.
  return /^[\w.-]{1,32}$/.test(v) ? v : HIDDEN;
}

/**
 * Commands are described, never quoted. Truncating a command does not redact it:
 * `client --session <uuid>` leaked a live token through an 80-character preview.
 * Only the executable and any referenced in-tree script are emitted.
 */
function describeCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (!REDACT) return { raw: cmd };
  const firstWord = cmd.trim().split(/\s+/)[0] ?? '';
  const exe = basename(firstWord.replace(/[;&|(){}'"]/g, '')) || null;
  const scriptAbs = cmd.match(/\/[\w.\-/]+\.(?:mjs|js|sh|py|ts)\b/)?.[0] ?? null;
  return {
    exe: ident(exe, 40),
    script: scriptAbs ? basename(scriptAbs) : null,
    length: cmd.length,
  };
}

/** URLs collapse to scheme + host. Userinfo, path, query and fragment are dropped. */
function describeUrl(u) {
  if (!u) return null;
  if (!REDACT) return String(u);
  try {
    const parsed = new URL(String(u));
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch { return '<url>'; }
}

/**
 * Permission rules reduce to a tool name only when the string matches a strict
 * tool grammar. Anything else becomes `(unrecognized)` — the previous
 * `split('(')[0]` emitted the entire rule whenever it contained no parenthesis,
 * exposing e.g. `Bash cat ~/.ssh/id_rsa` as a "tool name".
 */
const TOOL_NAME_RE = /^([A-Za-z][A-Za-z0-9_]*)(\(|$)/;
function permissionTool(rule) {
  const m = String(rule).match(TOOL_NAME_RE);
  if (!m) return '(unrecognized)';
  const name = m[1];
  return name.length <= 64 ? name : '(unrecognized)';
}

// ---------------------------------------------------------------------------
// frontmatter — strict subset; refuses to guess
// ---------------------------------------------------------------------------

/**
 * Parses a small, well-defined subset of YAML and REFUSES anything outside it,
 * recording a warning instead of approximating. A wrong value is worse than a
 * missing one here, because the audit makes assertions from these fields.
 *
 * Supported: plain scalars, single-quoted, double-quoted without escapes, block
 * scalars `>`/`|` with optional `-`/`+` chomping, and empty values (-> null).
 * Refused: indentation indicators (`>2`), double-quoted strings containing
 * backslash escapes, duplicate keys, anchors/aliases/tags.
 */
function parseFrontmatter(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;

  const fm = {};
  const warnings = [];
  const lines = m[1].split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    if (/^\s/.test(rawLine) || rawLine.trimStart().startsWith('-')) continue;
    const kv = rawLine.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();

    if (Object.prototype.hasOwnProperty.call(fm, key)) {
      warnings.push(`duplicate key '${key}'`);
      continue;
    }

    if (value === '') {
      // Could be YAML null or the start of a nested block; either way there is
      // no scalar here. Record null rather than an empty string.
      const next = lines[i + 1];
      if (next && /^\s+\S/.test(next)) { fm[key] = null; continue; }
      fm[key] = null;
      continue;
    }
    if (value.startsWith('&') || value.startsWith('*') || value.startsWith('!')) {
      warnings.push(`unsupported anchor/alias/tag for '${key}'`);
      continue;
    }

    const block = value.match(/^([>|])([0-9]*)([-+]?)$/);
    if (block) {
      if (block[2]) { warnings.push(`indentation indicator unsupported for '${key}'`); continue; }
      const body = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() && !/^\s/.test(next)) break;
        body.push(next.replace(/^\s{0,8}/, ''));
        i++;
      }
      while (body.length && !body[body.length - 1].trim()) body.pop();
      if (block[1] === '>') {
        // Folded: blank lines are paragraph breaks and must survive folding.
        const paras = body.join('\n').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim());
        value = paras.filter(Boolean).join('\n\n');
      } else {
        value = body.join('\n');
      }
      if (block[3] === '-') value = value.replace(/\n+$/, '');
      fm[key] = value;
      continue;
    }

    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
      if (value.includes('\\')) { warnings.push(`escape sequences unsupported for '${key}'`); continue; }
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    fm[key] = value;
  }

  Object.defineProperty(fm, '__warnings', { value: warnings, enumerable: false });
  return fm;
}

// ---------------------------------------------------------------------------
// layer helpers
// ---------------------------------------------------------------------------

const ok = (items, extra = {}) => ({ status: 'ok', count: items.length, items, ...extra });
const unconfigured = (reason, extra = {}) => ({ status: 'unconfigured', count: 0, items: [], reason, ...extra });

function layer(fn, label) {
  try { return fn(); }
  catch (err) { return { status: 'error', count: 0, items: [], reason: `failed to scan ${label}: ${err.message}` }; }
}

function collectSettings(roots) {
  const files = [];
  for (const { label, dir } of roots) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const p = join(dir, name);
      const data = readJson(p);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        files.push({ scope: label, file: pathOf(p), data });
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------

function scanAgents(roots) {
  const items = [];
  const parseWarnings = [];
  for (const { label, dir } of roots) {
    const agentsDir = join(dir, 'agents');
    if (!isDir(agentsDir)) continue;
    for (const file of walk(agentsDir, '.md', 2)) {
      const fm = parseFrontmatter(readTextBounded(file));
      if (!fm) continue;
      if (fm.__warnings?.length) parseWarnings.push({ file: pathOf(file), warnings: fm.__warnings });
      items.push({
        name: ident(fm.name || basename(file, '.md')),
        model: fm.model ? ident(fm.model, 40) : null,
        description: truncate(fm.description ?? '', 200) || null,
        descriptionLength: (fm.description ?? '').length,
        tools: fm.tools ? truncate(fm.tools, 60) : null,
        scope: label,
        file: pathOf(file),
      });
    }
  }
  if (!items.length) return unconfigured('no agents/*.md with frontmatter found');

  const byModel = {};
  for (const a of items) byModel[a.model || '(unset)'] = (byModel[a.model || '(unset)'] || 0) + 1;
  return ok(items.sort((a, b) => a.name.localeCompare(b.name)), {
    byModel,
    bareInherit: items.filter((a) => a.model === 'inherit').map((a) => a.name),
    unpinned: items.filter((a) => !a.model).map((a) => a.name),
    parseWarnings,
  });
}

function scanHooks(settingsFiles) {
  const items = [];
  for (const { scope, file, data } of settingsFiles) {
    const hooks = data?.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) continue;
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        for (const def of Array.isArray(entry?.hooks) ? entry.hooks : []) {
          items.push({
            event: ident(event, 40),
            matcher: entry?.matcher === '' || entry?.matcher == null ? '(all)' : ident(entry.matcher, 60),
            type: ident(def?.type, 20),
            timeout: typeof def?.timeout === 'number' ? def.timeout : null,
            command: describeCommand(def?.command),
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

  // Referenced scripts: only existence and in-tree name are emitted.
  const scriptRefs = [];
  const seenPath = new Set();
  for (const { data } of settingsFiles) {
    for (const entries of Object.values(data?.hooks ?? {})) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries) for (const h of e?.hooks ?? []) {
        for (const p of String(h?.command ?? '').match(/\/[\w.\-/]+\.(?:mjs|js|sh|py|ts)\b/g) ?? []) {
          if (seenPath.has(p)) continue;
          seenPath.add(p);
          scriptRefs.push({ path: pathOf(p), name: basename(p), exists: existsSync(p) });
        }
      }
    }
  }

  return ok(items, {
    byEvent,
    events: Object.keys(byEvent).sort(),
    scriptRefs,
    missingTimeout: items.filter((h) => h.timeout == null).length,
  });
}

/**
 * Execute this machine's PreToolUse hooks against synthetic tool input to learn
 * whether a guard actually blocks. Opt-in only.
 *
 * Pattern-matching a hook's command text cannot establish this: a hook reading
 * `echo 'rm -rf, drop table' >/dev/null; exit 0` matches every guard pattern and
 * blocks nothing. Only running it and observing the exit status is proof.
 *
 * Rails: 2s timeout, throwaway cwd, minimal environment, no stdio inheritance,
 * and HARNESS_MAP_PROBE=1 so a hook can detect a probe and no-op.
 */
const PROBE_COMMANDS = {
  'rm -rf': 'rm -rf /tmp/harness-map-probe-target',
  'drop table': 'psql -c "drop table users"',
  'drop database': 'psql -c "drop database production"',
  'reset --hard': 'git reset --hard HEAD~5',
  'force push': 'git push --force origin main',
};

function probeHooks(settingsFiles) {
  const results = {};
  const cwd = tmpdir();
  const commands = [];
  for (const { data } of settingsFiles) {
    for (const e of data?.hooks?.PreToolUse ?? []) {
      const matcher = e?.matcher ?? '';
      if (matcher && !/bash/i.test(matcher)) continue; // only Bash-facing guards
      for (const h of e?.hooks ?? []) if (h?.type === 'command' && h?.command) commands.push(String(h.command));
    }
  }

  for (const [pattern, synthetic] of Object.entries(PROBE_COMMANDS)) {
    const toolInput = JSON.stringify({ tool_name: 'Bash', command: synthetic });
    let blocked = false;
    let ran = 0;
    for (const command of commands) {
      try {
        const r = spawnSync('sh', ['-c', command], {
          cwd,
          timeout: PROBE_TIMEOUT_MS,
          stdio: ['ignore', 'ignore', 'ignore'],
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: process.env.HOME ?? HOME,
            TOOL_INPUT: toolInput,
            CLAUDE_TOOL_INPUT: toolInput,
            HARNESS_MAP_PROBE: '1',
          },
        });
        ran++;
        if (typeof r.status === 'number' && r.status !== 0) blocked = true;
      } catch { /* a hook that cannot run is not a guard */ }
    }
    results[pattern] = { blocked, hooksRun: ran };
  }
  return { probed: true, hookCount: commands.length, results };
}

function scanCommands(roots) {
  const items = [];
  for (const { label, dir } of roots) {
    const cmdDir = join(dir, 'commands');
    if (!isDir(cmdDir)) continue;
    for (const file of walk(cmdDir, '.md', 3)) {
      const fm = parseFrontmatter(readTextBounded(file)) || {};
      const rel = relative(cmdDir, file).replace(/\.md$/, '');
      const parts = rel.split(sep);
      const name = parts.length > 1 ? `${parts.slice(0, -1).join(':')}:${parts.at(-1)}` : parts[0];
      items.push({
        name: `/${ident(name, 60)}`,
        description: truncate(fm.description ?? '', 160) || null,
        scope: label,
        file: pathOf(file),
      });
    }
  }
  return items.length ? ok(items.sort((a, b) => a.name.localeCompare(b.name))) : unconfigured('no commands/*.md found');
}

function scanSkills(roots) {
  const items = [];
  const parseWarnings = [];
  for (const { label, dir } of roots) {
    const skillsDir = join(dir, 'skills');
    if (!isDir(skillsDir)) continue;
    for (const entry of listDir(skillsDir)) {
      const skillFile = join(skillsDir, entry, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const fm = parseFrontmatter(readTextBounded(skillFile)) || {};
      if (fm.__warnings?.length) parseWarnings.push({ file: pathOf(skillFile), warnings: fm.__warnings });
      items.push({
        name: ident(fm.name || entry),
        description: truncate(fm.description ?? '', 200) || null,
        descriptionLength: (fm.description ?? '').length,
        scope: label,
      });
    }
  }
  return items.length
    ? ok(items.sort((a, b) => a.name.localeCompare(b.name)), { parseWarnings })
    : unconfigured('no skills/*/SKILL.md found');
}

function scanPlugins(userDir, settingsFiles) {
  const installed = readJson(join(userDir, 'plugins', 'installed_plugins.json'));
  const known = readJson(join(userDir, 'plugins', 'known_marketplaces.json'));
  const items = [];

  const enabledMap = {};
  for (const { data } of settingsFiles) {
    const ep = data?.enabledPlugins;
    if (ep && typeof ep === 'object' && !Array.isArray(ep)) Object.assign(enabledMap, ep);
  }

  const plugins = installed?.plugins;
  if (plugins && typeof plugins === 'object') {
    for (const [key, entries] of Object.entries(plugins)) {
      const [name, marketplace] = String(key).split('@');
      const first = Array.isArray(entries) ? entries[0] : entries;
      items.push({
        name: ident(name),
        marketplace: ident(marketplace, 60) ?? null,
        scope: ident(first?.scope, 20) ?? null,
        version: ident(first?.version, 40) ?? null,
        enabled: key in enabledMap ? Boolean(enabledMap[key]) : null,
      });
    }
  }

  const marketplaces = [];
  if (known && typeof known === 'object') {
    for (const [name, meta] of Object.entries(known)) {
      const src = meta?.source ?? {};
      marketplaces.push({
        name: ident(name),
        type: ident(src.source, 20) ?? null,
        // A marketplace repo slug is a public identifier; a local path is not.
        repo: src.repo ? ident(src.repo, 80) : src.path ? pathOf(src.path) : null,
      });
    }
  }

  if (!items.length && !marketplaces.length) return unconfigured('no installed plugins or marketplaces found');
  return ok(items.sort((a, b) => a.name.localeCompare(b.name)), {
    marketplaces,
    disabled: items.filter((p) => p.enabled === false).map((p) => p.name),
  });
}

/**
 * MCP servers, resolved in Claude Code's documented precedence order:
 *   local (project entry in claude.json) > project (.mcp.json) > user > plugin
 * Only the ACTIVE project's local entry participates; other projects are counted
 * but their paths are never emitted (they name client work and private repos).
 */
function scanMcp(settingsFiles, roots, userDir, projectPath) {
  const layers = { local: [], project: [], user: [], plugin: [] };
  const mk = (name, cfg, origin, extra = {}) => ({
    name: ident(name),
    origin,
    transport: cfg?.type ?? (cfg?.url ? 'http' : cfg?.command ? 'stdio' : null),
    command: cfg?.command ? ident(basename(String(cfg.command)), 40) : null,
    argsCount: Array.isArray(cfg?.args) ? cfg.args.length : 0,
    envKeys: cfg?.env && typeof cfg.env === 'object' ? Object.keys(cfg.env).map((k) => ident(k, 40)) : [],
    url: describeUrl(cfg?.url),
    ...extra,
  });
  const each = (obj, fn) => { if (obj && typeof obj === 'object' && !Array.isArray(obj)) for (const [n, c] of Object.entries(obj)) fn(n, c); };

  const claudeJsonPath = join(dirname(userDir), '.claude.json');
  const claudeJson = readJson(claudeJsonPath);
  const activeProject = projectPath ? realpathOr(projectPath) : null;
  let otherProjectServers = 0;
  let otherProjects = 0;

  if (claudeJson) {
    each(claudeJson.mcpServers, (n, c) => layers.user.push(mk(n, c, 'user')));
    const projects = claudeJson.projects;
    if (projects && typeof projects === 'object') {
      for (const [path, cfg] of Object.entries(projects)) {
        const servers = cfg?.mcpServers;
        if (!servers || typeof servers !== 'object') continue;
        if (activeProject && realpathOr(path) === activeProject) {
          each(servers, (n, c) => layers.local.push(mk(n, c, 'local')));
        } else {
          otherProjects++;
          otherProjectServers += Object.keys(servers).length;
        }
      }
    }
  }

  for (const { scope, data } of settingsFiles) {
    each(data?.mcpServers, (n, c) => layers[scope === 'project' ? 'project' : 'user'].push(mk(n, c, `settings (${scope})`)));
  }

  // Project-scope file lives at <project>/.mcp.json — NOT <project>/.claude/.mcp.json.
  if (projectPath) {
    each(readJson(join(projectPath, '.mcp.json'))?.mcpServers, (n, c) => layers.project.push(mk(n, c, 'project')));
  }
  for (const { dir } of roots) {
    each(readJson(join(dir, '.mcp.json'))?.mcpServers, (n, c) => layers.user.push(mk(n, c, 'user')));
  }

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
      const candidates = [join(dir, entry, '.mcp.json'), ...listDir(join(dir, entry)).map((s) => join(dir, entry, s, '.mcp.json'))];
      for (const candidate of candidates) {
        const data = readJson(candidate);
        if (!data) continue;
        const owner = basename(dirname(candidate));
        const enabled = pluginEnabled(owner);
        each(data.mcpServers, (n, c) => layers.plugin.push(mk(n, c, 'plugin', { plugin: ident(owner), enabled })));
      }
    }
  }

  // Precedence: first definition wins, walking highest-priority scope first.
  const resolved = new Map();
  for (const scope of ['local', 'project', 'user', 'plugin']) {
    for (const s of layers[scope]) {
      const prev = resolved.get(s.name);
      if (!prev) resolved.set(s.name, { ...s, active: s.enabled !== false });
      else (prev.shadowed ||= []).push(s.origin);
    }
  }
  const items = [...resolved.values()];

  const caveat = 'Account-level connectors (for example Gmail, Drive, Figma, Slack) are provisioned server-side and cannot be detected from configuration files.';
  if (!items.length) {
    return unconfigured('no MCP servers found in settings, claude.json, or plugins', { caveat, otherProjects, otherProjectServers });
  }
  const byOrigin = {};
  for (const m of items) byOrigin[m.origin] = (byOrigin[m.origin] || 0) + 1;
  return ok(items, {
    byOrigin,
    caveat,
    otherProjects,
    otherProjectServers,
    inactive: items.filter((m) => !m.active).length,
  });
}

const realpathOr = (p) => { try { return realpathSync(p); } catch { return p; } };

function scanEnvironment(settingsFiles) {
  const env = {};
  const permissions = { allow: 0, deny: 0, ask: 0, defaultMode: null, toolBreakdown: {}, unrecognized: 0 };
  let model = null;
  let statusLine = null;

  for (const { data } of settingsFiles) {
    if (!data) continue;
    if (typeof data.model === 'string') model = ident(data.model, 60);
    if (data.statusLine && typeof data.statusLine === 'object') {
      const raw = String(data.statusLine.command ?? '');
      const ref = raw.match(/\/[\w.\-/]+\.(?:sh|mjs|js|py|ts)\b/)?.[0] ?? null;
      statusLine = {
        type: ident(data.statusLine.type, 20),
        command: describeCommand(data.statusLine.command),
        script: ref ? { name: basename(ref), exists: existsSync(ref) } : null,
      };
    }
    if (data.env && typeof data.env === 'object' && !Array.isArray(data.env)) {
      for (const [k, v] of Object.entries(data.env)) env[ident(k, 60)] = envValue(k, v);
    }
    const p = data.permissions;
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      if (typeof p.defaultMode === 'string') permissions.defaultMode = ident(p.defaultMode, 30);
      for (const bucket of ['allow', 'deny', 'ask']) {
        const list = p[bucket];
        if (!Array.isArray(list)) continue;
        permissions[bucket] += list.length;
        if (bucket !== 'allow') continue;
        for (const rule of list) {
          const tool = permissionTool(rule);
          if (tool === '(unrecognized)') permissions.unrecognized++;
          else permissions.toolBreakdown[tool] = (permissions.toolBreakdown[tool] || 0) + 1;
        }
      }
    }
  }

  if (!(model || statusLine || Object.keys(env).length || permissions.allow)) {
    return { status: 'unconfigured', reason: 'no model/env/permissions/statusLine in settings' };
  }
  return { status: 'ok', model, statusLine, env, permissions };
}

/** Rule files are read for headings only, and never through a symlink. */
function scanRules(roots) {
  const items = [];
  const headingsOf = (text, n) => text.split(/\r?\n/)
    .filter((l) => /^#{1,3}\s/.test(l))
    .map((l) => truncate(l.replace(/^#+\s*/, '').trim(), 90))
    .slice(0, n);

  for (const { label, dir } of roots) {
    const rulesDir = join(dir, 'rules');
    if (!isDir(rulesDir)) continue;
    for (const file of walk(rulesDir, '.md', 1)) {
      const text = readTextBounded(file);
      if (text == null) continue;
      items.push({ name: ident(basename(file, '.md')), file: pathOf(file), headings: headingsOf(text, 12), scope: label, contained: true });
    }
  }
  for (const { label, dir, claudeMd } of roots) {
    const p = claudeMd || join(dir, 'CLAUDE.md');
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    const text = readTextBounded(p);
    if (text == null) continue;
    items.push({ name: 'CLAUDE.md', file: pathOf(p), headings: headingsOf(text, 20), scope: label, contained: true });
  }
  return items.length ? ok(items) : unconfigured('no rules/*.md or CLAUDE.md found');
}

const ORCHESTRATOR_NAMES = ['goal', 'loop', 'supergoal', 'ultrawork', 'improve', 'gsd', 'ship-issue', 'foreman'];
const REVIEWER_HINTS = ['review', 'linus', 'codex', 'gemini', 'neo', 'verifier', 'critic', 'audit'];
const PACK_PREFIXES = ['recipe-', 'persona-', 'gws-'];
const inSkillPack = (n) => PACK_PREFIXES.some((p) => String(n).toLowerCase().startsWith(p));

function scanProseLayer(kind, { skills, commands, agents, rules }) {
  const names = kind === 'orchestrators' ? ORCHESTRATOR_NAMES : REVIEWER_HINTS;
  const match = (n) => {
    if (inSkillPack(n)) return false;
    const lower = String(n).toLowerCase();
    return names.some((k) => (kind === 'orchestrators' ? lower === k : lower.includes(k)));
  };

  const found = [];
  for (const s of skills.items ?? []) if (match(s.name)) found.push({ kind: 'skill', name: s.name });
  for (const c of commands.items ?? []) if (match(String(c.name).replace(/^\//, '').split(':').pop())) found.push({ kind: 'command', name: c.name });
  for (const a of agents.items ?? []) if (match(a.name)) found.push({ kind: 'agent', name: a.name });

  const wanted = kind === 'orchestrators'
    ? ['agent-routing', 'context-hygiene', 'CLAUDE.md']
    : ['verifier-protocol', 'agent-routing', 'safety', 'CLAUDE.md'];
  // Only contained, non-symlinked files are offered for interpretation.
  const proseRefs = (rules.items ?? [])
    .filter((r) => r.contained && wanted.some((w) => r.name.includes(w)))
    .map((r) => ({ name: r.name, file: r.file, headings: r.headings }));

  const seen = new Set();
  const items = found.filter((f) => {
    const key = `${f.kind}:${f.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

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
  if (opts.help) { process.stdout.write(HELP); return 0; }
  REDACT = !opts.includeValues;

  const userDir = opts.root ? opts.root : join(HOME, '.claude');
  const roots = [{ label: 'user', dir: userDir, claudeMd: join(userDir, 'CLAUDE.md') }];
  if (opts.project) {
    roots.push({ label: 'project', dir: join(opts.project, '.claude'), claudeMd: join(opts.project, 'CLAUDE.md') });
  }
  ROOTS = roots;

  const settingsFiles = collectSettings(roots);
  const agents = layer(() => scanAgents(roots), 'agents');
  const commands = layer(() => scanCommands(roots), 'commands');
  const skills = layer(() => scanSkills(roots), 'skills');
  const rules = layer(() => scanRules(roots), 'rules');
  const hooks = layer(() => scanHooks(settingsFiles), 'hooks');

  if (opts.probeHooks && hooks.status === 'ok') {
    try { hooks.probe = probeHooks(settingsFiles); }
    catch (e) { hooks.probe = { probed: false, reason: e.message }; }
  }

  const doc = {
    schemaVersion: SCHEMA_VERSION,
    tool: 'harness-map',
    redacted: REDACT,
    hooksProbed: Boolean(opts.probeHooks),
    sources: roots.map((r) => ({ scope: r.label, path: pathOf(r.dir), exists: isDir(r.dir) })),
    settingsFiles: settingsFiles.map((s) => ({ scope: s.scope, file: s.file })),
    layers: {
      agents,
      hooks,
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
