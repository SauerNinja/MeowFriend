require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const {
  RPC_USER,
  RPC_PASS,
  RPC_HOST = '127.0.0.1',
  RPC_PORT = 8332,
  PAYOUT_AMOUNT = 10,
  ALLOWED_ORIGIN,
  PORT = 3000,
  DONATION_ADDRESS = 'mewc1qklnr4rdvh9aq59p2r0dtyqr2q5rff2xjlkm7zw',
  DONATION_MIN_CONFIRMATIONS = 6,
  DONATION_TICKETS_PER_100_MEWC = 1000,
  COOKIE_SIGNING_SECRET,
  SNAPSHOT_SECRET,
  TICKET_ASSET_NAME = 'MEOWFRIEND_TICKET',
  TICKET_HOLDING_ADDRESS,
  TICKET_MIN_CONFIRMATIONS = 1,
  BOOP_TICKET_COOLDOWN_HOURS = 5,
  BOOP_STREAK_WINDOW_HOURS = 12,
} = process.env;

// Fail loudly on startup if secrets are missing, rather than silently
// running an unauthenticated/misconfigured bridge.
['RPC_USER', 'RPC_PASS', 'ALLOWED_ORIGIN', 'COOKIE_SIGNING_SECRET', 'TICKET_HOLDING_ADDRESS', 'SNAPSHOT_SECRET'].forEach((key) => {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}. Check your .env file.`);
    process.exit(1);
  }
});

const app = express();

// Trust the Cloudflare Tunnel's proxy headers so req.ip reflects the real
// client IP rather than the tunnel's local address. Required for the
// IP-based rate limiter below to actually work.
app.set('trust proxy', 1);

app.use(express.json({ limit: '10kb' }));
app.use(cookieParser(COOKIE_SIGNING_SECRET));

// --- CORS: only your GitHub Pages origin may call this from a browser ---
// credentials:true + matching frontend fetch({credentials:'include'}) lets
// the device-id cookie set below actually round-trip cross-origin.
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ['POST', 'GET'],
    credentials: true,
  })
);

// --- Layer 1: IP-based rate limit ---
// 2 requests per IP per 24h (1 real attempt + 1 retry on a transient error).
// This is a deterrent, not a guarantee — see the address-level cache below,
// which is the layer that actually protects the wallet balance.
const ipLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 2,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP. Try again tomorrow.' },
});

// --- Layer 2: address-based cooldown ---
// Tracks addresses that have already been paid in the last 24h, independent
// of which IP or browser asks. This is what actually stops one address
// being drained repeatedly by clearing localStorage or switching browsers.
const paidAddresses = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 600 });

// --- Layer 3: device cookie ---
// A random ID set as an httpOnly cookie on first visit. Ties claims to
// "this browser profile on this machine" in addition to IP and address.
// Like IP, it's not unbeatable (clearing cookies / private browsing resets
// it) but it raises the bar beyond a client-side localStorage timer, which
// any user can just delete.
const paidDevices = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 600 });
const DEVICE_COOKIE = 'mf_device';

// The device cookie is signed (HMAC via cookie-parser's built-in support)
// so the server can detect tampering and reject a forged value — this
// does NOT make the cookie itself a safe place to store a ticket balance;
// it only makes the *identity pointer* trustworthy. The balance the
// identity points to always lives server-side in ticketLedger below,
// never in the cookie.
function getOrSetDeviceId(req, res) {
  let id = req.signedCookies && req.signedCookies[DEVICE_COOKIE];
  if (!id) {
    id = crypto.randomUUID();
    res.cookie(DEVICE_COOKIE, id, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      signed: true,
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }
  return id;
}

// In-memory single-flight lock so two near-simultaneous requests for the
// same address can't both pass the cache check before either has written
// to it (a classic race condition in naive rate limiters).
const inFlight = new Set();

// Cache the wallet balance briefly rather than hitting the daemon on every
// pageview — also softens the impact of exposing this endpoint at all.
const balanceCache = new NodeCache({ stdTTL: 30 });

function isValidMeowcoinAddress(addr) {
  return (
    typeof addr === 'string' &&
    addr.length >= 26 &&
    addr.length <= 40 &&
    /^M[a-zA-Z0-9]+$/.test(addr)
  );
}

// Shared RPC helper — every economy/registration route below goes through
// this so auth, timeout, and error-shape handling stay in one place.
async function rpcCall(method, params = []) {
  const response = await axios.post(
    `http://${RPC_HOST}:${RPC_PORT}`,
    { jsonrpc: '1.0', id: `meowfriend-${method}`, method, params },
    { auth: { username: RPC_USER, password: RPC_PASS }, timeout: 20000 }
  );
  if (response.data && response.data.error) {
    throw new Error(response.data.error.message || `RPC ${method} returned an error`);
  }
  return response.data.result;
}

