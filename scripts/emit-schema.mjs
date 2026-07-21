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
  CUSTOM, HIDDEN, '<file>', '<script>', '<plugin>', '<detected>', '<external path>',
  '(all)', '(mcp tools)', '(unset)', '(unrecognized)', '(other)',
]);
// agent-01, skill-12, mcp-03, plugin-01, rule-02, script-05, env-04
const GENERATED_LABEL = /^(?:agent|skill|command|mcp|plugin|rule|script|env)-\d{1,4}$/;
// `user:agents/foo.md` — a scope prefix plus a path relative to a scanned root.
const RELATIVE_PATH = /^(?:user|project|local|plugin):[\w.\-/@ ]{0,120}$/;

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

// The one sentence the MCP layer attaches about server-side connectors.
const KNOWN_NOTES = new Set([
  'Account-level connectors (for example Gmail, Drive, Figma, Slack) are provisioned'
  + ' server-side and cannot be detected from configuration files.',
]);

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
  return GENERATED_LABEL.test(s) || PLACEHOLDERS.has(s) ? s : CUSTOM;
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
  return /^(?:opus|sonnet|haiku|fable|inherit|opusplan|default)$/.test(s)
    || /^claude[\w.[\]-]{0,48}$/i.test(s)
    || PLACEHOLDERS.has(s)
    ? s
    : CUSTOM;
};
/** A hook matcher: built-in tool names, optionally alternated. */
const matcher = (v) => {
  if (v == null) return null;
  const s = String(v);
  if (PROSE) return s;
  if (PLACEHOLDERS.has(s)) return s;
  return /^[A-Za-z][A-Za-z0-9_]{0,30}(?:\|[A-Za-z][A-Za-z0-9_]{0,30}){0,7}$/.test(s) || s === '*'
    ? s
    : CUSTOM;
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
  if (KNOWN_NOTES.has(s)) return s;
  // Reason/warning strings are generated here, so they may only contain the
  // vocabulary this tool writes: letters, digits and light punctuation.
  return /^[A-Za-z0-9 ,.;:()/'\-<>$]{0,200}$/.test(s) ? s : null;
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
const COMMAND_SHAPE = { type: enumOf(COMMAND_TYPES), length: num };
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

/**
 * Build the output document from DOCUMENT. Anything not declared is dropped —
 * that is the entire point, so do not add an "unknown keys" passthrough.
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
      .map((v) => build(v, spec.__array));
  }
  if (spec && spec.__map) {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [k, v] of Object.entries(value)) {
      const key = spec.__map.keyEmit(k);
      if (key == null) continue;
      out[key] = spec.__map.valEmit(v);
    }
    return out;
  }
  if (spec && typeof spec === 'object') {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
    const out = {};
    for (const [k, sub] of Object.entries(spec)) {
      if (!(k in value)) continue;
      const built = build(value[k], sub);
      if (built !== undefined) out[k] = built;
    }
    return out;
  }
  return null;
}
