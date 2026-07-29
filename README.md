# MeowFriend

A retro arcade faucet site for Meowcoin (MEWC) — a static, browser-based collection of minigames, a virtual pet system, and an optional Meowcoin-node-integrated backend, all wrapped in a neon CRT-arcade look.

**Live site:** https://sauerninja.github.io/MeowFriend/

MeowFriend is an independent fan project and demo faucet. It is not affiliated with or endorsed by the official Meowcoin team, and nothing on the site is financial advice.

## What's in here

- **Faucet** — a small MEWC drip faucet with a cooldown timer, gated behind a sign-to-register flow so a player proves control of their own address before claiming.
- **Arcade minigames** — a slot machine, a road-crossing game, and an endless runner, all sharing a single in-game "ticket" economy.
- **Gotchya** — a persistent virtual pet with hunger/happiness/energy, weight and IQ that grow over real time, a shop for food and permanent upgrades, and a backpack for items found while playing.
- **Cat Hack** — a turn-based, permadeath roguelike dungeon crawl starring your Gotchya pet, with a cemetery for pets who don't make it back.
- **Donations & registration** — an optional flow for donating MEWC and registering a wallet address via cryptographic message signing (`verifymessage`), verified against a real Meowcoin node rather than trusted client-side.
- A shared, lightweight **Node.js/Express bridge server** that talks to a Meowcoin Core node's RPC interface for anything that needs real chain data — the frontend itself is static HTML/CSS/JS and can be hosted anywhere that serves static files (this repo is set up for GitHub Pages).

## Tech

Vanilla HTML/CSS/JS on the frontend (no build step, no framework), Tailwind via CDN for utility styling, and a small Express server for the parts that need to talk to a real Meowcoin node. No accounts, no tracking, no ads.

## Open source

This project is open for anyone to use, fork, modify, and build on. It's released under the **MIT License** — see `LICENSE` for the full text. Contributions, forks, and reuse are welcome.

## Disclaimer

Any ticket, in-game currency, or game asset described on this site has no monetary value and is not redeemable for MEWC, cash, or anything else, except where explicitly built as a real on-chain feature and clearly labeled as such. Addresses generated or shown by the site are for small, game-related amounts only — this is not a wallet and should not be used to store or hold funds.
