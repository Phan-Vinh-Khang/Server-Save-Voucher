const dotenv = require('dotenv');
const express = require('express');
const { MongoClient } = require('mongodb');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5000);
const UPSTREAM_VOUCHER_CONFIGS =
  process.env.UPSTREAM_VOUCHER_CONFIGS || 'https://otistx.com/api/x7k9m2p4/voucher-configs';
const UPSTREAM_FREESHIP_VOUCHERS =
  process.env.UPSTREAM_FREESHIP_VOUCHERS || 'https://api.autopee.com/shopee/freeships?limit=200';
const UPSTREAM_SAVE_VOUCHER =
  process.env.UPSTREAM_SAVE_VOUCHER || 'https://api.autopee.com/shopee/save-voucher';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'save100_sid';
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 21600);
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'saveVoucher';
const MONGODB_COLLECTION_NAME = process.env.MONGODB_COLLECTION_NAME || 'account';

let mongoStatus = 'disconnected';
let mongoClient;
const cookieSessionStore = new Map();

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const requestOrigin = req.headers.origin;
  const allowOrigin = FRONTEND_ORIGIN === '*' && requestOrigin ? requestOrigin : FRONTEND_ORIGIN;

  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  return next();
});

async function fetchUpstream(url, init) {
  if (typeof fetch === 'function') return fetch(url, init);
  const nodeFetch = await import('node-fetch');
  return nodeFetch.default(url, init);
}

async function fetchUpstreamJson(url, label) {
  const upstream = await fetchUpstream(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'User-Agent': 'save100-express-proxy/1.0',
    },
  });

  const body = await upstream.text();

  if (!upstream.ok) {
    throw new Error(`Cannot load ${label}: HTTP ${upstream.status}`);
  }

  try {
    return JSON.parse(body);
  } catch (_err) {
    throw new Error(`Invalid JSON from ${label}`);
  }
}

function normalizeCookieValue(input) {
  const value = String(input ?? '').trim();
  if (!value) return '';
  if (value.startsWith('SPC_ST=')) return value;
  return `SPC_ST=${value}`;
}

function parseCookieHeader(cookieHeader) {
  const parsed = {};
  const source = String(cookieHeader || '');
  if (!source) return parsed;

  for (const part of source.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) continue;
    parsed[rawKey] = decodeURIComponent(rawValue.join('=') || '');
  }

  return parsed;
}

function setSessionIdCookie(req, res, sessionId) {
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const securePart = isSecure ? '; Secure' : '';
  const cookieValue = `${SESSION_COOKIE_NAME}=${encodeURIComponent(
    sessionId
  )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${securePart}`;
  res.setHeader('Set-Cookie', cookieValue);
}

function getSessionId(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const raw = cookies[SESSION_COOKIE_NAME];
  return raw ? String(raw) : '';
}

function getOrCreateSessionId(req, res) {
  const existing = getSessionId(req);
  if (existing) {
    setSessionIdCookie(req, res, existing);
    return existing;
  }

  const generated = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  setSessionIdCookie(req, res, generated);
  return generated;
}

function saveSessionCookie(req, res, cookieValue) {
  const normalizedCookie = normalizeCookieValue(cookieValue);
  if (!normalizedCookie) return '';

  const sessionId = getOrCreateSessionId(req, res);
  cookieSessionStore.set(sessionId, {
    cookie: normalizedCookie,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  });

  return sessionId;
}

function getSessionCookie(req) {
  const sessionId = getSessionId(req);
  if (!sessionId) return '';

  const entry = cookieSessionStore.get(sessionId);
  if (!entry) return '';

  if (Date.now() > entry.expiresAt) {
    cookieSessionStore.delete(sessionId);
    return '';
  }

  return entry.cookie;
}

function normalizeFreeshipVoucher(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.hasExpired === true || raw.disabled === true || raw.hidden === true) return null;

  const promotionId = raw.promotionId ?? raw.promotionid ?? raw.voucherIdString;
  const voucherCode = raw.voucherCode ?? raw.voucher_code;
  const signature = raw.signature ?? raw.userSignature;

  if (!promotionId || !voucherCode || !signature) return null;

  return {
    benefitName: raw.benefitName || raw.voucherName || raw.voucherCode || 'Voucher Freeship',
    voucherIdString: String(promotionId),
    voucherCode: String(voucherCode),
    userSignature: String(signature),
    client_id: `freeship:${String(promotionId)}`,
    lastUpdated: raw.updatedAt || raw.lastUpdated || null,
  };
}

function normalizeVoucherForSave(raw, fallbackClientId) {
  if (!raw || typeof raw !== 'object') return null;

  const promotionid = raw.promotionid ?? raw.promotionId ?? raw.voucherIdString ?? raw.id;
  const voucher_code = raw.voucher_code ?? raw.voucherCode ?? raw.code;
  const signature = raw.signature ?? raw.userSignature;

  if (!promotionid || !voucher_code || !signature) return null;

  return {
    client_id: String(raw.client_id ?? raw.clientId ?? fallbackClientId ?? ''),
    promotionid: String(promotionid),
    voucher_code: String(voucher_code),
    signature: String(signature),
  };
}

