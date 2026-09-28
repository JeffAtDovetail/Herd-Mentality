#!/usr/bin/env bash
# Run the game on this laptop and publish it on your own domain through a named
# Cloudflare Tunnel, so phones on any network (mobile data, remote people) can join.
#
#   npm run tunnel:cloudflare      (alias: npm run prod)
#
# Needs, in .env or the shell (see README → "Option B"):
#   CLOUDFLARE_TUNNEL_NAME   e.g. herd
#   CLOUDFLARE_PUBLIC_URL    e.g. https://herd.example.com
set -euo pipefail
cd "$(dirname "$0")/.."

# Pick up settings from .env (shell values win).
if [ -f .env ]; then
  while IFS='=' read -r key value; do
    case "$key" in CLOUDFLARE_TUNNEL_NAME|CLOUDFLARE_PUBLIC_URL|PORT)
      [ -z "${!key:-}" ] && export "$key=$value" ;;
    esac
  done < <(grep -E '^[A-Z_]+=' .env)
fi

TUNNEL_NAME="${CLOUDFLARE_TUNNEL_NAME:-}"
export PUBLIC_URL="${CLOUDFLARE_PUBLIC_URL:-}"
export PORT="${PORT:-7420}"
if [ -z "$TUNNEL_NAME" ] || [ -z "$PUBLIC_URL" ]; then
  echo "Set CLOUDFLARE_TUNNEL_NAME and CLOUDFLARE_PUBLIC_URL in .env (see README → Option B)."
  exit 1
fi

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
