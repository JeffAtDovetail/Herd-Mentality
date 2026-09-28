# Herd Mentality

A Herd Mentality-style icebreaker for big meetings. Players scan a QR code, join from their phones, and score a point whenever they give the same answer as the majority. After each question, the rankings show who's in the running to be crowned **the Almighty Cow**.

It's a small Node.js app with no build step and no database. It runs on the host's laptop, and there are two ways to let people join:

| | [Option A: local network only](#option-a-local-network-only) | [Option B: online via a tunnel](#option-b-online-via-a-tunnel) |
| --- | --- | --- |
| Who can join | Only people on the **same Wi-Fi** as the host laptop | Anyone with the link, on any network (mobile data, remote people) |
| Needs | Nothing extra | A tunnel tool (Cloudflare Tunnel or ngrok) and an account for it |
| Command | `npm start` | `npm run tunnel:cloudflare` or `npm run tunnel:ngrok` |

In both options the server runs on your laptop. Nothing is deployed to a cloud host, and game state is saved on your machine.

> **Assumption for both options:** AI features use **Amazon Bedrock with the same AWS setup as Dovetail's `platform` repo**: the `dev` AWS SSO profile, region `us-east-1`, and Claude cross-region inference profiles, with no API keys. If you don't have that access, the game still works; it just falls back to plain text matching (see [AI features and Bedrock](#ai-features-and-bedrock)).

---

## Quick start

```bash
git clone <this repo>
cd herd-mentality
npm install
cp .env.example .env            # no secrets in here; see comments inside
aws sso login --profile dev     # optional: enables AI features (same setup as platform)
npm start
```

Open the host screen at <http://localhost:7420> on your laptop and put it on the projector. Players scan the QR code.

## Requirements

- **Node.js 20.12+** (`node --version`)
- **macOS or Linux shell** for the tunnel scripts. The game itself runs anywhere Node does.
- **Optional, for AI features:**
  - AWS CLI v2 with the `dev` SSO profile configured, as for the `platform` repo
  - Access to Claude Haiku 4.5 and Sonnet 4.5 inference profiles in that account
  - Check with `npm run bedrock:smoke`, which should print a hello from Claude
- **Option B only:** `cloudflared` or `ngrok`, plus an account for it. Read [Which tunnel to use](#which-tunnel-to-use) first.

---

## Option A: local network only

Everyone must be on the **same Wi-Fi network** as the laptop running the game. Phones on mobile data, and remote people on a video call, can't join this way.

```bash
aws sso login --profile dev   # optional, if your session has expired
npm start
```

The terminal prints the join URL, e.g. `http://192.168.1.42:7420/join`, and the QR code on the host screen points at it.

**Before the meeting, check the network.** Many office and guest Wi-Fi networks block devices from talking to each other (client isolation). Test with your own phone on the same Wi-Fi:

- **The page loads:** you're good.
- **The page never loads:** the network is blocking it. Use Option B, or ask IT.

**Other issues:**

- **Laptop changed networks:** restart the server. The QR code uses the IP detected at startup.
- **Wrong IP detected** (VPN, Docker, multiple adapters): `PUBLIC_URL=http://$(ipconfig getifaddr en0):7420 npm start`
- **macOS firewall:** allow incoming connections for `node` when prompted.

---

## Option B: online via a tunnel

A tunnel gives your laptop's game a public HTTPS address, so people can join from any network. The game still runs on your laptop, and only while the command is running. Stop it with Ctrl+C and the link stops working.

### Which tunnel to use

The original setup used **Cloudflare Tunnel on a personal Cloudflare account and a personal domain** (`herd.jeffreyhuang.com`). That's fine for a one-off, but it isn't a company-managed service.

**If you're running this for Dovetail, use tools and accounts the company already approves.** If Dovetail already uses ngrok, use the company ngrok account. If it uses Cloudflare, use the company Cloudflare account and domain. Otherwise, check with the security or platform team before exposing anything from your laptop. Don't reuse someone else's personal account or domain.

Both tunnels are supported. Pick one:

### B1: ngrok

```bash
# One-time
brew install ngrok
ngrok config add-authtoken <your-token>   # from the ngrok dashboard (company account if there is one)

# Each time
aws sso login --profile dev               # optional
npm run tunnel:ngrok
```

`scripts/tunnel-ngrok.sh` starts ngrok, reads its public URL from ngrok's local API (port 4040), and starts the game with that URL in the QR code. It logs to `data/ngrok.log`.

**Notes:**

- **Link changes each run:** without a reserved domain, ngrok gives a new random URL every time. For a stable link, reserve a domain in the ngrok dashboard and set `NGROK_URL=https://your-name.ngrok.app` in `.env`.
- **Free plan warning page:** the free plan shows a "You are about to visit…" page the first time each phone opens the link. Players tap **Visit Site** once. Paid plans don't show it.

### B2: Cloudflare Tunnel with your own domain

You need a domain whose DNS is managed in the Cloudflare account you log in with.

```bash
# One-time
brew install cloudflared
cloudflared tunnel login                                 # browser: choose your domain → Authorize
cloudflared tunnel create herd                           # saves credentials in ~/.cloudflared/
cloudflared tunnel route dns herd herd.<your-domain>     # creates the DNS record
```

Add to `.env`:

```bash
CLOUDFLARE_TUNNEL_NAME=herd
CLOUDFLARE_PUBLIC_URL=https://herd.<your-domain>
```

Each time:

```bash
aws sso login --profile dev    # optional
npm run tunnel:cloudflare      # (npm run prod is an alias)
```

`scripts/tunnel-cloudflare.sh`:

- starts the tunnel, logging to `data/cloudflared.log`
- starts the game with your URL in the QR code
- prints `✓ https://herd.<your-domain> is live` once `/healthz` answers through the tunnel

Tunnel credentials stay in `~/.cloudflared/`, never in the repo.

**Troubleshooting:**

- **"Tunnel not found":** redo `cloudflared tunnel login` and `create`. `cloudflared tunnel list` shows your tunnels.
- **Cloudflare error 1033 or 530:** the tunnel isn't connected. Check `data/cloudflared.log`.
- **No DNS record:** in the Cloudflare dashboard, check that `herd` is a proxied CNAME to `<tunnel-id>.cfargotunnel.com`.

### Security with a tunnel

- **Players:** anyone with the link can join as a player.
- **Host controls:** the host screen, question editor and LLM test page only work on `localhost`, or with the `?key=…` host link printed at startup. Anything arriving through a tunnel counts as remote, so it needs the key.
- **Test before the meeting:** switch your phone to mobile data, scan the QR code and join.

---

## Running the game

| Step | Host screen | Phones |
| --- | --- | --- |
| **Lobby** | QR code, the players who've joined (click a name to remove it), timers and AI status | Enter a name |
| **Question** | Question, options, countdown and answered count. After a free-text question it briefly shows "Counting the herd…" while the AI groups answers. | Tap an option or type an answer |
| **Reveal** | Answers as bars; the herd answer is highlighted. Free-text questions also list every answer, with merged spellings. | "You're in the herd! +1" or "You strayed…" |
| **Rankings** | "Who will be crowned the Almighty Cow?": frontrunner(s) with a crowned cow, then the podium and the top 10 | Your rank and points |
| **Final results** | The Almighty Cow's coronation (confetti included), then the rest of the herd | "You are the Almighty Cow!" or your final rank |

- **Advancing:** use the green button (top right), or press **Space**, **Enter** or **→**.
- **Timers:** multiple choice defaults to 15 seconds and free text to 20. Change them in the lobby before starting.
- **Closing answers:** answers close when the timer runs out, when every connected player has answered, or when you click **Close answers**.
- **Bots:** with fewer than 3 players at the start, bots such as "Bessie (bot)" fill in. They're removed on restart.
- **Late joiners** can join mid-game and play from the next question.
- **Host menu (•••):**
  - **Edit questions:** lobby only.
  - **Restart game (keep players):** back to the lobby with scores reset.
  - **Reset everything:** also clears all players.
  - **LLM test:** try prompts against Bedrock.
- **Before a real session:** open ••• and click **Reset everything** to clear test players, because the game resumes from its saved state.

### Scoring

- **The herd:** everyone who gave the most popular answer gets 1 point.
- **Ties:** if two or more answers tie for most popular, all of them score.
- **No herd:** if two or more people answered and nobody shares an answer, nobody scores.
- **Only one answer:** a lone answerer is their own herd and scores.
- **Ranks:** tied scores share a rank (1, 2, 2, 4). The top-ranked player at the end is **the Almighty Cow**.

### Questions

The default 13 questions live in `src/default-questions.js`: 9 multiple choice, then 4 free text. Some are Dovetail-specific, such as values and meeting rooms, so change them for your audience.

- **Editing:** use ••• → **Edit questions** to add, remove or reorder questions, edit options (2–24) and set timers. Edits save to `data/questions.json`; **Reset to defaults** restores the built-in set.
- **Length:** for about 5 minutes, use 6–8 questions. The editor shows a play-time estimate.

---

## AI features and Bedrock

**Assumption:** the AI features use Amazon Bedrock with the **same infrastructure as Dovetail's `platform` repo**:

- **Credentials:** the AWS SDK default credential chain, which locally resolves to the `dev` SSO profile for your developer AWS account. There are **no API keys or secrets** anywhere in this repo.
- **Region:** `AWS_REGION=us-east-1`
- **Models:** cross-region inference profiles that are already enabled there. Invocation logging is configured on the account side.

**What the AI does:**

| Feature | Model (default) | Without Bedrock |
| --- | --- | --- |
| Groups free-text answers that mean the same thing ("Obama" = "Barack Obama") | Claude Haiku 4.5 | Text matching only (typos and plurals) |
| Invents realistic free-text answers for bots | Claude Haiku 4.5 | Canned answers |
| LLM test page (`/llm`) and `npm run bedrock:smoke` | Claude Sonnet 4.5 | Shows an error |

**The game never depends on Bedrock.** Any failure falls back to text matching, including a missing or expired login, network issues, Bedrock errors, a reply slower than 8 seconds or a garbled reply. The reveal screen says which method grouped the answers. At startup the terminal prints `✓ AI grouping ready` or a warning, and the host lobby shows the same status.

**Setup:**

1. Run `aws sso login --profile dev`. Sessions last a few hours, so log in shortly before you host.
2. Make sure `.env` has `AWS_PROFILE=dev` and `AWS_REGION=us-east-1` (copied from `.env.example`).
3. Run `npm run bedrock:smoke` to check. Expired sessions report "AWS SSO session expired or missing — run `aws sso login --profile dev`".

**Models** (inference profile IDs):

| Model | ID |
| --- | --- |
| Claude Sonnet 4.5 (`BEDROCK_MODEL_ID` default) | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| Claude Haiku 4.5 (`LLM_GROUPING_MODEL_ID` default) | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| Claude Sonnet 4 | `us.anthropic.claude-sonnet-4-20250514-v1:0` |

Bedrock is only ever called from the server. Browsers talk to this server, never to AWS.

---

## Configuration

Set these in `.env` or in the shell. `.env.example` lists them all.

| Env var | Default | What it does |
| --- | --- | --- |
| `PORT` | `7420` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind. It needs to be `0.0.0.0` for phones on the Wi-Fi to connect. |
| `PUBLIC_URL` | auto-detected LAN URL | Base URL in the QR code. The tunnel scripts set it for you. |
| `HOST_KEY` | random, saved in `data/` | Key for host controls from another device |
| `DATA_DIR` | `./data` | Where game state is saved |
| `AWS_PROFILE` / `AWS_REGION` | none / `us-east-1` | AWS SSO profile and Bedrock region |
| `LLM_GROUPING` | on | `off` means free text always uses text matching |
| `LLM_GROUPING_MODEL_ID` | Haiku 4.5 | Model for answer grouping and bot answers |
| `LLM_TIMEOUT_MS` | `8000` | Maximum wait for AI grouping before falling back |
| `BOTS_MIN_PLAYERS` | `3` | Bots fill the game up to this many players (`0` turns bots off) |
| `LLM_BOTS` | on | `off` gives bots canned answers only |
| `BEDROCK_MODEL_ID` | Sonnet 4.5 | Model for the LLM test page and smoke test |
| `CLOUDFLARE_TUNNEL_NAME` / `CLOUDFLARE_PUBLIC_URL` | none | Used by `npm run tunnel:cloudflare` |
| `NGROK_URL` | none | Reserved ngrok domain, used by `npm run tunnel:ngrok` |

## Storage

There's no database. State is saved as JSON in `data/` (git-ignored) after every change, so a crash or restart resumes exactly where it was.

| File | Contents |
| --- | --- |
| `data/game.json` | Current game: players, answers, results, phase |
| `data/questions.json` | Your edited questions and timers |
| `data/games/*.json` | Archive of each finished or restarted game, with its leaderboard |
| `data/host-key.json` | Host key for remote host access |

Delete `data/` for a clean slate.

---

## Building on top of this

```bash
npm run dev   # restarts on file changes
npm test      # unit tests: matching, scoring, bots, Bedrock errors, AI grouping
```

| Path | What's there |
| --- | --- |
| `server.js` | HTTP routes, WebSocket protocol, host access, LLM test route |
| `src/game.js` | Game state machine, scoring, bots, host and player views |
| `src/default-questions.js` | Default questions and timers |
| `src/matching.js` | Free-text normalisation and typo-tolerant grouping |
| `src/llm/bedrock.js` | Bedrock client and `converse()` helper (Converse API), error mapping |
| `src/llm/grouping.js` | AI merging of answer groups, with text-matching fallback |
| `src/bots.js` | Bot names and answers (LLM with canned fallback) |
| `src/store.js` | JSON file persistence |
| `public/` | Host screen, phone page, question editor, LLM test page (plain HTML/CSS/JS) |
| `scripts/` | Bedrock smoke test and the tunnel scripts |

Conventions:

- **Plain ESM JavaScript**, with no framework or bundler.
- **Keep Bedrock calls server-side**, and keep the fallback behaviour so the game never depends on the LLM.
- **Add a test** in `test/` for any scoring or matching change.
