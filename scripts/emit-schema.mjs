/**
 * emit-schema.mjs — the single gate every scan document passes through.
 *
 * WHY THIS EXISTS. The scanner used to decide what was safe at each of ~15
 * emission sites. That is a blocklist wearing an allowlist's clothes: it protects
 * the fields someone thought about, and a NEWLY ADDED field defaults to leaking.
 * Three consecutive cross-model reviews each found fields nobody had considered —
 * settings.model, statusLine.type, permissions.defaultMode, mcpServers[].type,
 * agent model, hook defect labels, plugin scope, marketplace type, the key quoted
 * inside a parse-warning message, rule filenames behind proseRefs. Every fix was
 * correct and every round found more, because "no authored text anywhere" is a
 * universal negative over a surface Claude Code keeps extending.
 *
 * So the shape is declared ONCE, here, and `gate()` builds the output document
 * from this declaration rather than from whatever the scanners happen to produce.
 * A field that is not declared below cannot reach the output, whoever adds it and
 * whenever. That turns the guarantee from "we remembered every field" into "the
 * document is constructed from a list", which is checkable by reading one file.
 *
 * Emitters are deliberately narrow. Each one answers "what shape may this field
 * be?", not "does this value look like a secret?" — pattern-matching for secrets
 * is what failed originally.
 */

export const CUSTOM = '<custom>';
export const HIDDEN = '<hidden>';

// --- vocabularies ----------------------------------------------------------
const STATUS = new Set(['ok', 'unconfigured', 'error']);
const SCOPES = new Set(['user', 'project', 'local', 'plugin', 'builtin', 'dynamic']);
const KINDS = new Set(['agent', 'command', 'skill']);
const ORIGINS = new Set([
  'user', 'project', 'local', 'plugin', 'settings (user)', 'settings (project)',
  'settings (local)',
]);
const COMMAND_TYPES = new Set(['command', 'prompt', 'static']);
const INTERPRETATIONS = new Set(['required', 'optional', 'none']);

// Placeholders this tool generates. Nothing else may occupy a label position.
const PLACEHOLDERS = new Set([
  CUSTOM, HIDDEN, '<file>', '<script>', '<plugin>', '<marketplace>', '<detected>',
  '<external path>', '(all)', '(mcp tools)', '(unset)', '(unrecognized)', '(other)',
]);
// agent-01, skill-12, mcp-03, plugin-01, rule-02, script-05, env-04
const GENERATED_LABEL = /^(?:agent|skill|command|mcp|plugin|marketplace|rule|script|env)-\d{1,6}$/;
// Filenames Claude Code itself defines. These are not authored by the user, and
// consumers match on them: the audit's CLAUDE.md check compares by name, so
// collapsing this to a placeholder made it report "no CLAUDE.md found" on a
// config that has one.
const PUBLISHED_NAMES = new Set([
  'CLAUDE.md', 'CLAUDE.local.md', 'agent-routing', 'safety', 'verifier-protocol',
  'context-hygiene', 'git-conventions',
]);
// `user:agents/foo.md` — a scope prefix plus a path relative to a scanned root.
// In default mode the prose policy has already reduced every path to one of four
// GENERATED shapes, so the emitter accepts exactly those rather than a permissive
// character class. An earlier form allowed 120 arbitrary characters after `user:`
// and did not even require a slash, so `user:ACME_INTERNAL_TOKEN` satisfied it —
// and a single authored segment is structurally indistinguishable from a real
// single-segment filename, which is why this enumerates instead.
const CONFIG_ROOTS = 'agents|commands|skills|rules|hooks|scripts|plugins';
const CONFIG_FILES = 'settings\\.json|settings\\.local\\.json|\\.mcp\\.json|CLAUDE\\.md|CLAUDE\\.local\\.md';
const RELATIVE_PATH = new RegExp(
  '^(?:user|project|local|plugin):'
  + `(?:\\.|${CONFIG_FILES}`
  + `|(?:${CONFIG_ROOTS})\\/(?:agent|command|skill|rule|script|plugin)-\\d{1,6}\\.[a-z]{1,5})$`,
);

// Published Claude Code vocabulary. These are NOT authored by the user: they are
// names Anthropic defines, so they may appear verbatim as map keys and enums.
const EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop',
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'PreCompact', 'PostCompact',
]);
const TOOLS = new Set([
  'Agent', 'Task', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch',
  'WebSearch', 'NotebookEdit', 'TodoWrite', 'ExitPlanMode', 'Artifact',
  'SlashCommand', 'KillShell', 'BashOutput', '*', '(mcp tools)',
]);
const ENV_KEYS = new Set([
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'DISABLE_AUTO_COMPACT', 'MAX_MCP_OUTPUT_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS',
  'MAX_THINKING_TOKENS', 'DISABLE_TELEMETRY', 'DISABLE_COST_WARNINGS',
]);

