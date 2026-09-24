#!/usr/bin/env bash
# Run the game on this laptop and publish it at https://herd.jeffreyhuang.com through a
# Cloudflare Tunnel, so phones on any network (mobile data, remote people) can join.
# One-time setup: see "Hosting on jeffreyhuang.com" in the README.
#
#   npm run prod
#
# Override with env vars: TUNNEL_NAME (default herd), PUBLIC_URL, PORT.
set -euo pipefail
cd "$(dirname "$0")/.."

TUNNEL_NAME="${TUNNEL_NAME:-herd}"
export PUBLIC_URL="${PUBLIC_URL:-https://herd.jeffreyhuang.com}"
export PORT="${PORT:-7420}"
mkdir -p data
LOG="data/cloudflared.log"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed. Install it with: brew install cloudflared"
  exit 1
fi
if ! cloudflared tunnel info "$TUNNEL_NAME" >/dev/null 2>&1; then
  echo "Tunnel '$TUNNEL_NAME' not found (or not logged in to Cloudflare)."
  echo "Run the one-time setup in the README: cloudflared tunnel login / create / route dns."
  exit 1
fi

# Start the tunnel in the background and stop it when the game stops.
cloudflared tunnel --no-autoupdate run --url "http://localhost:$PORT" "$TUNNEL_NAME" >"$LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill "$TUNNEL_PID" 2>/dev/null || true' EXIT INT TERM
echo "Cloudflare Tunnel '$TUNNEL_NAME' starting → $PUBLIC_URL (logs: $LOG)"

# Once everything is up, check the public URL actually reaches this laptop.
(
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    if curl -fsS -m 5 "$PUBLIC_URL/healthz" >/dev/null 2>&1; then
      echo "  ✓ $PUBLIC_URL is live"
      exit 0
    fi
  done
  echo "  ⚠ $PUBLIC_URL isn't reachable yet — check $LOG"
) &

node server.js
