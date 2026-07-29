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
  DONATION_TICKETS_PER_100_MEWC = 10,
  TICKET_ASSET_NAME = 'MEOWFRIEND_TICKET',
  TICKET_HOLDING_ADDRESS, // the game's own address that holds/reclaims spent tickets — must be set in .env
  TICKET_STARTING_GRANT = 100,
  TICKET_MIN_CONFIRMATIONS = 1,
  WITHDRAW_COOLDOWN_HOURS = 5,
} = process.env;

// Fail loudly on startup if secrets are missing, rather than silently
// running an unauthenticated/misconfigured bridge.
['RPC_USER', 'RPC_PASS', 'ALLOWED_ORIGIN', 'TICKET_HOLDING_ADDRESS'].forEach((key) => {
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
app.use(cookieParser());

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

function getOrSetDeviceId(req, res) {
  let id = req.cookies && req.cookies[DEVICE_COOKIE];
  if (!id) {
    id = crypto.randomUUID();
    res.cookie(DEVICE_COOKIE, id, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
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

// --- Donation address registration (sign-to-register) ---
// A user proves they control a Meowcoin address by signing a one-time
// challenge message with it (via their wallet's "sign message" feature),
// which we verify against the node with `verifymessage`. Only on a
// genuine RPC-confirmed pass do we save the address against their device.
// This does NOT create any cross-device identity, leaderboard, or account
// system — it's a single stored (device -> address) mapping, scoped to
// donation attribution, and nothing else reads or writes it.

// device_id -> { message, expiresAt } — one pending challenge per device.
// TTL matches expiresAt so an unused challenge cleans itself up.
const authChallenges = new NodeCache({ stdTTL: 10 * 60, checkperiod: 60 });

// device_id -> meowcoinAddress — the actual saved registration.
// No TTL: registration is meant to persist until the user re-registers
// (which simply overwrites their existing entry).
const registeredDonors = new NodeCache({ stdTTL: 0, checkperiod: 0 });

// device_id -> deposit address (the player's own per-account ticket
// address, generated server-side; its private key never leaves this
// server's wallet).
const depositAddresses = new NodeCache({ stdTTL: 0, checkperiod: 0 });

app.get('/api/auth/challenge', ipLimiter, (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `MeowFriend-Registration-${nonce}`;
  const expiresAt = Date.now() + 10 * 60 * 1000;

  authChallenges.set(deviceId, { message, expiresAt });

  return res.json({ message, expiresAt });
});

app.post('/api/auth/register', ipLimiter, async (req, res) => {
  const { address, signature } = req.body || {};
  const deviceId = getOrSetDeviceId(req, res);

  if (!isValidMeowcoinAddress(address)) {
    return res.status(400).json({ error: 'Invalid Meowcoin address format.' });
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    return res.status(400).json({ error: 'Missing signature.' });
  }

  const challenge = authChallenges.get(deviceId);
  if (!challenge || challenge.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Challenge expired or missing. Generate a new one and try again.' });
  }

  try {
    const rpcResponse = await axios.post(
      `http://${RPC_HOST}:${RPC_PORT}`,
      {
        jsonrpc: '1.0',
        id: 'meowfriend-verify',
        method: 'verifymessage',
        params: [address, signature, challenge.message],
      },
      {
        auth: { username: RPC_USER, password: RPC_PASS },
        timeout: 15000,
      }
    );

    if (rpcResponse.data && rpcResponse.data.error) {
      throw new Error(rpcResponse.data.error.message || 'RPC returned an error');
    }

    const isValidSignature = rpcResponse.data.result === true;
    if (!isValidSignature) {
      return res.status(400).json({ error: 'Signature verification failed. Make sure you signed the exact challenge message with the address you entered.' });
    }

    // Only now, after a genuine RPC-confirmed pass, do we save anything.
    registeredDonors.set(deviceId, address);
    authChallenges.del(deviceId); // used challenges can't be replayed

    // Generate this player's own deposit address. The private key for it
    // is never exported or sent anywhere — it stays in this node's own
    // wallet, under server custody, the same way the faucet's payout
    // wallet already works.
    const depositAddress = await rpcCall('getnewaddress', ['', 'legacy']);
    depositAddresses.set(deviceId, depositAddress);

    // Broadcast the starting grant. This is a real on-chain transfer, so
    // it starts at 0 confirmations — the frontend is expected to poll
    // /api/economy/grant-status with the returned txid before treating
    // the player as having any tickets yet.
    let grantTxid = null;
    try {
      grantTxid = await rpcCall('transferfromaddress', [
        TICKET_ASSET_NAME,
        TICKET_HOLDING_ADDRESS,
        Number(TICKET_STARTING_GRANT),
        depositAddress,
      ]);
    } catch (grantErr) {
      // Registration itself still succeeded — the deposit address exists
      // and is saved. The starting grant failing is a holding-wallet
      // problem (e.g. insufficient TICKET_ASSET_NAME balance) that
      // shouldn't be silently hidden, but also shouldn't undo the
      // registration that already succeeded.
      console.error('Starting ticket grant failed:', grantErr.message);
    }

    return res.json({ success: true, address, depositAddress, grantTxid });
  } catch (err) {
    console.error('verifymessage RPC error:', err.message);
    return res.status(502).json({ error: 'Could not verify signature. Try again later.' });
  }
});

// Lets the frontend check on load whether this device already has a
// registered address, without re-running the sign flow.
app.get('/api/auth/status', (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const address = registeredDonors.get(deviceId);
  const depositAddress = depositAddresses.get(deviceId);
  return res.json({
    registered: !!address,
    address: address || null,
    depositAddress: depositAddress || null,
  });
});

// --- Ticket economy ---
// There is no server-side ticket counter anywhere. A player's ticket
// balance IS whatever MEOWFRIEND_TICKET balance sits at their deposit
// address on-chain, queried live every time. Spending tickets means
// actually transferring them back to the game's holding wallet — the
// balance only ever changes because a real transaction confirmed.

app.get('/api/economy/tickets', ipLimiter, async (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const depositAddress = depositAddresses.get(deviceId);
  if (!depositAddress) {
    return res.status(400).json({ error: 'No deposit address for this device. Register first.' });
  }

  try {
    const balances = await rpcCall('listassetbalancesbyaddress', [depositAddress]);
    const tickets = (balances && balances[TICKET_ASSET_NAME]) || 0;
    return res.json({ tickets });
  } catch (err) {
    console.error('Ticket balance RPC error:', err.message);
    return res.status(502).json({ error: 'Could not read ticket balance right now.' });
  }
});

// Generic confirmation-status poller, shared by the starting grant and by
// spends — the frontend just needs to know, for a given txid: how many
// confirmations does it have, and has it reached the required threshold.
app.get('/api/economy/tx-status', ipLimiter, async (req, res) => {
  const txid = req.query.txid;
  if (typeof txid !== 'string' || !/^[a-fA-F0-9]{64}$/.test(txid)) {
    return res.status(400).json({ error: 'Missing or invalid txid.' });
  }

  try {
    const tx = await rpcCall('gettransaction', [txid]);
    const confirmations = Number(tx.confirmations || 0);
    return res.json({
      confirmations,
      required: Number(TICKET_MIN_CONFIRMATIONS),
      confirmed: confirmations >= Number(TICKET_MIN_CONFIRMATIONS),
    });
  } catch (err) {
    // Not found yet is expected right after broadcast — treat as still
    // pending rather than a hard error, so the poller keeps trying.
    return res.json({ confirmations: 0, required: Number(TICKET_MIN_CONFIRMATIONS), confirmed: false, notYetSeen: true });
  }
});

// Spends a fixed batch amount of tickets by transferring them from the
// player's own deposit address back to the game's holding wallet. Only
// one spend OR withdrawal may be pending confirmation per device at a
// time — this prevents a player from firing off several requests before
// the first one confirms and moving more tickets than their real balance
// would allow, since we're relying on wallet-level UTXO selection rather
// than a server-tracked counter to enforce sufficiency per request.
const pendingSpends = new NodeCache({ stdTTL: 15 * 60, checkperiod: 60 });

// device_id -> last successful withdrawal timestamp, for the cooldown.
const lastWithdrawal = new NodeCache({ stdTTL: 0, checkperiod: 0 });

app.post('/api/economy/spend', ipLimiter, async (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const depositAddress = depositAddresses.get(deviceId);
  if (!depositAddress) {
    return res.status(400).json({ error: 'No deposit address for this device. Register first.' });
  }

  if (pendingSpends.get(deviceId)) {
    return res.status(409).json({ error: 'A previous spend or withdrawal is still waiting on confirmation. Try again once it resolves.' });
  }

  const amount = Number(req.body && req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount.' });
  }

  try {
    const txid = await rpcCall('transferfromaddress', [
      TICKET_ASSET_NAME,
      depositAddress,
      amount,
      TICKET_HOLDING_ADDRESS,
    ]);
    pendingSpends.set(deviceId, { kind: 'spend', txid, amount, startedAt: Date.now() });
    return res.json({ success: true, txid, amount, required: Number(TICKET_MIN_CONFIRMATIONS) });
  } catch (err) {
    console.error('Spend RPC error:', err.message);
    // Most common real-world cause: insufficient MEOWFRIEND_TICKET balance
    // at the deposit address for the requested amount.
    return res.status(400).json({ error: 'Could not spend that amount — check your ticket balance and try again.' });
  }
});

// Frontend calls this once a spend's txid shows enough confirmations, to
// release the per-device spend lock. Re-checks confirmation itself rather
// than trusting the client's word for it.
app.post('/api/economy/spend-complete', ipLimiter, async (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const pending = pendingSpends.get(deviceId);
  if (!pending) {
    return res.status(400).json({ error: 'No pending spend for this device.' });
  }

  try {
    const tx = await rpcCall('gettransaction', [pending.txid]);
    const confirmations = Number(tx.confirmations || 0);
    if (confirmations < Number(TICKET_MIN_CONFIRMATIONS)) {
      return res.status(202).json({ pending: true, confirmations, required: Number(TICKET_MIN_CONFIRMATIONS) });
    }
    pendingSpends.del(deviceId);
    return res.json({ success: true, confirmations });
  } catch (err) {
    return res.status(502).json({ error: 'Could not check spend status right now.' });
  }
});

// Total issued supply of the ticket asset — shown as context ("N tickets
// exist in total") alongside a player's own balance. Purely informational.
app.get('/api/economy/supply', ipLimiter, async (req, res) => {
  try {
    const assetData = await rpcCall('getassetdata', [TICKET_ASSET_NAME]);
    const totalSupply = (assetData && assetData.amount) || 0;
    return res.json({ asset: TICKET_ASSET_NAME, totalSupply });
  } catch (err) {
    console.error('Supply lookup RPC error:', err.message);
    return res.status(502).json({ error: 'Could not read total supply right now.' });
  }
});

// Withdraws a portion (25-100%) of the player's ticket balance out of the
// game entirely, to their own registered address — the real cash-out
// moment, distinct from spending (which stays inside the game economy).
// Same confirmation requirement as a spend, but gated by its own cooldown
// since tickets leaving the game is a bigger step than an in-game spend.
app.post('/api/economy/withdraw', ipLimiter, async (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const depositAddress = depositAddresses.get(deviceId);
  const registeredAddress = registeredDonors.get(deviceId);

  if (!depositAddress || !registeredAddress) {
    return res.status(400).json({ error: 'No deposit or registered address for this device. Register first.' });
  }

  if (pendingSpends.get(deviceId)) {
    return res.status(409).json({ error: 'A previous spend or withdrawal is still waiting on confirmation. Try again once it resolves.' });
  }

  const lastTime = lastWithdrawal.get(deviceId) || 0;
  const cooldownMs = Number(WITHDRAW_COOLDOWN_HOURS) * 60 * 60 * 1000;
  const remainingMs = cooldownMs - (Date.now() - lastTime);
  if (remainingMs > 0) {
    return res.status(429).json({
      error: `Withdrawal cooldown active. Try again in ${Math.ceil(remainingMs / (60 * 1000))} minutes.`,
      cooldownRemainingMs: remainingMs,
    });
  }

  const percent = Number(req.body && req.body.percent);
  if (!Number.isFinite(percent) || percent < 25 || percent > 100) {
    return res.status(400).json({ error: 'Percent must be between 25 and 100.' });
  }

  let currentBalance;
  try {
    const balances = await rpcCall('listassetbalancesbyaddress', [depositAddress]);
    currentBalance = (balances && balances[TICKET_ASSET_NAME]) || 0;
  } catch (err) {
    console.error('Withdraw balance lookup RPC error:', err.message);
    return res.status(502).json({ error: 'Could not read your current balance right now.' });
  }

  if (currentBalance <= 0) {
    return res.status(400).json({ error: 'No tickets available to withdraw.' });
  }

  const amount = Math.floor(currentBalance * (percent / 100));
  if (amount <= 0) {
    return res.status(400).json({ error: 'That percentage rounds down to 0 tickets — try a higher percentage.' });
  }

  try {
    const txid = await rpcCall('transferfromaddress', [
      TICKET_ASSET_NAME,
      depositAddress,
      amount,
      registeredAddress,
    ]);
    pendingSpends.set(deviceId, { kind: 'withdraw', txid, amount, startedAt: Date.now() });
    return res.json({ success: true, txid, amount, percent, required: Number(TICKET_MIN_CONFIRMATIONS) });
  } catch (err) {
    console.error('Withdraw RPC error:', err.message);
    return res.status(400).json({ error: 'Could not process the withdrawal. Try again later.' });
  }
});

// Frontend calls this once a withdrawal's txid shows enough
// confirmations, to release the spend lock and start the cooldown timer.
app.post('/api/economy/withdraw-complete', ipLimiter, async (req, res) => {
  const deviceId = getOrSetDeviceId(req, res);
  const pending = pendingSpends.get(deviceId);
  if (!pending || pending.kind !== 'withdraw') {
    return res.status(400).json({ error: 'No pending withdrawal for this device.' });
  }

  try {
    const tx = await rpcCall('gettransaction', [pending.txid]);
    const confirmations = Number(tx.confirmations || 0);
    if (confirmations < Number(TICKET_MIN_CONFIRMATIONS)) {
      return res.status(202).json({ pending: true, confirmations, required: Number(TICKET_MIN_CONFIRMATIONS) });
    }
    pendingSpends.del(deviceId);
    // Cooldown starts from confirmation, not from when the withdrawal was
    // first requested — so a slow confirmation doesn't eat into the
    // player's next available withdrawal window.
    lastWithdrawal.set(deviceId, Date.now());
    return res.json({ success: true, confirmations });
  } catch (err) {
    return res.status(502).json({ error: 'Could not check withdrawal status right now.' });
  }
});

// --- Donation verification ---
// A TXID is only ever accepted after a real `gettransaction` RPC call
// confirms: the transaction exists in this node's own wallet (which it
// will, since the donation address was generated by this same wallet),
// it actually paid the donation address (not just any address touched by
// the tx), and it has reached the required confirmation depth. Tickets
// are calculated server-side from the verified on-chain amount — the
// client never gets to just say how much it donated.

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

    return res.json({
      success: true,
      amount: paidToDonationAddress,
      tickets,
      confirmations,
    });
  } catch (err) {
    console.error('Donation verify RPC error:', err.message);
    return res.status(502).json({ error: 'Could not verify transaction right now. Try again later.' });
  }
});

// Basic health check — useful for confirming the tunnel + server are up
// without touching the wallet.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`MeowFriend bridge listening on port ${PORT}`);
});
