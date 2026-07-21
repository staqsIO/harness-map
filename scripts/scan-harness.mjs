#!/usr/bin/env node
/**
 * scan-harness.mjs — deterministic Claude Code harness scanner.
 *
 * Reads a Claude Code configuration and emits a JSON document describing the
 * harness topology: agents and their model bindings, hooks, commands, skills,
 * plugins, MCP servers, and pointers to prose rule files.
 *
 * PRIVACY MODEL — ALLOWLIST, PLUS A PROSE OPT-IN.
 * Redaction by pattern ("hide things that look secret") cannot support a
 * safe-to-share claim: `SERVICE_URL=postgres://admin:pw@host` is neither a
 * secret-shaped key nor a branded token, and it leaked verbatim. So the default
 * document contains only shapes that cannot carry a secret:
 *   - enumerations (model, transport, scope, event, status)
 *   - counts, booleans, timeouts
 *   - paths relative to a scanned root; never absolute
 *   - opaque stable labels (agent-01, skill-03) in place of authored names
 * Never emitted: environment values (outside a short allowlist of non-sensitive
 * Claude Code variables), hook or status-line command text, MCP URLs and
 * hostnames, permission rule arguments, other projects' paths.
 *
 * Authored NAMES, DESCRIPTIONS and rule HEADINGS are free-form text the user
 * wrote, so they can contain anything and no scan can vet them. They require
 * --include-prose, which makes the output readable but no longer share-safe
 * without review. --include-values additionally disables the allowlist.
 *
 * Zero dependencies. Read-only: it never writes, and never executes any command
 * from the configuration it reads.
 *
 * Usage:
 *   node scan-harness.mjs [--pretty] [--root <dir>] [--project <dir>]
 *                         [--include-prose] [--include-values]
 */

import { readFileSync, readdirSync, existsSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname, extname, relative, sep, isAbsolute } from 'node:path';

const SCHEMA_VERSION = 2;
const HOME = homedir();

