#!/usr/bin/env bash
# Test suite for harness-map. Runs the scanner and renderer against fixtures and
# asserts the contracts that matter: valid output, graceful degradation on a
# minimal config, and no secret leakage.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN="$ROOT/scripts/scan-harness.mjs"
RENDER="$ROOT/scripts/render-map.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok()   { printf '  ok    %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
check(){ if [ "$1" = "true" ]; then ok "$2"; else bad "$2"; fi; }

j() { python3 -c "
import json,sys
d=json.load(open('$1'))
print('true' if bool($2) else 'false')
" 2>/dev/null || echo false; }

echo "harness-map tests"

# --- 1. minimal config: degrades, never crashes ------------------------------
echo "[minimal fixture]"
node "$SCAN" --root "$ROOT/test/fixtures/minimal/.claude" \
             --project "$ROOT/test/fixtures/minimal" > "$TMP/min.json" 2>"$TMP/min.err"
check "$([ $? -eq 0 ] && echo true || echo false)" "scanner exits 0 with no .claude dir"
check "$([ ! -s "$TMP/min.err" ] && echo true || echo false)" "scanner writes nothing to stderr"
check "$(j "$TMP/min.json" "d['schemaVersion']==1")" "emits schemaVersion 1"
for layer in agents orchestrators review; do
  check "$(j "$TMP/min.json" "d['layers']['$layer']['status']=='unconfigured'")" \
        "layer '$layer' is unconfigured (not fabricated)"
done
check "$(j "$TMP/min.json" "d['layers']['rules']['status']=='ok'")" "picks up a bare CLAUDE.md as a rules source"

node "$RENDER" --scan "$TMP/min.json" --out "$TMP/min.html" 2>/dev/null
check "$([ -s "$TMP/min.html" ] && echo true || echo false)" "renderer produces output for an empty config"
check "$(grep -q 'class="empty"' "$TMP/min.html" && echo true || echo false)" "renders empty states"
check "$(grep -q 'built-in defaults apply' "$TMP/min.html" && echo true || echo false)" "explains the built-in fallback"

# --- 2. redaction ------------------------------------------------------------
echo "[redaction]"
node "$SCAN" --root "$ROOT/test/fixtures/rich/.claude" > "$TMP/rich.json"
LEAK="$(grep -oE 'sk-[A-Za-z0-9]{6,}|ghp_[A-Za-z0-9]{10,}|supersecret' "$TMP/rich.json" | sort -u)"
check "$([ -z "$LEAK" ] && echo true || echo false)" "planted secrets are redacted by default"
[ -n "$LEAK" ] && printf '        leaked: %s\n' "$LEAK"
check "$(j "$TMP/rich.json" "d['layers']['environment']['env']['SOME_API_KEY']=='<redacted>'")" "secret-shaped env keys are masked"
check "$(j "$TMP/rich.json" "d['layers']['environment']['env']['SAFE_FLAG']=='on'")" "non-secret env values are preserved"
check "$(j "$TMP/rich.json" "d['layers']['mcp']['items'][0]['envKeys']==['API_TOKEN']")" "MCP env keys kept, values dropped"

node "$SCAN" --root "$ROOT/test/fixtures/rich/.claude" --include-values > "$TMP/raw.json"
check "$(grep -qE 'sk-supersecret|ghp_ABCDEF' "$TMP/raw.json" && echo true || echo false)" "--include-values opts out of redaction"

# --- 3. malformed input ------------------------------------------------------
echo "[resilience]"
check "$(j "$TMP/rich.json" "len(d['layers']['agents']['items'])==1")" "agent with unterminated frontmatter is skipped, not fatal"
check "$(j "$TMP/rich.json" "d['layers']['agents']['items'][0]['model']=='haiku'")" "parses a scalar containing a colon"

node "$SCAN" --root /nonexistent/path/xyz > "$TMP/none.json" 2>/dev/null
check "$([ $? -eq 0 ] && echo true || echo false)" "nonexistent root exits 0"
check "$(j "$TMP/none.json" "all(v.get('status')=='unconfigured' for v in d['layers'].values())")" \
      "every layer degrades to unconfigured"

# --- 4. rendered output is self-contained and themed --------------------------
echo "[render contract]"
node "$RENDER" --scan "$TMP/rich.json" --out "$TMP/rich.html" 2>/dev/null
check "$(! grep -qE '(src|href)="https?://' "$TMP/rich.html" && echo true || echo false)" \
      "no external requests (CSP-safe)"
for sel in 'prefers-color-scheme:dark' '\[data-theme="dark"\]' '\[data-theme="light"\]'; do
  check "$(grep -q "$sel" "$TMP/rich.html" && echo true || echo false)" "defines theme path: $sel"
done
OPEN=$(grep -o '<div\b' "$TMP/rich.html" | wc -l | tr -d ' ')
CLOSE=$(grep -o '</div>' "$TMP/rich.html" | wc -l | tr -d ' ')
check "$([ "$OPEN" = "$CLOSE" ] && echo true || echo false)" "balanced <div> tags ($OPEN/$CLOSE)"
check "$(grep -q 'class="scroll"' "$TMP/rich.html" && echo true || echo false)" "tables are wrapped for horizontal scroll"

# --- 5. manifests are valid ---------------------------------------------------
echo "[manifests]"
for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json; do
  python3 -c "import json;json.load(open('$ROOT/$f'))" 2>/dev/null
  check "$([ $? -eq 0 ] && echo true || echo false)" "$f is valid JSON"
done

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
