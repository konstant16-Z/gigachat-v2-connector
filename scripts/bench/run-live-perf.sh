#!/usr/bin/env bash
# PHASE 12 §33 — live performance harness.
#
# Runs the same five scenarios (simple chat, large prompt, tool call, 5 parallel
# tools, long stream) through `opencode run --standalone` against the LIVE
# GigaChat API, in isolated XDG dirs, and compares connector modes:
#
#   --mode v1        current connector   (plugin option v2:false)
#   --mode v2        connector V2         (plugin option v2:true)
#   --mode gpt2giga  external gpt2giga proxy (no connector; --gpt2giga-url)
#
# A capture plugin (scripts/bench/perf-plugin) records TTFT / total latency /
# tokens-per-second per outbound request to a JSONL file; results are aggregated
# by scripts/bench/lib/analyze-perf.py into logs/perf-analysis.json.
#
# Secrets: credentials are copied programmatically from the live config and are
# NEVER printed. This script must be run where api.giga.chat is reachable.
#
# Usage:
#   scripts/bench/run-live-perf.sh --mode v2 [--mode v1] [--repeat 3]
#                                  [--scenario simple|all]
#                                  [--gpt2giga-url https://host/v1]
#
# Env overrides:
#   PERF_SOURCE_CONFIG  live opencode.json with connector credentials
#   PERF_CA_PEM         PEM bundle for OpenCode->GigaChat TLS
#   PERF_MODEL          provider/model (default gigachat/GigaChat-2-Max)
#   PERF_ROOT           scratch root (default /tmp/opencode/gigachat-perf)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$REPO_ROOT/fixtures/opencode-project"
PERF_ROOT="${PERF_ROOT:-/tmp/opencode/gigachat-perf}"
SOURCE_CONFIG="${PERF_SOURCE_CONFIG:-/mnt/c/OpnCod_Proj/opencode/local/config/opencode/opencode.json}"
CA_PEM="${PERF_CA_PEM:-/mnt/c/OpnCod_Proj/opencode/local/config/opencode/certs/russian_trusted_root_ca.pem}"
MODEL="${PERF_MODEL:-gigachat/GigaChat-2-Max}"
GPT2GIGA_URL=""
GPT2GIGA_API_KEY="${GPT2GIGA_API_KEY:-}"
REPEAT=3
KEEP=0
SCENARIO="all"
declare -a MODES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODES+=("$2"); shift ;;
    --repeat) REPEAT="$2"; shift ;;
    --scenario) SCENARIO="$2"; shift ;;
    --gpt2giga-url) GPT2GIGA_URL="$2"; shift ;;
    --keep) KEEP=1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ ${#MODES[@]} -gt 0 ]] || MODES=(v2)

# --- 1. Build ---------------------------------------------------------------
echo ">> Building plugin (bun run build)"
(cd "$REPO_ROOT" && bun run build >/dev/null)

# --- 2. Scratch dirs --------------------------------------------------------
rm -rf "$PERF_ROOT"
mkdir -p "$PERF_ROOT/config/opencode" "$PERF_ROOT/data" "$PERF_ROOT/cache" \
         "$PERF_ROOT/state" "$PERF_ROOT/logs" "$PERF_ROOT/plugin" "$PERF_ROOT/npm-cache"
cp "$REPO_ROOT/dist/index.js" "$PERF_ROOT/plugin/index.js"
cat > "$PERF_ROOT/plugin/package.json" <<'EOF'
{
  "name": "gigachat-v2-plugin",
  "version": "2.0.0",
  "description": "GigaChat Connector plugin for OpenCode V2 (perf build)",
  "type": "module",
  "main": "index.js",
  "license": "MIT"
}
EOF
cp -r "$REPO_ROOT/scripts/bench/perf-plugin" "$PERF_ROOT/perf-plugin"

# Snapshot the pristine read-only fixture (scenarios never write).
rm -rf "$PERF_ROOT/fixture-pristine"
cp -r "$FIXTURE" "$PERF_ROOT/fixture-pristine"
# Large-prompt input (~40 KB), generated locally and read via the read tool.
python3 - "$PERF_ROOT/fixture-pristine/large-context.txt" <<'PY'
import sys
text = ("The quick brown fox jumps over the lazy dog. " * 900)
open(sys.argv[1], "w").write(text)
print(f"   large-context.txt: {len(text)} bytes")
PY

# --- 3. Credentials (never echoed) ------------------------------------------
if [[ "${MODES[*]}" == *"v1"* || "${MODES[*]}" == *"v2"* ]]; then
  GIGACHAT_CREDENTIALS_VALUE="$(python3 - "$SOURCE_CONFIG" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
for p in cfg.get("plugins", []):
    if isinstance(p, dict) and isinstance(p.get("options"), dict) and p["options"].get("credentials"):
        print(p["options"]["credentials"])
        break
else:
    raise SystemExit("ERROR: no connector credentials in source config")
PY
)"
  export GIGACHAT_CREDENTIALS_VALUE
fi

