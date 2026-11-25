'use strict';
/*
  BIM real-time server
  - نفس الـAPI اللي index.html شغال عليه (/api/stream + /api/state) — مفيش تغيير في الصفحة.
  - الحفظ: Postgres لو DATABASE_URL موجود (الأفضل على Railway)، وإلا ملف JSON (لازم Volume).
  - مصمم ما يقعش: أي خطأ بيتسجّل بس والسيرفر يكمّل.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const SYNC = process.env.SYNC_CODE || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const NESTED_PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html'));
const PUB = NESTED_PUB ? path.join(__dirname, 'public') : __dirname;
const PUBLIC_FILES = new Set(['index.html', 'sw.js', 'manifest.json', 'icon-192.png', 'icon-512.png']);
const L = n => require(fs.existsSync(path.join(__dirname, n + '.js')) ? './' + n : './engine/' + n);
const MAX_BODY = 15e6;
const A = require('./auth');
const G = L('geo'), RK = L('risk'), OPS = L('ops-api'), BR = L('branches');
const crypto = require('crypto');
const LEGACY = process.env.ALLOW_LEGACY === '1';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') { console.error('JWT_SECRET مطلوب في production.'); process.exit(1); }
  console.warn('⚠️  JWT_SECRET مش مضبوط — الجلسات هتتلغي مع كل إعادة تشغيل. ضيفه في Variables.');
}
const AUTH_FILE = process.env.AUTH_FILE || path.join(__dirname, 'auth.json');
const USER_RE = /^[A-Za-z0-9._@-]{3,40}$/;

process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));

/* ───────────── التخزين ───────────── */
let pool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
      max: 3,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', e => console.error('pg pool error:', e.message));
  } catch (e) {
    console.error('❌ مكتبة pg مش متسطّبة (npm install). هشتغل بالملف مؤقتاً:', e.message);
  }
} else {
  console.warn('⚠️  DATABASE_URL مش مضبوط — الحفظ في ملف. على Railway الملف بيضيع مع كل Deploy إلا لو عندك Volume (DATA_FILE=/data/data.json).');
}

let auth = {};
async function loadAuth() {
  if (pool) {
    await pool.query('create table if not exists bim_auth (id int primary key, data jsonb not null)');
    const r = await pool.query('select data from bim_auth where id = 1');
    return r.rows[0] ? r.rows[0].data : {};
  }
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return {}; }
}
async function saveAuth() {
  const json = JSON.stringify(auth);
  if (pool) await pool.query('insert into bim_auth(id,data) values(1,$1::jsonb) on conflict (id) do update set data=excluded.data', [json]);
  else { await fs.promises.writeFile(AUTH_FILE + '.tmp', json); await fs.promises.rename(AUTH_FILE + '.tmp', AUTH_FILE); }
}
const nameTaken = (n, exceptSap) => Object.entries(auth).some(([k, v]) => k !== String(exceptSap) && String(v.username).toLowerCase() === String(n).toLowerCase());

let state = null;
let ready = false;
let dirty = false, saving = false, saveT = null;

function readFileState() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; }
}

async function loadState() {
  if (pool) {
    await pool.query('create table if not exists bim_state (id int primary key, data jsonb not null, updated_at timestamptz not null default now())');
    const r = await pool.query('select data from bim_state where id = 1');
    if (r.rows[0]) return r.rows[0].data;
    const f = readFileState();
    if (f) { console.log('ℹ️  نقل البيانات من الملف القديم لـPostgres'); }
    return f;
  }
  return readFileState();
}

async function flush() {
  if (saving || !dirty || !state) return;
  saving = true; dirty = false;
  const json = JSON.stringify(state);
  try {
    if (pool) {
      await pool.query(
        'insert into bim_state(id,data,updated_at) values(1,$1::jsonb,now()) on conflict (id) do update set data=excluded.data, updated_at=now()',
        [json]);
    } else {
      await fs.promises.writeFile(DATA_FILE + '.tmp', json);
      await fs.promises.rename(DATA_FILE + '.tmp', DATA_FILE);
    }
  } catch (e) {
    dirty = true;
    console.error('save failed (هنعيد المحاولة):', e.message);
    setTimeout(flush, 3000);
  } finally {
    saving = false;
    if (dirty && !saveT) schedule();
  }
}
function schedule() {
  dirty = true;
  if (saveT) return;
  saveT = setTimeout(() => { saveT = null; flush(); }, 700);
}

