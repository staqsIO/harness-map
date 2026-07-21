---
name: harness-map
description: Visualize a Claude Code harness setup — agents and their model tiers, hooks across the session lifecycle, orchestrator routing, the review pipeline, and installed commands/skills/plugins/MCP servers — as an interactive page. Use when the user says "/harness-map", "visualize my harness", "show my Claude Code setup", "map my agents and hooks", "what hooks do I have", "diagram my config", or asks how their harness is wired. Also use when auditing a config for model-tier drift (bare `inherit`, unpinned agents) or reviewing which hooks fire when.
user_invocable: true
argument-hint: "[--project <path>] [--include-values]"
license: MIT
---

# Harness Map

Turn a Claude Code configuration into an interactive map. Two deterministic
scripts do the work; you supply interpretation only for the parts that live in
prose.

## Pipeline

```
scan-harness.mjs  ──>  scan.json  ──>  render-map.mjs  ──>  map.html  ──>  Artifact
                            │              ▲
                            └── you ───────┘
                              prose.json (optional)
```

**Never hand-write the structural facts.** The scanner is the source of truth for
agents, hooks, environment, and inventory. Your job is the two prose layers and
nothing else. Reporting an agent count or hook that the scanner did not emit is a
fabrication.

## Step 1 — scan

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scan-harness.mjs" --pretty > /tmp/hm-scan.json
```

Add `--project <path>` to include a project-level `.claude/` and `CLAUDE.md`.
Add `--include-values` **only** if the user explicitly asks for unredacted output;
warn them the result must not be shared.

Read the result. Every layer carries `status`:

| status | meaning | what to do |
|---|---|---|
| `ok` | data found | render it |
| `unconfigured` | nothing present | let the empty state render; do **not** invent content |
| `error` | scan failed | surface the reason to the user |

## Step 2 — interpret the prose layers (only if `status: "ok"`)

`layers.orchestrators` and `layers.review` are detected, not parsed — the scanner
reports which skills/commands/agents matched and lists `proseRefs`, the rule files
that describe the actual logic.

If either is `ok`, read **only** the files named in its `proseRefs` and write
`/tmp/hm-prose.json`:

```json
{
  "tiers": [
    { "name": "HUB", "model": "Opus 4.8", "role": "Orchestrates; delegates bulk work down." }
  ],
  "orchestrators": {
    "items": [ { "name": "/goal", "kind": "closed loop", "when": "A measurable done-condition exists." } ]
  },
  "review": {
    "cap": "Hard cap: 2 reviewer calls per issue.",
    "rows": [ { "trigger": "Security-sensitive path", "reviewers": ["Linus", "Codex"], "note": "Different model families." } ]
  }
}
```

Every field is optional; omit what the config does not define. `tiers` should
reflect the user's own tier vocabulary if they have one, and otherwise be omitted
entirely — do not impose a HUB/JUDGE/BULK scheme on a config that has no tiers.

If a layer is `unconfigured`, skip it. The renderer draws an empty state that
names what is missing, which is more useful than a guess.

## Step 3 — render and publish

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-map.mjs" \
  --scan /tmp/hm-scan.json --prose /tmp/hm-prose.json --out /tmp/harness-map.html
```

Publish `/tmp/harness-map.html` with the Artifact tool. Use favicon `🗺️` and keep
it stable across redeploys. Omit `--prose` when there is nothing to interpret.

## Reporting back

Summarize in a few lines: counts per layer, which layers were unconfigured, and
any **drift worth flagging** the scanner surfaced:

- `layers.agents.bareInherit` — agents on bare `inherit` silently bind to the
  session model, so a bulk agent can quietly run at the top tier's cost.
- `layers.agents.unpinned` — agents with no `model:` field at all.
- `layers.environment.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` — auto-compact fires at
  roughly 84% of this value, not at the value itself.

Do not editorialize beyond what the scan shows.

## Privacy

Output is redacted by default: home paths collapse to `~`, values under
secret-shaped keys become `<redacted>`, MCP args/env values are dropped in favor
of key names, permission rules reduce to per-tool counts, and hook commands are
truncated to a preview. Artifacts are private until shared, but treat the page as
shareable and keep it redacted unless told otherwise.
