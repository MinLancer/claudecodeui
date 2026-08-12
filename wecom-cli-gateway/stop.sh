#!/usr/bin/env bash
# =============================================================
#  WeCom CLI Gateway stopper (Linux / macOS)
#  Stops: gateway (tsx src/index.ts) + claudecodeui server
#  Matches command lines precisely so unrelated node processes
#  are NOT touched.
# =============================================================
set -u

stopped=0

# Stop gateway: tsx loader runs "...src/index.ts"
for pid in $(pgrep -f 'src/index\.ts' 2>/dev/null); do
  echo "Stopping gateway PID $pid"
  kill "$pid" 2>/dev/null && stopped=1
done

# Stop claudecodeui server: tsx ... server/index.ts
for pid in $(pgrep -f 'server/index\.ts' 2>/dev/null); do
  echo "Stopping claudecodeui server PID $pid"
  kill "$pid" 2>/dev/null && stopped=1
done

if [ "$stopped" -eq 0 ]; then
  echo "No gateway / claudecodeui server processes found."
else
  echo "Done. (Forced kill if needed: pkill -9 -f 'tsx src/index.ts')"
fi
