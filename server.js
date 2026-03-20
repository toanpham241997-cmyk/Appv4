import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = String(process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const LINK4M_API_TOKEN = String(process.env.LINK4M_API_TOKEN || '').trim();
const FREE_KEY_TTL_HOURS = Math.max(1, Number(process.env.FREE_KEY_TTL_HOURS || 5));
const SESSION_TTL_MINUTES = Math.max(5, Number(process.env.SESSION_TTL_MINUTES || 30));
const SESSION_SECRET = String(process.env.SESSION_SECRET || 'change-this-secret-before-deploy');

const dataDir = path.join(__dirname, 'data');
const storePath = path.join(dataDir, 'store.json');

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

function ensureStoreFile() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(storePath)) {
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          keysByKey: {},
          deviceIndex: {},
          sessions: {},
          notifications: [],
          settings: {
            freeKeyPortal: '/free-key.html',
            telegram: 'https://t.me/example_support',
            zalo: 'https://zalo.me/0123456789',
            facebook: 'https://facebook.com/example.page',
            youtube: 'https://youtube.com/@example'
          }
        },
        null,
        2
      )
    );
  }
}

function readStore() {
  ensureStoreFile();
  const raw = fs.readFileSync(storePath, 'utf8');
  return JSON.parse(raw);
}