# --- 4. Config generation ---------------------------------------------------
write_config() {
  local mode="$1"
  python3 - "$SOURCE_CONFIG" "$PERF_ROOT" "$mode" "$GPT2GIGA_URL" "$GPT2GIGA_API_KEY" <<'PY'
import json, sys
src, root, mode, gpt_url, gpt_key = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
creds, scope = None, "GIGACHAT_API_PERS"
try:
    live = json.load(open(src))
    for p in live.get("plugins", []):
        if isinstance(p, dict) and isinstance(p.get("options"), dict) and p["options"].get("credentials"):
            creds = p["options"]["credentials"]
            scope = p["options"].get("scope", scope)
            break
except Exception:
    pass

perf_plugin = {"package": f"{root}/perf-plugin", "options": {}}
plugins = []
if mode in ("v1", "v2"):
    if not creds:
        raise SystemExit("ERROR: no connector credentials found")
    plugins.append({"package": f"{root}/plugin", "options": {"credentials": creds, "scope": scope, "v2": mode == "v2"}})
    base_url = "https://api.giga.chat/v1"
    provider_env = ["GIGACHAT_CREDENTIALS"]
elif mode == "gpt2giga":
    if not gpt_url:
        raise SystemExit("ERROR: --gpt2giga-url is required for mode gpt2giga")
    base_url = gpt_url
    provider_env = ["GPT2GIGA_API_KEY"]
else:
    raise SystemExit(f"ERROR: unknown mode {mode}")
plugins.append(perf_plugin)

cfg = {
    "providers": {
        "gigachat": {
            "name": "GigaChat (perf)",
            "package": "@opencode/ai/providers/openai-compatible",
            "env": provider_env,
            "settings": {"baseURL": base_url},
            "models": {
                "GigaChat-2-Max": {
                    "name": "GigaChat 2 Max",
                    "limit": {"context": 128000, "output": 8192},
                    "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
                }
            },
        }
    },
    "plugins": plugins,
}
json.dump(cfg, open(f"{root}/config/opencode/opencode.json", "w"), indent=2)
print(f"   config written for mode={mode} baseURL={base_url}")
PY
}

# --- 5. Scenarios -----------------------------------------------------------
scenario_prompt() {
  case "$1" in
    simple) echo "Reply with exactly one word: pong" ;;
    large) echo "Use the read tool to read large-context.txt, then summarize it in one short sentence." ;;
    tool) echo "Use the read tool to read src/hello.ts, then answer which function it exports." ;;
    parallel) echo "In a SINGLE assistant step issue three SEPARATE tool calls at once: (1) glob src/**/*.ts, (2) glob tests/**/*.ts, (3) read src/hello.ts. Then list what you found, one line each." ;;
    long) echo "Write a detailed explanation of how TLS 1.3 works, about 800 words. Output only the explanation." ;;
    *) echo "" ;;
  esac
}
declare -a SCENARIOS
if [[ "$SCENARIO" == "all" ]]; then
  SCENARIOS=(simple large tool parallel long)
else
  SCENARIOS=("$SCENARIO")
fi

run_one() {
  local mode="$1" scenario="$2" repeat="$3"
  local prompt log
  prompt="$(scenario_prompt "$scenario")"
  log="$PERF_ROOT/logs/${mode}-${scenario}-${repeat}.log"
  echo ">> [$mode/$scenario #$repeat]"
  set +e
  ( cd "$PERF_ROOT/fixture-pristine" && env \
      XDG_CONFIG_HOME="$PERF_ROOT/config" \
      XDG_DATA_HOME="$PERF_ROOT/data" \
      XDG_CACHE_HOME="$PERF_ROOT/cache" \
      XDG_STATE_HOME="$PERF_ROOT/state" \
      NODE_EXTRA_CA_CERTS="$CA_PEM" \
      PERF_LOG="$PERF_ROOT/logs/perf-$mode.jsonl" \
      PERF_MODE="$mode" \
      PERF_SCENARIO="$scenario" \
      ${GIGACHAT_CREDENTIALS_VALUE:+GIGACHAT_CREDENTIALS="$GIGACHAT_CREDENTIALS_VALUE"} \
      ${GPT2GIGA_API_KEY:+GPT2GIGA_API_KEY="$GPT2GIGA_API_KEY"} \
      npm_config_cache="$PERF_ROOT/npm-cache" \
      opencode run --standalone --auto --print-logs --model "$MODEL" --agent build "$prompt" ) >"$log" 2>&1
  local rc=$?
  set -e
  echo "   exit=$rc (log: $log)"
}

for mode in "${MODES[@]}"; do
  write_config "$mode"
  : > "$PERF_ROOT/logs/perf-$mode.jsonl"
  for scenario in "${SCENARIOS[@]}"; do
    for ((r = 1; r <= REPEAT; r++)); do
      run_one "$mode" "$scenario" "$r" || true
    done
  done
done

# --- 6. Analysis ------------------------------------------------------------
echo ""
python3 "$REPO_ROOT/scripts/bench/lib/analyze-perf.py" \
  $(for m in "${MODES[@]}"; do echo "$PERF_ROOT/logs/perf-$m.jsonl"; done) \
  || { echo ">> analysis failed (see logs under $PERF_ROOT/logs)"; exit 1; }

echo ""
echo ">> Raw captures: $PERF_ROOT/logs/perf-*.jsonl"
echo ">> Per-run logs: $PERF_ROOT/logs/<mode>-<scenario>-<n>.log"
