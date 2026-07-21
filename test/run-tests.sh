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
# Opened as a standalone file there is no HTTP charset header and no wrapper
# <head>, so without this every em dash rendered as mojibake.
check "$(head -c 200 "$TMP/min.html" | grep -qi 'charset=.utf-8' && echo true || echo false)" \
      "declares utf-8 within the first bytes so standalone output is not mojibake"
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
# Local-scope servers live under `projects[<absolute project path>]` in
# .claude.json, so this fixture is inherently path-dependent. Committing one
# machine's checkout path made the suite pass here and fail on any other clone
# (and in CI). Build it against the real path at run time instead.
echo "[mcp precedence]"
cp -R "$ROOT/test/fixtures/prec" "$TMP/prec-fx"
python3 - "$TMP/prec-fx" <<'PYEOF'
import json, os, sys
root = sys.argv[1]
proj = os.path.join(root, 'proj')
p = os.path.join(root, '.claude.json')
json.dump({
    "mcpServers": {"db": {"command": "user-server"}},
    "projects": {proj: {"mcpServers": {"db": {"command": "local-server"}}}},
}, open(p, 'w'))
PYEOF
node "$SCAN" --root "$TMP/prec-fx/.claude" --project "$TMP/prec-fx/proj" --include-prose > "$TMP/prec.json"
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
check "$(j "$TMP/rich.json" "any(m['name']=='pluginsrv' and m['active'] is False for m in d['layers']['mcp']['items'])")" \
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
# --- regressions found by cross-model review round 4 -------------------------
# Every assertion here corresponds to a defect that shipped. Two of them
# (hooks.defects, the bounded auditor read) had already been "fixed" once and
# silently regressed, which is why they are pinned by a test rather than a note.
echo "[review round 4 regressions]"

mkdir -p "$TMP/r4/.claude/agents"
cat > "$TMP/r4/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "echo \"$TOOL_INPUT\" | grep -q rm && exit 1" }] },
      { "matcher": "CLIENT_ALPHA_INTERNAL",
        "hooks": [{ "type": "command", "command": "true" }] }
    ],
    "CLIENT_CUSTOM_EVENT": [
      { "matcher": "*", "hooks": [{ "type": "CLIENT_TYPE", "command": "true" }] }
    ]
  }
}
JSON
node "$SCAN" --root "$TMP/r4/.claude" > "$TMP/r4.json" 2>/dev/null

check "$(j "$TMP/r4.json" "'defects' in d['layers']['hooks']")" \
      "scan emits hooks.defects (the two contract checks have data to read)"
check "$(j "$TMP/r4.json" "len(d['layers']['hooks']['defects']['readsToolInputEnv'])==1")" \
      "a hook reading \$TOOL_INPUT through a pipe is flagged"
check "$(j "$TMP/r4.json" "len(d['layers']['hooks']['defects']['nonBlockingExit'])==1")" \
      "a PreToolUse hook exiting 1 with no exit 2 is flagged"
check "$(! grep -q 'CLIENT_ALPHA_INTERNAL\|CLIENT_CUSTOM_EVENT\|CLIENT_TYPE' "$TMP/r4.json" && echo true || echo false)" \
      "authored matcher, event and hook type never reach default output"
check "$(j "$TMP/r4.json" "any(i['matcher']=='<custom>' for i in d['layers']['hooks']['items'])")" \
      "an unrecognised matcher collapses to a placeholder"
check "$(j "$TMP/r4.json" "any(i['matcher']=='Bash' for i in d['layers']['hooks']['items'])")" \
      "a built-in tool matcher is still emitted verbatim"

# A nested block under a key the scanner does NOT read must leave the document
# usable. Rejecting these wholesale reported 103 of 132 real skills as having no
# description, because SKILL.md files routinely carry a `metadata:` block.
printf -- '---\nname: keeps\nmodel: sonnet\ndescription: still parsed\nmetadata:\n  type: user\n  tags:\n    - a\n---\nbody\n' \
  > "$TMP/r4/.claude/agents/meta.md"
node "$SCAN" --root "$TMP/r4/.claude" --include-prose > "$TMP/r4m.json" 2>/dev/null
check "$(j "$TMP/r4m.json" "any(a['name']=='keeps' and a['model']=='sonnet' and a['description']=='still parsed' for a in d['layers']['agents']['items'])")" \
      "a nested block under an unread key leaves the scalars intact"
