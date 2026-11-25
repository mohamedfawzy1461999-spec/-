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
const SYNC = process.env.SYNC_CODE || ''; // لا يوجد كود مزامنة افتراضي
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUB = path.join(__dirname, 'public');
const MAX_BODY = 15e6;
const A = require('./auth');
const G = require('./engine/geo'), RK = require('./engine/risk'), OPS = require('./engine/ops-api'), BR = require('./engine/branches');
const crypto = require('crypto');
const LEGACY = process.env.ALLOW_LEGACY === '1';   // legacy login disabled unless explicitly enabled
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

let auth = {};   // sap -> { username, hash, admin?, name?, mustChange? } — منفصل عن الحالة، العميل مايقدرش يكتب فيه
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
let ready = false;      // مفيش كتابة ولا قراءة للحالة قبل ما التحميل يخلص (عشان ما نمسحش بيانات بالغلط)
let dirty = false, saving = false, saveT = null;

function readFileState() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; }
}

async function loadState() {
  if (pool) {
    await pool.query('create table if not exists bim_state (id int primary key, data jsonb not null, updated_at timestamptz not null default now())');
    const r = await pool.query('select data from bim_state where id = 1');
    if (r.rows[0]) return r.rows[0].data;
    const f = readFileState();           // أول مرة بعد التحويل لـPostgres: لو في ملف قديم ننقله
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
    dirty = true;                        // نحاول تاني
    console.error('save failed (هنعيد المحاولة):', e.message);
    setTimeout(flush, 3000);
  } finally {
    saving = false;
    if (dirty && !saveT) schedule();
  }
}
function schedule() {                    // تجميع الكتابات: كتابة واحدة كل ~700ms مهما كان عدد التعديلات
  dirty = true;
  if (saveT) return;
  saveT = setTimeout(() => { saveT = null; flush(); }, 700);
}