async function loadMergedVoucherConfigs() {
  const [baseConfigs, freeshipPayload] = await Promise.all([
    fetchUpstreamJson(UPSTREAM_VOUCHER_CONFIGS, 'voucher configs'),
    fetchUpstreamJson(UPSTREAM_FREESHIP_VOUCHERS, 'freeship vouchers'),
  ]);

  const mergedConfigs =
    baseConfigs && typeof baseConfigs === 'object' && !Array.isArray(baseConfigs) ? { ...baseConfigs } : {};

  for (const [key, value] of Object.entries(mergedConfigs)) {
    if (key === 'freeship_vouchers') continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      mergedConfigs[key] = { ...value, client_id: String(value.client_id ?? key) };
    }
  }

  const freeshipList = Array.isArray(freeshipPayload?.data) ? freeshipPayload.data : [];
  mergedConfigs.freeship_vouchers = freeshipList.map(normalizeFreeshipVoucher).filter(Boolean);

  return mergedConfigs;
}

function findVoucherByClientId(configs, clientId) {
  if (!clientId || !configs || typeof configs !== 'object') return null;

  for (const [key, value] of Object.entries(configs)) {
    if (key === 'freeship_vouchers' && Array.isArray(value)) {
      for (const item of value) {
        const normalized = normalizeVoucherForSave(item, item?.client_id);
        if (normalized && normalized.client_id === clientId) return normalized;
      }
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const normalized = normalizeVoucherForSave(value, key);
      if (normalized && normalized.client_id === clientId) return normalized;
    }
  }

  return null;
}

async function connectMongo() {
  if (!MONGODB_URI) {
    throw new Error('Missing MONGODB_URI in environment variables.');
  }

  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();

  const db = mongoClient.db(MONGODB_DB_NAME);

  try {
    await db.createCollection(MONGODB_COLLECTION_NAME);
    console.log(`Created collection: ${MONGODB_DB_NAME}.${MONGODB_COLLECTION_NAME}`);
  } catch (err) {
    if (err?.code === 48 || err?.codeName === 'NamespaceExists') {
      console.log(`Collection already exists: ${MONGODB_DB_NAME}.${MONGODB_COLLECTION_NAME}`);
    } else {
      throw err;
    }
  }

  mongoStatus = 'connected';
  console.log(`Connected MongoDB and ready DB: ${MONGODB_DB_NAME}`);
}

app.get('/api/voucher-configs', async (_req, res) => {
  try {
    const mergedConfigs = await loadMergedVoucherConfigs();

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(mergedConfigs);
  } catch (err) {
    return res.status(502).json({
      message: 'Cannot load voucher configs from upstream',
      error: err?.message || 'Unknown error',
    });
  }
});

app.post('/api/session/cookie', (req, res) => {
  const normalizedCookie = normalizeCookieValue(req.body?.cookie);

  if (!normalizedCookie) {
    return res.status(400).json({ message: 'Missing cookie value.' });
  }

  saveSessionCookie(req, res, normalizedCookie);
  return res.status(200).json({ ok: true });
});

app.post('/api/save-voucher/:clientId', async (req, res) => {
  try {
    const clientId = String(req.params?.clientId || '').trim();
    if (!clientId) {
      return res.status(400).json({ message: 'Missing voucher client id.' });
    }

    const savedCookie = getSessionCookie(req);
    if (!savedCookie) {
      return res.status(401).json({
        message: 'Cookie session missing or expired. Please re-enter cookie.',
      });
    }

    const mergedConfigs = await loadMergedVoucherConfigs();
    const voucher = findVoucherByClientId(mergedConfigs, clientId);

    if (!voucher) {
      return res.status(404).json({ message: 'Voucher not found from current configs.' });
    }

    const upstream = await fetchUpstream(UPSTREAM_SAVE_VOUCHER, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'save100-express-proxy/1.0',
      },
      body: JSON.stringify({
        cookie: savedCookie,
        signature: voucher.signature,
        voucher_code: voucher.voucher_code.trim(),
        voucher_promotionid: voucher.promotionid,
      }),
    });

    const body = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';

    res.setHeader('Content-Type', contentType);
    return res.status(upstream.status).send(body);
  } catch (err) {
    return res.status(502).json({
      message: 'Cannot save voucher through upstream',
      error: err?.message || 'Unknown error',
    });
  }
});

app.post('/api/save-voucher', async (req, res) => {
  try {
    const upstream = await fetchUpstream(UPSTREAM_SAVE_VOUCHER, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'save100-express-proxy/1.0',
      },
      body: JSON.stringify(req.body || {}),
    });

    const body = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';

    res.setHeader('Content-Type', contentType);
    return res.status(upstream.status).send(body);
  } catch (err) {
    return res.status(502).json({
      message: 'Cannot save voucher through upstream',
      error: err?.message || 'Unknown error',
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true, mongo: mongoStatus });
});

async function startServer() {
  try {
    await connectMongo();
    app.listen(PORT, () => {
      console.log(`save100 backend listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('MongoDB connection failed:', err?.message || err);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  if (mongoClient) {
    await mongoClient.close();
  }
  process.exit(0);
});

startServer();
