#!/usr/bin/env bash
# PHASE 12 §27 — long-session live E2E for the GigaChat V2 connector.
#
# Drives ONE OpenCode session through the plan's agent loop
# (inspect → find → modify → run tests → inspect failure → fix → run tests →
# review diff) as a sequence of `opencode run --session <id>` turns, then runs
# the §27 analyzer over the session store + outbound dump:
#
#   scripts/smoke/lib/analyze-long-session.py
#
# Requires a network path to the live GigaChat API (api.giga.chat). The run is
# isolated from the environment's own OpenCode config (scratch XDG under
# /tmp/opencode/gigachat-smoke-long) and credentials are copied from the live
# config programmatically — never printed to stdout.
#
# Usage:
#   scripts/smoke/run-long-session.sh [--keep] [--min-tools N] [--analyze-only]
#
# Env overrides:
#   SMOKE_ROOT           scratch root (default /tmp/opencode/gigachat-smoke-long)
#   SMOKE_SOURCE_CONFIG  live opencode.json to read credentials from
#   SMOKE_CA_PEM         PEM bundle for OpenCode->GigaChat TLS
#   SMOKE_MODEL          provider/model (default gigachat/GigaChat-2-Max)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$REPO_ROOT/fixtures/opencode-project"
SMOKE_ROOT="${SMOKE_ROOT:-/tmp/opencode/gigachat-smoke-long}"
SOURCE_CONFIG="${SMOKE_SOURCE_CONFIG:-/mnt/c/OpnCod_Proj/opencode/local/config/opencode/opencode.json}"
CA_PEM="${SMOKE_CA_PEM:-/mnt/c/OpnCod_Proj/opencode/local/config/opencode/certs/russian_trusted_root_ca.pem}"
MODEL="${SMOKE_MODEL:-gigachat/GigaChat-2-Max}"
MIN_TOOLS="${SMOKE_MIN_TOOLS:-20}"
KEEP=0
ANALYZE_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --min-tools) MIN_TOOLS="$2"; shift ;;
    --analyze-only) ANALYZE_ONLY=1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

ANALYZER="$REPO_ROOT/scripts/smoke/lib/analyze-long-session.py"

if [[ $ANALYZE_ONLY -eq 1 ]]; then
  python3 "$ANALYZER" --root "$SMOKE_ROOT" --min-tools "$MIN_TOOLS"
  exit $?
fi

WORKSPACE="$SMOKE_ROOT/workspace"
DUMP="$SMOKE_ROOT/logs/outbound-dump.log"

# --- 1. Build the plugin -----------------------------------------------------
echo ">> Building plugin (bun run build)"
(cd "$REPO_ROOT" && bun run build >/dev/null)

# --- 2. Prepare scratch dirs -------------------------------------------------
echo ">> Scratch root: $SMOKE_ROOT"
rm -rf "$SMOKE_ROOT"
mkdir -p "$SMOKE_ROOT/config/opencode" "$SMOKE_ROOT/data" "$SMOKE_ROOT/cache" \
         "$SMOKE_ROOT/state" "$SMOKE_ROOT/logs" "$SMOKE_ROOT/plugin" \
         "$SMOKE_ROOT/npm-cache" "$SMOKE_ROOT/capture-plugin"

cp "$REPO_ROOT/dist/index.js" "$SMOKE_ROOT/plugin/index.js"
cat > "$SMOKE_ROOT/plugin/package.json" <<'EOF'
{
  "name": "gigachat-v2-plugin",
  "version": "2.0.0",
  "description": "GigaChat Connector plugin for OpenCode V2 (long-session smoke build)",
  "type": "module",
  "main": "index.js",
  "license": "MIT"
}
EOF

cp "$REPO_ROOT/scripts/smoke/lib/capture-plugin/index.js" "$SMOKE_ROOT/capture-plugin/index.js"
cp "$REPO_ROOT/scripts/smoke/lib/capture-plugin/package.json" "$SMOKE_ROOT/capture-plugin/package.json"

# Work on a scratch COPY of the fixture (never touch the repo fixture).
cp -r "$FIXTURE" "$WORKSPACE"
( cd "$WORKSPACE" && git init -q && git config user.email smoke@example.invalid \
    && git config user.name "smoke" && git add -A && git commit -qm "pristine fixture" )

# --- 3. Generate scratch config (secrets injected, never echoed) -------------
python3 - "$SOURCE_CONFIG" "$SMOKE_ROOT/plugin" "$SMOKE_ROOT/capture-plugin" "$WORKSPACE" "$SMOKE_ROOT/config/opencode/opencode.json" <<'PY'
import json, sys
src, plugin, capture, fixture, out = sys.argv[1:6]
with open(src) as f:
    live = json.load(f)