(async function boot() {
  for (let i = 1; ; i++) {
    try {
      state = sanitizeState(await loadState());
      auth = await loadAuth();
      if (process.env.ADMIN_USER && process.env.ADMIN_PASS && !auth.ADMIN) {
        auth.ADMIN = { username: process.env.ADMIN_USER, hash: await A.hashPassword(process.env.ADMIN_PASS), admin: true, name: 'أدمن المنظومة' };
        await saveAuth(); console.log('✅ اتعمل حساب الأدمن');
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
  if (!u.admin) delete s.securityLog;          // سجل الأمان للأدمن فقط
  if (!u.mgr) delete s.fraudAlerts;            // إنذارات الخروج والتلاعب للإدارة فقط
  delete s.photoHashes; if (!u.mgr) delete s.opsPlans; // بصمات الصور وخطط الجدولة للإدارة فقط
  return s;
}
const viewKey = u => [u.admin ? 1 : 0, u.mgr ? 1 : 0, u.cls || '', u.branch || ''].join('|');

/* ───────────── الكتابة ───────────── */
const MGR_KEYS = ['meeting', 'scheduledMeetings', 'branches'];
// لا تسمح بإنشاء مفاتيح حالة عشوائية من طلبات العملاء. المفاتيح الحساسة
// (syncCode وsecurityLog) تظل مملوكة للسيرفر فقط.
const SHIFT_MS = 9 * 3600e3;   // الشيفت 9 ساعات: مفيش انصراف قبلها غير بإذن الأدمن
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
        if (!u.mgr && e.status === 'PRESENT' && old.status !== 'PRESENT') {   // تسجيل حضور: لازم حدث سيرفر ناجح داخل النطاق في آخر 3 دقايق
          const rk = riskMem[u.sap];
          if (rk && rk.okUntil > Date.now()) { rk.okUntil = 0; rk.outN = 0; acceptedIn = true; }   // البوابة تُستخدم مرة واحدة
          else { e = { ...e, status: old.status, checkInTime: old.checkInTime, geoVerified: old.geoVerified }; }
        }
        if (!u.mgr && old.status === 'PRESENT' && e.status !== 'PRESENT' && old.checkInAt && Date.now() - old.checkInAt < SHIFT_MS)
          e = { ...e, status: old.status, checkInTime: old.checkInTime };      // انصراف قبل 9 ساعات: مرفوض (الأدمن بس يقدر يفرج)
        const keep = u.admin ? { password: old.password, id: old.id } : { password: old.password, id: old.id, role: old.role, branch: old.branch, isAdminDelegate: old.isAdminDelegate, sap: old.sap };
        const own = u.mgr ? {} : { inBranch: old.inBranch, exitLog: old.exitLog, checkInAt: old.checkInAt };   // حقول بيملكها السيرفر
        state.employees[i] = { ...old, ...e, ...keep, ...own };
        if (!u.mgr && old.status === 'PRESENT' && state.employees[i].status !== 'PRESENT') Object.assign(state.employees[i], { inBranch: false, checkInAt: null });   // انصراف مقبول
        if (acceptedIn) Object.assign(state.employees[i], { inBranch: true, checkInAt: Date.now(), exitLog: old.exitLog || [] });
      }
    } else if (k === 'chat') { if (Array.isArray(v)) state.chat = union(state.chat || [], v.filter(x => x && typeof x === 'object'), x => x.sender + '|' + x.text + '|' + x.time, false); }
    else if (k === 'notifications') { if (Array.isArray(v)) state.notifications = union(state.notifications || [], v.filter(x => x && typeof x === 'object' && x.id != null), x => x.id, true); }
    else if (MGR_KEYS.includes(k)) { if (u.mgr && v && typeof v === 'object') state[k] = v; }
    else if (!PATCH_KEYS.has(k)) { continue; }
    else if (k === 'fraudAlerts') {              // الأدمن بس: يأكّد الاطلاع (ack) — الإنذارات الجديدة بيعملها السيرفر
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
function broadcast() {                   // تجميع: لو جت 10 تعديلات ورا بعض يتبعتوا مرة واحدة
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
const riskMem = {};   // sap -> حالة المخاطر في الذاكرة (بتتصفّر مع إعادة التشغيل؛ السجل نفسه محفوظ في state.securityLog)
const rl = new Map();
const geminiRate = new Map(); // حد بسيط يحمي مفتاح Gemini من الطلبات المتكررة
setInterval(() => { const now = Date.now(); for (const [k, v] of geminiRate) if (v.reset <= now) geminiRate.delete(k); }, 60000).unref();
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
      const password = String(b.password || '');
      if (!id || id.length > 80 || !password || password.length > 256) return json(res, 400, { error: 'بيانات الدخول غير صالحة' });
      const sap = Object.keys(auth).find(k => k.toLowerCase() === id || String(auth[k].username).toLowerCase() === id);
      const ok = await A.verifyPassword(password, sap ? auth[sap].hash : 's1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      const u = ok && sap ? identity(sap) : null;
      if (!u) { failed(ip); return json(res, 401, { error: 'اسم المستخدم أو الكود غير صحيح' }); }
      rl.delete(ip);
      return json(res, 200, { token: A.signToken({ sap: String(u.sap) }, JWT_SECRET), user: u, mustChange: !!auth[sap].mustChange });
    }

    // Gemini AI — المفتاح محفوظ على السيرفر فقط داخل Railway Variables
    if (p === '/api/gemini') {
      const u = me(b);
      if (!u) return json(res, 401, { error: 'سجّل دخول الأول' });
      if (auth[u.sap] && auth[u.sap].mustChange)
        return json(res, 403, { error: 'غيّر كلمة المرور المؤقتة أولاً' });

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return json(res, 503, { error: 'مفتاح Gemini غير مضبوط في Railway Variables' });

      const question = String(b.question || '').trim();
      if (!question || question.length > 4000)
        return json(res, 400, { error: 'اكتب سؤالاً لا يتجاوز 4000 حرف' });
      const now = Date.now(), rateKey = String(u.sap);
      let rate = geminiRate.get(rateKey);
      if (!rate || rate.reset <= now) { rate = { count: 0, reset: now + 60000 }; geminiRate.set(rateKey, rate); }
      if (rate.count >= 12) return json(res, 429, { error: 'وصلت للحد المؤقت لأسئلة Gemini. جرّب بعد دقيقة.' });
      rate.count++;

      // الموظف العادي يرسل سجله فقط؛ الإدارة تستخدم البيانات التي تسمح بها صلاحيات السيرفر.
      const safe = view(u);
      const ownEmployee = (safe.employees || []).find(e => String(e.sap) === String(u.sap));
      const employees = u.mgr ? (safe.employees || []).slice(0, 300) : (ownEmployee ? [ownEmployee] : []);
      const branchNames = (u.mgr ? (safe.branches || []) : (ownEmployee ? (safe.branches || []).filter(x => x.name === ownEmployee.branch) : []))
        .slice(0, 150).map(x => ({ name: x.name, code: x.code, address: x.address,
          openTime: x.openTime, closeTime: x.closeTime, lat: x.lat, lng: x.lng,
          geofenceRadius: x.geofenceRadius }));
      const context = {
        user: { name: u.name || '', branch: u.branch || '', role: u.cls || (u.admin ? 'ADMIN' : 'STAFF'), manager: !!u.mgr },
        employees: employees.map(e => ({
          name: e.name, sap: e.sap, role: e.role, branch: e.branch,
          status: e.status, inBranch: e.inBranch, checkInTime: e.checkInTime,
          checkInAt: e.checkInAt, geoVerified: e.geoVerified,
          distanceMeters: e.distanceMeters, geofenceRadius: e.geofenceRadius,
          leaveType: e.leaveType, monthlyAbsence: e.monthlyAbsence,
          transferHistory: Array.isArray(e.transferHistory) ? e.transferHistory.slice(-12) : [],
          shift: e.shift, phone: e.phone, email: e.email,
          attendanceHistory: Array.isArray(e.attendanceHistory) ? e.attendanceHistory.slice(-31) : []
        })),
        branches: branchNames,
        attendanceSummary: {
          employeeCount: employees.length,
          present: employees.filter(e => e.status === 'PRESENT').length,
          late: employees.filter(e => e.status === 'LATE_OPEN').length,
          notPresent: employees.filter(e => e.status !== 'PRESENT').length,
          outsideBranch: employees.filter(e => e.status === 'PRESENT' && e.inBranch === false).length
        },
        lateOpenings: (safe.lateOpenings || []).slice(0, 80).map(x => ({
          title: x.title, body: x.body, branch: x.branch, time: x.time,
          empName: x.empName, status: x.status
        })),
        fraudAlerts: (safe.fraudAlerts || []).slice(0, 60).map(x => ({
          empName: x.empName, branch: x.branch, title: x.title,
          detail: x.detail, time: x.time, ack: x.ack, sev: x.sev
        })),
        notifications: (safe.notifications || []).slice(0, 30).map(x => ({
          title: x.title, body: x.body, time: x.time, severity: x.severity
        })),
        aiMemory: {
          interactions: Number(safe.aiMemory && safe.aiMemory.interactions || 0),
          learnedPatterns: Array.isArray(safe.aiMemory && safe.aiMemory.learnedPatterns) ? safe.aiMemory.learnedPatterns.slice(0, 30) : [],
          branchNotes: u.mgr && safe.aiMemory && safe.aiMemory.branchNotes && typeof safe.aiMemory.branchNotes === 'object' ? safe.aiMemory.branchNotes : {}
        }
      };

      const model = String(process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 55000);
      try {
        const upstream = await fetch(endpoint, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text:
              'أنت محلل ومستشار ذكاء اصطناعي متخصص داخل BIM Enterprise OS، ولست روبوت ردود جاهزة. مهمتك فهم السؤال كاملاً ثم تحليل بيانات السياق المرفقة فعلياً قبل الإجابة. أجب بالعربية المصرية الواضحة والمهنية وبشكل مباشر. استخدم الأرقام والأسماء والتواريخ الموجودة في البيانات، واحسب النسب والمقارنات عند الحاجة مع توضيح طريقة الحساب باختصار. اربط المعلومات ببعضها واستخرج الأنماط والمشكلات والأسباب المحتملة والتوصيات العملية. لا تكرر ملخصاً عاماً إذا كان السؤال محدداً، ولا تعرض أمثلة أو اقتراحات محفوظة بدلاً من الإجابة. عند السؤال عن موظف أو فرع ابحث في كل السجلات المتاحة في السياق. إذا كانت البيانات غير كافية فحدد بالضبط ما ينقصك ولا تخمن. لا تدّع تنفيذ إجراء داخل النظام؛ اشرح فقط ما يمكن استنتاجه. التزم بصلاحيات المستخدم ولا تكشف بيانات غير موجودة في السياق أو كلمات مرور أو مفاتيح API. إذا طلب المستخدم مقارنة أو ترتيباً فأنشئ ترتيباً فعلياً من البيانات المتاحة.' }] },
            contents: [{ role: 'user', parts: [{ text:
              `بيانات النظام المسموح بها لهذا المستخدم:\n${JSON.stringify(context)}\n\nسؤال المستخدم: ${question}` }] }],
            generationConfig: { temperature: 0.35, maxOutputTokens: 1200 }
          })
        });
        const payload = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          const providerMessage = String(payload.error && payload.error.message || 'Unknown provider error').slice(0, 500);
          console.error('Gemini API error:', upstream.status, providerMessage);
          return json(res, 502, { error: 'Google Gemini رفض الطلب (' + upstream.status + '): ' + providerMessage, provider: 'google-gemini', model });
        }
        const answer = (payload.candidates || [])
          .flatMap(c => c.content && c.content.parts || [])
          .map(x => x.text || '').join('\n').trim();
        if (!answer) return json(res, 502, { error: 'Gemini لم يرجع إجابة نصية. جرّب صياغة السؤال بطريقة أخرى.' });
        return json(res, 200, { ok: true, answer, model });
      } catch (e) {
        console.error('Gemini request failed:', e.message);
        return json(res, 502, { error: e.name === 'AbortError'
          ? 'انتهت مهلة الاتصال بـ Gemini، حاول مرة أخرى'
          : 'تعذر الاتصال بخدمة Gemini حالياً' });
      } finally {
        clearTimeout(timeout);
      }
    }

    // Gemini Text-to-Speech — صوت رجالي عربي مصري، والمفتاح يظل على السيرفر.
    if (p === '/api/gemini-tts') {
      const u = me(b);
      if (!u) return json(res, 401, { error: 'سجّل دخول الأول' });
      if (auth[u.sap] && auth[u.sap].mustChange)
        return json(res, 403, { error: 'غيّر كلمة المرور المؤقتة أولاً' });
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return json(res, 503, { error: 'مفتاح Gemini غير مضبوط في Railway Variables' });
      const text = String(b.text || '').trim();
      if (!text || text.length > 6000) return json(res, 400, { error: 'النص المطلوب نطقه غير صالح أو طويل جداً' });
      const now = Date.now(), rateKey = 'tts:' + String(u.sap);
      let rate = geminiRate.get(rateKey);
      if (!rate || rate.reset <= now) { rate = { count: 0, reset: now + 60000 }; geminiRate.set(rateKey, rate); }
      if (rate.count >= 8) return json(res, 429, { error: 'طلبات الصوت كثيرة مؤقتاً. حاول بعد دقيقة.' });
      rate.count++;
      const model = String(process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts').trim();
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 35000);
      try {
        const upstream = await fetch(endpoint, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{
              text,
              speechMetadata: { style: 'Speak clearly in Egyptian Arabic with a natural, calm, confident adult male voice. Moderate conversational pace. Read the supplied text verbatim without adding words.' }
            }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { voice: 'Charon' } }
            }
          })
        });
        const payload = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          const providerMessage = String(payload.error && payload.error.message || 'Unknown provider error').slice(0, 500);
          console.error('Gemini TTS API error:', upstream.status, providerMessage);
          return json(res, 502, { error: 'Google Gemini TTS رفض الطلب (' + upstream.status + '): ' + providerMessage, provider: 'google-gemini-tts', model });
        }
        const audioPart = (payload.candidates || []).flatMap(c => c.content && c.content.parts || []).find(x => x.inlineData && x.inlineData.data);
        if (!audioPart) return json(res, 502, { error: 'Gemini لم يرجع ملفاً صوتياً.' });
        return json(res, 200, { ok: true, audioBase64: audioPart.inlineData.data, mimeType: audioPart.inlineData.mimeType || 'audio/L16;rate=24000' });
      } catch (e) {
        console.error('Gemini TTS request failed:', e.message);
        return json(res, 502, { error: e.name === 'AbortError' ? 'انتهت مهلة إنشاء الصوت، حاول مرة أخرى' : 'تعذر الاتصال بخدمة الصوت Gemini حالياً' });
      } finally { clearTimeout(timeout); }
    }

    if (p === '/api/admin/import-credentials') {     // يستقبل هاشات بس (مش أكواد) — بمفتاح الأدمن أو توكن أدمن
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

    if (p === '/api/me/credentials') {               // الموظف يغيّر اسم المستخدم و/أو الكود بتاعه
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


    if (p === '/api/attendance/event') {             // السيرفر هو اللي يحسب النطاق والمخاطر — مش المتصفح
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
      return json(res, 200, { inside, dist, radius, serverTime: serverT, risk: { level: r.level, trust: r.trust } });   // تنبيه فقط — القرار للأدمن
    }

    if (p === '/api/attendance/presence') {          // نبض الموقع أثناء الشيفت: السيرفر يقرر خرج/رجع، ومابيخزّنش إحداثيات (المسافة والوقت بس)
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
        if (rk.outN >= (acc <= 30 ? 1 : 2) && e.inBranch !== false) {      // قراءة دقيقة واحدة تكفي، وغير كده لازم قراءتين ورا بعض (ضوضاء GPS)
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

    if (p === '/api/admin/users') {                  // الأدمن يضيف موظف باسم مستخدم وكود
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

    if (p === '/api/admin/branch-locate') {          // تثبيت لوكيشن فرع من إحداثيات أو لينك جوجل ماب (بيقفل التثبيت التلقائي)
      if (!state) return json(res, 409, { error: 'مفيش بيانات لسه' });
      const r = await BR.locate(state, b); if (r.dirty) { schedule(); broadcast(); } return json(res, r.code, r.body);
    }
    if (p === '/api/admin/branch-autolocate') {      // يعيد تثبيت الفروع غير المثبّتة من قايمة اللينكات
      if (!state) return json(res, 409, { error: 'مفيش بيانات لسه' });
      const ch = await BR.autoLocate(state); if (ch.length) { schedule(); broadcast(); } return json(res, 200, { updated: ch });
    }

    if (p === '/api/admin/reset') {                  // إعادة تعيين كود موظف (يرجّع الكود الجديد مرة واحدة)
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

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(ready ? 'ok' : 'loading'); }

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
server.requestTimeout = 0;               // SSE بيفضل مفتوح
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
