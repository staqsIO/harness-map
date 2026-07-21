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

## Audit signals

The scan surfaces drift that is easy to miss by eye:

- **Bare `inherit` agents** — an agent with `model: inherit` silently binds to
  your session model, so a subagent built to be cheap can quietly run at the top
  tier's cost.
- **Unpinned agents** — no `model:` field at all.
- **Auto-compact threshold** — `CLAUDE_CODE_AUTO_COMPACT_WINDOW` fires at roughly
  **84%** of the value you set, not at the value. The map does the arithmetic.

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