(async function boot() {
  for (let i = 1; ; i++) {
    try {
      state = sanitizeState(await loadState());
      auth = await loadAuth();
      const _AU = String(process.env.ADMIN_USER || '').trim(), _AP = String(process.env.ADMIN_PASS || '').trim();
      console.log('ℹ️  ADMIN_USER:', _AU ? 'موجود' : 'ناقص', '| ADMIN_PASS:', _AP ? 'موجود (' + _AP.length + ' حرف)' : 'ناقص', '| ADMIN_RESET:', process.env.ADMIN_RESET === '1' ? 'شغال' : 'مقفول', '| أدمن محفوظ:', auth.ADMIN ? 'أيوه' : 'لا');
      if (_AU && _AP && (!auth.ADMIN || process.env.ADMIN_RESET === '1')) {
        auth.ADMIN = { username: _AU, hash: await A.hashPassword(_AP), admin: true, name: 'أدمن المنظومة' };
        await saveAuth(); console.log('✅ اتعمل حساب الأدمن');
      }
      if (process.env.CREDENTIALS_IMPORT) {
        try {
          let n = 0; const _imp = JSON.parse(process.env.CREDENTIALS_IMPORT);
          for (const x of (_imp.list || [])) {
            const sap = String(x.sap || '');
            if (!sap || (auth[sap] && !(_imp.overwrite && auth[sap].hash !== x.hash && !auth[sap].admin)) || !USER_RE.test(String(x.username)) || !/^s1\$/.test(String(x.hash))) continue;
            auth[sap] = { username: x.username, hash: x.hash, mustChange: x.mustChange !== false }; n++;
          }
          if (n) { await saveAuth(); console.log('✅ اتستورد ' + n + ' حساب'); }
        } catch (e) { console.error('CREDENTIALS_IMPORT مش صالح:', e.message); }
      }
      ready = true;
      if (state) BR.autoLocate(state).then(ch => { if (ch.length) { console.log('📍 اتثبّت لوكيشن:', ch.join('، ')); schedule(); broadcast(); } }).catch(() => {});
      console.log(state ? '✅ البيانات اتحمّلت' : 'ℹ️  مفيش بيانات لسه — أول مدير يدخل هيرفعها');
      return;
    } catch (e) {
      console.error(`تحميل البيانات فشل (محاولة ${i}):`, e.message);
      await new Promise(r => setTimeout(r, Math.min(15000, 1000 * i)));
    }
  }
})();

/* ───────────── الصلاحيات ───────────── */
const cls = r => /مساعد/.test(r || '') ? 'ASSISTANTS' : /مسئول|مسؤول/.test(r || '') ? 'MANAGERS' : 'STAFF';
const audOk = (a, c) => !a || a === 'ALL' || a === c || (a === 'MGR_ASSIST' && c !== 'STAFF');
const canSee = (u, aud, scope) => u.mgr || (audOk(aud, u.cls) && (!scope || scope === 'ALL' || scope === 'كل الفروع' || scope === u.branch));

function identity(sap) {
  const a = auth[sap]; if (!a) return null;
  const e = state && (state.employees || []).find(x => String(x.sap) === String(sap));
  const adm = !!(a.admin || (e && e.isAdminDelegate));
  if (e) return { sap: e.sap, name: e.name, cls: cls(e.role), branch: e.branch, mgr: adm, admin: adm };
  return a.admin ? { sap, name: a.name || sap, mgr: true, admin: true } : null;
}
const me = b => { const p = b && b.token && A.verifyToken(b.token, JWT_SECRET); return p ? identity(p.sap) : null; };

function who(q) {
  if (q && q.token) return me(q);
  if (!LEGACY) return null;
  if (!q || q.sync !== SYNC) return null;
  const e = state && (state.employees || []).find(x => String(x.sap) === String(q.sap));
  if (e) return { sap: e.sap, cls: cls(e.role), branch: e.branch, mgr: !!e.isAdminDelegate, admin: !!e.isAdminDelegate };
  if ((q.role === 'admin' || q.role === 'manager') && ADMIN_KEY && q.key === ADMIN_KEY)
    return { sap: q.sap, mgr: true, admin: q.role === 'admin' };
  return null;
}

function sanitizeState(s) {
  if (!s || typeof s !== 'object') return s;
  delete s.syncCode;
  if (Array.isArray(s.employees)) s.employees.forEach(e => { if (e && typeof e === 'object') delete e.password; });
  if (s.settings && typeof s.settings === 'object') {
    delete s.settings.adminPasswords;
    if (Array.isArray(s.settings.managers)) s.settings.managers.forEach(m => { if (m && typeof m === 'object') delete m.password; });
  }
  return s;
}
function view(u) {
  const s = sanitizeState(JSON.parse(JSON.stringify(state)));
  const m = s.meeting || {};
  if (m.active && !canSee(u, m.audience, m.branchScope)) s.meeting = { active: false, audience: 'ALL', branchScope: 'ALL' };
  s.scheduledMeetings = (s.scheduledMeetings || []).filter(x => canSee(u, x.audience, x.scope));
  s.notifications = (s.notifications || []).filter(n => !n.aud || canSee(u, n.aud, n.scope));
  if (!u.admin) delete s.securityLog;
  if (!u.mgr) delete s.fraudAlerts;
  delete s.photoHashes; if (!u.mgr) delete s.opsPlans;
  return s;
}
const viewKey = u => [u.admin ? 1 : 0, u.mgr ? 1 : 0, u.cls || '', u.branch || ''].join('|');