app.post('/api/boop', ipLimiter, async (req, res) => {
  const address = req.body && req.body.address;
  const deviceId = getOrSetDeviceId(req, res);

  if (!isValidMeowcoinAddress(address)) {
    return res.status(400).json({ error: 'Invalid Meowcoin address format.' });
  }

  if (paidAddresses.get(address)) {
    return res.status(429).json({ error: 'This address already claimed within the last 24 hours.' });
  }

  if (paidDevices.get(deviceId)) {
    return res.status(429).json({ error: 'This device already claimed within the last 24 hours.' });
  }

  if (inFlight.has(address)) {
    return res.status(429).json({ error: 'A claim for this address is already in progress.' });
  }

  inFlight.add(address);

  try {
    const rpcResponse = await axios.post(
      `http://${RPC_HOST}:${RPC_PORT}`,
      {
        jsonrpc: '1.0',
        id: 'meowfriend',
        method: 'sendtoaddress',
        params: [address, Number(PAYOUT_AMOUNT)],
      },
      {
        auth: { username: RPC_USER, password: RPC_PASS },
        timeout: 15000,
      }
    );

    if (rpcResponse.data && rpcResponse.data.error) {
      throw new Error(rpcResponse.data.error.message || 'RPC returned an error');
    }

    // Mark address AND device as paid only after the RPC call actually succeeds.
    paidAddresses.set(address, true);
    paidDevices.set(deviceId, true);

    return res.json({ success: true, txid: rpcResponse.data.result, amount: Number(PAYOUT_AMOUNT) });
  } catch (err) {
    console.error('RPC error:', err.message);
    return res.status(502).json({ error: 'Faucet node error. Try again later.' });
  } finally {
    inFlight.delete(address);
  }
});

// --- Wallet balance ---
// Public read-only endpoint. Cached 30s so it doesn't hammer the daemon,
// and rounded to 2 decimals so we're not exposing exact-satoshi precision.
// NOTE: exposing balance at all makes the wallet a more visible target —
// keep the hot wallet topped up in small amounts, not holding a big reserve.
app.get('/api/balance', async (req, res) => {
  const cached = balanceCache.get('balance');
  if (cached !== undefined) {
    return res.json({ balance: cached });
  }
  try {
    const rpcResponse = await axios.post(
      `http://${RPC_HOST}:${RPC_PORT}`,
      { jsonrpc: '1.0', id: 'meowfriend-balance', method: 'getbalance', params: [] },
      { auth: { username: RPC_USER, password: RPC_PASS }, timeout: 10000 }
    );
    if (rpcResponse.data && rpcResponse.data.error) {
      throw new Error(rpcResponse.data.error.message || 'RPC returned an error');
    }
    const balance = Math.round(Number(rpcResponse.data.result) * 100) / 100;
    balanceCache.set('balance', balance);
    return res.json({ balance });
  } catch (err) {
    console.error('Balance RPC error:', err.message);
    return res.status(502).json({ error: 'Could not fetch wallet balance.' });
  }
});

// --- Ticket economy ---
// Tickets are a proof-of-concept, valueless-in-play in-game currency.
// The server-side ledger below is the ONLY source of truth for a
// player's balance — the signed device cookie is just a pointer to a row
// in this ledger, never the balance itself, so clearing/editing cookies
// or localStorage cannot fabricate tickets.
//
// No TTL on these — a device's ticket history should persist, not expire
// silently in the background.
const ticketLedger = new NodeCache({ stdTTL: 0, checkperiod: 0 });
const boopStreaks = new NodeCache({ stdTTL: 0, checkperiod: 0 }); // device -> { count, lastBoopAt }