// Every string this tool can put in a note position, enumerated. Reasons and
// warnings are GENERATED here, so the set is finite and can be listed — which is
// stronger than any character-class test. A charset check passed 200 characters of
// authored text, and node:fs error messages embed the absolute path that failed.
// Every label passed to layer() in scan-harness.mjs. Omitting the two derived
// layers meant `failed to scan orchestrators (EACCES)` was withheld — losing the
// explanation exactly on the error path. test/notes-test.mjs now derives this
// list from the source so the two cannot drift again.
const LAYERS = [
  'agents', 'hooks', 'environment', 'commands', 'skills', 'plugins', 'mcp',
  'rules', 'orchestrators', 'review',
];
// A real errno, not any uppercase word: `failed to scan agents (ACME_SECRET)`
// passed the previous [A-Z_]{1,20} form. Not user-reachable today, but an emitter
// must hold on its own rather than trusting its caller.
const ERRNOS = [
  'EACCES', 'ENOENT', 'EPERM', 'EISDIR', 'ENOTDIR', 'EMFILE', 'ENFILE', 'ELOOP',
  'ENAMETOOLONG', 'EBADF', 'EINVAL', 'ENOMEM', 'EEXIST', 'EROFS', 'EAGAIN',
  'EBUSY', 'ENOSPC', 'EIO', 'ETIMEDOUT', 'unknown error',
];
const KNOWN_NOTES = new Set([
  'harness-map',
  'Account-level connectors (for example Gmail, Drive, Figma, Slack) are provisioned'
  + ' server-side and cannot be detected from configuration files.',
  // unconfigured reasons
  'no agents/*.md with frontmatter found',
  'no commands/*.md found',
  'no hooks configured in settings.json',
  'no installed plugins or marketplaces found',
  'no rules/*.md or CLAUDE.md found',
  'no skills/*/SKILL.md found',
  'no MCP servers found in settings, claude.json, or plugins',
  'no model/env/permissions/statusLine in settings',
  'no orchestrator skills/commands and no routing rules found — Claude Code built-in defaults apply',
  'no reviewer agents/commands and no review or verifier rules found',
  // frontmatter rejections, AFTER stripKey has removed the authored key
  'anchor/alias/tag unsupported',
  'duplicate key',
  'escape sequences unsupported',
  'flow collection unsupported',
  'indentation indicator unsupported',
  'indented line outside a nested value',
  'unparseable line',
  'unterminated double quote',
  'unterminated single quote',
  'non-scalar value',
]);
// `failed to scan <layer> (<CODE>)` — the layer is ours, the code is an fs errno.
const SCAN_ERROR = new RegExp(
  `^failed to scan (?:${LAYERS.join('|')}) \\((?:${ERRNOS.join('|')})\\)$`,
);

// --- emitters --------------------------------------------------------------
// Each returns a value of a shape that cannot carry free-form text, EXCEPT text(),
// which is null unless --include-prose was passed.
let PROSE = false;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v) => (v == null ? null : Boolean(v));
const enumOf = (set, fallback = CUSTOM) => (v) =>
  (v == null ? null : set.has(String(v)) ? String(v) : fallback);
const oneOf = (set) => (v) => (v != null && set.has(String(v)) ? String(v) : null);

/** An opaque generated label, a placeholder, or — with --include-prose — any string. */
const label = (v) => {
  if (v == null) return null;
  const s = String(v);
  if (PROSE) return s;
  return GENERATED_LABEL.test(s) || PLACEHOLDERS.has(s) || PUBLISHED_NAMES.has(s) ? s : CUSTOM;
};
/** A path relative to a scanned root. Never absolute, never outside the tree. */
const path = (v) => {
  if (v == null) return null;
  const s = String(v);
  if (PROSE) return s;
  if (PLACEHOLDERS.has(s)) return s;
  return RELATIVE_PATH.test(s) && !s.includes('..') ? s : '<file>';
};
/** Free-form text the user authored. Withheld unless prose is explicitly enabled. */
const text = (v) => (PROSE ? (v == null ? null : String(v)) : null);
/** A model name: a published alias or id, else opaque. */
const modelName = (v) => {
  if (v == null) return null;
  const s = String(v);
  if (PROSE) return s;
  // A published model id is dashed and lowercase (claude-opus-4-8, optionally
  // with a [1m] context suffix). `claudeAcmeSecret` is not a model id, and the
  // previous `claude` prefix test passed it verbatim.
  // A `claude-` prefix is not enough: `claude-acme-secret-prod` satisfied it.
  // A published id names a FAMILY (claude-opus-4-8) or opens with a generation
  // number (claude-3-5-sonnet-20241022); everything after that is digits, dots
  // and dashes. Anthropic also supports arbitrary custom gateway model names, and
  // those necessarily collapse here — preserving an arbitrary authored name and
  // guaranteeing no authored text are mutually exclusive, so the guarantee wins.
  return /^(?:opus|sonnet|haiku|fable|inherit|opusplan|default)$/.test(s)
    || (s.length <= 40
      && /^claude-(?:(?:opus|sonnet|haiku|fable|instant)|\d+)[\d.-]*(?:-(?:opus|sonnet|haiku|fable|instant))?[\d.-]*(?:\[[a-z0-9]{1,6}\])?$/.test(s))
    || PLACEHOLDERS.has(s)
    ? s
    : CUSTOM;
};
/**
 * A hook matcher: built-in tool names, optionally alternated with `|`.
 * The scanner already collapses unknown matchers, but the gate must not depend on
 * that — an emitter that accepts any identifier provides no guarantee on its own.
 */