/* ───────────── الكتابة ───────────── */
const MGR_KEYS = ['meeting', 'scheduledMeetings', 'branches'];
const SHIFT_MS = 9 * 3600e3;
const PATCH_KEYS = new Set(['fraudAlerts', 'employees', 'chat', 'notifications', 'meeting', 'scheduledMeetings', 'branches', 'lateOpenings', 'aiMemory', 'userAvatarData']);
const union = (cur, add, keyOf, front) => {
  const seen = new Set(cur.map(keyOf));
  const fresh = add.filter(x => !seen.has(keyOf(x)));
  return (front ? [...fresh, ...cur] : [...cur, ...fresh]).slice(0, 500);
};
function apply(u, patch) {
  if (!Array.isArray(state.employees)) state.employees = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'employees') {
      if (!Array.isArray(v)) continue;
      for (let e of v) {
        if (!e || typeof e !== 'object' || Array.isArray(e) || e.id == null) continue;
        if ('password' in e) { const { password, ...rest } = e; e = rest; }
        const i = state.employees.findIndex(x => x && String(x.id) === String(e.id));
        if (i < 0) { if (u.admin && e.sap != null) state.employees.push(e); continue; }
        const old = state.employees[i];
        if (!(u.mgr || String(old.sap) === String(u.sap))) continue;
        let acceptedIn = false;
        if (!u.mgr && e.status === 'PRESENT' && old.status !== 'PRESENT') {
          const rk = riskMem[u.sap];
          if (rk && rk.okUntil > Date.now()) { rk.okUntil = 0; rk.outN = 0; acceptedIn = true; }
          else { e = { ...e, status: old.status, checkInTime: old.checkInTime, geoVerified: old.geoVerified }; }
        }
        if (!u.mgr && old.status === 'PRESENT' && e.status !== 'PRESENT' && old.checkInAt && Date.now() - old.checkInAt < SHIFT_MS)
          e = { ...e, status: old.status, checkInTime: old.checkInTime };
        const keep = u.admin ? { password: old.password, id: old.id } : { password: old.password, id: old.id, role: old.role, branch: old.branch, isAdminDelegate: old.isAdminDelegate, sap: old.sap };
        const own = u.mgr ? {} : { inBranch: old.inBranch, exitLog: old.exitLog, checkInAt: old.checkInAt };
        state.employees[i] = { ...old, ...e, ...keep, ...own };
        if (!u.mgr && old.status === 'PRESENT' && state.employees[i].status !== 'PRESENT') Object.assign(state.employees[i], { inBranch: false, checkInAt: null });
        if (acceptedIn) Object.assign(state.employees[i], { inBranch: true, checkInAt: Date.now(), exitLog: old.exitLog || [] });
      }
    } else if (k === 'chat') { if (Array.isArray(v)) state.chat = union(state.chat || [], v.filter(x => x && typeof x === 'object'), x => x.sender + '|' + x.text + '|' + x.time, false); }
    else if (k === 'notifications') { if (Array.isArray(v)) state.notifications = union(state.notifications || [], v.filter(x => x && typeof x === 'object' && x.id != null), x => x.id, true); }
    else if (MGR_KEYS.includes(k)) { if (u.mgr && v && typeof v === 'object') state[k] = v; }
    else if (!PATCH_KEYS.has(k)) { continue; }
    else if (k === 'fraudAlerts') {
      if (u.mgr && Array.isArray(v)) { const cur = state.fraudAlerts || [], by = new Map(cur.map(a => [a.id, a]));
        for (const a of v) { const o = a && by.get(a.id); if (o && a.ack === true) o.ack = true; }
        state.fraudAlerts = cur; }
    }
    else if (k === 'lateOpenings') { if (Array.isArray(v)) state[k] = v; }
    else if (k === 'aiMemory') { if (v && typeof v === 'object' && !Array.isArray(v)) state[k] = v; }
    else if (k === 'userAvatarData') { if (typeof v === 'string' && v.length <= 2e6) state[k] = v; }
  }
}

/* ───────────── البث اللحظي (SSE) ───────────── */
const clients = new Set();
let bcastT = null;
function broadcast() {
  if (bcastT) return;
  bcastT = setTimeout(() => {
    bcastT = null;
    if (!state) return;
    const cache = new Map();
    for (const c of clients) {
      try {
        const u = who(c.q); if (!u) continue;
        const k = viewKey(u);
        let msg = cache.get(k);
        if (!msg) { msg = `event: state\ndata: ${JSON.stringify(view(u))}\n\n`; cache.set(k, msg); }
        if (c.res.writableLength > 5e6) { c.res.destroy(); clients.delete(c); continue; }
        c.res.write(msg);
      } catch (e) { clients.delete(c); }
    }
  }, 60);
}
setInterval(() => {
  for (const c of clients) { try { c.res.write(': hb\n\n'); } catch { clients.delete(c); } }
}, 25000).unref();

/* ───────────── الملفات الثابتة (مع gzip وكاش في الذاكرة) ───────────── */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const COMPRESSIBLE = new Set(['.html', '.js', '.json', '.svg']);
const fileCache = new Map();
function getFile(rel) {
  if (!NESTED_PUB && !PUBLIC_FILES.has(String(rel).replace(/^\/+/, ''))) return null;
  const f = path.normalize(path.join(PUB, rel));
  if (f !== PUB && !f.startsWith(PUB + path.sep)) return null;
  let hit = fileCache.get(f);
  try {
    const st = fs.statSync(f);
    if (!st.isFile()) return null;
    if (!hit || hit.mtime !== st.mtimeMs) {
      const buf = fs.readFileSync(f), ext = path.extname(f).toLowerCase();
      hit = { mtime: st.mtimeMs, buf, gz: COMPRESSIBLE.has(ext) && buf.length > 1024 ? zlib.gzipSync(buf, { level: 6 }) : null, type: MIME[ext] || 'application/octet-stream', ext };
      fileCache.set(f, hit);
    }
    return hit;
  } catch { return null; }
}

const cors = {
  'Access-Control-Allow-Origin': process.env.ALLOW_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};
const json = (res, code, obj) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

/* ───────────── الدخول وإدارة المستخدمين ───────────── */
const riskMem = {};
const rl = new Map();
const ipOf = req => String((process.env.TRUST_PROXY === '1' && req.headers['x-real-ip']) || req.socket.remoteAddress || 'unknown').slice(0, 80);
const limited = ip => { const r = rl.get(ip); return !!r && Date.now() - r.t < 9e5 && r.n >= 10; };
const failed = ip => { const r = rl.get(ip); if (!r || Date.now() - r.t >= 9e5) rl.set(ip, { n: 1, t: Date.now() }); else r.n++; };
setInterval(() => { const n = Date.now(); for (const [k, v] of rl) if (n - v.t > 9e5) rl.delete(k); }, 6e5).unref();