creds = None
scope = "GIGACHAT_API_PERS"
for p in live.get("plugins", []):
    if isinstance(p, dict) and isinstance(p.get("options"), dict) and p["options"].get("credentials"):
        creds = p["options"]["credentials"]
        scope = p["options"].get("scope", scope)
        break
if not creds:
    print("ERROR: no plugin credentials found in source config", file=sys.stderr)
    sys.exit(1)
cfg = {
    "providers": {
        "gigachat": {
            "name": "GigaChat V2 (api.giga.chat)",
            "package": "@opencode/ai/providers/openai-compatible",
            "env": ["GIGACHAT_CREDENTIALS"],
            "settings": {"baseURL": "https://api.giga.chat/v1"},
            "models": {
                "GigaChat-2-Max": {
                    "name": "GigaChat 2 Max",
                    "limit": {"context": 128000, "output": 8192},
                    "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
                }
            },
        }
    },
    "plugins": [
        {"package": plugin, "options": {"credentials": creds, "scope": scope, "v2": True}},
        {"package": capture, "options": {}},
    ],
    "mcp": {
        "servers": {
            "fs": {
                "type": "local",
                "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", fixture],
            }
        }
    },
}
with open(out, "w") as f:
    json.dump(cfg, f, indent=2)
print(f"   scratch config written: {out}")
PY

GIGACHAT_CREDENTIALS_VALUE="$(python3 -c "
import json
cfg=json.load(open('$SMOKE_ROOT/config/opencode/opencode.json'))
print(cfg['plugins'][0]['options']['credentials'])
")"

export XDG_CONFIG_HOME="$SMOKE_ROOT/config"
export XDG_DATA_HOME="$SMOKE_ROOT/data"
export XDG_CACHE_HOME="$SMOKE_ROOT/cache"
export XDG_STATE_HOME="$SMOKE_ROOT/state"
export NODE_EXTRA_CA_CERTS="$CA_PEM"
export GIGACHAT_DEBUG="true"
export GIGACHAT_CREDENTIALS="$GIGACHAT_CREDENTIALS_VALUE"
export SMOKE_DUMP_LOG="$DUMP"
export npm_config_cache="$SMOKE_ROOT/npm-cache"

# --- 4. Session helper -------------------------------------------------------
SID=""
STEP=0

resolve_session() {
  SID="$(python3 - "$SMOKE_ROOT" <<'PY'
import sqlite3, sys
db = sys.argv[1] + "/data/opencode/opencode.db"
try:
    con = sqlite3.connect(db)
    row = con.execute(
        "SELECT id FROM session_v2 ORDER BY time_created DESC LIMIT 1"
    ).fetchone()
    print(row[0] if row else "")
except Exception:
    print("")
PY
)"
}

run_step() {
  local name="$1"; shift
  local prompt="$1"
  local log="$SMOKE_ROOT/logs/$(printf '%02d' "$STEP")-$name.log"
  STEP=$((STEP + 1))
  local extra=()
  if [[ -n "$SID" ]]; then extra+=(--session "$SID"); fi
  echo ">> [$name] $(date +%H:%M:%S) session=${SID:-<new>}"
  set +e
  ( cd "$WORKSPACE" && opencode run --standalone --auto --print-logs \
      --model "$MODEL" --agent build "${extra[@]}" "$prompt" ) >"$log" 2>&1
  local rc=$?
  set -e
  echo "   exit=$rc"
  # Resolve the session id right after the first (session-creating) turn.
  if [[ -z "$SID" ]]; then resolve_session; echo "   session=$SID"; fi
  RESULTS+=("$name:exit=$rc")
}

# --- 5. Steps (single session; ~10 turns → 20-30 tool interactions) ----------
declare -a RESULTS
FAILED=0

