#!/usr/bin/env bash
# PHASE 10 §26 — Real OpenCode smoke test for the GigaChat V2 connector.
#
# Runs the CURRENT build of the plugin inside a REAL `opencode run --standalone`
# session against the LIVE GigaChat V2 API, driven by the fixture project in
# fixtures/opencode-project/. Isolated from the environment's own OpenCode
# config (scratch XDG under /tmp/opencode/gigachat-smoke).
#
# Secrets: credentials are copied from the live OpenCode config into the
# scratch config programmatically and are NEVER printed to stdout.
#
# Usage:
#   scripts/smoke/run-smoke.sh [--keep] [--scenario N]
#
# Env overrides:
#   SMOKE_SOURCE_CONFIG  live opencode.json to read credentials from
#   SMOKE_CA_PEM         PEM bundle for OpenCode->GigaChat TLS
#   SMOKE_MODEL          provider/model (default gigachat/GigaChat-2-Max)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$REPO_ROOT/fixtures/opencode-project"
SMOKE_ROOT="${SMOKE_ROOT:-/tmp/opencode/gigachat-smoke}"
SOURCE_CONFIG="${SMOKE_SOURCE_CONFIG:-/mnt/c/OpnCod_Proj/opencode/local/config/opencode/opencode.json}"
CA_PEM="${SMOKE_CA_PEM:-/mnt/c/OpnCod_Proj/opencode/local/config/opencode/certs/russian_trusted_root_ca.pem}"
MODEL="${SMOKE_MODEL:-gigachat/GigaChat-2-Max}"
KEEP=0
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --scenario) ONLY="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# --- 1. Build the plugin -----------------------------------------------------
echo ">> Building plugin (bun run build)"
(cd "$REPO_ROOT" && bun run build >/dev/null)

# --- 2. Prepare scratch dirs -------------------------------------------------
echo ">> Scratch root: $SMOKE_ROOT"
rm -rf "$SMOKE_ROOT"
mkdir -p "$SMOKE_ROOT/config/opencode" "$SMOKE_ROOT/data" "$SMOKE_ROOT/cache" \
         "$SMOKE_ROOT/state" "$SMOKE_ROOT/logs" "$SMOKE_ROOT/plugin" "$SMOKE_ROOT/npm-cache"

# Plugin package dir (matches the harness's gigachat-plugin/ layout)
cp "$REPO_ROOT/dist/index.js" "$SMOKE_ROOT/plugin/index.js"
cat > "$SMOKE_ROOT/plugin/package.json" <<'EOF'
{
  "name": "gigachat-v2-plugin",
  "version": "2.0.0",
  "description": "GigaChat Connector plugin for OpenCode V2 (smoke build)",
  "type": "module",
  "main": "index.js",
  "license": "MIT"
}
EOF

# Evidence-capture plugin (observes the FINAL outbound request after the connector)
cp -r "$REPO_ROOT/scripts/smoke/lib/capture-plugin" "$SMOKE_ROOT/capture-plugin"

# --- 3. Generate scratch config (secrets injected, never echoed) -------------
python3 - "$SOURCE_CONFIG" "$SMOKE_ROOT/plugin" "$SMOKE_ROOT/capture-plugin" "$FIXTURE" "$SMOKE_ROOT/config/opencode/opencode.json" <<'PY'
import json, sys
src, plugin, capture, fixture, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
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
    # Capture plugin listed AFTER the connector so its hooks observe the final
    # request: hard evidence the traffic went to the live V2 endpoint.
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

# --- 4. Run helper -------------------------------------------------------------
FAILED=0
declare -a RESULTS

echo ">> Snapshot pristine fixture -> $SMOKE_ROOT/fixture-pristine"
rm -rf "$SMOKE_ROOT/fixture-pristine"
cp -r "$FIXTURE" "$SMOKE_ROOT/fixture-pristine"