function readJson(req, res, cb) {
  let body = '', dead = false;
  req.on('data', d => { body += d; if (body.length > 2e6 && !dead) { dead = true; json(res, 413, { error: 'too large' }); req.destroy(); } });
  req.on('error', () => {});
  req.on('end', async () => {
    if (dead) return;
    let b; try { b = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
    try { await cb(b); } catch (e) { console.error('api error:', e); if (!res.headersSent) json(res, 500, { error: 'server error' }); }
  });
}

function route(p, req, res) {
  if (!ready) return json(res, 503, { error: 'loading' });
  return readJson(req, res, async b => {
    if (p === '/api/login') {
      const ip = ipOf(req);
      if (limited(ip)) return json(res, 429, { error: 'محاولات كتير — جرّب بعد شوية' });
      const id = String(b.username || '').trim().toLowerCase();
      const password = String(b.password || '').trim();
      if (!id || id.length > 80 || !password || password.length > 256) return json(res, 400, { error: 'بيانات الدخول غير صالحة' });
      const sap = Object.keys(auth).find(k => k.toLowerCase() === id || String(auth[k].username).toLowerCase() === id);
      const ok = await A.verifyPassword(password, sap ? auth[sap].hash : 's1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      const u = ok && sap ? identity(sap) : null;
      if (!u) { failed(ip); return json(res, 401, { error: 'اسم المستخدم أو الكود غير صحيح' }); }
      rl.delete(ip);
      return json(res, 200, { token: A.signToken({ sap: String(u.sap) }, JWT_SECRET), user: u, mustChange: !!auth[sap].mustChange });
    }

    if (p === '/api/admin/import-credentials') {
      const u = me(b);
      if (!(u && u.admin) && !(ADMIN_KEY && b.key === ADMIN_KEY)) return json(res, 403, { error: 'denied' });
      let n = 0, skipped = [];
      for (const x of Array.isArray(b.list) ? b.list : []) {
        const sap = String(x.sap || '');
        if (!sap || !USER_RE.test(String(x.username)) || !/^s1\$/.test(String(x.hash)) || (auth[sap] && !b.overwrite) || nameTaken(x.username, sap)) { skipped.push(sap); continue; }
        auth[sap] = { username: x.username, hash: x.hash, mustChange: x.mustChange !== false, ...(auth[sap] && auth[sap].admin ? { admin: true } : {}) }; n++;
      }
      await saveAuth();
      return json(res, 200, { imported: n, skipped });
    }

    const u = me(b);
    if (!u) return json(res, 401, { error: 'سجّل دخول الأول' });
    if (auth[u.sap] && auth[u.sap].mustChange && p !== '/api/me/credentials')
      return json(res, 403, { error: 'لازم تغيّر كلمة المرور المؤقتة قبل استخدام النظام' });

    if (p === '/api/me/credentials') {
      const a = auth[u.sap];
      if (!(await A.verifyPassword(String(b.oldPassword || ''), a.hash))) return json(res, 403, { error: 'الكود الحالي غير صحيح' });
      if (b.newUsername) {
        const nu = String(b.newUsername).trim();
        if (!USER_RE.test(nu)) return json(res, 400, { error: 'اسم المستخدم 3-40 حرف إنجليزي/أرقام/. _ - @' });
        if (nameTaken(nu, u.sap)) return json(res, 409, { error: 'اسم المستخدم مستخدم' });
        a.username = nu;
        const e = (state.employees || []).find(x => String(x.sap) === String(u.sap)); if (e) { e.username = nu; schedule(); broadcast(); }
      }
      if (b.newPassword) {
        if (String(b.newPassword).length < 8) return json(res, 400, { error: 'الكود الجديد 8 حروف على الأقل' });
        a.hash = await A.hashPassword(String(b.newPassword)); a.mustChange = false;
      }
      await saveAuth();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/attendance/event') {
      const e = (state.employees || []).find(x => String(x.sap) === String(u.sap));
      if (!e) return json(res, 404, { error: 'مفيش موظف بالحساب ده' });
      const lat = Number(b.lat), lng = Number(b.lng), acc = Number(b.acc) || 0;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json(res, 400, { error: 'إحداثيات غير صالحة' });
      const br = (state.branches || []).find(x => x.name === e.branch);
      const [blat, blng] = String(br && br.coords || '').split(',').map(parseFloat);
      if (!Number.isFinite(blat) || !Number.isFinite(blng)) return json(res, 422, { error: 'إحداثيات الفرع غير مضبوطة' });
      const serverT = Date.now(), rk = (riskMem[u.sap] ||= { suspicion: null, last: null, devices: new Set(), minutes: [], at: 0 });
      if (serverT - rk.at < 2000) return json(res, 429, { error: 'بسرعة جدًا' });
      rk.at = serverT;
      const radius = Number(br.radiusMeters || e.geofenceRadius || 150);
      const dist = Math.round(G.haversine({ lat, lng }, { lat: blat, lng: blng }));
      const d = new Date(serverT), minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
      const r = RK.assess({ lat, lng, acc, t: Number(b.deviceTime) || 0, serverT, mock: !!b.mock, rooted: !!b.rooted, devOptions: !!b.devOptions,
        integrityOk: b.integrityOk, deviceId: b.deviceId ? String(b.deviceId).slice(0, 64) : null, minuteOfDay },
        { last: rk.last, history: { minutes: rk.minutes }, deviceIds: rk.devices, suspicion: rk.suspicion });
      rk.suspicion = r.suspicion; rk.last = { lat, lng, acc, t: serverT };
      if (b.deviceId) rk.devices.add(String(b.deviceId).slice(0, 64));
      if (dist <= radius) rk.minutes = [minuteOfDay, ...rk.minutes].slice(0, 60);
      const inside = dist <= radius;
      rk.okUntil = inside ? serverT + 180000 : 0;
      state.securityLog = [{ t: serverT, sap: String(u.sap), name: e.name, branch: e.branch, inside, dist, radius, acc, level: r.level, trust: r.trust, reasons: r.reasons },
        ...(state.securityLog || [])].slice(0, 1000);
      schedule(); if (r.level !== 'LOW') broadcast();
      return json(res, 200, { inside, dist, radius, serverTime: serverT, risk: { level: r.level, trust: r.trust } });
    }

    if (p === '/api/attendance/presence') {
      const e = (state.employees || []).find(x => String(x.sap) === String(u.sap));
      if (!e) return json(res, 404, { error: 'مفيش موظف بالحساب ده' });
      if (e.status !== 'PRESENT') return json(res, 200, { active: false });
      const lat = Number(b.lat), lng = Number(b.lng), acc = Math.max(0, Number(b.acc) || 0);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json(res, 400, { error: 'إحداثيات غير صالحة' });
      const br = (state.branches || []).find(x => x.name === e.branch), [blat, blng] = String(br && br.coords || '').split(',').map(parseFloat);
      if (!Number.isFinite(blat) || !Number.isFinite(blng)) return json(res, 422, { error: 'إحداثيات الفرع غير مضبوطة' });
      const now = Date.now(), rk = (riskMem[u.sap] ||= { suspicion: null, last: null, devices: new Set(), minutes: [], at: 0 });
      if (now - (rk.pAt || 0) < 5000) return json(res, 429, { error: 'بسرعة جدًا' });
      rk.pAt = now;
      const radius = Number(br.radiusMeters || e.geofenceRadius || 150), dist = Math.round(G.haversine({ lat, lng }, { lat: blat, lng: blng }));
      const outside = dist - Math.min(acc, 50) > radius;
      const time = new Date(now).toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const day = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
      const note = (title, body, severity) => { state.notifications = [{ id: 'n_' + now + '_' + Math.random().toString(36).slice(2, 6), title, body, severity, time, read: false, aud: 'MGR_ASSIST', scope: e.branch }, ...(state.notifications || [])].slice(0, 500); };
      if (!outside) {
        rk.outN = 0;
        if (e.inBranch === false) {
          e.inBranch = true; const o = (e.exitLog || [])[0]; if (o && !o.back) { o.back = time; o.backT = now; }
          note('↩️ عودة للفرع', `${e.name} رجع داخل نطاق فرع ${e.branch}${o && o.t ? ` بعد ${Math.max(1, Math.round((now - o.t) / 60000))} دقيقة` : ''}.`, 'INFO');
          schedule(); broadcast();
        }
      } else {
        rk.outN = (rk.outN || 0) + 1;
        if (rk.outN >= (acc <= 30 ? 1 : 2) && e.inBranch !== false) {
          const worked = e.checkInAt ? now - e.checkInAt : null, left = worked == null ? null : Math.max(0, SHIFT_MS - worked), early = left != null && left > 0;
          const leftTxt = early ? ` — فاضل ${Math.floor(left / 3600e3)} س و${Math.floor((left % 3600e3) / 60000)} د على نهاية الـ9 ساعات` : '';
          e.inBranch = false; e.exitLog = [{ day, time, dist, t: now, early }, ...(e.exitLog || [])].slice(0, 50);
          note('🚪 موظف خرج من الفرع', `${e.name} خرج من نطاق فرع ${e.branch} (${dist}م) الساعة ${time}${leftTxt}`, 'URGENT');
          state.fraudAlerts = [{ id: 'fa_' + now + '_' + Math.random().toString(36).slice(2, 6), empId: e.id, empName: e.name, branch: e.branch, type: 'out_range', sev: 'high',
            title: early ? 'خرج من الفرع قبل اكتمال 9 ساعات' : 'خرج من نطاق الفرع', detail: `${dist}م من الفرع${leftTxt}`, t: now, time, ack: false }, ...(state.fraudAlerts || [])].slice(0, 150);
          state.securityLog = [{ t: now, sap: String(u.sap), name: e.name, branch: e.branch, inside: false, dist, radius, acc, level: early ? 'HIGH' : 'MEDIUM', trust: RK.trustScore(rk.suspicion == null ? 0.02 : rk.suspicion), reasons: [early ? 'خروج قبل اكتمال الشيفت' : 'خروج من النطاق'] }, ...(state.securityLog || [])].slice(0, 1000);
          schedule(); broadcast();
        }
      }
      return json(res, 200, { inside: !outside, dist });
    }

    if (p.startsWith('/api/ops/')) { const r = await OPS.handle(p, u, b, state); if (r.dirty) { schedule(); broadcast(); } return json(res, r.code, r.body); }

    if (!u.admin) return json(res, 403, { error: 'للأدمن فقط' });

    if (p === '/api/admin/users') {
      const sap = String(b.sap || '').trim(), name = String(b.name || '').trim(), pw = String(b.password || '');
      if (!sap || !/^[A-Za-z0-9_-]{3,32}$/.test(sap) || !name || !b.branch || !b.role) return json(res, 400, { error: 'الاسم وSAP صالح والفرع والدور مطلوبين' });
      if (!(state.branches || []).some(x => x && x.name === b.branch)) return json(res, 422, { error: 'الفرع المحدد غير موجود في بيانات النظام' });
      if (!USER_RE.test(String(b.username))) return json(res, 400, { error: 'اسم المستخدم غير صالح' });
      if (pw.length < 8) return json(res, 400, { error: 'الكود 8 حروف على الأقل' });
      if (auth[sap] || (state.employees || []).some(x => String(x.sap) === sap)) return json(res, 409, { error: 'الـSAP موجود' });
      if (nameTaken(b.username, sap)) return json(res, 409, { error: 'اسم المستخدم مستخدم' });
      state.employees.push({ id: 'emp_' + sap + '_' + Date.now().toString(36), name, englishName: b.englishName || '', username: b.username, sap, branch: b.branch,
        branchCode: b.branchCode || '', subArea: b.subArea || '', role: b.role, status: 'ABSENT', inBranch: false, monthlyAbsence: 0, checkInTime: null,
        leaveType: 'لا يوجد (دوام/متابعة)', leaveLog: [], transferHistory: [], history: [], geofenceRadius: 150, geoVerified: false, biometricVerified: false,
        isAdminDelegate: false, shift: 'DAY' });
      auth[sap] = { username: b.username, hash: await A.hashPassword(pw), mustChange: true };
      await saveAuth(); schedule(); broadcast();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/branch-locate') {
      if (!state) return json(res, 409, { error: 'مفيش بيانات لسه' });
      const r = await BR.locate(state, b); if (r.dirty) { schedule(); broadcast(); } return json(res, r.code, r.body);
    }
    if (p === '/api/admin/branch-autolocate') {
      if (!state) return json(res, 409, { error: 'مفيش بيانات لسه' });
      const ch = await BR.autoLocate(state); if (ch.length) { schedule(); broadcast(); } return json(res, 200, { updated: ch });
    }

    if (p === '/api/admin/reset') {
      const sap = String(b.sap || '');
      if (!auth[sap]) return json(res, 404, { error: 'مفيش حساب بالـSAP ده' });
      const code = b.password ? String(b.password) : A.randomCode(8);
      if (code.length < 8) return json(res, 400, { error: 'الكود 8 حروف على الأقل' });
      auth[sap].hash = await A.hashPassword(code); auth[sap].mustChange = true;
      await saveAuth();
      return json(res, 200, { ok: true, code });
    }
    return json(res, 404, { error: 'not found' });
  });
}

/* ───────────── Optical Decision + Math/AI Load & Fault Guard ───────────── */
const opticalNodes = new Map([
  ['sfu-cairo-1', { id: 'sfu-cairo-1', region: 'eg-cai', capacity: 8000, activeLoad: 0, latencyMs: 18, lossRate: 0.002, healthy: true, ewmaLoad: 0, ewmaLatency: 18, lastSeen: Date.now() }],
  ['sfu-alex-1',  { id: 'sfu-alex-1',  region: 'eg-aly', capacity: 7000, activeLoad: 0, latencyMs: 24, lossRate: 0.004, healthy: true, ewmaLoad: 0, ewmaLatency: 24, lastSeen: Date.now() }],
  ['sfu-edge-2',  { id: 'sfu-edge-2',  region: 'eu-edge', capacity: 10000, activeLoad: 0, latencyMs: 36, lossRate: 0.003, healthy: true, ewmaLoad: 0, ewmaLatency: 36, lastSeen: Date.now() }],
]);

const voiceRooms = new Map();
const telemetryWindow = [];
const ALPHA = 0.35;

function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }

function scoreOpticalNode(n, preferredRegion) {
  if (!n || !n.healthy) return Number.POSITIVE_INFINITY;
  const util = clamp01(n.ewmaLoad);
  const latNorm = clamp01(n.ewmaLatency / 250);
  const lossNorm = clamp01(n.lossRate / 0.05);
  const regionPenalty = preferredRegion && n.region !== preferredRegion ? 0.12 : 0;
  const overloadPenalty = util > 0.8 ? Math.pow((util - 0.8) * 5, 2) : 0;
  return (0.45 * util) + (0.30 * latNorm) + (0.15 * lossNorm) + regionPenalty + overloadPenalty + (0.10 * clamp01(n.activeLoad / Math.max(1, n.capacity)));
}

function selectOpticalRoute(preferredRegion = 'eg-cai') {
  let best = null, bestScore = Number.POSITIVE_INFINITY;
  const ranked = [];
  for (const n of opticalNodes.values()) {
    const score = scoreOpticalNode(n, preferredRegion);
    ranked.push({ id: n.id, region: n.region, healthy: n.healthy, util: Number(n.ewmaLoad.toFixed(3)), latencyMs: Math.round(n.ewmaLatency), lossRate: n.lossRate, score: Number.isFinite(score) ? Number(score.toFixed(4)) : null });
    if (score < bestScore) { bestScore = score; best = n; }
  }
  ranked.sort((a, b) => (a.score ?? 1e9) - (b.score ?? 1e9));
  return { primary: best, ranked };
}

function recordAiTelemetry(sample) {
  const now = Date.now();
  const n = opticalNodes.get(sample.nodeId);
  if (!n) return null;

  const load = clamp01(sample.loadRatio ?? (n.activeLoad / Math.max(1, n.capacity)));
  const latency = Math.max(1, Number(sample.latencyMs ?? n.latencyMs) || n.latencyMs);
  const loss = clamp01(sample.lossRate ?? n.lossRate);

  n.activeLoad = Math.max(0, Math.min(n.capacity * 1.2, Math.round(sample.activeLoad ?? n.activeLoad)));
  n.latencyMs = latency;
  n.lossRate = loss;
  n.lastSeen = now;

  n.ewmaLoad = (ALPHA * load) + ((1 - ALPHA) * n.ewmaLoad);
  n.ewmaLatency = (ALPHA * latency) + ((1 - ALPHA) * n.ewmaLatency);

  const predictedLoad = clamp01(n.ewmaLoad + (load - n.ewmaLoad) * 0.5);
  const riskScore = Number(clamp01((predictedLoad * 0.5) + (clamp01(n.ewmaLatency / 220) * 0.3) + (clamp01(loss / 0.03) * 0.2)).toFixed(3));

  if (riskScore >= 0.85 || loss >= 0.04) {
    n.healthy = false;
  } else if (riskScore < 0.72) {
    n.healthy = true;
  }

  telemetryWindow.push({ t: now, nodeId: n.id, loadRatio: Number(load.toFixed(3)), latencyMs: latency, lossRate: loss, riskScore });
  if (telemetryWindow.length > 1000) telemetryWindow.splice(0, telemetryWindow.length - 1000);

  if (!n.healthy) {
    const { primary } = selectOpticalRoute(n.region);
    if (primary && primary.id !== n.id) {
      for (const room of voiceRooms.values()) {
        if (room.nodeId === n.id) {
          room.nodeId = primary.id;
          room.state = 'FAILOVER';
        }
      }
    }
  }

  return { nodeId: n.id, healthy: n.healthy, riskScore, predictedLoad: Number(predictedLoad.toFixed(3)) };
}

function serializeRoom(room) {
  return {
    id: room.id,
    title: room.title,
    createdBy: room.createdBy,
    createdAt: room.createdAt,
    nodeId: room.nodeId,
    state: room.state,
    speakers: Array.from(room.speakers),
    raisedHands: Array.from(room.raisedHands),
    listenersCount: room.listenersCount,
    totalParticipants: room.speakers.size + room.listenersCount,
  };
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const n of opticalNodes.values()) {
    if (n.healthy && now - n.lastSeen > 45000 && n.activeLoad > 0) {
      n.healthy = false;
      changed = true;
    }
  }
  if (changed) {
    for (const room of voiceRooms.values()) {
      const cur = opticalNodes.get(room.nodeId);
      if (!cur || !cur.healthy) {
        const { primary } = selectOpticalRoute();
        if (primary) { room.nodeId = primary.id; room.state = 'FAILOVER'; }
      }
    }
  }
}, 15000).unref();