function writeStore(store) {
  ensureStoreFile();
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function randomId(size = 16) {
  return crypto.randomBytes(size).toString('hex');
}

function randomKey() {
  return `FREE-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function sanitizeClientId(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  return v.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
}

function maskKey(key) {
  if (!key || key.length < 8) return key || '—';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function buildSignature(parts) {
  return crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(parts.join('|'))
    .digest('hex');
}

function cleanupStore(store) {
  const now = new Date();

  for (const [rid, session] of Object.entries(store.sessions || {})) {
    if (!session || !session.expiresAt) {
      delete store.sessions[rid];
      continue;
    }
    if (new Date(session.expiresAt) < now) {
      delete store.sessions[rid];
    }
  }

  for (const [key, keyRow] of Object.entries(store.keysByKey || {})) {
    if (!keyRow || !keyRow.expiresAt) {
      delete store.keysByKey[key];
      continue;
    }
    if (new Date(keyRow.expiresAt) < now) {
      if (keyRow.clientId && store.deviceIndex[keyRow.clientId] === key) {
        delete store.deviceIndex[keyRow.clientId];
      }
      delete store.keysByKey[key];
    }
  }

  for (const [clientId, key] of Object.entries(store.deviceIndex || {})) {
    if (!store.keysByKey[key]) {
      delete store.deviceIndex[clientId];
    }
  }

  return store;
}

function getActiveKeyForClient(store, clientId) {
  const key = store.deviceIndex?.[clientId];
  if (!key) return null;
  const row = store.keysByKey?.[key];
  if (!row) return null;
  if (new Date(row.expiresAt) <= new Date()) return null;
  return row;
}

function issueOrReuseKey(store, clientId) {
  const existing = getActiveKeyForClient(store, clientId);
  if (existing) {
    return existing;
  }

  let key;
  do {
    key = randomKey();
  } while (store.keysByKey[key]);

  const issuedAt = new Date();
  const expiresAt = addHours(issuedAt, FREE_KEY_TTL_HOURS);
  const row = {
    key,
    type: 'free',
    clientId,
    active: true,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    note: `Key miễn phí ${FREE_KEY_TTL_HOURS} giờ cho thiết bị hiện tại`,
    maxDevices: 1,
    uses: 0,
    lastLoginAt: null
  };

  store.keysByKey[key] = row;
  store.deviceIndex[clientId] = key;
  return row;
}

function createSession(store, clientId) {
  const createdAt = new Date();
  const expiresAt = addMinutes(createdAt, SESSION_TTL_MINUTES);
  const rid = randomId(12);
  const state = randomId(18);
  const sig = buildSignature([rid, clientId, createdAt.toISOString(), expiresAt.toISOString(), state]);

  const row = {
    rid,
    clientId,
    state,
    sig,
    verified: false,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    claimedAt: null,
    issuedKey: null
  };

  store.sessions[rid] = row;
  return row;
}

async function createLink4mShortUrl(targetUrl) {
  if (!LINK4M_API_TOKEN) {
    return {
      ok: false,
      message: 'Thiếu LINK4M_API_TOKEN trong biến môi trường.'
    };
  }

  const apiUrl = new URL('https://link4m.co/api-shorten/v2');
  apiUrl.searchParams.set('api', LINK4M_API_TOKEN);
  apiUrl.searchParams.set('url', targetUrl);

  const response = await fetch(apiUrl.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  const text = await response.text();
  let json;

  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      message: `Phản hồi Link4m không hợp lệ: ${text.slice(0, 200)}`
    };
  }

  if (json.status !== 'success' || !json.shortenedUrl) {
    return {
      ok: false,
      message: json.message || 'Link4m không trả về shortenedUrl.'
    };
  }

  return {
    ok: true,
    shortenedUrl: json.shortenedUrl
  };
}

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    appBaseUrl: APP_BASE_URL,
    hasLink4mToken: Boolean(LINK4M_API_TOKEN),
    freeKeyTtlHours: FREE_KEY_TTL_HOURS,
    sessionTtlMinutes: SESSION_TTL_MINUTES
  });
});

app.get('/api/app-config', (_req, res) => {
  const store = cleanupStore(readStore());
  writeStore(store);

  res.json({
    status: 'success',
    appName: 'VIP TOOL PRO V4',
    brandLine: 'Premium License Console',
    logoUrl: 'https://sf-static.upanhlaylink.com/img/image_20260313c8e5ff3531d34404575f229fe201d9ac.jpg',
    freeKeyPortalUrl: `${APP_BASE_URL}${store.settings?.freeKeyPortal || '/free-key.html'}`,
    links: {
      telegram: store.settings?.telegram || '#',
      zalo: store.settings?.zalo || '#',
      facebook: store.settings?.facebook || '#',
      youtube: store.settings?.youtube || '#'
    },
    notifications: store.notifications || []
  });
});

app.post('/api/free/create-session', async (req, res) => {
  const clientId = sanitizeClientId(req.body?.clientId);
  if (!clientId) {
    return res.status(400).json({ status: 'error', message: 'Thiếu clientId hợp lệ.' });
  }

  const store = cleanupStore(readStore());
  const activeKey = getActiveKeyForClient(store, clientId);
  if (activeKey) {
    writeStore(store);
    return res.json({
      status: 'success',
      mode: 'existing',
      message: 'Thiết bị đã có key miễn phí còn hiệu lực.',
      key: activeKey.key,
      maskedKey: maskKey(activeKey.key),
      expiresAt: activeKey.expiresAt,
      ttlHours: FREE_KEY_TTL_HOURS
    });
  }

  const session = createSession(store, clientId);
  const verifyUrl = new URL('/verify', APP_BASE_URL);
  verifyUrl.searchParams.set('rid', session.rid);
  verifyUrl.searchParams.set('state', session.state);
  verifyUrl.searchParams.set('sig', session.sig);

  try {
    const shortResult = await createLink4mShortUrl(verifyUrl.toString());
    if (!shortResult.ok) {
      return res.status(500).json({ status: 'error', message: shortResult.message });
    }

    writeStore(store);
    return res.json({
      status: 'success',
      mode: 'link',
      rid: session.rid,
      shortUrl: shortResult.shortenedUrl,
      expiresAt: session.expiresAt,
      ttlHours: FREE_KEY_TTL_HOURS,
      portalUrl: `${APP_BASE_URL}/free-key.html?rid=${encodeURIComponent(session.rid)}`
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message || 'Không tạo được link rút gọn.' });
  }
});

app.get('/verify', (req, res) => {
  const rid = String(req.query?.rid || '');
  const state = String(req.query?.state || '');
  const sig = String(req.query?.sig || '');

  const store = cleanupStore(readStore());
  const session = store.sessions?.[rid];
  if (!session) {
    writeStore(store);
    return res.redirect(`${APP_BASE_URL}/free-key.html?error=${encodeURIComponent('Phiên xác minh không tồn tại hoặc đã hết hạn.')}`);
  }

  if (new Date(session.expiresAt) < new Date()) {
    delete store.sessions[rid];
    writeStore(store);
    return res.redirect(`${APP_BASE_URL}/free-key.html?error=${encodeURIComponent('Phiên xác minh đã hết hạn, hãy tạo link mới.')}`);
  }

  const expectedSig = buildSignature([rid, session.clientId, session.createdAt, session.expiresAt, session.state]);
  if (state !== session.state || sig !== expectedSig) {
    writeStore(store);
    return res.redirect(`${APP_BASE_URL}/free-key.html?error=${encodeURIComponent('Xác minh không hợp lệ. Vui lòng thử lại.')}`);
  }

  const issued = issueOrReuseKey(store, session.clientId);
  session.verified = true;
  session.claimedAt = nowIso();
  session.issuedKey = issued.key;
  store.sessions[rid] = session;
  writeStore(store);

  return res.redirect(`${APP_BASE_URL}/free-key.html?verified=1&rid=${encodeURIComponent(rid)}`);
});

app.post('/api/free/claim', (req, res) => {
  const rid = String(req.body?.rid || '').trim();
  const clientId = sanitizeClientId(req.body?.clientId);
  if (!rid || !clientId) {
    return res.status(400).json({ status: 'error', message: 'Thiếu rid hoặc clientId.' });
  }

  const store = cleanupStore(readStore());
  const session = store.sessions?.[rid];
  if (!session) {
    writeStore(store);
    return res.status(404).json({ status: 'error', message: 'Không tìm thấy phiên xác minh.' });
  }

  if (session.clientId !== clientId) {
    writeStore(store);
    return res.status(403).json({ status: 'error', message: 'Phiên này không thuộc thiết bị hiện tại.' });
  }

  if (!session.verified) {
    writeStore(store);
    return res.status(403).json({ status: 'error', message: 'Bạn chưa hoàn tất bước vượt link.' });
  }

  const keyRow = store.keysByKey?.[session.issuedKey] || getActiveKeyForClient(store, clientId);
  if (!keyRow) {
    writeStore(store);
    return res.status(500).json({ status: 'error', message: 'Không thể cấp key cho thiết bị này.' });
  }

  writeStore(store);
  return res.json({
    status: 'success',
    key: keyRow.key,
    maskedKey: maskKey(keyRow.key),
    expiresAt: keyRow.expiresAt,
    ttlHours: FREE_KEY_TTL_HOURS,
    note: keyRow.note
  });
});

app.post('/api/key/validate', (req, res) => {
  const key = String(req.body?.key || '').trim().toUpperCase();
  const clientId = sanitizeClientId(req.body?.clientId);
  if (!key) {
    return res.status(400).json({ status: 'error', message: 'Thiếu key.' });
  }
  if (!clientId) {
    return res.status(400).json({ status: 'error', message: 'Thiếu clientId hợp lệ.' });
  }

  const store = cleanupStore(readStore());
  const row = store.keysByKey?.[key];
  if (!row) {
    writeStore(store);
    return res.status(404).json({ status: 'error', message: 'Key không tồn tại trong hệ thống.' });
  }

  if (!row.active) {
    writeStore(store);
    return res.status(403).json({ status: 'error', message: 'Key đã bị vô hiệu hóa.' });
  }

  if (new Date(row.expiresAt) <= new Date()) {
    if (row.clientId && store.deviceIndex[row.clientId] === key) {
      delete store.deviceIndex[row.clientId];
    }
    delete store.keysByKey[key];
    writeStore(store);
    return res.status(403).json({ status: 'error', message: 'Key đã hết hạn.' });
  }

  if (row.clientId !== clientId) {
    writeStore(store);
    return res.status(403).json({ status: 'error', message: 'Key này chỉ dùng được trên thiết bị đã nhận key.' });
  }

  row.uses = Number(row.uses || 0) + 1;
  row.lastLoginAt = nowIso();
  store.keysByKey[key] = row;
  writeStore(store);

  return res.json({
    status: 'success',
    keyData: {
      expiry: new Date(row.expiresAt).toLocaleString('vi-VN'),
      expiryDate: row.expiresAt,
      note: row.note,
      active: row.active,
      maxDevices: row.maxDevices,
      type: row.type,
      uses: row.uses,
      deviceLabel: '1 thiết bị'
    }
  });
});

app.get('/api/key/status', (req, res) => {
  const clientId = sanitizeClientId(req.query?.clientId);
  if (!clientId) {
    return res.status(400).json({ status: 'error', message: 'Thiếu clientId.' });
  }

  const store = cleanupStore(readStore());
  const activeKey = getActiveKeyForClient(store, clientId);
  writeStore(store);

  if (!activeKey) {
    return res.json({ status: 'success', hasActiveKey: false });
  }

  return res.json({
    status: 'success',
    hasActiveKey: true,
    key: activeKey.key,
    maskedKey: maskKey(activeKey.key),
    expiresAt: activeKey.expiresAt,
    note: activeKey.note
  });
});

app.use((req, res) => {
  res.status(404).json({ status: 'error', message: `Không tìm thấy đường dẫn ${req.method} ${req.originalUrl}` });
});

app.listen(PORT, () => {
  console.log(`VIP TOOL PRO portal running at ${APP_BASE_URL}`);
});