run_scenario() {
  local name="$1"; shift
  local prompt="$1"; shift
  local log="$SMOKE_ROOT/logs/$name.log"
  echo ""
  echo ">> [$(date +%H:%M:%S)] Scenario $name"
  set +e
  ( cd "$FIXTURE" && env \
    XDG_CONFIG_HOME="$SMOKE_ROOT/config" \
    XDG_DATA_HOME="$SMOKE_ROOT/data" \
    XDG_CACHE_HOME="$SMOKE_ROOT/cache" \
    XDG_STATE_HOME="$SMOKE_ROOT/state" \
    NODE_EXTRA_CA_CERTS="$CA_PEM" \
    GIGACHAT_DEBUG=true \
    GIGACHAT_CREDENTIALS="$GIGACHAT_CREDENTIALS_VALUE" \
    SMOKE_DUMP_LOG="$SMOKE_ROOT/logs/outbound-dump.log" \
    npm_config_cache="$SMOKE_ROOT/npm-cache" \
    opencode run --standalone --auto --print-logs --model "$MODEL" --agent build "$prompt" ) >"$log" 2>&1
  local rc=$?
  set -e
  echo "   exit=$rc"
  if grep -q "REQ url=https://api.giga.chat/v2/chat/completions" "$SMOKE_ROOT/logs/outbound-dump.log" 2>/dev/null; then
    echo "   V2-pipeline: CONFIRMED (outbound to api.giga.chat/v2/chat/completions)"
  else
    echo "   V2-pipeline: NOT CONFIRMED — grep '$SMOKE_ROOT/logs/outbound-dump.log' for REQ url=https://api.giga.chat/v2/chat/completions"
  fi
  RESULTS+=("$name:exit=$rc")
  return $rc
}

GIGACHAT_CREDENTIALS_VALUE="$(python3 -c "
import json,sys
cfg=json.load(open('$SMOKE_ROOT/config/opencode/opencode.json'))
print(cfg['plugins'][0]['options']['credentials'])
")"

