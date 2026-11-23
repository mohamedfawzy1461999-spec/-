'use strict';
const assert = require('assert'), { haversine, insidePolygon, impossibleJump, speed } = require('../engine/geo'), R = require('../engine/risk');
let n = 0; const t = (name, f) => { f(); n++; console.log('✓', name); };
const A = { lat: 30.5965, lng: 32.2715 }; // الإسماعيلية تقريباً

t('haversine: نقطة لنفسها = 0', () => assert.strictEqual(haversine(A, A), 0));
t('haversine: 0.001° عرض ≈ 111م', () => { const d = haversine(A, { lat: A.lat + 0.001, lng: A.lng }); assert(Math.abs(d - 111.2) < 1, d); });
t('haversine: القاهرة↔الإسماعيلية ≈ 105-125كم', () => { const d = haversine({ lat: 30.0444, lng: 31.2357 }, A) / 1000; assert(d > 105 && d < 125, d); });
t('مضلع: داخل/خارج', () => { const sq = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 0 }];
  assert(insidePolygon({ lat: .5, lng: .5 }, sq)); assert(!insidePolygon({ lat: 1.5, lng: .5 }, sq)); });
t('سرعة: 111م في 10ث ≈ 11م/ث', () => { const v = speed({ ...A, t: 0 }, { lat: A.lat + .001, lng: A.lng, t: 10000 }); assert(Math.abs(v - 11.1) < .2, v); });
t('قفزة مستحيلة: 100كم في 60ث', () => assert(impossibleJump({ ...A, t: 0 }, { lat: A.lat + .9, lng: A.lng, t: 60000 })));
t('قفزة عادية: مشي 50م في 60ث ليست مستحيلة', () => assert(!impossibleJump({ ...A, acc: 5, t: 0 }, { lat: A.lat + .00045, lng: A.lng, acc: 5, t: 60000 })));
t('قفزة: Δt<=0 مستحيلة', () => assert(impossibleJump({ ...A, t: 5 }, { ...A, t: 5 })));
t('بايز: موقع وهمي يرفع الاشتباه بقوة', () => { const s = R.updateSuspicion(0.02, ['mockFlag']); assert(s > 0.4, s); });
t('بايز: 10 حركات نظيفة ترجّع الاشتباه لمستوى LOW (<0.2)', () => { let s = 0.5; for (let i = 0; i < 10; i++) s = R.updateSuspicion(s, []); assert(s < 0.2, s); });
t('assess: حدث نظيف = LOW', () => { const now = Date.now(); const r = R.assess({ ...A, acc: 10, t: now, serverT: now, deviceId: 'd1', integrityOk: true }, { deviceIds: new Set(['d1']) }); assert.strictEqual(r.level, 'LOW'); });
t('assess: mock + قفزة = HIGH مع أسباب', () => { const now = Date.now();
  const r = R.assess({ lat: A.lat + .9, lng: A.lng, acc: 10, t: now, serverT: now, mock: true }, { last: { ...A, acc: 10, t: now - 60000 } });
  assert.strictEqual(r.level, 'HIGH'); assert(r.reasons.length >= 2); });
t('Z-score: توقيت شاذ يتسجّل', () => { const r = R.assess({ ...A, acc: 5, t: Date.now(), serverT: Date.now(), minuteOfDay: 180 }, { history: { minutes: [480, 485, 478, 490, 482, 479] } }); assert(Math.abs(r.z) > 3); });
console.log(`\n${n} اختبار نجح`);
