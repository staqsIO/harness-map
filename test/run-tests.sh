#!/usr/bin/env bash
# Test suite for harness-map. Runs the scanner and renderer against fixtures and
# asserts the contracts that matter: valid output, graceful degradation on a
# minimal config, and no secret leakage.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN="$ROOT/scripts/scan-harness.mjs"
RENDER="$ROOT/scripts/render-map.mjs"
AUDIT="$ROOT/scripts/audit-harness.mjs"
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
check "$(j "$TMP/min.json" "d['schemaVersion']==2")" "emits schemaVersion 2"
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
# The privacy contract is an ALLOWLIST: only structurally safe shapes are
# emitted. These fixtures plant credentials in shapes a blocklist cannot catch —
# an ordinary key name with a credential value, a token inside a command, URL
# userinfo, a permission rule with no parenthesis, a path outside $HOME. Every
# one of these leaked in an earlier build while the old tests passed.
echo "[redaction]"
node "$SCAN" --root "$ROOT/test/fixtures/rich/.claude" --include-prose > "$TMP/rich.json"
LEAK="$(grep -oE 'sk-[A-Za-z0-9]{6,}|ghp_[A-Za-z0-9]{10,}|supersecret|hunter2|id_rsa|550e8400|postgres://' "$TMP/rich.json" | sort -u)"
check "$([ -z "$LEAK" ] && echo true || echo false)" "no planted credential appears in output"
[ -n "$LEAK" ] && printf '        leaked: %s\n' "$LEAK"
check "$(j "$TMP/rich.json" "all(v=='<hidden>' for k,v in d['layers']['environment']['env'].items() if k!='CLAUDE_CODE_AUTO_COMPACT_WINDOW')")" \
      "every env value is hidden, whatever the key looks like"
check "$(j "$TMP/rich.json" "d['layers']['environment']['env']['CLAUDE_CODE_AUTO_COMPACT_WINDOW']=='475000'")" \
      "allowlisted non-sensitive env value still emitted"
check "$(j "$TMP/rich.json" "any(m['name']=='leaky' and m['envKeys']==['API_TOKEN'] for m in d['layers']['mcp']['items'])")" "MCP env keys kept, values dropped"
check "$(j "$TMP/rich.json" "all(m['url'] is None for m in d['layers']['mcp']['items'])")" \
      "MCP url is never emitted; only remote:true"
check "$(j "$TMP/rich.json" "any(m['name']=='leaky' and m['remote'] is True for m in d['layers']['mcp']['items'])")" \
      "remote flag replaces the hostname"
check "$(j "$TMP/rich.json" "d['layers']['environment']['permissions']['unrecognized']>=1")" \
      "permission rule without a tool grammar becomes (unrecognized), not echoed"
check "$(j "$TMP/rich.json" "all('preview' not in (h.get('command') or {}) for h in d['layers']['hooks']['items'])")" \
      "hook commands are described, never quoted"
check "$(! grep -qE '\"(/|[A-Za-z]:\\\\)' "$TMP/rich.json" && echo true || echo false)" \
      "no absolute path is emitted anywhere"

node "$SCAN" --root "$ROOT/test/fixtures/rich/.claude" --include-values > "$TMP/raw.json"
check "$(grep -qE 'hunter2|supersecret' "$TMP/raw.json" && echo true || echo false)" "--include-values opts out of redaction"

# --- 2d. MCP precedence -------------------------------------------------------
echo "[mcp precedence]"
node "$SCAN" --root "$ROOT/test/fixtures/prec/.claude" --project "$ROOT/test/fixtures/prec/proj" --include-prose > "$TMP/prec.json"
check "$(j "$TMP/prec.json" "any(m['name']=='db' and m['origin']=='local' for m in d['layers']['mcp']['items'])")" \
      "local scope wins over project and user"
check "$(j "$TMP/prec.json" "len([m for m in d['layers']['mcp']['items'] if m['name']=='db'])==1")" \
      "a shadowed server appears once, not repeatedly"
