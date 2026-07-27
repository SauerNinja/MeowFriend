# MeowFriend API Bridge

Secure bridge between your static GitHub Pages frontend and your local Meowcoin Core node.

## Setup on your Ubuntu server

```bash
mkdir -p ~/meowfriend-api && cd ~/meowfriend-api
# copy package.json, server.js, .env.example into this folder
npm install
cp .env.example .env
nano .env   # fill in RPC_USER, RPC_PASS, and ALLOWED_ORIGIN with your real values
node server.js
```

You should see: `MeowFriend bridge listening on port 3000`

Leave your `cloudflared` tunnel running in its own terminal, pointed at `http://127.0.0.1:3000`, same as before.

## What the two rate-limit layers do

- **IP limiter** (`express-rate-limit`): blocks a given IP after 2 requests/24h. Easy for someone to route around with a VPN, so it's a speed bump, not the real defense.
- **Address cache** (`node-cache` + in-flight lock): once an address has been paid, it's rejected for 24h *no matter what IP or browser asks* — including bare `curl` requests that skip your frontend/CORS entirely. This is the layer that actually protects the wallet.

## Before you go live

- Test with a **testnet or a wallet holding only a small amount** of MEWC first.
- Set `ALLOWED_ORIGIN` in `.env` to your real `https://YOUR_USERNAME.github.io` — don't leave the placeholder in.
- Never commit `.env` to git or paste its contents anywhere, including to Claude or Gemini.
- Keep the faucet wallet's balance topped up manually in small amounts rather than holding a large reserve in it.
- Consider adding a simple CAPTCHA (e.g., Cloudflare Turnstile, which is free) in front of `/api/boop` if you see abuse — it stops scripted claims without adding backend complexity.

## Restarting after a reboot

`node-cache` and the rate limiter both live in memory, so a server restart clears all cooldowns. That's a minor availability trade-off (not a security hole — worst case someone gets one extra claim right after a restart), but worth knowing.
