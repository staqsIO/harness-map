---
name: claude-harness-visualizer
description: Visualize a Claude Code harness setup — agents and their model tiers, hooks across the session lifecycle, orchestrator routing, the review pipeline, and installed commands/skills/plugins/MCP servers — as an interactive page. Use when the user says "/claude-harness-visualizer", "visualize my harness", "show my Claude Code setup", "map my agents and hooks", "what hooks do I have", "diagram my config", or asks how their harness is wired. Also use when auditing a config for model-tier drift (bare `inherit`, unpinned agents) or reviewing which hooks fire when.
user_invocable: true
argument-hint: "[--project <path>] [--include-prose]"
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
By default names appear as opaque labels (`agent-01`) and descriptions are
withheld, so the output is shareable. Add `--include-prose` when the user wants a
readable map — and tell them the result should be reviewed before sharing. Add
`--include-values` only on an explicit request; that output must not be shared.

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
`/tmp/hm-prose.json`.

**Containment is mandatory.** Read a `proseRef` only if it sits inside a scanned
root and is a regular file, never a symlink. The scanner already excludes
symlinked rule files for exactly this reason: a `rules/agent-routing.md` pointing
at `~/.ssh/id_rsa` would otherwise turn a configuration map into arbitrary local
file disclosure in a published page. Never read a path the scan did not emit, and
never follow a path out of the config tree.

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

## Step 3 — audit

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/audit-harness.mjs" --scan /tmp/hm-scan.json --json > /tmp/hm-audit.json
```

Deterministic — do not second-guess its verdicts or add findings of your own to
the JSON. It exits non-zero when a high-severity check fails.

## Step 4 — render and publish

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-map.mjs" \
  --scan /tmp/hm-scan.json --prose /tmp/hm-prose.json \
  --audit /tmp/hm-audit.json --out /tmp/claude-harness-visualizer.html
```

Publish `/tmp/claude-harness-visualizer.html` with the Artifact tool. Use favicon `🗺️` and keep
it stable across redeploys. Omit `--prose` or `--audit` when you do not have them.

## Reporting back

Lead with the audit headline (`N/M applicable checks pass`, high/medium/low
counts) and any high-severity finding, then counts per layer and which layers were
unconfigured. Also flag drift the scanner surfaced:

- `layers.agents.bareInherit` — agents on bare `inherit` silently bind to the
  session model, so a bulk agent can quietly run at the top tier's cost.
- `layers.agents.unpinned` — agents with no `model:` field at all.
- `layers.environment.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` — auto-compact fires at
  roughly 84% of this value, not at the value itself.

Do not editorialize beyond what the scan shows.

## Privacy

The default document contains only structural shapes — counts, enums, booleans,
root-relative paths, and opaque labels in place of authored names. Environment
values, command text, MCP URLs and hostnames, permission rule arguments and
absolute paths are never emitted.

`--include-prose` adds authored names, descriptions and rule headings. That output
is readable but should be reviewed before sharing, because free-form text can
contain anything. Say so when the user asks about sharing; do not call any output
universally safe.

Never claim the user is protected against a destructive operation. This tool does
not verify hook blocking behaviour — see the README section on what it does not
check.