const matcher = (v) => {
  if (v == null) return null;
  const s = String(v);
  if (PROSE) return s;
  if (PLACEHOLDERS.has(s)) return s;
  const parts = s.split('|');
  return parts.length <= 8 && parts.every((t) => TOOLS.has(t)) ? s : CUSTOM;
};
/** An environment VALUE: only a number or a boolean survives. */
const envValue = (v) => {
  if (v == null) return null;
  const s = String(v);
  if (PROSE && s === HIDDEN) return s;
  return /^(?:true|false|0|1|[0-9]{1,15}|[0-9]{1,12}\.[0-9]{1,4})$/i.test(s) ? s : HIDDEN;
};
/** A short reason string this tool generates (never user text). */
const note = (v) => {
  if (v == null) return null;
  const s = String(v);
  // --include-prose is the mode where authored text is allowed through; a warning
  // that names the offending key is exactly the detail it exists to provide.
  if (PROSE) return s;
  return KNOWN_NOTES.has(s) || SCAN_ERROR.test(s) ? s : null;
};

/** A key drawn from published Claude Code vocabulary, else an opaque label. */
const vocab = (set) => (v) => {
  if (v == null) return null;
  const s = String(v);
  if (set.has(s)) return s;
  if (PROSE) return s;
  return GENERATED_LABEL.test(s) || PLACEHOLDERS.has(s) ? s : CUSTOM;
};
const eventName = vocab(EVENTS);
const toolName = vocab(TOOLS);
const envKey = vocab(ENV_KEYS);

const arrayOf = (spec) => ({ __array: spec });
const mapOf = (keyEmit, valEmit) => ({ __map: { keyEmit, valEmit } });

// --- the declared document -------------------------------------------------
// The renderer's cmdLabel() reads exe, script and raw. exe/script are basenames
// (authored, so text()); raw is the full command and exists only under
// --include-values, which already disables redaction.
const COMMAND_SHAPE = {
  type: enumOf(COMMAND_TYPES), length: num, exe: text, script: text, raw: text,
};
const PROSE_REF = { name: label, file: path, headings: arrayOf(text) };
const PARSE_WARNING = { file: path, warnings: arrayOf(note) };
const DETECTED_ITEM = { kind: oneOf(KINDS), name: label };

