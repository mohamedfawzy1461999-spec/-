'use strict';
/*
  node scripts/credentials.js gen            → يولّد كود سري لكل موظف:
       credentials.csv        (الأكواد — سري، للتوزيع على الموظفين، ما يترفعش على GitHub)
       credentials-import.json (هاشات بس، للرفع على السيرفر)
  node scripts/credentials.js push <URL> <ADMIN_KEY> [ملف]   → يرفع الهاشات للسيرفر
*/
const fs = require('fs'), path = require('path');
const { hashPassword, randomCode } = require('../auth');
const root = path.join(__dirname, '..');

async function gen() {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const m = html.match(/const DEFAULT_EMPLOYEES = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error('مش لاقي DEFAULT_EMPLOYEES');
  const emps = JSON.parse(m[1]), seen = new Set(), rows = [], list = [], dups = [];
  for (const e of emps) {
    const sap = String(e.sap);
    if (seen.has(sap)) { dups.push(`${e.name} (${sap})`); continue; }
    seen.add(sap);
    const code = randomCode(8);
    rows.push([e.name, sap, e.branch, e.role, e.username, code]);
    list.push({ sap, username: e.username, hash: await hashPassword(code), mustChange: true });
  }
  const q = v => '"' + String(v).replace(/"/g, '""') + '"';
  fs.writeFileSync(path.join(root, 'credentials.csv'), '\ufeff' + [['الاسم', 'SAP', 'الفرع', 'الدور', 'اسم المستخدم', 'الكود السري'], ...rows].map(r => r.map(q).join(',')).join('\n'));
  fs.writeFileSync(path.join(root, 'credentials-import.json'), JSON.stringify({ list }, null, 1));
  console.log(`تم: ${rows.length} موظف.` + (dups.length ? ` تكرار SAP اتتخطى: ${dups.join('، ')}` : ''));
}

async function push(url, key, file) {
  const body = JSON.parse(fs.readFileSync(file || path.join(root, 'credentials-import.json'), 'utf8'));
  const r = await fetch(url.replace(/\/$/, '') + '/api/admin/import-credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, ...body }) });
  const text = await r.text(); console.log(r.status, text);
  if (!r.ok) throw new Error('فشل رفع بيانات الحسابات');
}

async function reset(url, username, password, sap) {
  const base = url.replace(/\/$/, '');
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const session = await login.json();
  if (!login.ok || !session.token || !session.user.admin) throw new Error('فشل دخول الأدمن');
  const r = await fetch(base + '/api/admin/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: session.token, sap }) });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || 'فشل إعادة التعيين');
  console.log('الكود المؤقت (يُعرض مرة واحدة):', result.code);
}

const [, , cmd, ...a] = process.argv;
(cmd === 'gen' ? gen() : cmd === 'push' && a.length >= 2 ? push(...a) : cmd === 'reset' && a.length >= 4 ? reset(...a) : Promise.reject(new Error('الاستخدام: gen | push <URL> <ADMIN_KEY> [file] | reset <URL> <ADMIN_USER> <ADMIN_PASS> <SAP>')))
  .catch(e => { console.error(e.message); process.exit(1); });