check "$(j "$TMP/r4m.json" "len(d['layers']['agents'].get('parseWarnings',[]))==0")" \
      "a nested block under an unread key raises no warning"
rm -f "$TMP/r4/.claude/agents/meta.md"

printf -- '---\nname: nested\nmodel:\n  family: haiku\ndescription: ok\n---\nbody\n' \
  > "$TMP/r4/.claude/agents/nested.md"
node "$SCAN" --root "$TMP/r4/.claude" --include-prose > "$TMP/r4n.json" 2>/dev/null
check "$(j "$TMP/r4n.json" "len(d['layers']['agents'].get('items',[]))==0")" \
      "a nested value under model: is withheld, never reported as model:null"
check "$(j "$TMP/r4n.json" "len(d['layers']['agents'].get('parseWarnings',[]))>0")" \
      "the withheld key is reported as a parse warning"

# --- round 5: every field that reached default output as authored text --------
# Each name below survived the "structure only" default in review round 5. The
# leak was never a pattern-matching miss — it was fields assumed to be closed
# enumerations that are in fact free text the user typed.
mkdir -p "$TMP/r5/.claude/agents"
cat > "$TMP/r5/.claude/settings.json" <<'JSON'
{
  "model": "CLIENT_MODEL_SECRET",
  "env": { "DISABLE_TELEMETRY": "CLIENT_ENV_SECRET" },
  "statusLine": { "type": "CLIENT_STATUS_SECRET", "command": "true" },
  "permissions": { "defaultMode": "CLIENT_MODE_SECRET" },
  "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command",
    "command": "/tmp/CLIENT_HOOK_SECRET.sh; echo \"$TOOL_INPUT\"" }] }] },
  "mcpServers": { "server": { "type": "CLIENT_TRANSPORT_SECRET" } }
}
JSON
printf -- '---\nname: a\nmodel: # CUSTOMER_SECRET\n---\nx\n' > "$TMP/r5/.claude/agents/a.md"
node "$SCAN" --root "$TMP/r5/.claude" > "$TMP/r5.json" 2>/dev/null

check "$(! grep -qE 'CLIENT_[A-Z_]+|CUSTOMER_SECRET' "$TMP/r5.json" && echo true || echo false)" \
      "no authored model, env value, statusLine type, permission mode, transport or script name survives"
check "$(j "$TMP/r5.json" "d['layers']['hooks']['defects']['readsToolInputEnv']==['script-01']")" \
      "a defect label refers to a script by index, never by its authored basename"
check "$(j "$TMP/r5.json" "d['layers']['environment']['env']['DISABLE_TELEMETRY']=='<hidden>'")" \
      "an allowlisted env key still hides a value outside its numeric/boolean domain"

printf -- '---\nname: n\nmodel: 475000\n---\nx\n' > "$TMP/r5/.claude/agents/a.md"
node "$SCAN" --root "$TMP/r5/.claude" --include-prose > "$TMP/r5v.json" 2>/dev/null
check "$(j "$TMP/r5v.json" "all(a['model']!='# CUSTOMER_SECRET' for a in d['layers']['agents']['items'])")" \
      "a comment-only value parses as empty, not as the comment text"

# `-foo: v` at column 0 is a top-level KEY in YAML: the dash has no space after it.
printf -- '---\nname: dash\nmetadata:\n-foo: kept\nmodel: sonnet\n---\nx\n' > "$TMP/r5/.claude/agents/a.md"
node "$SCAN" --root "$TMP/r5/.claude" --include-prose > "$TMP/r5d.json" 2>/dev/null
check "$(j "$TMP/r5d.json" "len(d['layers']['agents'].get('parseWarnings',[]))>0 or all(a.get('model')=='sonnet' for a in d['layers']['agents']['items'])")" \
      "a dash-prefixed top-level key is not swallowed into the preceding nested block"

python3 - "$TMP/hostile3.json" <<'PYEOF'
import json,sys
json.dump({"schemaVersion":2,"layers":{"mcp":{"status":"ok","count":1,
  "items":[{"name":"m","origin":"user","shadowed":"not-a-list"}]}}}, open(sys.argv[1],"w"))
