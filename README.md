# harness-map

Visualize your Claude Code harness — the agents, model tiers, hooks, orchestrators
and review steps that actually shape a session — as an interactive page.

Claude Code configuration accretes: agents in one directory, hooks in
`settings.json`, routing conventions in prose, plugins from four marketplaces.
There is no single place that shows you what you have. `harness-map` reads all of
it and draws it.

```
/plugin marketplace add staqsIO/harness-map
/plugin install harness-map
/harness-map
```

## What it shows

| View | Source | Works without config? |
|---|---|---|
| **Agents & tiers** | `agents/*.md` frontmatter | needs `agents/` |
| **Hooks & flow** | `settings.json` hooks, env, permissions | needs `settings.json` |
| **Orchestrators** | your routing rules | falls back to built-in defaults |
| **Review pipeline** | your review/verifier rules | shows what to add |
| **Inventory** | commands, skills, plugins, MCP servers, rules | always |

Structural facts come from a deterministic scanner. Only the two prose-backed
views involve model interpretation, and each degrades to an explicit empty state
naming what is missing — the map never invents a routing rule you did not write.

## Audit

```bash
node scripts/audit-harness.mjs --scan scan.json
```

```
HARNESS AUDIT   14/18 applicable checks pass
                0 high · 1 medium · 3 low

● MEDIUM skills.description-present
         Every skill has a description
         4 of 132 skills have no description
         → gws-email-read, gws-inbox, gws-sanitize, portfolio-capture
```

**There is no composite score, on purpose.** Every check is a named assertion that
returns pass, fail, or n/a with concrete evidence. A weighted 0–100 number would
be this author's guesses about weights dressed up as measurement, and "you have
132 skills" is not a strength — it is more trigger-collision surface to maintain.
A check that cannot apply (no agents defined, so no agent checks) is **n/a rather
than a failure**, which is what keeps the ratio comparable across very different
configs.

Exits non-zero only on a **high**-severity failure, so it works as a CI gate.

What it asserts, and why each one is falsifiable rather than a matter of taste:

- **A stated invariant with no mechanical enforcement.** If a rule file says
  "never force-push to main" but no `PreToolUse` hook matches that pattern, the
  invariant depends on the model remembering it. This is the check that found a
  real gap in the author's own config.
- **Hook scripts that do not exist on disk** — the guard looks configured in
  `settings.json` and silently never runs.
- **Bare `inherit` agents** — an agent with `model: inherit` adopts the session
  model, so a subagent written to be cheap can run at the top tier's price with
  nothing in the config making that visible.
- **MCP servers stranded behind a disabled plugin** — present in config, never
  started.
- **Skills with a missing or very short `description`** — routing is driven by
  the description, so a thin one fires inconsistently.
- **Auto-compact threshold** — `CLAUDE_CODE_AUTO_COMPACT_WINDOW` fires at roughly
  **84%** of the value you set, not at the value. The audit does the arithmetic.

## Privacy

Output is **redacted by default**, because these pages are meant to be shared:

- home paths collapse to `~`
- values under secret-shaped keys (`*_key`, `*token*`, `*secret*`) → `<redacted>`
- MCP server args and env **values** are dropped; only key names remain
- permission rules reduce to per-tool counts, never the full rule list
- hook commands are truncated to a short preview plus the script name

`--include-values` opts out. Output produced that way must not be shared.

The rendered page is fully self-contained: no external scripts, fonts, or images.

## Standalone use

Both scripts are plain Node with zero dependencies, so they work outside Claude
Code — in CI, or piped into your own tooling:

```bash
node scripts/scan-harness.mjs --pretty > scan.json
node scripts/render-map.mjs --scan scan.json --out map.html
```

**Scanner flags:** `--pretty`, `--include-values`, `--root <dir>` (default
`~/.claude`), `--project <dir>` to merge a project-level `.claude/` and
`CLAUDE.md`.

Every layer in the output carries a `status` of `ok`, `unconfigured`, or `error`,
and fails independently — a malformed agent file never takes down the scan.

## Development

```bash
bash test/run-tests.sh
```

Covers graceful degradation on an empty config, secret redaction (with planted
credentials), malformed-frontmatter resilience, and the self-contained/themed
render contract.

## License

MIT
