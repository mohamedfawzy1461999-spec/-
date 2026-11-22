'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const BRANCH_LINKS = require('./branch-links');
const { branches: SEED_BRANCHES, employees: SEED_EMPLOYEES } = require('./seed');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('⚠️  JWT_SECRET غير مضبوط — الجلسات هتتلغي مع كل ريستارت. اضبطه في Railway.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
});
const q = (text, params) => pool.query(text, params);

const ROLE_MAP = { m: 'manager', a: 'assistant', e: 'staff' };
const REQUIRED_SHIFT_SECONDS = 9 * 3600;

/* ───────────── قاعدة البيانات ───────────── */
async function migrate() {
  await q(`
    create table if not exists branches (
      id serial primary key,
      code text unique not null,
      name text not null,
      lat double precision,
      lng double precision,
      radius_m integer not null default 150,
      open_time text not null default '09:00'
    );
    create table if not exists employees (
      id serial primary key,
      code text unique,
      username text unique not null,
      name text not null,
      branch_id integer references branches(id),
      role text not null default 'staff' check (role in ('manager','assistant','staff')),
      is_admin boolean not null default false,
      password_hash text,
      must_change boolean not null default true,
      leave_type text not null default 'none',
      email text,
      active boolean not null default true,
      created_at timestamptz not null default now()
    );
    create table if not exists attendance (
      id serial primary key,
      employee_id integer not null references employees(id),
      day date not null,
      check_in timestamptz,
      check_out timestamptz,
      in_lat double precision, in_lng double precision, in_inside boolean,
      out_lat double precision, out_lng double precision, out_inside boolean,
      unique (employee_id, day)
    );
    create table if not exists notifications (
      id serial primary key,
      branch_id integer references branches(id),
      title text not null,
      body text not null,
      created_by integer references employees(id),
      created_at timestamptz not null default now()
    );
    alter table attendance add column if not exists in_photo text;
    alter table attendance add column if not exists out_photo text;
    alter table attendance add column if not exists in_accuracy real;
    create table if not exists shift_requests (
      id serial primary key,
      employee_id integer not null references employees(id),
      new_start date not null,
      reason text,
      status text not null default 'pending',
      created_at timestamptz not null default now()
    );
  `);
}

async function seed() {
  const { rows: [{ n }] } = await q('select count(*)::int n from branches');
  if (n === 0) {
    for (const [code, name] of SEED_BRANCHES) {
      await q('insert into branches(code,name) values($1,$2)', [code, name]);
    }
  }
  const { rows: [{ n: en }] } = await q('select count(*)::int n from employees where is_admin = false');
  if (en === 0) {
    const bmap = Object.fromEntries((await q('select id,code from branches')).rows.map(r => [r.code, r.id]));
    for (const [code, name, bcode, role, suffix] of SEED_EMPLOYEES) {
      const username = code ? code + suffix : 'PENDING-' + suffix + '-' + Math.random().toString(36).slice(2, 6);
      const hash = code ? await bcrypt.hash(code, 10) : null; // كلمة المرور المبدئية = الكود، ويتغيّر عند أول دخول
      await q(
        `insert into employees(code,username,name,branch_id,role,password_hash,must_change)
         values($1,$2,$3,$4,$5,$6,true)`,
        [code, username, name, bmap[bcode], ROLE_MAP[role], hash]
      );
    }
    console.log('✅ تم تحميل الفروع والموظفين.');
    if (SEED_EMPLOYEES.some(e => !e[0])) console.warn('⚠️  في موظف بدون كود (كريم عادل). حدد كوده من لوحة الأدمن: PATCH /api/employees/:id');
  }
  const { rows: admins } = await q('select id from employees where is_admin = true limit 1');
  if (!admins.length) {
    const user = process.env.ADMIN_USER || 'admin';
    let pass = process.env.ADMIN_PASSWORD;
    if (!pass) {
      pass = crypto.randomBytes(9).toString('base64url');
      console.warn(`⚠️  ADMIN_PASSWORD غير مضبوط. كلمة مرور الأدمن المؤقتة: ${pass}  (اتغيّرها فوراً)`);
    }
    await q(
      `insert into employees(username,name,role,is_admin,password_hash,must_change)
       values($1,'مدير النظام','manager',true,$2,$3)`,
      [user, await bcrypt.hash(pass, 10), !process.env.ADMIN_PASSWORD]
    );
    console.log('✅ تم إنشاء حساب الأدمن:', user);
  }
}