PYEOF
node "$RENDER" --scan "$TMP/hostile3.json" --out "$TMP/hostile3.html" 2>/dev/null
check "$([ -s "$TMP/hostile3.html" ] && echo true || echo false)" \
      "renderer survives mcp shadowed as a string"

python3 - "$TMP/hostile4.json" <<'PYEOF'
import json,sys
json.dump({"findings":[{"id":"x","severity":"high","title":"t","detail":"d",
  "evidence":"not-a-list"}],"passing":[]}, open(sys.argv[1],"w"))
PYEOF
node "$RENDER" --scan "$TMP/r5.json" --audit "$TMP/hostile4.json" --out "$TMP/hostile4.html" 2>/dev/null
check "$([ -s "$TMP/hostile4.html" ] && echo true || echo false)" \
      "renderer survives a finding whose evidence is a string"

# --- round 6: fields and paths that still carried authored text ---------------
mkdir -p "$TMP/r6/.claude/skills" "$TMP/r6/.claude/agents" "$TMP/r6/.claude/plugins" "$TMP/r6/outside/evil"
cat > "$TMP/r6/.claude/settings.json" <<'JSON'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./guard.sh"}]}]}}
JSON
cat > "$TMP/r6/.claude/plugins/installed_plugins.json" <<'JSON'
{"p@m":[{"scope":"/private/CLIENT_SCOPE_SECRET","version":"1.0"}]}
JSON
cat > "$TMP/r6/.claude/plugins/known_marketplaces.json" <<'JSON'
{"m":{"source":{"source":"CLIENT_MKT_SECRET","repo":"a/b"}}}
JSON
printf -- '---\nCLIENT_KEY_SECRET: &x v\nname: a\n---\nx\n' > "$TMP/r6/.claude/agents/a.md"
printf -- '---\nname: CLIENT_SKILL_SECRET\n---\n' > "$TMP/r6/outside/evil/SKILL.md"
ln -s "$TMP/r6/outside/evil" "$TMP/r6/.claude/skills/linked"
node "$SCAN" --root "$TMP/r6/.claude" > "$TMP/r6.json" 2>/dev/null

check "$(! grep -qE 'CLIENT_[A-Z_]+' "$TMP/r6.json" && echo true || echo false)" \
      "plugin scope, marketplace type, a parse-warning key and a symlinked skill all stay out of default output"
check "$(j "$TMP/r6.json" "d['layers']['hooks']['scriptRefs']==[] and d['layers']['hooks']['unresolvedRefs']==1")" \
      "./guard.sh counts as unresolved and is never treated as the absolute path /guard.sh"
check "$(j "$TMP/r6.json" "all('CLIENT' not in w for x in d['layers']['agents'].get('parseWarnings',[]) for w in x['warnings'])")" \
      "a parse warning states the reason without quoting the authored key"
check "$(j "$TMP/r6.json" "d['layers']['skills']['status']=='unconfigured'")" \
      "a symlinked skill directory is not followed out of the config tree"

printf -- '---\nname: q\nmodel: "sonnet" # trailing note\n---\nx\n' > "$TMP/r6/.claude/agents/a.md"
node "$SCAN" --root "$TMP/r6/.claude" --include-prose > "$TMP/r6q.json" 2>/dev/null
check "$(j "$TMP/r6q.json" "any(a['model']=='sonnet' for a in d['layers']['agents']['items'])")" \
      "a quoted scalar with a trailing comment parses to the quoted value"

python3 - "$TMP/nulls.json" <<'PYEOF'
import json,sys
json.dump({"schemaVersion":2,"layers":{
  "hooks":{"status":"ok","count":1,"items":[None],"byEvent":{},"events":[]}}}, open(sys.argv[1],"w"))
PYEOF
node "$RENDER" --scan "$TMP/nulls.json" --out "$TMP/nulls.html" 2>/dev/null
check "$([ -s "$TMP/nulls.html" ] && echo true || echo false)" \
      "renderer survives a null element inside an otherwise valid array"

python3 - "$TMP/hidden.json" <<'PYEOF'
import json,sys
json.dump({"schemaVersion":2,"layers":{"environment":{"status":"ok",
  "env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"<hidden>"},
  "permissions":{"allow":1,"deny":0,"ask":0,"toolBreakdown":{}}}}}, open(sys.argv[1],"w"))
