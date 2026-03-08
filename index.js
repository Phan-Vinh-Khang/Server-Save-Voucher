const dotenv = require('dotenv');
const express = require('express');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5000);
const UPSTREAM_VOUCHER_CONFIGS =
  process.env.UPSTREAM_VOUCHER_CONFIGS || 'https://otistx.com/api/x7k9m2p4/voucher-configs';
const UPSTREAM_SAVE_VOUCHER =
  process.env.UPSTREAM_SAVE_VOUCHER || 'https://api.autopee.com/shopee/save-voucher';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

const mongoStatus = 'disabled';

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

app.get('/api/voucher-configs', async (_req, res) => {
  try {
    const baseConfigs = await fetchUpstreamJson(UPSTREAM_VOUCHER_CONFIGS, 'voucher configs');
    const mergedConfigs =
      baseConfigs && typeof baseConfigs === 'object' && !Array.isArray(baseConfigs) ? { ...baseConfigs } : {};

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

function startServer() {
  app.listen(PORT, () => {
    console.log(`save100 backend listening on http://localhost:${PORT}`);
  });
}

startServer();