function handleVoiceAndOptical(pathname, req, res) {
  if (pathname === '/api/ops/optical-status' && req.method === 'GET') {
    const u = who(Object.fromEntries(new URL(req.url, 'http://x').searchParams));
    if (!u) return json(res, 401, { error: 'سجّل دخول الأول' });
    const { primary, ranked } = selectOpticalRoute();
    const recent = telemetryWindow.slice(-25);
    const avgRisk = recent.length ? Number((recent.reduce((s, x) => s + x.riskScore, 0) / recent.length).toFixed(3)) : 0;
    return json(res, 200, {
      ok: true,
      recommendedNode: primary ? primary.id : null,
      avgRisk,
      nodes: ranked,
      roomsCount: voiceRooms.size,
      activeSseClients: clients.size,
      recentTelemetry: recent,
    });
  }

  if (pathname === '/api/ops/telemetry' && req.method === 'POST') {
    return readJson(req, res, async b => {
      const u = me(b);
      if (!u || !u.mgr) return json(res, 403, { error: 'للإدارة فقط' });
      const resAi = recordAiTelemetry(b);
      if (!resAi) return json(res, 404, { error: 'عقدة غير موجودة' });
      const { primary, ranked } = selectOpticalRoute();
      return json(res, 200, { ok: true, telemetry: resAi, recommendedNode: primary ? primary.id : null, nodes: ranked });
    });
  }

  if (pathname === '/api/voice/rooms' && req.method === 'GET') {
    const u = who(Object.fromEntries(new URL(req.url, 'http://x').searchParams));
    if (!u) return json(res, 401, { error: 'سجّل دخول الأول' });
    return json(res, 200, { ok: true, rooms: Array.from(voiceRooms.values()).map(serializeRoom) });
  }

  if (pathname === '/api/voice/room' && req.method === 'POST') {
    return readJson(req, res, async b => {
      const u = me(b);
      if (!u) return json(res, 401, { error: 'سجّل دخول الأول' });
      const action = String(b.action || 'join');
      const preferredRegion = String(b.region || 'eg-cai');

      if (action === 'create') {
        const title = String(b.title || '').trim().slice(0, 100) || `غرفة ${u.name || u.sap}`;
        const { primary } = selectOpticalRoute(preferredRegion);
        if (!primary) return json(res, 503, { error: 'لا توجد عقدة SFU متاحة حالياً' });
        const id = 'room_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const room = {
          id,
          title,
          createdBy: String(u.sap),
          createdAt: Date.now(),
          nodeId: primary.id,
          speakers: new Set([String(u.sap)]),
          raisedHands: new Set(),
          listenersCount: 0,
          state: 'LIVE',
        };
        voiceRooms.set(id, room);
        primary.activeLoad += 1;
        recordAiTelemetry({ nodeId: primary.id, activeLoad: primary.activeLoad });
        return json(res, 200, { ok: true, room: serializeRoom(room), sfuNode: primary.id });
      }

      const room = voiceRooms.get(String(b.roomId || ''));
      if (!room) return json(res, 404, { error: 'الغرفة غير موجودة' });
      const sap = String(u.sap);

      if (action === 'join') {
        if (!room.speakers.has(sap)) room.listenersCount += 1;
        const n = opticalNodes.get(room.nodeId);
        if (n) { n.activeLoad += 1; recordAiTelemetry({ nodeId: n.id, activeLoad: n.activeLoad }); }
      } else if (action === 'leave') {
        if (room.speakers.has(sap)) room.speakers.delete(sap);
        else if (room.listenersCount > 0) room.listenersCount -= 1;
        room.raisedHands.delete(sap);
        const n = opticalNodes.get(room.nodeId);
        if (n && n.activeLoad > 0) { n.activeLoad -= 1; recordAiTelemetry({ nodeId: n.id, activeLoad: n.activeLoad }); }
      } else if (action === 'raise-hand') {
        room.raisedHands.add(sap);
      } else if (action === 'promote-speaker') {
        if (!u.mgr && room.createdBy !== sap) return json(res, 403, { error: 'صلاحية إدارة الغرفة مطلوبة' });
        const target = String(b.targetSap || sap);
        if (room.speakers.size >= 16) return json(res, 409, { error: 'اكتمل حد المتحدثين في الغرفة' });
        room.raisedHands.delete(target);
        room.speakers.add(target);
        if (room.listenersCount > 0) room.listenersCount -= 1;
      } else if (action === 'demote-listener') {
        if (!u.mgr && room.createdBy !== sap) return json(res, 403, { error: 'صلاحية إدارة الغرفة مطلوبة' });
        const target = String(b.targetSap || sap);
        if (room.speakers.delete(target)) room.listenersCount += 1;
      } else if (action === 'close') {
        if (!u.mgr && room.createdBy !== sap) return json(res, 403, { error: 'صلاحية إغلاق الغرفة مطلوبة' });
        const n = opticalNodes.get(room.nodeId);
        const total = room.speakers.size + room.listenersCount;
        if (n) { n.activeLoad = Math.max(0, n.activeLoad - total); recordAiTelemetry({ nodeId: n.id, activeLoad: n.activeLoad }); }
        voiceRooms.delete(room.id);
        return json(res, 200, { ok: true, closed: room.id });
      } else {
        return json(res, 400, { error: 'إجراء غير معروف' });
      }

      const { primary } = selectOpticalRoute();
      return json(res, 200, { ok: true, room: serializeRoom(room), recommendedNode: primary ? primary.id : room.nodeId });
    });
  }

  return null;
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(ready ? 'ok' : 'loading'); }

    const voiceHandled = handleVoiceAndOptical(url.pathname, req, res);
    if (voiceHandled) return voiceHandled;

    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/stream' && url.pathname !== '/api/state' && req.method === 'POST')
      return route(url.pathname, req, res);

    if (url.pathname === '/api/stream') {
      if (!ready) return json(res, 503, { error: 'loading' });
      const q = Object.fromEntries(url.searchParams), u = who(q);
      if (!u || (auth[u.sap] && auth[u.sap].mustChange)) { res.writeHead(403, cors); return res.end('denied'); }
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      req.socket.setTimeout(0); req.socket.setKeepAlive(true);
      const c = { res, q };
      clients.add(c);
      const drop = () => clients.delete(c);
      req.on('close', drop); res.on('error', drop);
      res.write(state ? `event: state\ndata: ${JSON.stringify(view(u))}\n\n` : 'event: empty\ndata: {}\n\n');
      return;
    }

    if (url.pathname === '/api/state' && req.method === 'POST') {
      if (!ready) return json(res, 503, { error: 'loading' });
      let body = '', size = 0, aborted = false;
      req.on('data', d => {
        size += d.length;
        if (size > MAX_BODY) { aborted = true; json(res, 413, { error: 'too large' }); req.destroy(); return; }
        body += d;
      });
      req.on('error', () => {});
      return req.on('end', () => {
        if (aborted) return;
        try {
          let b; try { b = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
          const u = who(b.q); if (!u) { res.writeHead(403, cors); return res.end(); }
          if (auth[u.sap] && auth[u.sap].mustChange) return json(res, 403, { error: 'غيّر كلمة المرور المؤقتة أولاً' });
          if (!state && b.full && u.mgr && typeof b.full === 'object' && !Array.isArray(b.full)) { state = sanitizeState(b.full); BR.autoLocate(state, { network: false }); }
          else if (state) apply(u, b.patch);
          if (state) { schedule(); broadcast(); }
          json(res, 200, { ok: true, view: state ? view(u) : null });
        } catch (e) { console.error('POST /api/state:', e); if (!res.headersSent) json(res, 500, { error: 'server error' }); }
      });
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    const f = getFile(rel === '/' ? 'index.html' : rel);
    if (!f) { res.writeHead(404); return res.end('not found'); }
    const h = { 'Content-Type': f.type, 'Cache-Control': f.ext === '.html' || rel === '/sw.js' ? 'no-cache' : 'public, max-age=3600', Vary: 'Accept-Encoding' };
    if (f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); return res.end(f.gz); }
    res.writeHead(200, h); res.end(f.buf);
  } catch (e) {
    console.error('request error:', e);
    try { if (!res.headersSent) res.writeHead(500); res.end(); } catch {}
  }
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 0;
server.listen(PORT, '0.0.0.0', () => console.log('🚀 BIM server on :' + PORT));

/* إغلاق نضيف: نحفظ آخر تعديلات قبل ما Railway يوقف السيرفر */
let closing = false;
async function shutdown(sig) {
  if (closing) return; closing = true;
  console.log(sig + ' — بحفظ البيانات وبقفل...');
  try { dirty = true; if (saveT) clearTimeout(saveT); for (let i = 0; i < 20 && saving; i++) await new Promise(r => setTimeout(r, 100)); await flush(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