check "$(j "$TMP/prec.json" "any(m['name']=='projonly' for m in d['layers']['mcp']['items'])")" \
      "project .mcp.json is read from <project>/.mcp.json"

# --- 2e. YAML strictness ------------------------------------------------------
# The parser must refuse constructs it cannot handle exactly. A wrong value is
# worse than a missing one, because the audit asserts on these fields.
echo "[yaml strictness]"
node "$SCAN" --root "$ROOT/test/fixtures/yaml/.claude" --include-prose > "$TMP/yaml.json"
check "$(j "$TMP/yaml.json" "any('indentation indicator' in w for x in d['layers']['agents']['parseWarnings'] for w in x['warnings'])")" \
      "indentation indicator (>2-) is refused, not guessed"
check "$(j "$TMP/yaml.json" "any('escape sequence' in w for x in d['layers']['agents']['parseWarnings'] for w in x['warnings'])")" \
      "double-quoted escapes are refused, not emitted literally"
check "$(j "$TMP/yaml.json" "any(a['name']=='nullmodel' and a['model'] is None for a in d['layers']['agents']['items'])")" \
      "empty value parses as null, not empty string"
check "$(j "$TMP/yaml.json" "any(a['name']=='folded' and '\n\n' in (a['description'] or '') for a in d['layers']['agents']['items'])")" \
      "folded scalar preserves the paragraph break"

# --- 2f. symlink containment --------------------------------------------------
echo "[containment]"
node "$SCAN" --root "$ROOT/test/fixtures/symlink/.claude" > "$TMP/sym.json"
check "$(! grep -q 'SECRETMATERIAL' "$TMP/sym.json" && echo true || echo false)" \
      "symlinked rule file contents never reach output"
check "$(j "$TMP/sym.json" "not any(r['name']=='agent-routing' for r in d['layers']['rules'].get('items',[]))")" \
      "symlinked rule file is not offered as a proseRef for the model to read"

# --- 2b. MCP discovery across all four declaration sites ----------------------
# Regression: an earlier build read only settings.json and undercounted 14 -> 1.
echo "[mcp discovery]"
for pair in "leaky:settings (user)" "globalsrv:user" "pluginsrv:plugin"; do
  name="${pair%%:*}"; origin="${pair#*:}"
  check "$(j "$TMP/rich.json" "any(m['name']=='$name' and m['origin']=='$origin' for m in d['layers']['mcp']['items'])")" \
        "discovers '$name' from scope '$origin'"
done
# A server belonging to some OTHER project must be counted but never emitted:
# its config path names private repos and client work.
check "$(j "$TMP/rich.json" "not any(m['name']=='projsrv' for m in d['layers']['mcp']['items'])")" \
      "another project's server is not listed as loadable here"
check "$(j "$TMP/rich.json" "d['layers']['mcp']['otherProjectServers']>=1")" \
      "another project's servers are counted"
check "$(! grep -q 'projA' "$TMP/rich.json" && echo true || echo false)" \
      "other project paths are never emitted"
check "$(j "$TMP/rich.json" "any(m['name']=='pluginsrv' and m['enabled'] is False for m in d['layers']['mcp']['items'])")" \
      "marks servers from a disabled plugin as inactive"
check "$(j "$TMP/rich.json" "'connectors' in d['layers']['mcp'].get('caveat','').lower()")" \
      "states the account-connector caveat"
check "$(j "$TMP/min.json" "d['layers']['mcp']['status']=='unconfigured'")" \
      "--root stays hermetic (no bleed from the real ~/.claude.json)"

# --- 2g. prose policy ------------------------------------------------------
# Authored names/descriptions/headings cannot be vetted by any scan, so the
# DEFAULT document must contain none of them.
echo "[prose policy]"
node "$SCAN" --root "$ROOT/test/fixtures/rich/.claude" > "$TMP/opaque.json"
check "$(j "$TMP/opaque.json" "all(a['name'].startswith('agent-') for a in d['layers']['agents']['items'])")" \
      "agent names are opaque labels by default"