function getTicketBalance(deviceId) {
  return ticketLedger.get(deviceId) || 0;
}

function addTicketsToLedger(deviceId, amount) {
  const next = Math.max(0, getTicketBalance(deviceId) + amount);
  ticketLedger.set(deviceId, next);
  return next;
}

const BOOP_COOLDOWN_MS = Number(BOOP_TICKET_COOLDOWN_HOURS) * 60 * 60 * 1000;
const STREAK_WINDOW_MS = Number(BOOP_STREAK_WINDOW_HOURS) * 60 * 60 * 1000;
const STREAK_TICKETS = [1000, 2000, 3000, 4000, 5000]; // streak 1..5, capped at index 4 beyond that

function ticketsForStreak(streakCount) {
  const idx = Math.min(streakCount, STREAK_TICKETS.length) - 1;
  return STREAK_TICKETS[Math.max(0, idx)];
}

app.get('/api/tickets/balance', (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  return res.json({ tickets: getTicketBalance(deviceId) });
});

// Lets game pages (Slots spend, Crossing life purchases, Shop, Gotchya
// care actions, etc.) apply an in-game SPEND to the real ledger, since
// those are numerous and scattered across many files rather than each
// having their own dedicated endpoint. Deliberately restricted to
// negative amounts only — a client can lower its own balance this way,
// but can never raise it. Any positive ticket award (boop, donation,
// item-drop milestones) must go through its own server-validated
// endpoint, never through this generic path, otherwise a client could
// simply call this with a large positive number and mint tickets for
// free.
app.post('/api/tickets/sync-delta', ipLimiter, (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const amount = Number(req.body && req.body.amount);

  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'Invalid amount.' });
  }
  if (amount > 0) {
    // Silently no-op rather than error loudly — a stray positive delta
    // from a game (e.g. a client-side-only visual bonus that was never
    // meant to touch the real ledger) shouldn't break that game's UI,
    // it just never reaches the real balance.
    return res.json({ tickets: getTicketBalance(deviceId), ignored: true });
  }

  const newBalance = addTicketsToLedger(deviceId, amount);
  return res.json({ tickets: newBalance });
});

app.post('/api/tickets/boop', ipLimiter, (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const now = Date.now();
  const streak = boopStreaks.get(deviceId) || { count: 0, lastBoopAt: 0 };

  const sinceLastBoop = now - streak.lastBoopAt;
  if (streak.lastBoopAt && sinceLastBoop < BOOP_COOLDOWN_MS) {
    const remainingMs = BOOP_COOLDOWN_MS - sinceLastBoop;
    return res.status(429).json({
      error: `Still recharging. Try again in ${Math.ceil(remainingMs / (60 * 1000))} minutes.`,
      cooldownRemainingMs: remainingMs,
    });
  }

  // Streak continues only if this boop lands within the window after the
  // cooldown cleared; otherwise it resets to 1. A boop landing before the
  // cooldown even cleared is already rejected above, so "on time" here
  // specifically means: cooldown just cleared, and it's within the extra
  // grace window on top of that before the streak lapses.
  const withinStreakWindow = streak.lastBoopAt && sinceLastBoop <= BOOP_COOLDOWN_MS + STREAK_WINDOW_MS;
  const newCount = withinStreakWindow ? streak.count + 1 : 1;
  const ticketsAwarded = ticketsForStreak(newCount);

  boopStreaks.set(deviceId, { count: newCount, lastBoopAt: now });
  const newBalance = addTicketsToLedger(deviceId, ticketsAwarded);

  return res.json({
    success: true,
    ticketsAwarded,
    streak: newCount,
    balance: newBalance,
    nextBoopAvailableAt: now + BOOP_COOLDOWN_MS,
    streakExpiresAt: now + BOOP_COOLDOWN_MS + STREAK_WINDOW_MS,
  });
});

