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
#   SMOKE_ATTEMPTS       per-scenario retries (default 3; 1 disables retries)
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
# Explicit empty initializers: under `set -u`, a declared-but-never-assigned
# array makes `${#arr[@]}` abort with "unbound variable".
declare -a RESULTS=()
declare -a FAILED_SCENARIOS=()
SMOKE_ATTEMPTS="${SMOKE_ATTEMPTS:-3}"

echo ">> Snapshot pristine fixture -> $SMOKE_ROOT/fixture-pristine"
rm -rf "$SMOKE_ROOT/fixture-pristine"
cp -r "$FIXTURE" "$SMOKE_ROOT/fixture-pristine"

restore_fixture() {
  rm -rf "$FIXTURE"
  cp -r "$SMOKE_ROOT/fixture-pristine" "$FIXTURE"
}

GIGACHAT_CREDENTIALS_VALUE="$(python3 -c "
import json,sys
cfg=json.load(open('$SMOKE_ROOT/config/opencode/opencode.json'))
print(cfg['plugins'][0]['options']['credentials'])
")"

# Run one attempt of a scenario and preserve its log per attempt. Sets the
# global V2_CONFIRMED from only the requests emitted during *this* attempt
# (offset into the shared outbound dump), so a later scenario can never borrow
# an earlier scenario's V2 evidence.
V2_CONFIRMED=0
run_scenario_attempt() {
  local name="$1"
  local prompt="$2"
  local attempt="$3"
  local log="$SMOKE_ROOT/logs/$name.log"
  local dump="$SMOKE_ROOT/logs/outbound-dump.log"
  local before=0
  [[ -f "$dump" ]] && before="$(wc -l < "$dump")"

  set +e
  ( cd "$FIXTURE" && env \
    XDG_CONFIG_HOME="$SMOKE_ROOT/config" \
    XDG_DATA_HOME="$SMOKE_ROOT/data" \
    XDG_CACHE_HOME="$SMOKE_ROOT/cache" \
    XDG_STATE_HOME="$SMOKE_ROOT/state" \
    NODE_EXTRA_CA_CERTS="$CA_PEM" \
    GIGACHAT_DEBUG=true \
    GIGACHAT_CREDENTIALS="$GIGACHAT_CREDENTIALS_VALUE" \
    SMOKE_DUMP_LOG="$dump" \
    npm_config_cache="$SMOKE_ROOT/npm-cache" \
    opencode run --standalone --auto --print-logs --model "$MODEL" --agent build "$prompt" ) >"$log" 2>&1
  local rc=$?
  set -e
  cp "$log" "$SMOKE_ROOT/logs/$name.attempt${attempt}.log"

  local new_v2=0
  if [[ -f "$dump" ]]; then
    new_v2="$(tail -n +"$((before + 1))" "$dump" | grep -c "REQ url=https://api.giga.chat/v2/chat/completions" || true)"
  fi
  if [[ "$new_v2" -gt 0 ]]; then V2_CONFIRMED=1; else V2_CONFIRMED=0; fi
  echo "   exit=$rc  v2-requests-this-attempt=$new_v2"
  return $rc
}

# Run one scenario step under an already-restored fixture. Returns 0 only when
# opencode exited 0, the request went to the V2 endpoint and the assertion
# passed. Sets V2_CONFIRMED for the attempt.
run_step() {
  local name="$1"
  local prompt="$2"
  local assert_fn="$3"
  local attempt="$4"
  echo ""
  echo ">> [$(date +%H:%M:%S)] Scenario $name (attempt $attempt/$SMOKE_ATTEMPTS)"
  run_scenario_attempt "$name" "$prompt" "$attempt" || true
  if [[ "$V2_CONFIRMED" -eq 1 ]] && ( "$assert_fn" ); then
    return 0
  fi
  return 1
}

# Retry an independent scenario up to SMOKE_ATTEMPTS times; each attempt starts
# from the pristine fixture. Connector failures are not masked: the per-attempt
# V2 evidence and the assertions are re-checked on every attempt.
try_scenario() {
  local name="$1"
  local prompt="$2"
  local assert_fn="$3"
  local attempt
  for attempt in $(seq 1 "$SMOKE_ATTEMPTS"); do
    restore_fixture
    if run_step "$name" "$prompt" "$assert_fn" "$attempt"; then
      RESULTS+=("$name:PASS(attempt=$attempt)")
      return 0
    fi
    echo "   -> attempt $attempt did not satisfy the gate; retrying from pristine"
  done
  RESULTS+=("$name:FAIL(after $SMOKE_ATTEMPTS attempts)")
  FAILED=1
  FAILED_SCENARIOS+=("$name")
  return 1
}

# Steps 02 -> 03 -> 04 form a chain (03 adds tests that 04 runs), so retry them
# together from the pristine fixture instead of in isolation.
try_chain() {
  local attempt ok
  for attempt in $(seq 1 "$SMOKE_ATTEMPTS"); do
    restore_fixture
    ok=1
    run_step 02-fix-factorial "$PROMPT_02" assert_02_fix_factorial "$attempt" || ok=0
    run_step 03-add-tests "$PROMPT_03" assert_03_add_tests "$attempt" || ok=0
    run_step 04-run-and-fix "$PROMPT_04" assert_04_run_and_fix "$attempt" || ok=0
    if [[ $ok -eq 1 ]]; then
      RESULTS+=("02-04:chain PASS(attempt=$attempt)")
      return 0
    fi
    echo "   -> attempt $attempt did not satisfy the 02-04 chain gate; retrying from pristine"
  done
  RESULTS+=("02-04:chain FAIL(after $SMOKE_ATTEMPTS attempts)")
  FAILED=1
  FAILED_SCENARIOS+=("02-03-04")
  return 1
}

