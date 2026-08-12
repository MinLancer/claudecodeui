#!/usr/bin/env bash
# =============================================================
#  WeCom CLI Gateway one-click launcher (Linux / macOS)
#  Starts: claudecodeui server (3001) + gateway (3002)
#  Usage : chmod +x start.sh && ./start.sh
#  Deps  : node/npm, Redis (address configurable, see below)
# =============================================================
set -euo pipefail

GATEWAY_DIR="${GATEWAY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"   # gateway dir = script dir
CLAUDE_UI_DIR="${CLAUDE_UI_DIR:-$(cd "$GATEWAY_DIR/.." && pwd)}"              # claudecodeui root = parent
CCUI_PORT="${CCUI_PORT:-3001}"
GATEWAY_PORT="${GATEWAY_PORT:-3002}"
LOG_DIR="${LOG_DIR:-$GATEWAY_DIR/logs}"
# Optional: point to a separately installed claude-agent-sdk (sdk.mjs dir) if not in gateway node_modules
export CLAUDE_AGENT_SDK_PATH="${CLAUDE_AGENT_SDK_PATH:-}"

mkdir -p "$LOG_DIR"

echo "=============================================="
echo " WeCom CLI Gateway launcher"
echo " claudecodeui : $CLAUDE_UI_DIR  -> :$CCUI_PORT"
echo " gateway      : $GATEWAY_DIR  -> :$GATEWAY_PORT"
echo " logs        : $LOG_DIR"
echo "=============================================="

# ---- Resolve Redis: REDIS_URL env > config.yaml redis.url > default ----
redis_url="${REDIS_URL:-}"
if [ -z "$redis_url" ] && [ -f "$GATEWAY_DIR/config.yaml" ]; then
  redis_url="$(awk '/^redis:/{f=1;next} f&&/^\s+url:/{gsub(/^[ \t]+url:[ \t]*/,"");gsub(/["'"'"']/,"");print;exit}' "$GATEWAY_DIR/config.yaml")"
fi
redis_url="${redis_url:-redis://localhost:6379}"
# extract host / port from redis://[user:pass@]host:port
redis_host="$(echo "$redis_url" | sed -E 's|^[a-z]+://([^:/@]+).*|\1|')"
redis_port="$(echo "$redis_url" | sed -nE 's|^[a-z]+://[^:/@]+:([0-9]+).*|\1|p')"
redis_port="${redis_port:-6379}"
[ -z "$redis_host" ] && redis_host="127.0.0.1"

# bash built-in port probe (no lsof/nc needed)
port_open() { (echo >/dev/tcp/"$1"/"$2") >/dev/null 2>&1; }

# 1. Check Redis (configurable, not assumed local)
# localhost may resolve to IPv6 (::1) while Redis listens on IPv4; probe 127.0.0.1
probe_host="$redis_host"
[ "$probe_host" = "localhost" ] && probe_host="127.0.0.1"
if port_open "$probe_host" "$redis_port"; then
  echo "[1/3] Redis reachable ($redis_url)"
else
  echo "[1/3] WARNING: Redis not reachable at $redis_url"
  echo "      Gateway needs Redis to store sessions/stream state. Start Redis, set"
  echo "      REDIS_URL, or point redis.url in config.yaml to a reachable server."
fi

# 2. Start claudecodeui server
if port_open 127.0.0.1 "$CCUI_PORT"; then
  echo "[2/3] Port $CCUI_PORT already in use, skip (assume running)"
else
  echo "[2/3] Starting claudecodeui server (:$CCUI_PORT) ..."
  (cd "$CLAUDE_UI_DIR" && nohup npm run server:dev >"$LOG_DIR/ccui.log" 2>&1 &)
  echo "      -> log: $LOG_DIR/ccui.log"
fi

# 3. Start gateway
if port_open 127.0.0.1 "$GATEWAY_PORT"; then
  echo "[3/3] Port $GATEWAY_PORT already in use, skip (assume running)"
else
  echo "[3/3] Starting gateway (:$GATEWAY_PORT) ..."
  (cd "$GATEWAY_DIR" && nohup npx tsx src/index.ts >"$LOG_DIR/gateway.log" 2>&1 &)
  echo "      -> log: $LOG_DIR/gateway.log"
fi

echo ""
echo "Done. View logs:"
echo "  claudecodeui: tail -f $LOG_DIR/ccui.log"
echo "  gateway     : tail -f $LOG_DIR/gateway.log"
echo "Stop: ./stop.sh"