app.get('/api/tickets/streak-status', (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const streak = boopStreaks.get(deviceId) || { count: 0, lastBoopAt: 0 };
  const now = Date.now();
  const cooldownRemainingMs = streak.lastBoopAt ? Math.max(0, BOOP_COOLDOWN_MS - (now - streak.lastBoopAt)) : 0;
  const streakExpiresAt = streak.lastBoopAt ? streak.lastBoopAt + BOOP_COOLDOWN_MS + STREAK_WINDOW_MS : null;
  const streakExpired = streakExpiresAt !== null && now > streakExpiresAt;
  return res.json({
    tickets: getTicketBalance(deviceId),
    streak: streakExpired ? 0 : streak.count,
    cooldownRemainingMs,
    streakExpiresAt,
    nextTicketsIfBoopedNow: ticketsForStreak(streakExpired ? 1 : streak.count + 1),
  });
});

// One withdrawal may be pending confirmation per device at a time.
const pendingWithdrawals = new NodeCache({ stdTTL: 15 * 60, checkperiod: 60 });

app.post('/api/tickets/withdraw', ipLimiter, async (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const { amount } = req.body || {};

  // Withdrawals only ever go to the address this device verified
  // ownership of once, via signature — never to an address supplied
  // fresh in the request body. This closes off a whole class of mistake
  // (typo'd address) and, more importantly, means a compromised session
  // can't redirect a withdrawal to an attacker's address without also
  // having separately broken the signature verification.
  const toAddress = linkedWithdrawAddresses.get(deviceId);
  if (!toAddress) {
    return res.status(400).json({ error: 'No linked withdrawal address for this account. Link one first.' });
  }

  const requestedAmount = Number(amount);
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount.' });
  }
  if (pendingWithdrawals.get(deviceId)) {
    return res.status(409).json({ error: 'A previous withdrawal is still waiting on confirmation.' });
  }

  const balance = getTicketBalance(deviceId);
  if (requestedAmount > balance) {
    return res.status(400).json({ error: `Insufficient balance. You have ${balance} tickets.` });
  }

  // Debit the ledger immediately, before broadcasting — this is the
  // server's own real balance, not a value trusted from the client, so
  // there's no risk of a client racing multiple withdrawal requests to
  // drain more than they have (the pending-lock above also blocks that).
  addTicketsToLedger(deviceId, -requestedAmount);

  try {
    const txid = await rpcCall('transfer', [
      TICKET_ASSET_NAME,
      requestedAmount,
      toAddress,
    ]);
    pendingWithdrawals.set(deviceId, { txid, amount: requestedAmount, startedAt: Date.now() });
    return res.json({ success: true, txid, amount: requestedAmount, toAddress, required: Number(TICKET_MIN_CONFIRMATIONS) });
  } catch (err) {
    // Refund the ledger — the debit above was provisional on the transfer
    // actually broadcasting; if the RPC call itself failed, nothing left
    // this server, so the player's balance should not have dropped.
    addTicketsToLedger(deviceId, requestedAmount);
    console.error('Withdraw RPC error:', err.message);
    return res.status(502).json({ error: 'Could not process the withdrawal. Try again later.' });
  }
});

app.post('/api/tickets/withdraw-complete', ipLimiter, async (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const pending = pendingWithdrawals.get(deviceId);
  if (!pending) {
    return res.status(400).json({ error: 'No pending withdrawal for this device.' });
  }

  try {
    const tx = await rpcCall('gettransaction', [pending.txid]);
    const confirmations = Number(tx.confirmations || 0);
    if (confirmations < Number(TICKET_MIN_CONFIRMATIONS)) {
      return res.status(202).json({ pending: true, confirmations, required: Number(TICKET_MIN_CONFIRMATIONS) });
    }
    pendingWithdrawals.del(deviceId);
    return res.json({ success: true, confirmations });
  } catch (err) {
    return res.status(502).json({ error: 'Could not check withdrawal status right now.' });
  }
});