// Resource budgets. Without these a 500MB claude.json blocks the host process.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIR_ENTRIES = 2000;   // per readdir
const MAX_WALK_DIRS = 5000;     // global: directories entered in one walk
const MAX_WALK_ENTRIES = 50000; // global: entries examined in one walk
const MAX_WALK_DEPTH = 3;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { pretty: false, includeValues: false, includeProse: false, root: null, project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pretty') opts.pretty = true;
    else if (a === '--include-values') opts.includeValues = true;
    else if (a === '--include-prose') opts.includeProse = true;
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
  --include-prose    include authored names, descriptions and headings
                     (readable, but no longer safe to share unreviewed)
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
function walk(dir, ext, maxDepth = MAX_WALK_DEPTH, depth = 0, out = [], seen = new Set(), budget = null) {
  // The budget must count entries EXAMINED, globally — not matching files found.
  // A tree of 2000 directories each holding 2000 more contains no `.md` files, so
  // a `out.length` cap never trips while millions of entries are walked.
  const b = budget ?? { entries: 0, dirs: 0, exhausted: false };
  if (depth > maxDepth || b.exhausted) return out;
  if (b.dirs++ > MAX_WALK_DIRS) { b.exhausted = true; return out; }

  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) return out;
    const key = `${st.dev}:${st.ino}`;
    if (seen.has(key)) return out;
    seen.add(key);
  } catch { return out; }

  for (const entry of listDir(dir)) {
    if (b.entries++ > MAX_WALK_ENTRIES) { b.exhausted = true; return out; }
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) continue; // never follow links out of the config tree
    if (st.isDirectory()) walk(full, ext, maxDepth, depth + 1, out, seen, b);
    else if (st.isFile() && extname(entry) === ext) out.push(full);
    if (b.exhausted) return out;
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
// Hook event names, matchers and types come from the user's settings.json, so
// they are authored text rather than a closed enumeration. A matcher in
// particular is a free-form pattern. Emit the recognised vocabulary verbatim and
// collapse anything else to a placeholder, so the default document cannot carry
// a string the user wrote.
const CUSTOM = '<custom>';
const KNOWN_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop',
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'PreCompact', 'PostCompact',
]);
const KNOWN_HOOK_TYPES = new Set(['command', 'prompt']);
// Anthropic-published values, not text the user invented. Anything else is
// authored and collapses. `model` also accepts a published model id.
const KNOWN_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit', 'opusplan', 'default']);
const KNOWN_TRANSPORTS = new Set(['stdio', 'sse', 'http', 'https', 'ws', 'wss', 'sse-http']);
const KNOWN_STATUSLINE_TYPES = new Set(['command', 'static']);
const KNOWN_PERMISSION_MODES = new Set([
  'default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto',
]);
function modelLabel(raw) {
  if (raw == null) return null;
  const v = String(raw);
  if (!REDACT) return ident(v, 60);
  if (KNOWN_MODEL_ALIASES.has(v)) return v;
  return /^claude[\w.[\]-]{0,48}$/i.test(v) ? v : CUSTOM;
}
// Built-in tool names only. A matcher may alternate them with `|`; anything else
// (a custom regex, an MCP tool name, a plugin tool) is authored text.
const KNOWN_TOOLS = new Set([
  'Agent', 'Task', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch',
  'WebSearch', 'NotebookEdit', 'TodoWrite', 'ExitPlanMode', 'Artifact',
  'SlashCommand', 'KillShell', 'BashOutput', '*',
]);
function enumOr(value, allowed, placeholder) {
  const v = String(value ?? '');
  return allowed.has(v) ? v : placeholder;
}
function matcherLabel(raw) {
  if (raw === '' || raw == null) return '(all)';
  const v = String(raw);
  if (!REDACT) return ident(v, 60);
  // `manual|auto` on PreCompact and similar non-tool matchers are covered by the
  // tool list where they overlap; everything else is opaque.
  const parts = v.split('|');
  if (parts.length <= 8 && parts.every((t) => KNOWN_TOOLS.has(t))) return v;
  return CUSTOM;
}
function envValue(key, value) {
  if (!REDACT) return String(value);
  if (!SAFE_ENV_VALUES.has(key)) return HIDDEN;
  const v = String(value);
  // Even an allowlisted key only passes through if the VALUE is in the documented
  // domain for these variables: a number or a boolean. `\w` was far too wide —
  // DISABLE_TELEMETRY=CLIENT_ACME_PROD passed it verbatim.
  return /^(?:true|false|0|1|[0-9]{1,15}|[0-9]{1,12}\.[0-9]{1,4})$/i.test(v) ? v : HIDDEN;
}

/**
 * Commands are described, never quoted. Truncating a command does not redact it:
 * `client --session <uuid>` leaked a live token through an 80-character preview.
 * Only the executable and any referenced in-tree script are emitted.
 */
function describeCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (!REDACT) return { raw: cmd };
  // No substring of the command is emitted by default. Parsing out an
  // "executable" leaked `API_TOKEN=sk-live-...` from `API_TOKEN=... node x.js`,
  // and shell assignment prefixes, `env` wrappers and quoting make a correct
  // parse unreliable. Only the shape is reported.
  return { type: 'command', length: cmd.length };
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
  const nonScalar = new Set();
  const lines = m[1].split(/\r?\n/);
  // ALL-OR-NOTHING: any construct outside the supported subset rejects the whole
  // block. Returning a partially-guessed object is how a wrong `model:` or a
  // truncated `description:` reaches the audit and becomes a false assertion.
  const reject = (reason) => {
    const out = {};
    Object.defineProperty(out, '__rejected', { value: reason, enumerable: false });
    return out;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    // An indented line or a sequence entry at this point belongs to a nested
    // structure. This parser reads scalars only, so it does not try to represent
    // one — but it must not pretend the key was empty either: skipping the body
    // of `model:\n  family: haiku` yielded `model: null`, which the audit then
    // read as a real value ("no model pinned"). Instead the key is recorded as
    // NON-SCALAR and its body consumed. Callers that need the key as a scalar
    // treat it as unparsed; callers that ignore the key are unaffected, which is
    // what keeps a `metadata:` block from invalidating a whole SKILL.md.
    // `-foo: v` at column 0 is a top-level mapping KEY in YAML, because the dash
    // is not followed by whitespace. Only a dash followed by space (or a bare
    // dash) opens a sequence entry.
    if (/^\s/.test(rawLine) || /^-(?:\s|$)/.test(rawLine)) {
      return reject('indented line outside a nested value');
    }
    const kv = rawLine.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) return reject('unparseable line');
    const key = kv[1];
    let value = kv[2];

    if (Object.prototype.hasOwnProperty.call(fm, key)) return reject(`duplicate key '${key}'`);

    // `key:` with nothing after it, followed by an indented block or a sequence,
    // is a nested value. Consume the body, mark the key non-scalar, move on.
    if (value.trim() === '') {
      const body = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() === '') { body.push(next); i++; continue; }
        if (!/^\s/.test(next) && !/^-(?:\s|$)/.test(next)) break;
        body.push(next); i++;
      }
      if (body.some((l) => l.trim() !== '')) {
        nonScalar.add(key);
        fm[key] = null;
        continue;
      }
      // genuinely an empty scalar
      fm[key] = null;
      continue;
    }

    const blockHeader = value.trim().match(/^([>|])([0-9]*)([-+]?)(\s+#.*)?$/);
    if (blockHeader) {
      if (blockHeader[2]) return reject(`indentation indicator unsupported ('${key}')`);
      const chomp = blockHeader[3];
      const raw = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() && !/^\s/.test(next)) break;
        raw.push(next);
        i++;
      }
      // Base indent is the first non-empty line's indent — a fixed strip width
      // destroys meaningful relative indentation inside a literal block.
      const firstContent = raw.find((l) => l.trim());
      const baseIndent = firstContent ? (firstContent.match(/^\s*/)?.[0].length ?? 0) : 0;
      const body = raw.map((l) => (l.trim() ? l.slice(baseIndent) : ''));
      while (body.length && !body[body.length - 1].trim()) body.pop();

      if (blockHeader[1] === '>') {
        value = body.join('\n').split(/\n\s*\n/)
          .map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
      } else {
        value = body.join('\n');
      }
      if (chomp === '+') {
        const trailing = raw.length - body.length;
        value += '\n'.repeat(Math.max(0, trailing));
      } else if (chomp !== '-') {
        value += '\n'; // clip: exactly one trailing newline
      }
      fm[key] = value;
      continue;
    }

    value = value.trim();
    // `model: # note` has no value at all; the comment is not the value. Emitting
    // the comment text made a free-form string reach the default output through
    // the agent model field.
    if (value.startsWith('#')) { fm[key] = null; continue; }
    if (value === '') { fm[key] = null; continue; }
    if (value.startsWith('&') || value.startsWith('*') || value.startsWith('!')) {
      return reject(`anchor/alias/tag unsupported ('${key}')`);
    }
    if (value.startsWith('[') || value.startsWith('{')) return reject(`flow collection unsupported ('${key}')`);

    if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length < 2) return reject(`unterminated double quote ('${key}')`);
      if (value.slice(1, -1).includes('\\')) return reject(`escape sequences unsupported ('${key}')`);
      fm[key] = value.slice(1, -1);
      continue;
    }
    if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) return reject(`unterminated single quote ('${key}')`);
      fm[key] = value.slice(1, -1).replace(/''/g, "'");
      continue;
    }

    // Plain scalar: ` #` begins a comment in YAML, so it is not part of the value.
    value = value.replace(/\s+#.*$/, '').trim();
    if (/^(null|Null|NULL|~)$/.test(value)) { fm[key] = null; continue; }
    fm[key] = value;
  }
  if (nonScalar.size) {
    Object.defineProperty(fm, '__nonScalar', { value: nonScalar, enumerable: false });
  }
  return fm;
}