# --- 5. Assertions -------------------------------------------------------------
assert_01_explain() {
  grep -qi "greet" "$SMOKE_ROOT/logs/01-explain.log"
}

assert_02_fix_factorial() {
  local ok=1
  ( cd "$FIXTURE" && bun -e "import {factorial} from './src/math.ts'; if (factorial(5)!==120 || factorial(0)!==1 || factorial(1)!==1) process.exit(1);" ) >/dev/null 2>&1 || ok=0
  grep -q "n % 2 === 1" "$FIXTURE/src/math.ts" || ok=0
  if [[ $ok -eq 1 ]]; then
    echo "   ASSERT: factorial(5)=120, factorial(0)=1, isEven untouched OK"
    return 0
  fi
  echo "   ASSERT FAIL: factorial still wrong or isEven was modified" >&2
  return 1
}

assert_03_add_tests() {
  grep -rlq "factorial" "$FIXTURE/tests" 2>/dev/null
}

assert_04_run_and_fix() {
  set +e
  ( cd "$FIXTURE" && bun test ) >"$SMOKE_ROOT/logs/04-fixture-bun-test.log" 2>&1
  local rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    echo "   ASSERT: fixture 'bun test' green OK"
    return 0
  fi
  echo "   ASSERT FAIL: fixture tests not green ($rc)" >&2
  return 1
}

assert_05_parallel_tools() {
  grep -q "hello.ts" "$SMOKE_ROOT/logs/05-parallel-tools.log" \
    && grep -q "math.ts" "$SMOKE_ROOT/logs/05-parallel-tools.log"
}

assert_06_mcp_fs() {
  grep -qi "Read README" "$SMOKE_ROOT/logs/06-mcp-fs.log" \
    && grep -qi "bun" "$SMOKE_ROOT/logs/06-mcp-fs.log"
}

# --- 6. Scenarios --------------------------------------------------------------
PROMPT_01="Explain what src/hello.ts does in 3-5 sentences."
PROMPT_02="src/math.ts contains a bug in factorial(). Find it, fix it in place, then run the test suite to confirm nothing broke. Do NOT modify isEven() — leave it exactly as it is."
PROMPT_03="Use the read tool to read src/math.ts. Then write tests/math.test.ts with bun:test unit tests for factorial (n=0, n=1, n=5), fibonacci (n=0..6) and isEven (one even, one odd input). Do NOT modify anything under src/. Do not ask questions — just do it."
PROMPT_04="Run 'bun test' in this project. If any test fails, fix the SOURCE CODE (never the tests) until the whole suite passes, then run 'bun test' once more to confirm."
PROMPT_05="In a SINGLE assistant step issue three SEPARATE tool calls at once: (1) glob tool with src/**/*.ts, (2) glob tool with tests/**/*.ts, (3) read tool with src/hello.ts. Do NOT wrap or nest tool calls inside the execute tool. Then report each file you actually found, with a one-line summary each."
PROMPT_06="Use the MCP filesystem tool read_file with the project root path to read README.md (the MCP server is named fs, directory fixtures/opencode-project). Then summarize the project in 2-3 sentences. Do not ask questions — just do it."

if [[ -n "$ONLY" ]]; then
  # Isolated run: one step on its own, retried per SMOKE_ATTEMPTS.
  case "$ONLY" in
    1) try_scenario 01-explain "$PROMPT_01" assert_01_explain || true ;;
    2) try_scenario 02-fix-factorial "$PROMPT_02" assert_02_fix_factorial || true ;;
    3) try_scenario 03-add-tests "$PROMPT_03" assert_03_add_tests || true ;;
    4) try_scenario 04-run-and-fix "$PROMPT_04" assert_04_run_and_fix || true ;;
    5) try_scenario 05-parallel-tools "$PROMPT_05" assert_05_parallel_tools || true ;;
    6) try_scenario 06-mcp-fs "$PROMPT_06" assert_06_mcp_fs || true ;;
  esac
else
  try_scenario 01-explain "$PROMPT_01" assert_01_explain || true
  try_chain || true
  try_scenario 05-parallel-tools "$PROMPT_05" assert_05_parallel_tools || true
  try_scenario 06-mcp-fs "$PROMPT_06" assert_06_mcp_fs || true
fi

mkdir -p "$SMOKE_ROOT/after"
cp -r "$FIXTURE" "$SMOKE_ROOT/after/fixture-final"
echo ""
echo "================================================================"
echo " RESULTS"
echo "================================================================"
for r in ${RESULTS[@]+"${RESULTS[@]}"}; do echo "  $r"; done
if [[ ${#FAILED_SCENARIOS[@]} -gt 0 ]]; then
  echo "  failed scenarios: ${FAILED_SCENARIOS[*]}"
fi
echo "================================================================"

if [[ $KEEP -eq 0 && -z "$ONLY" ]]; then
  echo ">> Restoring pristine fixture (from snapshot)"
  rm -rf "$FIXTURE"
  cp -r "$SMOKE_ROOT/fixture-pristine" "$FIXTURE"
fi

echo ">> Logs: $SMOKE_ROOT/logs | final state: $SMOKE_ROOT/after/fixture-final"
if [[ $FAILED -ne 0 ]]; then echo "SMOKE RESULT: FAILED" >&2; exit 1; fi
echo "SMOKE RESULT: PASS"