// --- Per-player donation address (auto-tracked) ---
// Each device gets its own unique Meowcoin address, generated once via
// getnewaddress. Donations sent there are detected automatically (no TXID
// paste required) by comparing the address's current confirmed-received
// total against how much of it has already been credited as tickets —
// only the newly-seen difference is ever credited, so partial/incremental
// donations over time are all picked up exactly once each, never twice.
//
// IMPORTANT: this still only ever *credits tickets for real, verified,
// on-chain MEWC receipts* — there is no path here or anywhere else that
// lets a client deposit or fabricate tickets directly.
const donorAddresses = new NodeCache({ stdTTL: 0, checkperiod: 0 }); // device -> address
const creditedDonationTotals = new NodeCache({ stdTTL: 0, checkperiod: 0 }); // device -> MEWC already credited

app.get('/api/donation/address', async (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  let address = donorAddresses.get(deviceId);

  if (!address) {
    try {
      address = await rpcCall('getnewaddress', ['', 'legacy']);
      donorAddresses.set(deviceId, address);
      creditedDonationTotals.set(deviceId, 0);
    } catch (err) {
      console.error('Donation address generation RPC error:', err.message);
      return res.status(502).json({ error: 'Could not generate a donation address right now.' });
    }
  }

  return res.json({ address, alreadyCredited: creditedDonationTotals.get(deviceId) || 0 });
});

// Polled by the donate page. Checks the player's own address for any
// newly-confirmed MEWC received beyond what's already been credited, and
// credits the difference. NOTE: the exact RPC signature for
// listreceivedbyaddress used below (minconf, include_empty,
// include_watchonly, address_filter) follows the standard Bitcoin-derived
// convention and has NOT been confirmed against this daemon's actual
// `help listreceivedbyaddress` output — verify this against the real
// command before relying on it in production, the same way
// transferfromaddress's param order turned out to need correcting earlier.
app.get('/api/donation/check-deposits', ipLimiter, async (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const address = donorAddresses.get(deviceId);
  if (!address) {
    return res.status(400).json({ error: 'No donation address for this device yet. Load the donate page first.' });
  }

  try {
    const results = await rpcCall('listreceivedbyaddress', [
      Number(DONATION_MIN_CONFIRMATIONS),
      false,
      false,
      address,
    ]);
    const entry = Array.isArray(results) ? results.find((r) => r.address === address) : null;
    const confirmedTotal = (entry && Number(entry.amount)) || 0;

    const alreadyCredited = creditedDonationTotals.get(deviceId) || 0;
    const newAmount = confirmedTotal - alreadyCredited;

    if (newAmount <= 0) {
      return res.json({ newTickets: 0, totalDonated: confirmedTotal, balance: getTicketBalance(deviceId) });
    }

    const newTickets = Math.floor((newAmount / 100) * Number(DONATION_TICKETS_PER_100_MEWC));
    creditedDonationTotals.set(deviceId, confirmedTotal);

    let newBalance = getTicketBalance(deviceId);
    if (newTickets > 0) {
      newBalance = addTicketsToLedger(deviceId, newTickets);
    }

    return res.json({
      newTickets,
      totalDonated: confirmedTotal,
      balance: newBalance,
    });
  } catch (err) {
    console.error('Donation deposit check RPC error:', err.message);
    return res.status(502).json({ error: 'Could not check for new donations right now.' });
  }
});

// --- Manual TXID donation verification (fallback path) ---
// Kept alongside the auto-detected per-address flow above for anyone who
// donates to the single shared DONATION_ADDRESS instead of their own
// per-player address. Same rule as always: a TXID is only ever accepted
// after a real `gettransaction` RPC call confirms it actually paid the
// donation address and has reached the required confirmation depth —
// tickets are calculated server-side from the verified on-chain amount,
// never trusted from the client.

// Permanent record of claimed TXIDs, so the same transaction can't be
// submitted twice (from this device or a different one). No TTL — a
// spent TXID should never become claimable again.
const claimedDonationTxids = new NodeCache({ stdTTL: 0, checkperiod: 0 });

function looksLikeTxid(v) {
  return typeof v === 'string' && /^[a-fA-F0-9]{64}$/.test(v.trim());
}