PYEOF
check "$(node "$AUDIT" --scan "$TMP/hidden.json" 2>/dev/null | grep -qi 'NaN' && echo false || echo true)" \
      "a withheld auto-compact value never renders as NaNk"

head -c 20000000 /dev/zero | tr '\0' 'x' > "$TMP/huge.json" 2>/dev/null
node "$AUDIT" --scan "$TMP/huge.json" >/dev/null 2>"$TMP/huge.err"
check "$([ $? -ne 0 ] && grep -qi 'limit\|bytes' "$TMP/huge.err" && echo true || echo false)" \
      "auditor rejects an oversized --scan file before reading it"

python3 - "$TMP/hostile.json" <<'PYEOF'
import json,sys
json.dump({"schemaVersion":2,"prose":False,"sources":"not-a-list","layers":{
  "agents":{"status":"ok","items":"not-a-list","byModel":{}},
  "review":{"status":"ok","items":[]},
  "rules":{"status":"ok","items":[{"name":"r","headings":"nope"}]},
}}, open(sys.argv[1],"w"))
PYEOF
node "$RENDER" --scan "$TMP/hostile.json" \
  --audit /dev/null --out "$TMP/hostile.html" 2>"$TMP/hostile.err"
check "$([ -s "$TMP/hostile.html" ] || [ -s "$TMP/hostile.err" ] && echo true || echo false)" \
      "renderer either renders or fails loudly on wrong collection types, never hangs"

python3 - "$TMP/hostile2.json" <<'PYEOF'
import json,sys
json.dump({"schemaVersion":2,"findings":"nope","passing":"nope"}, open(sys.argv[1],"w"))
PYEOF
node "$RENDER" --scan "$TMP/r4.json" --audit "$TMP/hostile2.json" \
  --out "$TMP/hostile2.html" 2>/dev/null
check "$([ -s "$TMP/hostile2.html" ] && echo true || echo false)" \
      "renderer survives audit.findings and audit.passing as strings"

# note() is a CLOSED SET, which makes it airtight but creates a maintenance
# hazard: a reason string added to the scanner and not to KNOWN_NOTES is silently
# nulled, and an unconfigured layer with no reason explains nothing. Every fixture
# is checked, because each one leaves a different set of layers unconfigured.
echo "[reason coverage]"
for FX in minimal rich yaml symlink prec; do
  node "$SCAN" --root "$ROOT/test/fixtures/$FX/.claude" > "$TMP/reason-$FX.json" 2>/dev/null
  check "$(j "$TMP/reason-$FX.json" "all(v.get('reason') is not None for v in d['layers'].values() if v.get('status')!='ok')")" \
        "every unconfigured layer still carries a reason ($FX)"
done
node "$SCAN" > "$TMP/reason-self.json" 2>/dev/null
check "$(j "$TMP/reason-self.json" "all(v.get('reason') is not None for v in d['layers'].values() if v.get('status')!='ok')")" \
      "every unconfigured layer still carries a reason (this machine)"

# A proseRef names a file the model is told it may read, so its label must be the
# SAME label that file carries in the rules layer. The two lists were indexed
# independently, so `rule-03` named one file in rules.items and a different one in
# proseRefs.
check "$(j "$TMP/rich.json" "all(r['name'] in {x['name'] for x in d['layers']['rules']['items']} for k in ('orchestrators','review') for r in d['layers'][k].get('proseRefs',[]))")" \
      "every proseRef label resolves to an entry in the rules layer"

# Two suites run directly rather than through fixtures: the gate's defining
# property is about fields that do not exist YET, and note coverage is about
# reason strings a fixture may never reach.
for EXTRA in gate notes; do
  EXTRA_OUT="$(node "$ROOT/test/$EXTRA-test.mjs" 2>&1)"
  echo "$EXTRA_OUT" | grep -E '^  (ok|FAIL)' || true
  PASS=$((PASS + $(echo "$EXTRA_OUT" | grep -c '^  ok')))
  FAIL=$((FAIL + $(echo "$EXTRA_OUT" | grep -c '^  FAIL')))
done


echo "[manifests]"
for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json; do
  python3 -c "import json;json.load(open('$ROOT/$f'))" 2>/dev/null
  check "$([ $? -eq 0 ] && echo true || echo false)" "$f is valid JSON"
done

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
