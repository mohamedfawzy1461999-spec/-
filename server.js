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
const SYNC = process.env.SYNC_CODE || 'BIM-ISMAILIA-2026';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUB = path.join(__dirname, 'public');
const MAX_BODY = 15e6;

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
      state = await loadState();
      ready = true;
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

function who(q) {
  if (!q || q.sync !== SYNC) return null;
  const e = state && (state.employees || []).find(x => String(x.sap) === String(q.sap));
  if (e) return { sap: e.sap, cls: cls(e.role), branch: e.branch, mgr: !!e.isAdminDelegate, admin: !!e.isAdminDelegate };
  if ((q.role === 'admin' || q.role === 'manager') && ADMIN_KEY && q.key === ADMIN_KEY)
    return { sap: q.sap, mgr: true, admin: q.role === 'admin' };
  return null;
}

function view(u) {
  const s = { ...state };
  if (!u.admin) s.employees = (s.employees || []).map(({ password, ...e }) => e);
  const m = s.meeting || {};
  if (m.active && !canSee(u, m.audience, m.branchScope)) s.meeting = { active: false, audience: 'ALL', branchScope: 'ALL' };
  s.scheduledMeetings = (s.scheduledMeetings || []).filter(x => canSee(u, x.audience, x.scope));
  s.notifications = (s.notifications || []).filter(n => !n.aud || canSee(u, n.aud, n.scope));
  return s;
}
const viewKey = u => [u.admin ? 1 : 0, u.mgr ? 1 : 0, u.cls || '', u.branch || ''].join('|');

/* ───────────── الكتابة ───────────── */
const MGR_KEYS = ['meeting', 'scheduledMeetings', 'branches'];
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
      for (const e of v) {
        const i = state.employees.findIndex(x => x.id === e.id);
        if (i < 0) { if (u.admin) state.employees.push(e); continue; }
        const old = state.employees[i];
        if (!(u.mgr || String(old.sap) === String(u.sap))) continue;
        const keep = u.admin ? {} : { password: old.password, role: old.role, branch: old.branch, isAdminDelegate: old.isAdminDelegate };
        state.employees[i] = { ...old, ...e, ...keep };
      }
    } else if (k === 'chat') { if (Array.isArray(v)) state.chat = union(state.chat || [], v, x => x.sender + '|' + x.text + '|' + x.time, false); }
    else if (k === 'notifications') { if (Array.isArray(v)) state.notifications = union(state.notifications || [], v, x => x.id, true); }
    else if (MGR_KEYS.includes(k)) { if (u.mgr) state[k] = v; }
    else if (k !== 'syncCode') state[k] = v;
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
  'Access-Control-Allow-Origin': process.env.ALLOW_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};
const json = (res, code, obj) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(ready ? 'ok' : 'loading'); }

    if (url.pathname === '/api/stream') {
      if (!ready) return json(res, 503, { error: 'loading' });
      const q = Object.fromEntries(url.searchParams), u = who(q);
      if (!u) { res.writeHead(403, cors); return res.end('denied'); }
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
          if (!state && b.full && u.mgr && typeof b.full === 'object') state = b.full;
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
