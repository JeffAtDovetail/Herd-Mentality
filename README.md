# Herd Mentality

A Herd Mentality-style icebreaker for big meetings. Players scan a QR code, join from their phones, and score points by giving the same answer as the majority.

**Current iteration:** the lobby only. Players scan the QR code, enter a name, and appear live on the host screen.

## Run it locally

```bash
npm install
npm start
```

Then open the **host screen** at <http://localhost:7420> on your laptop and put it on the projector. Players scan the QR code, or type the join URL shown under it.

The server prints both URLs on startup:

```
  Herd Mentality is running
  Host screen:  http://localhost:7420
  Players join: http://192.168.1.42:7420/join
```

`npm run dev` restarts the server whenever a file changes.

## Configuration

| Env var      | Default               | What it does                                                                  |
| ------------ | --------------------- | ----------------------------------------------------------------------------- |
| `PORT`       | `7420`                | Port to listen on. Chosen to avoid ports used by other local repos.           |
| `HOST`       | `0.0.0.0`             | Interface to bind. `0.0.0.0` is needed so phones on your Wi-Fi can connect.   |
| `PUBLIC_URL` | auto-detected LAN URL | Base URL put in the QR code, e.g. a tunnel URL or a manually chosen LAN IP.   |

## If your phone can't connect

- **Same network:** your phone must be on the same Wi-Fi as your laptop, not mobile data.
- **Client isolation:** many office and guest Wi-Fi networks block device-to-device traffic. Try a different network, or use a tunnel:
  ```bash
  cloudflared tunnel --url http://localhost:7420
  # then restart with the printed https URL:
  PUBLIC_URL=https://<random>.trycloudflare.com npm start
  ```
- **Wrong IP detected** (VPN, Docker, multiple adapters): set it yourself, e.g. `PUBLIC_URL=http://192.168.1.42:7420 npm start`. You can find your IP with `ipconfig getifaddr en0`.
- **macOS firewall:** allow incoming connections for `node` if prompted.

## How it works

- `server.js` is a plain Node HTTP server plus a WebSocket endpoint (`/ws`). Lobby state is kept in memory, so restarting the server clears it.
- `public/host.html` is the projector view. It shows the QR code and join URL, plus live player chips; a grey dot means that phone disconnected.
- `public/join.html` is the phone view. Each phone gets a player id kept in `localStorage`, so refreshing or locking the phone rejoins as the same player rather than creating a duplicate.
- Duplicate names get a suffix, e.g. `Sam (2)`.

## Next up

- Rounds: multiple-choice and free-text questions
- Answer grouping and host merges, plus scoring and a leaderboard
- Host PIN, kick/rename players
- Optional AI answer grouping (OpenAI `gpt-6-luna`)