/* ───────────── أدوات ───────────── */
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false })); // الملف فيه سكربتات inline
app.use(express.json({ limit: '700kb' }));

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = x => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);
const TODAY = "(now() at time zone 'Africa/Cairo')::date";

const attempts = new Map(); // حماية بسيطة من تخمين كلمات المرور
function tooMany(key) {
  const now = Date.now();
  const rec = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(key, rec);
  return rec.length >= 8;
}

const publicEmp = e => ({
  id: e.id, code: e.code, username: e.username, name: e.name, role: e.role,
  is_admin: e.is_admin, branch_id: e.branch_id, must_change: e.must_change, leave_type: e.leave_type,
});

const auth = wrap(async (req, res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'سجّل الدخول الأول' });
  let payload;
  try { payload = jwt.verify(h.slice(7), JWT_SECRET); } catch { return res.status(401).json({ error: 'الجلسة انتهت' }); }
  const { rows } = await q('select * from employees where id=$1 and active', [payload.id]);
  if (!rows[0]) return res.status(401).json({ error: 'الحساب غير نشط' });
  req.user = rows[0];
  next();
});
const adminOnly = (req, res, next) => (req.user.is_admin ? next() : res.status(403).json({ error: 'للأدمن فقط' }));
const managerUp = (req, res, next) =>
  req.user.is_admin || req.user.role !== 'staff' ? next() : res.status(403).json({ error: 'مش مسموح' });

/* ───────────── الدخول ───────────── */
app.post('/api/login', wrap(async (req, res) => {
  const id = String(req.body.username || '').trim();
  const pw = String(req.body.password || '');
  if (!id || !pw) return res.status(400).json({ error: 'اكتب اسم المستخدم وكلمة المرور' });
  const key = req.ip + '|' + id.toLowerCase();
  if (tooMany(key)) return res.status(429).json({ error: 'محاولات كتير. جرّب بعد 15 دقيقة' });
  const { rows } = await q('select * from employees where (lower(username)=lower($1) or code=$1) and active limit 1', [id]);
  const e = rows[0];
  const ok = e && e.password_hash && (await bcrypt.compare(pw, e.password_hash));
  if (!ok) {
    attempts.get(key).push(Date.now());
    return res.status(401).json({ error: 'بيانات الدخول غلط' });
  }
  const token = jwt.sign({ id: e.id }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: publicEmp(e) });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const { rows } = await q(
    `select a.*, b.name branch_name, b.lat, b.lng, b.radius_m from employees e
     join branches b on b.id = e.branch_id
     left join attendance a on a.employee_id = e.id and a.day = ${TODAY}
     where e.id = $1`, [req.user.id]);
  res.json({ user: publicEmp(req.user), today: rows[0] || null });
}));

app.post('/api/change-password', auth, wrap(async (req, res) => {
  const { old_password, new_password } = req.body;
  if (!new_password || String(new_password).length < 8) return res.status(400).json({ error: 'كلمة المرور الجديدة 8 حروف/أرقام على الأقل' });
  if (!(await bcrypt.compare(String(old_password || ''), req.user.password_hash))) return res.status(401).json({ error: 'كلمة المرور القديمة غلط' });
  if (new_password === req.user.code) return res.status(400).json({ error: 'ما ينفعش تستخدم الكود ككلمة مرور' });
  await q('update employees set password_hash=$1, must_change=false where id=$2', [await bcrypt.hash(String(new_password), 10), req.user.id]);
  res.json({ ok: true });
}));

