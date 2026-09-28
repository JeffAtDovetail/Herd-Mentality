#!/usr/bin/env bash
# Run the game on this laptop and publish it through ngrok, so phones on any network can join.
#
#   npm run tunnel:ngrok
#
# Optional, in .env or the shell:
#   NGROK_URL   a reserved/static ngrok domain, e.g. https://herd-dovetail.ngrok.app
#               (without it, ngrok gives a new random URL each run)
# Needs ngrok installed and authenticated once: ngrok config add-authtoken <token>
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  while IFS='=' read -r key value; do
    case "$key" in NGROK_URL|PORT)
      [ -z "${!key:-}" ] && export "$key=$value" ;;
    esac
  done < <(grep -E '^[A-Z_]+=' .env)
fi

export PORT="${PORT:-7420}"
NGROK_API="http://127.0.0.1:4040/api/tunnels" # ngrok's local inspection API
mkdir -p data
LOG="data/ngrok.log"

if ! command -v ngrok >/dev/null 2>&1; then
  echo "ngrok is not installed. Install it with: brew install ngrok"
  exit 1
fi

args=(http "$PORT" --log stdout)
[ -n "${NGROK_URL:-}" ] && args+=(--url "$NGROK_URL")
ngrok "${args[@]}" >"$LOG" 2>&1 &
NGROK_PID=$!
trap 'kill "$NGROK_PID" 2>/dev/null || true' EXIT INT TERM

# Wait for ngrok to report its public https URL, then point the QR code at it.
PUBLIC_URL=""
for _ in $(seq 1 20); do
  sleep 0.5
  PUBLIC_URL="$(curl -fsS -m 2 "$NGROK_API" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).tunnels.find(t=>t.public_url.startsWith("https"));process.stdout.write(t?t.public_url:"")}catch{}})' || true)"
  [ -n "$PUBLIC_URL" ] && break
done
if [ -z "$PUBLIC_URL" ]; then
  echo "ngrok didn't start — check $LOG (is your authtoken set? ngrok config add-authtoken <token>)"
  exit 1
fi

export PUBLIC_URL
echo "ngrok tunnel → $PUBLIC_URL (logs: $LOG)"
node server.js
