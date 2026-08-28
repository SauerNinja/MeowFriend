# MeowFriend API Bridge

Secure bridge between your static GitHub Pages frontend and your local Meowcoin Core node.

---

## Part 1 — Install Node.js (bridge server)

This server has no native/compiled dependencies (everything in `package.json` is pure JavaScript), so the only real per-architecture step is getting Node.js itself installed correctly. Ubuntu's own `apt` package is often outdated — use NodeSource instead, which publishes builds for both architectures.

**First, check which architecture you're on:**

```bash
uname -m
```

- `aarch64` → you're on **ARM64** (e.g. an ARM-based KVM/cloud instance)
- `x86_64` → you're on **AMD64/x86_64** (a typical Intel/AMD server)

The install command is identical either way — NodeSource's setup script detects your architecture automatically:

```bash
sudo apt-get update && sudo apt-get install -y curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Verify it installed correctly:**

```bash
node -v
node -e "console.log(process.arch)"
```

Expect `arm64` on an ARM64 box, `x64` on AMD64.

---

## Part 2 — Install the Meowcoin daemon

Download the official release for your architecture from the Meowcoin GitHub releases page: https://github.com/Meowcoin-Foundation/Meowcoin/releases

Pick the `linux-aarch64` (ARM64) or `linux-x86_64` (AMD64) tarball matching your `uname -m` result above, then:

```bash
# Replace VERSION and the filename with the exact ones from the releases page
cd ~
curl -LO https://github.com/Meowcoin-Foundation/Meowcoin/releases/download/vVERSION/meowcoin-VERSION-FILENAME.tar.gz
tar -xzf meowcoin-VERSION-FILENAME.tar.gz
```

This gives you a folder like `~/meowcoin-VERSION/bin/` containing `meowcoind` and `meowcoin-cli`.

**Create the config directory and file:**

```bash
mkdir -p ~/.meowcoin
nano ~/.meowcoin/meowcoin.conf
```

Paste this in, then generate a real password before saving (see the command right after):

```
server=1
rpcuser=CHANGE_ME
rpcpassword=CHANGE_ME
rpcport=8332
rpcallowip=127.0.0.1
txindex=1
addressindex=1
```

**Generate a real random RPC username and password** (run this, then paste the two outputs into the file above in place of `CHANGE_ME`):

```bash
node -e "console.log(require('crypto').randomBytes(12).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(20).toString('hex'))"
```

**Start the daemon** (replace the path with your actual extracted folder):

```bash
~/meowcoin-VERSION/bin/meowcoind -daemon
```

**Confirm it's running and synced:**

```bash
~/meowcoin-VERSION/bin/meowcoin-cli getblockchaininfo
```

---

## Part 3 — Install and run the bridge server

```bash
mkdir -p ~/meowfriend-api && cd ~/meowfriend-api
# copy package.json, server.js, .env.example into this folder, then:
npm install
cp .env.example .env
nano .env
```

In `.env`, set `RPC_USER` and `RPC_PASS` to the **exact same values** you put in `meowcoin.conf` above, and fill in the other required values (`ALLOWED_ORIGIN`, `COOKIE_SIGNING_SECRET`, `TICKET_HOLDING_ADDRESS`, `SNAPSHOT_SECRET`).

**Generate the remaining random secrets** (run each, paste the output into `.env`):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # COOKIE_SIGNING_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # SNAPSHOT_SECRET
```

**Start the bridge server:**

```bash
node server.js
```

You should see: `MeowFriend bridge listening on port 3000`

---

## Part 4 — Expose it with a tunnel

Install `cloudflared` for your architecture:

```bash
# ARM64:
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
# AMD64:
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb

sudo dpkg -i cloudflared.deb
```

**Run the tunnel, pointed at the bridge server's port (3000, not the daemon's port):**

```bash
cloudflared tunnel --url http://localhost:3000
```

Copy the `https://....trycloudflare.com` URL it prints — that's what goes into `TICKETS_API_BASE`/`API_BASE` in the frontend files.

---

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

`node-cache` and the rate limiter both live in memory, so a server restart clears all cooldowns. That's a minor availability trade-off (not a security hole — worst case someone gets one extra claim right after a restart), but worth knowing. The daemon and bridge server also both need to be manually restarted after a reboot unless you set them up under `systemd` — `meowcoind -daemon` runs detached on its own, but `node server.js` and `cloudflared tunnel` will need `screen`/`tmux`/`systemd` to survive you logging out.
