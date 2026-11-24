'use strict';
const assert = require('assert'), { handle: H } = require('../engine/ops-api'), O = require('../engine/ops'), RM = require('../engine/rooms'), LV = require('../engine/live');
const st = { employees: ['1', '2', '3', '4'].map(s => ({ sap: s, name: 'م' + s, branch: 'ب1' })), branches: [{ name: 'ب1', coords: '30.0,31.0', radiusMeters: 100 }] };
const mgr = { sap: 'M', mgr: true }, adm = { sap: 'A', mgr: true, admin: true }, e1 = { sap: '1', branch: 'ب1' }, e2 = { sap: '2', branch: 'ب1' };
(async () => {
  let t = 0; const ok = async (n, f) => { await f(); t++; console.log('✓ ' + n); };
  await ok('الموظف العادي ممنوع من الجدولة', async () => assert.strictEqual((await H('/api/ops/schedule', e1, {}, st)).code, 403));
  await ok('Erlang يرجّع عدد نقاط', async () => assert.ok((await H('/api/ops/staffing', mgr, { lambda: 2, mu: 1, target: 1 }, st)).body.servers >= 3));
  let id; await ok('جدولة مثلى تتخزن PENDING', async () => { const r = await H('/api/ops/schedule', mgr, { days: 4, needMorning: 1, needNight: 1, branch: 'ب1' }, st); assert.strictEqual(r.code, 200); id = r.body.id; assert.strictEqual(st.opsPlans[0].status, 'PENDING'); });
  await ok('المدير مش بيوافق والأدمن بيوافق', async () => { assert.strictEqual((await H('/api/ops/approve', mgr, { id, decision: 'APPROVED' }, st)).code, 403); await H('/api/ops/approve', adm, { id, decision: 'APPROVED' }, st); assert.strictEqual(st.opsPlans[0].status, 'APPROVED'); });
  await ok('المثلى: تغطية كاملة وتبديلات أقل أو مساوية للجشعة', async () => { const a = { staff: ['a', 'b', 'c', 'd'], days: 6, shifts: ['MORNING', 'NIGHT'], need: { MORNING: 1, NIGHT: 1 } }, r = O.scheduleOptimal(a); assert.strictEqual(r.gaps.length, 0); assert.ok(r.switches <= r.baseline.switches); assert.ok(r.fairness <= 1); });
  await ok('المثلى: تكشف النقص وترفض المدخلات الغلط', async () => { assert.ok(O.scheduleOptimal({ staff: ['a'], days: 2, shifts: ['MORNING', 'NIGHT'], need: { MORNING: 1, NIGHT: 1 } }).gaps.length > 0); assert.throws(() => O.scheduleOptimal({ staff: [], days: -1, shifts: [], need: {} })); });
  await ok('توزيع مجري', async () => assert.strictEqual((await H('/api/ops/assign', mgr, { rows: ['x', 'y'], cols: ['p', 'q'], cost: [[4, 9], [6, 2]] }, st)).body.total, 6));
  await ok('صورة مكررة تتكشف وتتسجل في سجل الأمان', async () => { const p = { w: 8, h: 8, gray: Array.from({ length: 64 }, (_, i) => (i * 37) % 256) }; await H('/api/ops/photo', e1, p, st); const r = await H('/api/ops/photo', e1, p, st); assert.ok(r.body.reasons.some(x => /مشابهة/.test(x))); assert.ok(st.securityLog.some(x => x.kind === 'PHOTO')); });
  await ok('تتبع حي: وصل / في الطريق، والموظف ميشوفش القايمة', async () => {
    await H('/api/ops/ping', e1, { lat: 30.0, lng: 31.0 }, st); await H('/api/ops/ping', e2, { lat: 30.01, lng: 31.0, speed: 10 }, st);
    const r = (await H('/api/ops/live', mgr, {}, st)).body.items, s = x => r.find(i => i.sap === x);
    assert.strictEqual(s('1').status, 'وصل'); assert.strictEqual(s('2').status, 'في الطريق'); assert.ok(s('2').etaMin >= 1);
    assert.strictEqual((await H('/api/ops/live', e1, {}, st)).code, 403); await H('/api/ops/stop', e1, {}, st); assert.ok(!LV._live.has('1'));
  });
  await ok('تتبع: إحداثيات غلط ترفض', async () => assert.strictEqual((await H('/api/ops/ping', e1, { lat: 999, lng: 0 }, st)).code, 400));
  await ok('غرفة صوتية: رفع إيد وترقية ونزول', async () => {
    const c = (await H('/api/ops/room', mgr, { act: 'create', title: 'اجتماع' }, st)).body.room.id, R = (u, b) => H('/api/ops/room', u, { id: c, ...b }, st);
    await R(e1, { act: 'join' }); await R(e1, { act: 'hand' });
    assert.strictEqual((await R(e1, { act: 'promote', target: '1' })).code, 403);
    assert.strictEqual((await R(mgr, { act: 'promote', target: '1' })).code, 200);
    const v = (await R(e1, { act: 'poll' })).body.room; assert.ok(v.speakers.some(s => s.sap === '1')); assert.strictEqual(v.audience.length, 0);
    await R(e2, { act: 'join' }); await R(e2, { act: 'signal', target: '1', data: { type: 'offer' } });
    assert.strictEqual((await R(e1, { act: 'poll' })).body.signals[0].from, '2');
    await R(mgr, { act: 'demote', target: '1' }); assert.ok((await R(e1, { act: 'poll' })).body.room.audience.some(a => a.sap === '1'));
    assert.strictEqual((await R(mgr, { act: 'end' })).body.ended, true); assert.strictEqual((await R(e1, { act: 'poll' })).code, 404);
  });
  await ok('غرفة: المنصة 4 بالكتير', async () => {
    const c = (await H('/api/ops/room', mgr, { act: 'create', title: 'x' }, st)).body.room.id, R = (u, b) => H('/api/ops/room', u, { id: c, ...b }, st), us = ['1', '2', '3', '4'].map(s => ({ sap: s, branch: 'ب1' }));
    for (const u of us) await R(u, { act: 'join' }); const codes = []; for (const u of us) codes.push((await R(mgr, { act: 'promote', target: u.sap })).code);
    assert.deepStrictEqual(codes, [200, 200, 200, 409]);
  });
  await ok('الملخص الذكي بيرجع حقايق ونص (بدون مفتاح = قالب)', async () => { const r = await H('/api/ops/brief', mgr, { lambda: 2, mu: 1, target: 1 }, st); assert.strictEqual(r.code, 200); assert.strictEqual(r.body.facts.نقاط_تسجيل_مطلوبة, 3); assert.ok(r.body.text.length > 10); });
  console.log(`\n${t} اختبار نجح`);
})().catch(e => { console.error('✗', e); process.exit(1); });