/* ───────────── الحضور والانصراف (مربوط باللوكيشن) ───────────── */
const MAX_ACCURACY = Number(process.env.MAX_ACCURACY_M || 100);
const REQUIRE_PHOTO = process.env.REQUIRE_PHOTO !== '0';

async function branchOf(emp) {
  return (await q('select * from branches where id=$1', [emp.branch_id])).rows[0];
}

// القرار الوحيد: الموظف جوه نطاق فرعه ولا لأ — بيتحسب في السيرفر دايماً
function evaluate(br, lat, lng, acc) {
  if (!br) return { code: 400, error: 'الحساب ده مش تابع لفرع' };
  if (br.lat == null || br.lng == null) return { code: 409, error: 'لوكيشن فرعك لسه ماتسجلش. كلّم الأدمن' };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { code: 400, error: 'لازم تفعّل اللوكيشن' };
  if (Number.isFinite(acc) && acc > MAX_ACCURACY) return { code: 400, error: `دقة اللوكيشن ضعيفة (${Math.round(acc)} متر). اطلع مكان مفتوح وجرّب تاني` };
  const dist = Math.round(haversine(lat, lng, br.lat, br.lng));
  return { inside: dist <= br.radius_m, dist };
}

function proofOk(req) {
  try {
    const p = jwt.verify(String(req.body.proof || ''), JWT_SECRET);
    return p.typ === 'geo' && p.id === req.user.id && p.b === req.user.branch_id;
  } catch { return false; }
}

// الموبايل بيطلب إثبات موقع قبل ما يفتح الكاميرا أو يصوّر أو يسجّل
app.post('/api/geo-verify', auth, wrap(async (req, res) => {
  const br = await branchOf(req.user);
  const g = evaluate(br, num(req.body.lat), num(req.body.lng), num(req.body.accuracy));
  if (g.error) return res.status(g.code).json({ error: g.error });
  if (!g.inside) return res.status(403).json({ error: `إنت برّه نطاق فرع ${br.name} (${g.dist} متر)`, inside: false, dist: g.dist });
  const proof = jwt.sign({ id: req.user.id, typ: 'geo', b: br.id }, JWT_SECRET, { expiresIn: '3m' });
  res.json({ inside: true, dist: g.dist, proof, branch: br.name });
}));

async function record(kind, req, res) {
  const lat = num(req.body.lat), lng = num(req.body.lng), acc = num(req.body.accuracy);
  const br = await branchOf(req.user);
  const g = evaluate(br, lat, lng, acc);
  if (g.error) return res.status(g.code).json({ error: g.error });
  if (!g.inside) return res.status(403).json({ error: `إنت برّه نطاق الفرع (${g.dist} متر)`, dist: g.dist });
  if (!proofOk(req)) return res.status(403).json({ error: 'لازم التحقق من الموقع الأول' });
  const photo = String(req.body.photo || '');
  if (REQUIRE_PHOTO && !/^data:image\/jpeg;base64,/.test(photo)) return res.status(400).json({ error: 'لازم صورة من الكاميرا' });
  if (photo.length > 450000) return res.status(413).json({ error: 'الصورة كبيرة' });

  if (kind === 'in') {
    const r = await q(
      `insert into attendance(employee_id,day,check_in,in_lat,in_lng,in_inside,in_accuracy,in_photo)
       values($1,${TODAY},now(),$2,$3,true,$4,$5) on conflict (employee_id,day) do nothing returning id,check_in`,
      [req.user.id, lat, lng, acc, photo || null]);
    if (!r.rows[0]) return res.status(409).json({ error: 'سجّلت حضورك النهارده قبل كده' });
    return res.json({ ok: true, check_in: r.rows[0].check_in, dist: g.dist });
  }
  const r = await q(
    `update attendance set check_out=now(), out_lat=$2, out_lng=$3, out_inside=true, out_photo=$4
     where employee_id=$1 and day=${TODAY} and check_in is not null and check_out is null returning check_in,check_out`,
    [req.user.id, lat, lng, photo || null]);
  if (!r.rows[0]) return res.status(409).json({ error: 'لازم تسجّل حضور الأول، أو سجّلت انصراف قبل كده' });
  const worked = (new Date(r.rows[0].check_out) - new Date(r.rows[0].check_in)) / 1000;
  res.json({ ok: true, worked_seconds: Math.round(worked), short_shift: worked < REQUIRED_SHIFT_SECONDS });
}
app.post('/api/checkin', auth, wrap((req, res) => record('in', req, res)));
app.post('/api/checkout', auth, wrap((req, res) => record('out', req, res)));

