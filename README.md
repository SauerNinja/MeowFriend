# MeowFriend

A retro arcade faucet site for Meowcoin (MEWC) — a static, browser-based collection of minigames, a virtual pet system, and an optional Meowcoin-node-integrated backend, all wrapped in a neon CRT-arcade look.

**Live site:** https://sauerninja.github.io/MeowFriend/

MeowFriend is an independent fan project and demo faucet. It is not affiliated with or endorsed by the official Meowcoin team, and nothing on the site is financial advice.

## What's in here

- **Ticket faucet** — boop once an hour to mint Meow Tickets, with an escalating streak bonus (1,000 up to 5,000 tickets) for booping again within the streak window.
- **Arcade minigames** — a slot machine, a road-crossing game, and an endless runner, all sharing a single in-game ticket economy and per-game global leaderboards.
- **Gotchya** — a persistent virtual pet with hunger/happiness/energy, weight and IQ that grow over real time, a shop for food and permanent upgrades, and a backpack for items found while playing.
- **Cat Hack** — a turn-based, permadeath roguelike dungeon crawl starring your Gotchya pet, with a mandatory confirmation before entry, a wait-for-confirmation mechanic, and a cemetery for pets who don't make it back.
- **Donations** — donate real MEWC to earn tickets (1,000 tickets per 100 MEWC), verified against a real Meowcoin node rather than trusted client-side.
- **Withdrawals** — sign once to link a Meowcoin address, then withdraw tickets out to it as a real `MEOWFRIEND_TICKET` asset transfer.
- **Accounts & leaderboards** — a required-for-server-actions username, an account page showing your stats, and ticket/donation/per-game leaderboards.
- **Server status indicator** — a small badge shows live connectivity to the backend; browsing and playing games works offline, only ticket-minting and donation-crediting need the server to be reachable.
- **Supply tracking** — a GitHub Action snapshots the real on-chain ticket supply every 5 hours into a chart on the Supply page.
- A shared, lightweight **Node.js/Express bridge server** that talks to a Meowcoin Core node's RPC interface for anything that needs real chain data — the frontend itself is static HTML/CSS/JS and can be hosted anywhere that serves static files (this repo is set up for GitHub Pages).

## Tech

Vanilla HTML/CSS/JS on the frontend (no build step, no framework), Tailwind via CDN for utility styling, and a small Express server for the parts that need to talk to a real Meowcoin node. No ads.

## Fork & run this yourself

Forking the repo gets you the frontend for free (any static host will serve it), but the ticket economy, faucet, and donations all need a live backend talking to a real Meowcoin node. Here's the full path from fork to working instance:

### 1. Fork and enable GitHub Pages

Fork this repo, then in your fork's **Settings → Pages**, set the source to your default branch. Your site will be live at `https://YOUR_USERNAME.github.io/YOUR_REPO_NAME/`.

### 2. Get a Meowcoin node and the bridge server running

Full step-by-step instructions — installing Node.js, the Meowcoin daemon, the bridge server, and a Cloudflare Tunnel, for both ARM64 and AMD64 — are in **[`meowfriend-api/README.md`](meowfriend-api/README.md)**. Follow that end to end first; you'll come out of it with a live `https://something.trycloudflare.com` URL pointing at your running bridge server.

### 3. Point the frontend at your backend

Four files hold a placeholder backend URL that needs to become your real tunnel URL from step 2:

- `shared-tickets.js` — `TICKETS_API_BASE`
- `index.html` — `API_BASE`
- `donate.html` — `API_BASE`
- `withdraw.html` — `API_BASE`

In each, replace:

```js
const API_BASE = "https://YOUR_TUNNEL_URL.trycloudflare.com";
```

with your real tunnel URL, then commit and push. GitHub Pages will redeploy automatically.

### 4. Issue your own ticket asset

The live site's ticket economy runs on a real Meowcoin asset (`MEOWFRIEND_TICKET`) issued once via the daemon's `issue` RPC command — see `meowfriend-api/README.md` for the exact commands. If you fork this project, you'll want to issue your own asset under a name of your choosing, then set `TICKET_ASSET_NAME` and `TICKET_HOLDING_ADDRESS` in your `.env` to match.

### 5. Confirm it's all connected

```bash
curl https://YOUR-TUNNEL-URL.trycloudflare.com/api/health
```

Should return `{"status":"ok"}`. Once that works, load your GitHub Pages URL — the status badge in the bottom-right corner should show green/"ONLINE."

### Supply-tracking Action (optional)

The `.github/workflows/snapshot-supply.yml` workflow snapshots your ticket supply every 5 hours for the chart on the Supply page. It needs two repo secrets set under **Settings → Secrets and variables → Actions**: `SNAPSHOT_URL` (your tunnel URL) and `SNAPSHOT_SECRET` (must match `SNAPSHOT_SECRET` in your `.env`).

## Open source

This project is open for anyone to use, fork, modify, and build on. It's released under the **MIT License** — see `LICENSE` for the full text. Contributions, forks, and reuse are welcome.

## Disclaimer

Any ticket, in-game currency, or game asset described on this site has no monetary value and is not redeemable for MEWC, cash, or anything else, except where explicitly built as a real on-chain feature and clearly labeled as such. Addresses generated or shown by the site are for small, game-related amounts only — this is not a wallet and should not be used to store or hold funds.