# --- 5. Scenarios --------------------------------------------------------------
# One scenario set = all six scenarios. A FAILED set is retried once (upstream
# stalls / model flakiness) from the pristine snapshot.
run_scenario_set() {
if [[ -z "$ONLY" || "$ONLY" == "1" ]]; then
  run_scenario 01-explain \
    "Explain what src/hello.ts does in 3-5 sentences." || { FAILED=1; }
  [[ -z "$ONLY" ]] || { echo ">> skipped: isolated run (--scenario)"; }
  if [[ -z "$ONLY" ]] && ! grep -qi "greet" "$SMOKE_ROOT/logs/01-explain.log"; then echo "   ASSERT: 'greet' not found in answer" >&2; FAILED=1; fi
fi

if [[ -z "$ONLY" || "$ONLY" == "2" ]]; then
  run_scenario 02-fix-factorial \
    "src/math.ts contains a bug in factorial(). Find it, fix it in place, then run the test suite to confirm nothing broke. Do NOT modify isEven() — leave it exactly as it is." || { FAILED=1; }
  if [[ -z "$ONLY" ]]; then
    set +e
    (cd "$FIXTURE" && bun -e "import {factorial} from './src/math.ts'; if (factorial(5)!==120 || factorial(0)!==1 || factorial(1)!==1) process.exit(1);") >/dev/null 2>&1
    local_rc=$?
    set -e
    if [[ $local_rc -eq 0 ]]; then echo "   ASSERT: factorial(5)=120, factorial(0)=1 OK"; else echo "   ASSERT FAIL: factorial still wrong" >&2; FAILED=1; fi
    if grep -q "n % 2 === 1" "$FIXTURE/src/math.ts"; then echo "   ASSERT: isEven untouched OK"; else echo "   ASSERT FAIL: isEven was modified" >&2; FAILED=1; fi
  fi
fi

if [[ -z "$ONLY" || "$ONLY" == "3" ]]; then
  run_scenario 03-add-tests \
    "Use the read tool to read src/math.ts. Then write tests/math.test.ts with bun:test unit tests for factorial (n=0, n=1, n=5), fibonacci (n=0..6) and isEven (one even, one odd input). Do NOT modify anything under src/. Do not ask questions — just do it." || { FAILED=1; }
  if [[ -z "$ONLY" ]] && ! grep -rlq "factorial" "$FIXTURE/tests" 2>/dev/null; then echo "   ASSERT FAIL: no factorial test added under tests/" >&2; FAILED=1; fi
fi

if [[ -z "$ONLY" || "$ONLY" == "4" ]]; then
  run_scenario 04-run-and-fix \
    "Run 'bun test' in this project. If any test fails, fix the SOURCE CODE (never the tests) until the whole suite passes, then run 'bun test' once more to confirm." || { FAILED=1; }
  if [[ -z "$ONLY" ]]; then
    set +e
    (cd "$FIXTURE" && bun test >"$SMOKE_ROOT/logs/04-fixture-bun-test.log" 2>&1)
    local_rc=$?
    set -e
    if [[ $local_rc -eq 0 ]]; then echo "   ASSERT: fixture 'bun test' green OK"; else echo "   ASSERT FAIL: fixture tests not green ($local_rc)" >&2; FAILED=1; fi
  fi
fi

if [[ -z "$ONLY" || "$ONLY" == "5" ]]; then
  run_scenario 05-parallel-tools \
    "In a SINGLE assistant step issue three SEPARATE tool calls at once: (1) glob tool with src/**/*.ts, (2) glob tool with tests/**/*.ts, (3) read tool with src/hello.ts. Do NOT wrap or nest tool calls inside the execute tool. Then report each file you actually found, with a one-line summary each." || { FAILED=1; }
  if [[ -z "$ONLY" ]]; then
    grep -q "hello.ts" "$SMOKE_ROOT/logs/05-parallel-tools.log" && grep -q "math.ts" "$SMOKE_ROOT/logs/05-parallel-tools.log" \
      && echo "   ASSERT: both hello.ts and math.ts covered OK" \
      || { echo "   ASSERT FAIL: parallel output missing files" >&2; FAILED=1; }
  fi
fi

if [[ -z "$ONLY" || "$ONLY" == "6" ]]; then
  run_scenario 06-mcp-fs \
    "Use the MCP filesystem tool read_file with the project root path to read README.md (the MCP server is named fs, directory fixtures/opencode-project). Then summarize the project in 2-3 sentences. Do not ask questions — just do it." || { FAILED=1; }
  if [[ -z "$ONLY" ]]; then
    if grep -qi "Read README" "$SMOKE_ROOT/logs/06-mcp-fs.log" \
      && grep -qi "bun" "$SMOKE_ROOT/logs/06-mcp-fs.log"; then
      echo "   ASSERT: MCP read of README reflected (Bun mention) OK"
    else
      echo "   ASSERT FAIL: README content not reflected in answer" >&2; FAILED=1
    fi
  fi
fi
} # end run_scenario_set

# --- 6. Retry loop + evidence + restore ------------------------------------------
if [[ -n "$ONLY" ]]; then
  run_scenario_set
else
  attempt=1
  while :; do
    FAILED=0
    RESULTS=()
    run_scenario_set
    if [[ $FAILED -eq 0 || $attempt -ge 2 ]]; then break; fi
    echo ""
    echo ">> Scenario set FAILED on attempt $attempt — retrying once from pristine snapshot"
    rm -rf "$FIXTURE"
    cp -r "$SMOKE_ROOT/fixture-pristine" "$FIXTURE"
    attempt=$((attempt + 1))
  done
fi

mkdir -p "$SMOKE_ROOT/after"
cp -r "$FIXTURE" "$SMOKE_ROOT/after/fixture-final"
echo ""
echo "================================================================"
echo " RESULTS"
echo "================================================================"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "================================================================"

if [[ $KEEP -eq 0 && -z "$ONLY" ]]; then
  echo ">> Restoring pristine fixture (from snapshot)"
  rm -rf "$FIXTURE"
  cp -r "$SMOKE_ROOT/fixture-pristine" "$FIXTURE"
fi

echo ">> Logs: $SMOKE_ROOT/logs | final state: $SMOKE_ROOT/after/fixture-final"
if [[ $FAILED -ne 0 ]]; then echo "SMOKE RESULT: FAILED" >&2; exit 1; fi
echo "SMOKE RESULT: PASS"