/* ───────────── المتابعة (أدمن / مسئول فرع) ───────────── */
function scope(req) {
  return req.user.is_admin ? { sql: '', params: [] } : { sql: ' and e.branch_id = $1', params: [req.user.branch_id] };
}

app.get('/api/today', auth, managerUp, wrap(async (req, res) => {
  const s = scope(req);
  const { rows } = await q(
    `select e.id, e.code, e.name, e.role, e.leave_type, b.id branch_id, b.name branch, b.code branch_code,
            a.check_in, a.check_out, a.in_inside, a.in_lat, a.in_lng
     from employees e join branches b on b.id = e.branch_id
     left join attendance a on a.employee_id = e.id and a.day = ${TODAY}
     where e.active and not e.is_admin ${s.sql} order by b.name, e.role, e.name`, s.params);
  const present = rows.filter(r => r.check_in).length;
  res.json({ total: rows.length, present, absent: rows.length - present, employees: rows });
}));

app.get('/api/employees', auth, managerUp, wrap(async (req, res) => {
  const s = scope(req);
  const { rows } = await q(
    `select e.id,e.code,e.username,e.name,e.role,e.is_admin,e.leave_type,e.email,e.branch_id,b.name branch
     from employees e join branches b on b.id=e.branch_id where e.active ${s.sql} order by b.name,e.name`, s.params);
  res.json(rows);
}));

/* ───────────── إدارة الأدمن ───────────── */
app.post('/api/employees', auth, adminOnly, wrap(async (req, res) => {
  const { code, name, branch_id, role = 'staff', suffix = '', email } = req.body;
  if (!code || !name || !branch_id) return res.status(400).json({ error: 'الكود والاسم والفرع مطلوبين' });
  if (!['manager', 'assistant', 'staff'].includes(role)) return res.status(400).json({ error: 'وظيفة غير صحيحة' });
  const username = String(code) + String(suffix || name.trim()[0] || '').toUpperCase();
  try {
    const r = await q(
      `insert into employees(code,username,name,branch_id,role,email,password_hash,must_change)
       values($1,$2,$3,$4,$5,$6,$7,true) returning *`,
      [String(code), username, name, branch_id, role, email || null, await bcrypt.hash(String(code), 10)]);
    res.status(201).json(publicEmp(r.rows[0]));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'الكود أو اسم المستخدم موجود قبل كده' });
    throw e;
  }
}));

app.patch('/api/employees/:id', auth, adminOnly, wrap(async (req, res) => {
  const allowed = ['name', 'code', 'username', 'branch_id', 'role', 'is_admin', 'leave_type', 'email'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in req.body) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'مفيش حاجة تتعدّل' });
  // لو اتحدد كود لموظف مالوش كود: كلمة المرور المبدئية = الكود
  if (req.body.code) {
    vals.push(await bcrypt.hash(String(req.body.code), 10));
    sets.push(`password_hash = coalesce(password_hash, $${vals.length})`);
  }
  vals.push(req.params.id);
  try {
    const r = await q(`update employees set ${sets.join(',')} where id=$${vals.length} returning *`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'مش موجود' });
    res.json(publicEmp(r.rows[0]));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'الكود أو اسم المستخدم مكرر' });
    throw e;
  }
}));