app.post('/api/donation/verify', ipLimiter, async (req, res) => {
  const txid = req.body && req.body.txid && req.body.txid.trim();

  if (!looksLikeTxid(txid)) {
    return res.status(400).json({ error: 'That does not look like a valid TXID.' });
  }
  if (claimedDonationTxids.get(txid)) {
    return res.status(409).json({ error: 'This transaction has already been claimed.' });
  }

  try {
    const rpcResponse = await axios.post(
      `http://${RPC_HOST}:${RPC_PORT}`,
      {
        jsonrpc: '1.0',
        id: 'meowfriend-donation',
        method: 'gettransaction',
        params: [txid],
      },
      {
        auth: { username: RPC_USER, password: RPC_PASS },
        timeout: 15000,
      }
    );

    if (rpcResponse.data && rpcResponse.data.error) {
      // Most common case: the node's wallet has never seen this TXID at
      // all (wrong TXID, or a transaction that never touched this wallet).
      return res.status(404).json({ error: 'Transaction not found by this node. Double-check the TXID.' });
    }

    const tx = rpcResponse.data.result;
    const confirmations = Number(tx.confirmations || 0);

    // Sum only the outputs that actually paid the donation address —
    // ignores change outputs or any other address the tx happened to
    // touch, so a TXID can't be reused to claim credit for an unrelated
    // payment elsewhere in the same transaction.
    const paidToDonationAddress = (tx.details || [])
      .filter((d) => d.address === DONATION_ADDRESS && d.category === 'receive')
      .reduce((sum, d) => sum + Number(d.amount || 0), 0);

    if (paidToDonationAddress <= 0) {
      return res.status(400).json({ error: 'This transaction did not pay the faucet donation address.' });
    }

    if (confirmations < Number(DONATION_MIN_CONFIRMATIONS)) {
      return res.status(202).json({
        pending: true,
        confirmations,
        required: Number(DONATION_MIN_CONFIRMATIONS),
        error: `Waiting for confirmations: ${confirmations}/${DONATION_MIN_CONFIRMATIONS} so far.`,
      });
    }

    const tickets = Math.floor((paidToDonationAddress / 100) * Number(DONATION_TICKETS_PER_100_MEWC));
    if (tickets <= 0) {
      return res.status(400).json({ error: 'Donation amount is too small to earn any tickets.' });
    }

    // Only now, after real on-chain confirmation, is this TXID locked in.
    claimedDonationTxids.set(txid, { amount: paidToDonationAddress, tickets, claimedAt: Date.now() });
    const deviceId = getOrSetDeviceId(req, res);
    const newBalance = addTicketsToLedger(deviceId, tickets);

    return res.json({
      success: true,
      amount: paidToDonationAddress,
      tickets,
      balance: newBalance,
      confirmations,
    });
  } catch (err) {
    console.error('Donation verify RPC error:', err.message);
    return res.status(502).json({ error: 'Could not verify transaction right now. Try again later.' });
  }
});

// --- Supply snapshot (for the GitHub Action / supply chart) ---
// Reports two numbers: the real on-chain total issued supply of the
// ticket asset, and the sum of every player's in-game ledger balance
// (tickets currently "in play," not yet withdrawn). The gap between them
// is what's been withdrawn out to real wallets. Protected by a shared
// secret rather than left open, since this is meant to be called by the
// scheduled Action, not scraped freely by the public frontend.
app.get('/api/tickets/supply-snapshot', ipLimiter, async (req, res) => {
  const providedSecret = req.headers['x-snapshot-secret'];
  if (!SNAPSHOT_SECRET || providedSecret !== SNAPSHOT_SECRET) {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  try {
    const assetData = await rpcCall('getassetdata', [TICKET_ASSET_NAME]);
    const onChainSupply = (assetData && assetData.amount) || 0;

    const allBalances = ticketLedger.mget(ticketLedger.keys());
    const ledgerSum = Object.values(allBalances).reduce((sum, v) => sum + (Number(v) || 0), 0);

    return res.json({
      timestamp: new Date().toISOString(),
      onChainSupply,
      ledgerSum,
      playerCount: Object.keys(allBalances).length,
    });
  } catch (err) {
    console.error('Supply snapshot RPC error:', err.message);
    return res.status(502).json({ error: 'Could not read supply data right now.' });
  }
});

// --- Player identity (mandatory username + ToS gate) ---
// Every device must set a username and agree to terms before it can be
// credited for anything gameplay-related. This is what leaderboards
// display instead of a raw device ID or wallet address. Usernames are
// server-validated for uniqueness — never trusted as unique just because
// the client claims one is free.
const playerUsernames = new NodeCache({ stdTTL: 0, checkperiod: 0 }); // device -> username
const usernameOwners = new NodeCache({ stdTTL: 0, checkperiod: 0 }); // lowercased username -> device (for uniqueness checks)
const playerJoinedAt = new NodeCache({ stdTTL: 0, checkperiod: 0 }); // device -> timestamp of account creation

function isValidUsername(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_]{3,16}$/.test(name.trim());
}

