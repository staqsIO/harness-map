---
description: Visualize this Claude Code harness — agents, model tiers, hooks, orchestrators, and the review pipeline — as an interactive page
argument-hint: "[--project <path>] [--include-values]"
---

Use the `claude-harness-visualizer` skill to scan and visualize the current Claude Code harness.

Arguments (pass through to the scanner): $ARGUMENTS

Follow the skill exactly:

1. Run `scan-harness.mjs` and read the resulting JSON. It is the source of truth
   for agents, hooks, environment, and inventory — do not restate anything it did
   not emit.
2. For `orchestrators` and `review`, interpret **only** the files listed in each
   layer's `proseRefs`, and write `prose.json`. Skip any layer whose status is
   `unconfigured` — its empty state is the correct output.
3. Render with `render-map.mjs` and publish the HTML with the Artifact tool
   (favicon `🗺️`).
4. Report counts per layer, which layers were unconfigured, and any model-tier
   drift (`bareInherit`, `unpinned`).