app.post('/api/employees/:id/reset-password', auth, adminOnly, wrap(async (req, res) => {
  const { rows } = await q('select code from employees where id=$1', [req.params.id]);
  if (!rows[0] || !rows[0].code) return res.status(400).json({ error: 'الموظف ده ملوش كود' });
  await q('update employees set password_hash=$1, must_change=true where id=$2', [await bcrypt.hash(rows[0].code, 10), req.params.id]);
  res.json({ ok: true, note: 'كلمة المرور رجعت للكود وهيتغيّر عند الدخول' });
}));

app.delete('/api/employees/:id', auth, adminOnly, wrap(async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'ما ينفعش تحذف نفسك' });
  await q('update employees set active=false where id=$1', [req.params.id]); // حذف ناعم عشان السجلات
  res.json({ ok: true });
}));

app.get('/api/branches', auth, wrap(async (req, res) => {
  res.json((await q('select * from branches order by name')).rows);
}));
app.patch('/api/branches/:id', auth, adminOnly, wrap(async (req, res) => {
  const lat = num(req.body.lat), lng = num(req.body.lng), radius = num(req.body.radius_m);
  const r = await q(
    `update branches set lat=coalesce($1,lat), lng=coalesce($2,lng), radius_m=coalesce($3,radius_m),
            open_time=coalesce($4,open_time) where id=$5 returning *`,
    [lat, lng, radius, req.body.open_time || null, req.params.id]);
  res.json(r.rows[0]);
}));

/* ───────────── صور الحضور (للأدمن ومسئول الفرع) ───────────── */
app.get('/api/attendance/:empId/photo/:kind', auth, managerUp, wrap(async (req, res) => {
  const col = req.params.kind === 'out' ? 'out_photo' : 'in_photo';
  const r = await q(
    `select a.${col} photo, e.branch_id from attendance a join employees e on e.id=a.employee_id
     where a.employee_id=$1 and a.day=${TODAY}`, [req.params.empId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'مفيش سجل' });
  if (!req.user.is_admin && r.rows[0].branch_id !== req.user.branch_id) return res.status(403).json({ error: 'مش مسموح' });
  res.json({ photo: r.rows[0].photo });
}));

/* ───────────── تحديد لوكيشن الفرع ───────────── */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const inRegion = (lat, lng) => lat > 29.8 && lat < 31.2 && lng > 31.8 && lng < 32.8; // حدود الإسماعيلية تقريباً (حماية من إحداثيات غلط)
function parseCoords(text) {
  const pats = [
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/g,
    /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/g,
    /center=(-?\d{1,3}\.\d+)(?:%2C|,)(-?\d{1,3}\.\d+)/g,
    /^\s*(-?\d{1,3}\.\d+)\s*[,،\s]\s*(-?\d{1,3}\.\d+)\s*$/g,
  ];
  for (const re of pats) {
    for (const m of String(text).matchAll(re)) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (inRegion(lat, lng)) return { lat, lng };
    }
  }
  return null;
}
async function coordsFromLink(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8' } });
  const finalUrl = r.url;
  const html = await r.text();
  let name = '';
  try { name = decodeURIComponent((finalUrl.match(/\/maps\/place\/([^/]+)/) || [])[1] || '').replace(/\+/g, ' '); } catch {}
  return { name, coords: parseCoords(finalUrl) || parseCoords(html) };
}
app.post('/api/branches/:id/locate', auth, adminOnly, wrap(async (req, res) => {
  let c = null, name = '';
  if (req.body.lat != null && req.body.lng != null) c = { lat: num(req.body.lat), lng: num(req.body.lng) };
  else if (req.body.text) {
    const t = String(req.body.text).trim();
    c = parseCoords(t);
    if (!c && /^https?:\/\//.test(t)) { const r = await coordsFromLink(t); c = r.coords; name = r.name; }
  }
  if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) return res.status(400).json({ error: 'مقدرتش أطلع إحداثيات. ابعت lat و lng، أو انسخ الإحداثيات من جوجل ماب' });
  const r = await q('update branches set lat=$1,lng=$2 where id=$3 returning *', [c.lat, c.lng, req.params.id]);
  res.json({ ok: true, branch: r.rows[0], place_name: name });
}));