// device -> the address they've verified ownership of and linked for
// withdrawals. Signed once via verifymessage, then reused forever — the
// player never has to re-sign or re-type it for future withdrawals.
const linkedWithdrawAddresses = new NodeCache({ stdTTL: 0, checkperiod: 0 });

app.get('/api/player/status', (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const username = playerUsernames.get(deviceId);
  return res.json({
    hasUsername: !!username,
    username: username || null,
    linkedAddress: linkedWithdrawAddresses.get(deviceId) || null,
  });
});

app.post('/api/player/register-username', ipLimiter, (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const { username, agreedToTerms } = req.body || {};

  if (playerUsernames.get(deviceId)) {
    return res.status(409).json({ error: 'This device already has a username set.' });
  }
  if (!agreedToTerms) {
    return res.status(400).json({ error: 'You must agree to the terms to continue.' });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: 'Username must be 3-16 characters: letters, numbers, underscore only.' });
  }

  const key = username.trim().toLowerCase();
  if (usernameOwners.get(key)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  playerUsernames.set(deviceId, username.trim());
  usernameOwners.set(key, deviceId);
  playerJoinedAt.set(deviceId, Date.now());
  return res.json({ success: true, username: username.trim() });
});

// --- Sign-once withdrawal address linking ---
// A player proves control of their withdrawal address exactly once, via
// the same verifymessage pattern used elsewhere on the site. Once linked,
// that address is reused for every future withdrawal automatically — no
// re-typing, no re-signing. Linking a new address (if ever supported)
// would need its own re-verification; there's no path here that lets an
// unverified address become the withdrawal target.
const linkAddressChallenges = new NodeCache({ stdTTL: 10 * 60, checkperiod: 60 }); // device -> { message, expiresAt }