check "$(j "$TMP/opaque.json" "all(a['description'] is None for a in d['layers']['agents']['items'])")" \
      "descriptions are withheld by default"
check "$(j "$TMP/opaque.json" "all(a['descriptionLength']>=0 for a in d['layers']['agents']['items'])")" \
      "description LENGTH survives so the audit still works"
check "$(! grep -qE 'folded|literal|solo|leaky|globalsrv' "$TMP/opaque.json" && echo true || echo false)" \
      "no authored name from the fixture appears anywhere in default output"
check "$(j "$TMP/opaque.json" "all(r['headings']==[] for r in d['layers']['rules'].get('items',[]))")" \
      "rule headings are withheld by default"
check "$(j "$TMP/rich.json" "any(a['name']=='solo' for a in d['layers']['agents']['items'])")" \
      "--include-prose restores authored names"

# --- 3. malformed input ------------------------------------------------------
echo "[resilience]"
check "$(j "$TMP/rich.json" "len(d['layers']['agents']['items'])==3")" "agent with unterminated frontmatter is skipped, not fatal"
check "$(j "$TMP/rich.json" "any(a['name']=='solo' and a['model']=='haiku' for a in d['layers']['agents']['items'])")" "parses a scalar containing a colon"
# Regression: `description: >` used to read as the literal ">" (length 1), which
# made every length-based audit check fire a false positive.
check "$(j "$TMP/rich.json" "any(a['name']=='folded' and a['description'].startswith('A folded description that spans several') for a in d['layers']['agents']['items'])")" \
      "folded block scalar (>) is joined into one line"
check "$(j "$TMP/rich.json" "any(a['name']=='literal' and 'Line one' in a['description'] and 'Line two' in a['description'] for a in d['layers']['agents']['items'])")" \
      "literal block scalar (|) preserves both lines"
check "$(j "$TMP/rich.json" "all(len(a['description'] or '')>1 for a in d['layers']['agents']['items'])")" \
      "no description collapses to a bare block-scalar marker"

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

# --- 4b. audit ----------------------------------------------------------------
echo "[audit]"
node "$ROOT/scripts/audit-harness.mjs" --scan "$TMP/rich.json" --json > "$TMP/audit.json" 2>/dev/null
check "$(j "$TMP/audit.json" "'summary' in d and 'findings' in d")" "emits a structured report"
check "$(j "$TMP/audit.json" "d['summary']['passed']<=d['summary']['applicable']")" "passed never exceeds applicable"
check "$(j "$TMP/audit.json" "all(f['status']=='fail' for f in d['findings'])")" "findings contain only failures"
check "$(j "$TMP/audit.json" "all(f.get('evidence') or f.get('detail') for f in d['findings'])")" "every finding carries evidence or detail"
check "$(j "$TMP/audit.json" "[['high','medium','low'].index(f['severity']) for f in d['findings']] == sorted([['high','medium','low'].index(f['severity']) for f in d['findings']])")" \
      "findings are ordered most-severe first"
# n/a must not be counted as failure — that is what keeps the ratio honest.
node "$ROOT/scripts/audit-harness.mjs" --scan "$TMP/min.json" --json > "$TMP/audit-min.json" 2>/dev/null
check "$(j "$TMP/audit-min.json" "d['summary']['notApplicable']>0")" "empty config yields n/a checks, not failures"
check "$(j "$TMP/audit-min.json" "all(f['status']!='n/a' for f in d['findings'])")" "n/a checks never appear as findings"

# --- 5. manifests are valid ---------------------------------------------------
echo "[manifests]"
for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json; do
  python3 -c "import json;json.load(open('$ROOT/$f'))" 2>/dev/null
  check "$([ $? -eq 0 ] && echo true || echo false)" "$f is valid JSON"
done

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