async function autoLocate() {
  const { rows } = await q('select id,code,name from branches where lat is null or lng is null');
  for (const b of rows) {
    const link = BRANCH_LINKS[b.code];
    if (!link) continue;
    if (typeof link === 'object') { // إحداثيات مكتوبة مباشرة
      await q('update branches set lat=$1,lng=$2 where id=$3', [link.lat, link.lng, b.id]);
      console.log(`📍 ${b.name} (${b.code}) ← ${link.lat},${link.lng}`);
      continue;
    }
    try {
      const { name, coords } = await coordsFromLink(link);
      if (coords) {
        await q('update branches set lat=$1,lng=$2 where id=$3', [coords.lat, coords.lng, b.id]);
        console.log(`📍 ${b.name} (${b.code}) ← ${coords.lat},${coords.lng}  | المكان في الرابط: "${name}"`);
      } else console.warn(`⚠️  ${b.name} (${b.code}): الرابط وصل لـ "${name}" بس مفيش إحداثيات — ثبّتها من زرار 📍`);
    } catch (e) { console.warn(`⚠️  ${b.name} (${b.code}): فشل فتح الرابط (${e.message})`); }
  }
}

/* ───────────── الإشعارات وطلبات الشيفت ───────────── */
app.get('/api/notifications', auth, wrap(async (req, res) => {
  const { rows } = await q(
    `select n.*, b.name branch from notifications n left join branches b on b.id=n.branch_id
     where n.branch_id is null or n.branch_id=$1 or $2 order by n.created_at desc limit 50`,
    [req.user.branch_id, req.user.is_admin]);
  res.json(rows);
}));
app.post('/api/notifications', auth, managerUp, wrap(async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'العنوان والنص مطلوبين' });
  // مسئول الفرع يبعت لفرعه بس؛ الأدمن يبعت لأي فرع أو للكل
  const branch_id = req.user.is_admin ? (req.body.branch_id || null) : req.user.branch_id;
  const r = await q('insert into notifications(branch_id,title,body,created_by) values($1,$2,$3,$4) returning *', [branch_id, title, body, req.user.id]);
  res.status(201).json(r.rows[0]);
}));

app.post('/api/shift-requests', auth, wrap(async (req, res) => {
  const { new_start, reason } = req.body;
  if (!new_start) return res.status(400).json({ error: 'حدد تاريخ البداية' });
  const r = await q('insert into shift_requests(employee_id,new_start,reason) values($1,$2,$3) returning *', [req.user.id, new_start, reason || null]);
  res.status(201).json(r.rows[0]);
}));
app.get('/api/shift-requests', auth, managerUp, wrap(async (req, res) => {
  const s = scope(req);
  const { rows } = await q(
    `select r.*, e.name from shift_requests r join employees e on e.id=r.employee_id
     where true ${s.sql} order by r.created_at desc limit 100`, s.params);
  res.json(rows);
}));
app.patch('/api/shift-requests/:id', auth, adminOnly, wrap(async (req, res) => {
  const status = req.body.status;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'الحالة غلط' });
  res.json((await q('update shift_requests set status=$1 where id=$2 returning *', [status, req.params.id])).rows[0]);
}));

/* ───────────── الملفات الثابتة ───────────── */
app.get('/healthz', (_, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (_, res) => res.status(404).json({ error: 'مش موجود' }));
app.use((err, req, res, next) => { // eslint-disable-line
  console.error(err);
  res.status(500).json({ error: 'خطأ في السيرفر' });
});

(async () => {
  if (!process.env.DATABASE_URL) { console.error('❌ DATABASE_URL مش مضبوط. ضيف Postgres في Railway.'); process.exit(1); }
  await migrate();
  await seed();
  autoLocate().catch(e => console.warn('autoLocate', e.message));
  app.listen(PORT, () => console.log('🚀 BIM server on :' + PORT));
})().catch(e => { console.error(e); process.exit(1); });