app.get('/api/player/link-address/challenge', ipLimiter, (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  if (linkedWithdrawAddresses.get(deviceId)) {
    return res.status(409).json({ error: 'This account already has a linked withdrawal address.' });
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `MeowFriend-LinkWithdrawAddress-${nonce}`;
  linkAddressChallenges.set(deviceId, { message, expiresAt: Date.now() + 10 * 60 * 1000 });
  return res.json({ message });
});

app.post('/api/player/link-address', ipLimiter, async (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const { address, signature } = req.body || {};

  if (linkedWithdrawAddresses.get(deviceId)) {
    return res.status(409).json({ error: 'This account already has a linked withdrawal address.' });
  }
  if (!isValidMeowcoinAddress(address)) {
    return res.status(400).json({ error: 'Invalid Meowcoin address.' });
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    return res.status(400).json({ error: 'Missing signature.' });
  }

  const challenge = linkAddressChallenges.get(deviceId);
  if (!challenge || challenge.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Challenge expired or missing. Generate a new one and try again.' });
  }

  try {
    const isValidSignature = await rpcCall('verifymessage', [address, signature, challenge.message]);
    if (!isValidSignature) {
      return res.status(400).json({ error: 'Signature verification failed. Make sure you signed the exact challenge message with this address.' });
    }
    linkedWithdrawAddresses.set(deviceId, address);
    linkAddressChallenges.del(deviceId);
    return res.json({ success: true, address });
  } catch (err) {
    console.error('Link-address verifymessage RPC error:', err.message);
    return res.status(502).json({ error: 'Could not verify signature right now. Try again later.' });
  }
});

function getUsername(deviceId) {
  return playerUsernames.get(deviceId) || 'Anonymous';
}

// --- Leaderboards ---
// All leaderboards are read-only aggregations over existing real
// server-side data (ticketLedger, creditedDonationTotals, gameScores) —
// nothing here is a new place tickets or scores can be created or edited
// from the client.

app.get('/api/leaderboard/tickets', (req, res) => {
  const keys = ticketLedger.keys();
  const entries = keys
    .map((deviceId) => ({ username: getUsername(deviceId), tickets: getTicketBalance(deviceId) }))
    .filter((e) => e.tickets > 0)
    .sort((a, b) => b.tickets - a.tickets)
    .slice(0, 10);
  return res.json({ leaderboard: entries });
});

app.get('/api/leaderboard/donations', (req, res) => {
  const keys = creditedDonationTotals.keys();
  const entries = keys
    .map((deviceId) => ({ username: getUsername(deviceId), totalDonated: creditedDonationTotals.get(deviceId) || 0 }))
    .filter((e) => e.totalDonated > 0)
    .sort((a, b) => b.totalDonated - a.totalDonated)
    .slice(0, 10);
  return res.json({ leaderboard: entries });
});

// Per-game high scores (Crossing, Runner, ...). Keyed by game name so one
// endpoint/store serves all of them rather than duplicating this per game.
const gameScores = new NodeCache({ stdTTL: 0, checkperiod: 0 }); // "game:device" -> best score
const VALID_GAMES = new Set(['crossing', 'runner']);

app.post('/api/leaderboard/:game/submit', ipLimiter, (req, res) => {
  const game = req.params.game;
  if (!VALID_GAMES.has(game)) {
    return res.status(400).json({ error: 'Unknown game.' });
  }
  const deviceId = getOrSetDeviceId(req, res);
  if (!playerUsernames.get(deviceId)) {
    return res.status(403).json({ error: 'Set a username before submitting a score.' });
  }

  const score = Number(req.body && req.body.score);
  if (!Number.isFinite(score) || score < 0) {
    return res.status(400).json({ error: 'Invalid score.' });
  }

  const key = `${game}:${deviceId}`;
  const existing = gameScores.get(key) || 0;
  // Only ever keep this device's own best score for the game — submitting
  // a lower score never overwrites a previous higher one.
  if (score > existing) {
    gameScores.set(key, score);
  }
  return res.json({ success: true, best: Math.max(score, existing) });
});

app.get('/api/leaderboard/:game', (req, res) => {
  const game = req.params.game;
  if (!VALID_GAMES.has(game)) {
    return res.status(400).json({ error: 'Unknown game.' });
  }
  const prefix = `${game}:`;
  const entries = gameScores.keys()
    .filter((k) => k.startsWith(prefix))
    .map((k) => {
      const deviceId = k.slice(prefix.length);
      return { username: getUsername(deviceId), score: gameScores.get(k) || 0 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  return res.json({ leaderboard: entries });
});

// --- Account tab data ---
// Everything the account page needs in one call: identity, ticket
// balance, lifetime donation total, linked withdrawal address, and this
// device's own best score in every tracked game. All read from existing
// real server-side data — nothing new is created or trusted from the
// client here.
app.get('/api/player/account', (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const username = playerUsernames.get(deviceId);
  if (!username) {
    return res.status(400).json({ error: 'No account for this device yet.' });
  }

  const scores = {};
  VALID_GAMES.forEach((game) => {
    scores[game] = gameScores.get(`${game}:${deviceId}`) || 0;
  });

  return res.json({
    username,
    joinedAt: playerJoinedAt.get(deviceId) || null,
    tickets: getTicketBalance(deviceId),
    totalDonated: creditedDonationTotals.get(deviceId) || 0,
    linkedAddress: linkedWithdrawAddresses.get(deviceId) || null,
    scores,
  });
});



app.listen(PORT, () => {
  console.log(`MeowFriend bridge listening on port ${PORT}`);
});