/** Reads frontmatter, returning `{fm, warning}` so callers can report rejections. */
function frontmatterOf(file) {
  const fm = parseFrontmatter(readTextBounded(file));
  if (!fm) return { fm: null, warning: null };
  if (fm.__rejected) return { fm: null, warning: fm.__rejected };
  return { fm, warning: null, nonScalar: fm.__nonScalar ?? new Set() };
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
      const { fm, warning, nonScalar } = frontmatterOf(file);
      if (warning) { parseWarnings.push({ file: pathOf(file), warnings: [warning] }); continue; }
      if (!fm) continue;
      // A nested `metadata:` block is irrelevant here; a nested `model:` is not.
      const bad = ['name', 'model', 'description', 'tools'].filter((k) => nonScalar?.has(k));
      if (bad.length) {
        parseWarnings.push({ file: pathOf(file), warnings: [`non-scalar value for ${bad.join(', ')}`] });
        continue;
      }
      items.push({
        name: ident(fm.name || basename(file, '.md')),
        model: fm.model == null ? null : modelLabel(fm.model),
        description: truncate(fm.description ?? '', 200) || null,
        descriptionLength: (fm.description ?? '').length,
        tools: fm.tools ? truncate(fm.tools, 60) : null,
        scope: label,
        file: pathOf(file),
      });
    }
  }
  if (!items.length) {
    // Distinguish "no agents" from "agents exist but none parsed". Collapsing
    // both to unconfigured reported a clean empty state for a directory whose
    // every file was rejected, and dropped the warnings that said why.
    if (parseWarnings.length) {
      return { status: 'ok', count: 0, items: [], byModel: {}, bareInherit: [], unpinned: [], parseWarnings };
    }
    return unconfigured('no agents/*.md with frontmatter found');
  }

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
            event: REDACT ? enumOr(event, KNOWN_EVENTS, CUSTOM) : ident(event, 40),
            matcher: matcherLabel(entry?.matcher),
            type: REDACT ? enumOr(def?.type, KNOWN_HOOK_TYPES, CUSTOM) : ident(def?.type, 20),
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
  // A relative or variable-rooted reference (./guard.sh, $CLAUDE_PROJECT_DIR/x.sh)
  // resolves against a working directory this scanner does not know, so it can be
  // COUNTED but not checked. Reporting only the absolute ones as "every script"
  // overstated the check's coverage.
  let unresolvedRefs = 0;
  const scriptRefs = [];
  const scriptIndex = new Map();
  const seenPath = new Set();
  for (const { data } of settingsFiles) {
    for (const entries of Object.values(data?.hooks ?? {})) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries) for (const h of e?.hooks ?? []) {
        const cmdText = String(h?.command ?? '');
        for (const m of cmdText.match(/(?:^|[\s'"=(])((?:\.{1,2}\/|~\/|\$[A-Za-z_][\w]*\/)[\w.\-/$]*\.(?:mjs|js|sh|py|ts))\b/g) ?? []) {
          if (m) unresolvedRefs++;
        }
        for (const p of cmdText.match(/\/[\w.\-/]+\.(?:mjs|js|sh|py|ts)\b/g) ?? []) {
          if (seenPath.has(p)) continue;
          seenPath.add(p);
          scriptIndex.set(p, scriptRefs.length);
          scriptRefs.push({ path: pathOf(p), name: basename(p), exists: existsSync(p) });
        }
      }
    }
  }

  // Two TEXT-LEVEL defect detectors. Each searches a hook's command (and the
  // script it references) for one specific mistake that makes the hook unable to
  // do its job. They prove nothing about runtime behaviour — see the README
  // section on what this tool does not check — but each one found real dead
  // hooks in a live config. The command text is read here and never emitted.
  //
  // 1. $TOOL_INPUT — Claude Code delivers hook data as JSON on STDIN. No such
  //    environment variable is set, so a hook reading it inspects an empty
  //    string and never matches.
  // 2. exit 1 — only exit 2 blocks a PreToolUse call. Exit 1 is a NON-blocking
  //    error: it is logged and the tool call proceeds.
  const defects = { readsToolInputEnv: [], nonBlockingExit: [] };
  const inspect = (event, matcher, command, scriptPath) => {
    // A hook's script BASENAME is a substring of its command and a name the user
    // chose, so it cannot appear in default output. Refer to the scriptRefs entry
    // by index instead; --include-prose restores the readable name.
    const ev = REDACT ? enumOr(event, KNOWN_EVENTS, CUSTOM) : event;
    let label;
    if (scriptPath) {
      const idx = scriptIndex.get(scriptPath);
      label = REDACT
        ? `script-${String((idx ?? 0) + 1).padStart(2, '0')}`
        : ident(basename(scriptPath), 60);
    } else {
      label = `${ev}[${matcherLabel(matcher)}] inline`;
    }
    let text = command;
    if (scriptPath && existsSync(scriptPath)) text += '\n' + (readTextBounded(scriptPath) ?? '');
    const usesEnv = /\$\{?TOOL_INPUT|\$\{?CLAUDE_TOOL_INPUT/.test(text);
    // `echo "$TOOL_INPUT" | python3 -c '...sys.stdin...'` does read stdin, but the
    // stdin it reads is a pipe carrying an empty variable, not the hook event.
    // Counting that as a stdin fallback masked two genuinely dead guards.
    const pipesEnv = /(?:echo|printf|cat)[^|\n]*\$\{?(?:CLAUDE_)?TOOL_INPUT[^|\n]*\|/.test(text);
    const readsStdin = /\bcat\b|sys\.stdin|process\.stdin|read -r|readFileSync\(0|\/dev\/stdin/.test(text);
    if (usesEnv && (pipesEnv || !readsStdin)) defects.readsToolInputEnv.push(label);
    if (event === 'PreToolUse' && /\bexit\s+1\b/.test(text) && !/\bexit\s+2\b/.test(text)) {
      defects.nonBlockingExit.push(label);
    }
  };
  for (const { data } of settingsFiles) {
    for (const [event, entries] of Object.entries(data?.hooks ?? {})) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries) for (const h of Array.isArray(e?.hooks) ? e.hooks : []) {
        if (!h?.command) continue;
        const cmd = String(h.command);
        const script = cmd.match(/\/[\w.\-/]+\.(?:mjs|js|sh|py|ts)\b/)?.[0] ?? null;
        inspect(event, e?.matcher, cmd, script);
      }
    }
  }

  return ok(items, {
    byEvent,
    events: Object.keys(byEvent).sort(),
    scriptRefs,
    unresolvedRefs,
    defects,
    missingTimeout: items.filter((h) => h.timeout == null).length,
  });
}

function scanCommands(roots) {
  const items = [];
  for (const { label, dir } of roots) {
    const cmdDir = join(dir, 'commands');
    if (!isDir(cmdDir)) continue;
    for (const file of walk(cmdDir, '.md', 3)) {
      const fm = frontmatterOf(file).fm || {};
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
      const { fm: parsed, warning, nonScalar } = frontmatterOf(skillFile);
      if (warning) parseWarnings.push({ file: pathOf(skillFile), warnings: [warning] });
      const badKeys = ['name', 'description'].filter((k) => nonScalar?.has(k));
      if (badKeys.length) {
        parseWarnings.push({ file: pathOf(skillFile), warnings: [`non-scalar value for ${badKeys.join(', ')}`] });
      }
      const fm = parsed || {};
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
    key: String(name),
    name: ident(name),
    origin,
    transport: (() => {
      const t = cfg?.type ?? (cfg?.url ? 'http' : cfg?.command ? 'stdio' : null);
      if (t == null) return null;
      return REDACT ? enumOr(t, KNOWN_TRANSPORTS, CUSTOM) : ident(t, 20);
    })(),
    command: cfg?.command ? ident(basename(String(cfg.command)), 40) : null,
    argsCount: Array.isArray(cfg?.args) ? cfg.args.length : 0,
    envKeys: cfg?.env && typeof cfg.env === 'object' ? Object.keys(cfg.env).map((k) => ident(k, 40)) : [],
    // A hostname can itself be sensitive (customer-acme-prod.internal.…), so the
    // default emits only whether the server is remote. Host requires opt-in.
    remote: Boolean(cfg?.url),
    url: REDACT ? null : (cfg?.url ? String(cfg.url) : null),
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
      // Key on the untruncated name: two servers sharing an 80-char prefix are
      // distinct servers, and collapsing them hides one from the inventory.
      const prev = resolved.get(s.key);
      if (!prev) resolved.set(s.key, { ...s, active: s.enabled !== false });
      else (prev.shadowed ||= []).push(s.origin);
    }
  }
  const items = [...resolved.values()].map(({ key, ...rest }) => rest);

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
    if (typeof data.model === 'string') model = modelLabel(data.model);
    if (data.statusLine && typeof data.statusLine === 'object') {
      const raw = String(data.statusLine.command ?? '');
      const ref = raw.match(/\/[\w.\-/]+\.(?:sh|mjs|js|py|ts)\b/)?.[0] ?? null;
      statusLine = {
        type: REDACT ? enumOr(data.statusLine.type, KNOWN_STATUSLINE_TYPES, CUSTOM) : ident(data.statusLine.type, 20),
        command: describeCommand(data.statusLine.command),
        script: ref ? { name: basename(ref), exists: existsSync(ref) } : null,
      };
    }
    if (data.env && typeof data.env === 'object' && !Array.isArray(data.env)) {
      for (const [k, v] of Object.entries(data.env)) env[ident(k, 60)] = envValue(k, v);
    }
    const p = data.permissions;
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      if (typeof p.defaultMode === 'string') {
        permissions.defaultMode = REDACT
          ? enumOr(p.defaultMode, KNOWN_PERMISSION_MODES, CUSTOM)
          : ident(p.defaultMode, 30);
      }
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
// prose pass — applied ONCE, immediately before serialization
// ---------------------------------------------------------------------------

/**
 * Names, descriptions and headings are text the user wrote by hand, so they can
 * contain anything: a token, a customer, an internal hostname, an incident. No
 * scan of that text can be trusted to find every such case, so by default they
 * are replaced with stable opaque labels and the default document is share-safe
 * by construction rather than by inspection.
 *
 * `--include-prose` puts the real text back for local reading. Scanning always
 * runs on the REAL names (orchestrator/reviewer detection depends on them); only
 * the emitted document is relabelled.
 */
function applyProsePolicy(doc, includeProse) {
  if (includeProse) return doc;
  const pad = (i) => String(i + 1).padStart(2, '0');
  const relabel = (layer, kind) => {
    if (!Array.isArray(layer?.items)) return new Map();
    const map = new Map();
    layer.items.forEach((it, i) => {
      if (typeof it.name !== 'string') return;
      const label = `${kind}-${pad(i)}`;
      map.set(it.name, label);
      it.name = label;
      if ('description' in it) it.description = null;
      if ('tools' in it) it.tools = null;
      // The filename carries the same name — keep the directory, drop the leaf.
      // Keep only scope + top-level directory: a nested path such as
      // `user:commands/codex/design-review.md` names the vendor in the directory.
      if (typeof it.file === 'string') {
        const m = it.file.match(/^([^:]*:)?([^/]+)\//);
        it.file = m ? `${m[1] ?? ''}${m[2]}/${label}${extname(it.file)}` : `${label}${extname(it.file)}`;
      }
    });
    return map;
  };

  const L = doc.layers ?? {};
  const agentNames = relabel(L.agents, 'agent');
  const skillNames = relabel(L.skills, 'skill');
  const commandNames = relabel(L.commands, 'command');
  relabel(L.mcp, 'mcp');
  relabel(L.plugins, 'plugin');

  // Aggregates that repeat a name must be relabelled too, or the mapping leaks.
  const remap = (arr, m) => (Array.isArray(arr) ? arr.map((n) => m.get(n) ?? n) : arr);
  if (L.agents?.status === 'ok') {
    L.agents.bareInherit = remap(L.agents.bareInherit, agentNames);
    L.agents.unpinned = remap(L.agents.unpinned, agentNames);
    L.agents.parseWarnings = (L.agents.parseWarnings ?? []).map((w) => ({ file: '<file>', warnings: w.warnings }));
  }
  if (L.skills?.status === 'ok') {
    L.skills.parseWarnings = (L.skills.parseWarnings ?? []).map((w) => ({ file: '<file>', warnings: w.warnings }));
  }
  if (L.plugins?.status === 'ok') {
    L.plugins.disabled = (L.plugins.disabled ?? []).map(() => '<plugin>');
    // A marketplace name is authored too (`staqs`), and it appears on every
    // plugin item as well as in the marketplaces list.
    const mkt = new Map();
    (L.plugins.marketplaces ?? []).forEach((m, i) => mkt.set(m.name, `marketplace-${pad(i)}`));
    L.plugins.marketplaces = (L.plugins.marketplaces ?? []).map((m) => ({ ...m, name: mkt.get(m.name), repo: null }));
    for (const p of L.plugins.items) {
      if (p.marketplace) p.marketplace = mkt.get(p.marketplace) ?? '<marketplace>';
      if (p.version) p.version = null; // a git sha identifies the source repo
    }
  }
  if (L.mcp?.status === 'ok') {
    for (const m of L.mcp.items) {
      if ('plugin' in m) m.plugin = m.plugin ? '<plugin>' : m.plugin;
      if ('command' in m) m.command = null;
      m.envKeys = (m.envKeys ?? []).map((_, i) => `env-${pad(i)}`);
    }
  }
  if (L.rules?.status === 'ok') {
    L.rules.items.forEach((r, i) => {
      r.headingCount = Array.isArray(r.headings) ? r.headings.length : 0;
      r.headings = [];
      // Rule filenames are the routing vocabulary; keep the well-known ones only.
      if (!/^(CLAUDE\.md|agent-routing|safety|verifier-protocol|context-hygiene|git-conventions)$/.test(r.name)) {
        r.name = `rule-${pad(i)}`;
      }
      r.file = '<file>';
    });
  }
  // Prose layers list detections by name.
  for (const key of ['orchestrators', 'review']) {
    const layer = L[key];
    if (layer?.status !== 'ok') continue;
    layer.items = (layer.items ?? []).map((it) => ({
      kind: it.kind,
      name: (it.kind === 'agent' ? agentNames.get(it.name)
        : it.kind === 'skill' ? skillNames.get(it.name)
          : commandNames.get(it.name)) ?? '<detected>',
    }));
    layer.proseRefs = (layer.proseRefs ?? []).map((r) => ({ name: r.name, file: '<file>', headings: [] }));
  }
  // Hook matchers are user-written; keep only simple tool-name forms.
  if (L.hooks?.status === 'ok') {
    for (const h of L.hooks.items) {
      if (typeof h.matcher === 'string' && !/^[A-Za-z0-9_|*().-]{0,60}$/.test(h.matcher)) h.matcher = '<custom>';
    }
    L.hooks.scriptRefs = (L.hooks.scriptRefs ?? []).map((r, i) => ({ path: '<file>', name: `script-${pad(i)}`, exists: r.exists }));
  }
  if (L.environment?.status === 'ok') {
    const env = {};
    let i = 0;
    for (const [k, v] of Object.entries(L.environment.env ?? {})) {
      if (SAFE_ENV_VALUES.has(k)) env[k] = v; else env[`env-${pad(i++)}`] = v;
    }
    L.environment.env = env;
    if (L.environment.statusLine?.script) L.environment.statusLine.script.name = '<script>';
    // An MCP tool identifier carries its server name (mcp__ideabrowser__…), so
    // only Claude Code's built-in tool names survive; the rest aggregate.
    const BUILTIN = new Set(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'Agent',
      'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite', 'Artifact', 'Skill', 'ToolSearch']);
    const tb = {};
    let mcpTools = 0;
    for (const [tool, n] of Object.entries(L.environment.permissions?.toolBreakdown ?? {})) {
      if (BUILTIN.has(tool)) tb[tool] = n; else mcpTools += n;
    }
    if (mcpTools) tb['(mcp tools)'] = mcpTools;
    if (L.environment.permissions) L.environment.permissions.toolBreakdown = tb;
  }
  doc.settingsFiles = (doc.settingsFiles ?? []).map((f) => ({ scope: f.scope, file: f.file }));
  return doc;
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


  const doc = {
    schemaVersion: SCHEMA_VERSION,
    tool: 'harness-map',
    redacted: REDACT,
    prose: Boolean(opts.includeProse),
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

  applyProsePolicy(doc, opts.includeProse || !REDACT);
  process.stdout.write(JSON.stringify(doc, null, opts.pretty ? 2 : 0) + '\n');
  return 0;
}

process.exit(main());