run_session() {
  SID=""
  STEP=0
  RESULTS=()

  run_step inspect-repo \
    "Inspect the repository using SEPARATE tool calls: (a) glob src/**/*.ts, (b) glob tests/**/*.ts, (c) read README.md, (d) read src/math.ts. Then list each file you found with a one-line summary. Do not ask questions."

  run_step read-modules \
    "Using two SEPARATE tool calls, read tests/hello.test.ts and src/hello.ts. Then summarize each file in one line. Do not ask questions."

  run_step write-tests \
    "Use the write tool to create tests/math.test.ts with bun:test unit tests: factorial for n=0, n=1 and n=5; fibonacci for n=0..6; and isEven for one even and one odd input. Do not modify anything under src/. Do not ask questions."

  run_step run-tests \
    "Run 'bun test' in this project with the bash tool and report exactly which tests fail. Do not fix anything yet."

  run_step inspect-failure \
    "A factorial test failed. Read src/math.ts again and explain the exact bug in factorial(). Do not edit any file yet."

  run_step fix-factorial \
    "Fix the factorial() bug in src/math.ts in place using the edit tool. Do NOT modify isEven() — leave it exactly as it is. Then run 'bun test'."

  run_step fix-iseven \
    "The isEven tests still fail. Read src/math.ts, fix isEven() in place using the edit tool, then run 'bun test' again and confirm the whole suite passes."

  run_step review-diff \
    "Run 'git diff --stat' and then 'git diff' with the bash tool to review your changes. Summarize what changed and why."

  run_step parallel-tools \
    "In a SINGLE assistant step issue three SEPARATE tool calls at once: (1) glob src/**/*.ts, (2) glob tests/**/*.ts, (3) read src/hello.ts. Do NOT nest the calls inside another tool. Then report each result."

  run_step final-review \
    "Final review: read tests/math.test.ts and src/math.ts using two SEPARATE tool calls, then run 'bun test' one last time and report the result."
}

# One retry from a pristine workspace (upstream stalls / model flakiness).
attempt=1
while :; do
  FAILED=0
  run_session
  # Hard evidence assertion: the fixture suite must be green at the end.
  set +e
  ( cd "$WORKSPACE" && bun test >"$SMOKE_ROOT/logs/final-fixture-bun-test.log" 2>&1 )
  TEST_RC=$?
  set -e
  if [[ $TEST_RC -eq 0 ]]; then
    echo ">> ASSERT: fixture 'bun test' green OK"
  else
    echo ">> ASSERT FAIL: fixture tests not green ($TEST_RC) — see logs/final-fixture-bun-test.log"
    FAILED=1
  fi
  if [[ $FAILED -eq 0 || $attempt -ge 2 ]]; then break; fi
  echo ">> Session attempt $attempt failed — retrying once from a pristine workspace"
  rm -rf "$WORKSPACE"
  cp -r "$FIXTURE" "$WORKSPACE"
  ( cd "$WORKSPACE" && git init -q && git config user.email smoke@example.invalid \
      && git config user.name "smoke" && git add -A && git commit -qm "pristine fixture" )
  attempt=$((attempt + 1))
done

echo ""
echo "================================================================"
echo " STEPS"
echo "================================================================"
for r in "${RESULTS[@]}"; do echo "  $r"; done

# --- 6. Analyze the long session --------------------------------------------
echo ""
if [[ -n "$SID" ]]; then
  python3 "$ANALYZER" --root "$SMOKE_ROOT" --session-id "$SID" --min-tools "$MIN_TOOLS" || FAILED=1
else
  echo ">> ANALYZER SKIPPED: no session id resolved" >&2
  FAILED=1
fi

# --- 7. Optional cancellation probe (best-effort, non-fatal) -----------------
PROBE_LOG="$SMOKE_ROOT/logs/cancel-probe.log"
echo ""
echo ">> Cancellation probe (best-effort): SIGINT a long generation mid-stream"
set +e
( cd "$WORKSPACE" && timeout -s INT 25 opencode run --standalone --auto \
    --model "$MODEL" --agent build \
    "Write an extremely detailed 3000-word essay about the history of computing. Do not stop early." ) >"$PROBE_LOG" 2>&1
PROBE_RC=$?
set -e
if [[ $PROBE_RC -eq 124 || $PROBE_RC -eq 130 ]]; then
  echo "   probe: interrupted as expected (rc=$PROBE_RC)"
else
  echo "   probe: completed/interrupted with rc=$PROBE_RC (environment-dependent, non-fatal)"
fi
# A normal turn must still work after the abort.
set +e
( cd "$WORKSPACE" && opencode run --standalone --auto --model "$MODEL" --agent build \
    "Reply with exactly: OK" ) >"$SMOKE_ROOT/logs/cancel-recovery.log" 2>&1
RECOVER_RC=$?
set -e
if [[ $RECOVER_RC -eq 0 ]]; then
  echo "   recovery after abort: OK (rc=0)"
else
  echo "   recovery after abort: rc=$RECOVER_RC" >&2
fi

echo ""
echo ">> Logs: $SMOKE_ROOT/logs | analysis: $SMOKE_ROOT/logs/long-session-analysis.json"
if [[ $FAILED -ne 0 ]]; then echo "LONG-SESSION RESULT: FAILED" >&2; exit 1; fi
echo "LONG-SESSION RESULT: PASS"