export const DOCUMENT = {
  schemaVersion: num,
  tool: note,
  redacted: bool,
  prose: bool,
  sources: arrayOf({ scope: enumOf(SCOPES), path, exists: bool }),
  settingsFiles: arrayOf({ scope: enumOf(SCOPES), file: path }),
  layers: {
    agents: {
      status: enumOf(STATUS), reason: note, count: num,
      items: arrayOf({
        name: label, model: modelName, description: text, descriptionLength: num,
        tools: text, scope: enumOf(SCOPES), file: path,
      }),
      byModel: mapOf(modelName, num),
      bareInherit: arrayOf(label),
      unpinned: arrayOf(label),
      parseWarnings: arrayOf(PARSE_WARNING),
    },
    hooks: {
      status: enumOf(STATUS), reason: note, count: num,
      items: arrayOf({
        event: eventName, matcher, type: enumOf(COMMAND_TYPES), timeout: num,
        command: COMMAND_SHAPE, scope: enumOf(SCOPES), source: path,
      }),
      byEvent: mapOf(eventName, num),
      events: arrayOf(eventName),
      scriptRefs: arrayOf({ path, name: label, exists: bool }),
      unresolvedRefs: num,
      defects: {
        readsToolInputEnv: arrayOf(label),
        nonBlockingExit: arrayOf(label),
      },
      missingTimeout: num,
    },
    environment: {
      status: enumOf(STATUS), reason: note,
      model: modelName,
      statusLine: {
        type: enumOf(COMMAND_TYPES),
        command: COMMAND_SHAPE,
        script: { name: label, exists: bool },
      },
      env: mapOf(envKey, envValue),
      permissions: {
        allow: num, deny: num, ask: num,
        defaultMode: enumOf(new Set([
          'default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto',
        ])),
        toolBreakdown: mapOf(toolName, num),
        unrecognized: num,
      },
    },
    commands: {
      status: enumOf(STATUS), reason: note, count: num,
      items: arrayOf({ name: label, description: text, scope: enumOf(SCOPES), file: path }),
    },
    skills: {
      status: enumOf(STATUS), reason: note, count: num,
      items: arrayOf({
        name: label, description: text, descriptionLength: num, scope: enumOf(SCOPES),
      }),
      parseWarnings: arrayOf(PARSE_WARNING),
    },
    plugins: {
      status: enumOf(STATUS), reason: note, count: num,
      items: arrayOf({
        name: label, marketplace: label,
        scope: enumOf(new Set(['user', 'project', 'local', 'builtin', 'dynamic'])),
        version: label, enabled: bool,
      }),
      marketplaces: arrayOf({
        name: label,
        type: enumOf(new Set(['git', 'github', 'local', 'directory', 'npm', 'url'])),
        repo: label,
      }),
      disabled: arrayOf(label),
    },
    mcp: {
      status: enumOf(STATUS), reason: note, count: num,
      items: arrayOf({
        name: label, origin: enumOf(ORIGINS),
        transport: enumOf(new Set([
          'stdio', 'sse', 'http', 'https', 'ws', 'wss', 'sse-http', 'streamable-http',
        ])),
        command: label, argsCount: num, envKeys: arrayOf(label),
        remote: bool, url: text, active: bool, plugin: label,
        shadowed: arrayOf(enumOf(ORIGINS)),
      }),
      byOrigin: mapOf(enumOf(ORIGINS), num),
      caveat: note,
      otherProjects: num,
      otherProjectServers: num,
      inactive: num,
    },
    rules: {
      status: enumOf(STATUS), reason: note, count: num,
      items: arrayOf({
        name: label, file: path, headings: arrayOf(text), scope: enumOf(SCOPES),
        contained: bool, headingCount: num,
      }),
    },
    orchestrators: {
      status: enumOf(STATUS), reason: note, count: num,
      items: arrayOf(DETECTED_ITEM),
      proseRefs: arrayOf(PROSE_REF),
      interpretation: oneOf(INTERPRETATIONS),
    },
    review: {
      status: enumOf(STATUS), reason: note, count: num,
      items: arrayOf(DETECTED_ITEM),
      proseRefs: arrayOf(PROSE_REF),
      interpretation: oneOf(INTERPRETATIONS),
    },
  },
};

// Keys that mutate an object's prototype rather than adding a member. The map
// emitters would otherwise have to be trusted never to return one.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Arrays and maps are otherwise unbounded: output width follows input width, so a
// configuration with 10^6 entries produces a document of that size.
const MAX_ITEMS = 5000;

/**
 * Build the output document from DOCUMENT. Anything not declared is dropped —
 * that is the entire point, so do not add an "unknown keys" passthrough.
 *
 * Recursion depth is bounded by the SCHEMA, not by the input: build() only
 * descends where DOCUMENT declares structure, so a deeply nested or
 * self-referential input terminates at the declared depth instead of unwinding
 * the stack.
 */
export function gate(value, spec = DOCUMENT, { prose = false } = {}) {
  PROSE = prose;
  return build(value, spec);
}

function build(value, spec) {
  if (typeof spec === 'function') return spec(value);
  if (spec && spec.__array) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((v) => v !== null && v !== undefined)
      .slice(0, MAX_ITEMS)
      .map((v) => build(v, spec.__array));
  }
  if (spec && spec.__map) {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(k)) continue;
      if (n >= MAX_ITEMS) break;
      n += 1;
      const key = spec.__map.keyEmit(k);
      if (key == null || UNSAFE_KEYS.has(key)) continue;
      Object.defineProperty(out, key, {
        value: spec.__map.valEmit(v), enumerable: true, writable: true, configurable: true,
      });
    }
    return out;
  }
  if (spec && typeof spec === 'object') {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
    const out = {};
    for (const [k, sub] of Object.entries(spec)) {
      // hasOwnProperty, not `in`: `in` would accept a declared field inherited
      // from a polluted input prototype.
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
      const built = build(value[k], sub);
      if (built !== undefined) out[k] = built;
    }
    return out;
  }
  return null;
}
