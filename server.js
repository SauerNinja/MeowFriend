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
} = process.env;

// Fail loudly on startup if secrets are missing, rather than silently
// running an unauthenticated/misconfigured bridge.
['RPC_USER', 'RPC_PASS', 'ALLOWED_ORIGIN'].forEach((key) => {
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

// Basic health check — useful for confirming the tunnel + server are up
// without touching the wallet.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`MeowFriend bridge listening on port ${PORT}`);
});
