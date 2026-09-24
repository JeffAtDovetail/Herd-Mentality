# Herd Mentality

A Herd Mentality-style icebreaker for big meetings. Players scan a QR code, join from their phones, and score a point whenever they give the same answer as the majority.

## Run it

```bash
npm install
npm start
```

Open the **host screen** at <http://localhost:7420> on the laptop running the game, and put it on the projector. Players scan the QR code, or type the join URL printed in the terminal.

## Running the game

| Step | Host screen | Phones |
| --- | --- | --- |
| **Lobby** | QR code and the players who've joined. Click a name to remove it. | Enter a name |
| **Question** | Question, options, countdown, answered count | Tap an option or type an answer |
| **Reveal** | Answers as bars; the herd answer is highlighted | "You're in the herd! +1" or "You strayed…" |
| **Rankings** | Top 10, with the top 3 highlighted in gold, silver and bronze | Your rank and points |
| **Final results** | Winner, plus the top 10 | Your final rank |

- **Advancing:** use the green button (top right), or press **Space**, **Enter** or **→** to drive it like a slide deck.
- **Closing answers:** answers close when the timer runs out, when every connected player has answered, or when you click **Close answers**.
- **Late joiners:** people can join mid-game. The question screen shows a small QR code, and late joiners play from the next question.
- **Host menu (•••):**
  - **Edit questions:** lobby only.
  - **Restart game (keep players):** back to the lobby with scores reset, and everyone stays joined.
  - **Reset everything:** also clears all players.

### Scoring

- **The herd:** everyone who gave the most popular answer gets 1 point.
- **Ties:** if two or more answers tie for most popular, all of them score.
- **No herd:** if nobody shares an answer, nobody scores.
- **Ranks:** tied scores share a rank (1, 2, 2, 4).

### Free-text matching

Answers are normalised first: case, accents, punctuation and a leading "a/an/the" are ignored. Answers that are then a character or two apart count as the same answer:

| Shortest answer length | Differences allowed | Example |
| --- | --- | --- |
| 1–3 letters | 0 | `cat` ≠ `car` |
| 4–6 letters | 1 | `guitar` = `guiter`, `japan` = `japn` |
| 7+ letters | 2 | `pepperoni` = `peperoni`, `pancakes` = `pancakse` |

This lives in `src/matching.js`. It's the natural place to plug in an LLM later.

## Questions

The default set lives in `src/default-questions.js`. From the host screen, open **••• → Edit questions** to add, remove or reorder questions, change options (any number from 2 to 24), and set the seconds per question. Your edits are saved to `data/questions.json`, and **Reset to defaults** brings back the built-in set. Every game uses the current question list.

For a ~5 minute icebreaker, aim for **6–8 questions at ~20 seconds each**. The editor shows a rough play-time estimate.

## Storage

There's no database. Everything is saved as JSON in `data/` (git-ignored) after every change:

| File | Contents |
| --- | --- |
| `data/game.json` | The current game: players, answers, results and phase. If the server crashes or you restart it, it resumes exactly where it was, including a running countdown. |
| `data/questions.json` | Your edited question list |
| `data/games/*.json` | An archive of each finished or restarted game, with its final leaderboard |
| `data/host-key.json` | The key for hosting from another device |

Delete `data/` for a completely clean slate.

## Configuration

| Env var | Default | What it does |
| --- | --- | --- |
| `PORT` | `7420` | Port to listen on. Chosen to avoid ports used by other local repos. |
| `HOST` | `0.0.0.0` | Interface to bind. It needs to be `0.0.0.0` so phones on the Wi-Fi can connect. |
| `PUBLIC_URL` | auto-detected LAN URL | Base URL put in the QR code, e.g. a tunnel URL or a manually chosen LAN IP |
| `HOST_KEY` | random, saved in `data/` | Key for the host screen when it isn't opened on the laptop itself |
| `DATA_DIR` | `./data` | Where game state is saved |

### Host access

The host screen and question editor only work from the laptop running the server (`localhost`). If a player opens `/` on their phone, they just get a message. To host from another device, use the `?key=…` link printed on startup.

## If phones can't connect

- **Same network:** phones must be on the same Wi-Fi as the laptop. Restart the server if the laptop changed networks, because the QR code uses the IP detected at startup.
- **Wrong IP detected** (VPN, Docker, multiple adapters): `PUBLIC_URL=http://$(ipconfig getifaddr en0):7420 npm start`
- **macOS firewall:** allow incoming connections for `node`.
- **Client isolation** on office or guest Wi-Fi: use a tunnel.
  ```bash
  cloudflared tunnel --url http://localhost:7420
  PUBLIC_URL=https://<random>.trycloudflare.com npm start
  ```

## Development

```bash
npm run dev   # restarts on file changes
npm test      # matching + scoring unit tests
```

- `server.js`: HTTP routes, the WebSocket protocol, host access
- `src/game.js`: game state machine, scoring, host and player views
- `src/matching.js`: free-text normalisation and fuzzy grouping
- `src/store.js`: JSON file persistence
- `public/`: host screen, phone page and question editor (plain HTML/JS/CSS, no build step)
