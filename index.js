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
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'saveVoucher';
const MONGODB_COLLECTION_NAME = process.env.MONGODB_COLLECTION_NAME || 'account';

let mongoStatus = 'disconnected';
let mongoClient;

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
    lastUpdated: raw.updatedAt || raw.lastUpdated || null,
  };
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
    const [baseConfigs, freeshipPayload] = await Promise.all([
      fetchUpstreamJson(UPSTREAM_VOUCHER_CONFIGS, 'voucher configs'),
      fetchUpstreamJson(UPSTREAM_FREESHIP_VOUCHERS, 'freeship vouchers'),
    ]);

    const mergedConfigs =
      baseConfigs && typeof baseConfigs === 'object' && !Array.isArray(baseConfigs) ? { ...baseConfigs } : {};
    const freeshipList = Array.isArray(freeshipPayload?.data) ? freeshipPayload.data : [];

    mergedConfigs.freeship_vouchers = freeshipList.map(normalizeFreeshipVoucher).filter(Boolean);

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
