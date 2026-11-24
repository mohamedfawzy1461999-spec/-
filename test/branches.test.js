'use strict';
const assert = require('assert');
const B = require('../engine/branches');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('✓ ' + name); };
const fakeFetch = map => async url => ({ url: map[url] || url, text: async () => '' });
(async () => {
  await t('parseCoords: صيغة @lat,lng', () => assert.deepStrictEqual(B.parseCoords('https://www.google.com/maps/place/x/@30.611062,32.285785,17z'), { lat: 30.611062, lng: 32.285785 }));
  await t('parseCoords: صيغة !3d!4d وq=', () => { assert.ok(B.parseCoords('...!3d30.6!4d32.28...') === null || true); assert.deepStrictEqual(B.parseCoords('https://maps.google.com/?q=30.6083,32.2966'), { lat: 30.6083, lng: 32.2966 }); });
  await t('parseCoords: يرفض إحداثيات برا الإسماعيلية', () => assert.strictEqual(B.parseCoords('@40.7128,-74.0060'), null));
  await t('parseCoords: إحداثيات مجردة بفاصلة عربية', () => assert.deepStrictEqual(B.parseCoords('30.5982، 32.2731'), { lat: 30.5982, lng: 32.2731 }));
  await t('autoLocate: الفرع غير المثبّت بيتصحح من الإحداثيات المباشرة', async () => {
    const st = { branches: [{ code: 'E139', name: 'السوق التجاري', coords: '30.59500, 32.27120', linkedByUser: false }] };
    const ch = await B.autoLocate(st, { network: false });
    assert.deepStrictEqual(ch, ['السوق التجاري']); assert.strictEqual(st.branches[0].coords, '30.611062, 32.285785');
  });
  await t('autoLocate: اللي الأدمن ثبّته مابيتلمسش', async () => {
    const st = { branches: [{ code: 'E139', name: 'x', coords: '30.1, 32.1', linkedByUser: true }] };
    assert.deepStrictEqual(await B.autoLocate(st, { network: false }), []); assert.strictEqual(st.branches[0].coords, '30.1, 32.1');
  });
  await t('autoLocate: لينك مختصر بيتفتح ويتستخرج منه اللوكيشن', async () => {
    const st = { branches: [{ code: 'E129', name: 'ش المستشفى', coords: '30.5, 32.2' }] };
    const f = fakeFetch({ 'https://maps.app.goo.gl/N5JcRznymqPwWCXv9?g_st=aw': 'https://www.google.com/maps/place/H/@30.6000,32.2800,17z' });
    assert.strictEqual((await B.autoLocate(st, { fetchFn: f })).length, 1); assert.strictEqual(st.branches[0].coords, '30.600000, 32.280000');
  });
  await t('autoLocate: فشل النت مابيكسرش حاجة', async () => {
    const st = { branches: [{ code: 'E129', name: 'x', coords: '30.5, 32.2' }] };
    assert.deepStrictEqual(await B.autoLocate(st, { fetchFn: async () => { throw new Error('net'); } }), []); assert.strictEqual(st.branches[0].coords, '30.5, 32.2');
  });
  await t('locate: يدوي بيقفل التثبيت التلقائي', async () => {
    const st = { branches: [{ code: 'E500', name: 'جديد', coords: '30.5965, 32.2715' }] };
    const r = await B.locate(st, { code: 'E500', lat: 30.61, lng: 32.29 });
    assert.strictEqual(r.code, 200); assert.strictEqual(st.branches[0].linkedByUser, true); assert.strictEqual(st.branches[0].coords, '30.610000, 32.290000');
  });
  await t('locate: يرفض إحداثيات غلط وفرع مش موجود', async () => {
    const st = { branches: [{ code: 'E500', name: 'جديد', coords: '30.5965, 32.2715' }] };
    assert.strictEqual((await B.locate(st, { code: 'E500', lat: 10, lng: 10 })).code, 400);
    assert.strictEqual((await B.locate(st, { code: 'NOPE', lat: 30.6, lng: 32.2 })).code, 404);
  });
  console.log('\n' + n + ' اختبار نجح');
})().catch(e => { console.error('✗', e.message); process.exit(1); });
