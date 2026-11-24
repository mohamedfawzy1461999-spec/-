'use strict';
/* تكامل: بوابة الحضور، الخروج من النطاق (إشعار + إنذار للأدمن تلقائي)، ومنع الانصراف قبل 9 ساعات */
const { spawn } = require('child_process'), os = require('os'), path = require('path'), fs = require('fs');
const D = path.join(os.tmpdir(), 'bim_s_data.json'), AU = path.join(os.tmpdir(), 'bim_s_auth.json');
fs.rmSync(D, { force: true }); fs.rmSync(AU, { force: true });
const P = 4602, B = 'http://127.0.0.1:' + P;
const sv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: P, DATA_FILE: D, AUTH_FILE: AU, ADMIN_USER: 'admin', ADMIN_PASS: 'adminpass1', JWT_SECRET: 'z'.repeat(32) }, stdio: 'ignore' });
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ c: r.status, j: await r.json().catch(() => ({})) }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const t = (n, ok) => { console.log((ok ? '✓ ' : '✗ ') + n); if (!ok) fails++; };
(async () => {
  for (let i = 0; i < 40; i++) { try { if ((await (await fetch(B + '/healthz')).text()) === 'ok') break; } catch {} await sleep(200); }
  const at = (await post('/api/login', { username: 'admin', password: 'adminpass1' })).j.token;
  await post('/api/state', { q: { token: at }, full: { employees: [], branches: [{ code: 'E1', name: 'B1', coords: '30.0, 31.0', radiusMeters: 150, linkedByUser: true }] } });
  await post('/api/admin/users', { token: at, sap: 'E1001', name: 'Test', branch: 'B1', role: 'موظف', username: 'emp1', password: 'temp12345' });
  let l = await post('/api/login', { username: 'emp1', password: 'temp12345' });
  await post('/api/me/credentials', { token: l.j.token, oldPassword: 'temp12345', newPassword: 'newpass123' });
  const et = (await post('/api/login', { username: 'emp1', password: 'newpass123' })).j.token;
  const view = async tok => (await post('/api/state', { q: { token: tok }, patch: {} })).j.view;
  const emp = v => v.employees.find(x => x.sap === 'E1001');
  const id = emp(await view(et)).id;
  const patchE = patch => post('/api/state', { q: { token: et }, patch: { employees: [{ id, ...patch }] } }).then(r => emp(r.j.view));

  await post('/api/attendance/event', { token: et, lat: 30.0005, lng: 31.0, acc: 10, deviceTime: Date.now(), deviceId: 'd1' });
  let e = await patchE({ status: 'PRESENT', checkInTime: '09:00' });
  t('حضور بعد تحقق السيرفر: PRESENT + وقت دخول من السيرفر', e.status === 'PRESENT' && e.inBranch === true && Number.isFinite(e.checkInAt));

  const out = await post('/api/attendance/presence', { token: et, lat: 30.01, lng: 31.0, acc: 10 });
  t('خرج بره النطاق: السيرفر بيقرر', out.j.inside === false && out.j.dist > 150);
  let av = await view(at), ev = await view(et);
  t('الأدمن وصله إشعار خروج تلقائي', av.notifications.some(n => /خرج من الفرع/.test(n.title) && n.severity === 'URGENT'));
  t('الأدمن وصله إنذار (قبل 9 ساعات)', (av.fraudAlerts || []).some(a => a.type === 'out_range' && /قبل اكتمال 9 ساعات/.test(a.title)));
  t('الإحداثيات ماتخزنتش — مسافة ووقت بس', !JSON.stringify(emp(av).exitLog).includes('lat') && emp(av).exitLog[0].dist > 150);
  t('الموظف العادي ميشوفش إشعارات/إنذارات الخروج', !(ev.notifications || []).some(n => /خرج من الفرع/.test(n.title)) && !ev.fraudAlerts);
  e = await patchE({ inBranch: true, status: 'ABSENT', exitLog: [] });
  t('الموظف مايقدرش يمسح الخروج ولا ينصرف قبل 9 ساعات', e.status === 'PRESENT' && e.inBranch === false && e.exitLog.length === 1);

  await sleep(5200);
  await post('/api/attendance/presence', { token: et, lat: 30.0003, lng: 31.0, acc: 10 });
  av = await view(at);
  t('رجع للفرع: اتسجلت العودة وإشعار للأدمن', emp(av).inBranch === true && emp(av).exitLog[0].back && av.notifications.some(n => /عودة للفرع/.test(n.title)));

  await post('/api/state', { q: { token: at }, patch: { employees: [{ id, checkInAt: Date.now() - 10 * 3600e3 }] } });
  e = await patchE({ status: 'ABSENT' });
  t('بعد 9 ساعات: الانصراف يتقبل', e.status === 'ABSENT' && e.inBranch === false && e.checkInAt === null);
  sv.kill(); process.exit(fails ? 1 : 0);
})().catch(x => { console.error(x); sv.kill(); process.exit(1); });
