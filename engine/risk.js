'use strict';
const { impossibleJump } = require('./geo');

const LR = {
  mockFlag: 40, rooted: 8, devOptions: 2, integrityFail: 30,
  impossibleJump: 25, clockSkew: 6, lowAccuracy: 1.5, gpsOffRepeat: 3, outsideRepeat: 2.5, newDevice: 2,
};
const odds = p => p / (1 - p), prob = o => o / (1 + o);

function updateSuspicion(prior, signals) {
  let o = odds(Math.min(0.999, Math.max(0.001, prior == null ? 0.02 : prior)));
  for (const s of signals) if (LR[s]) o *= LR[s];
  if (!signals.length) o *= 0.85;
  return Math.min(0.999, Math.max(0.001, prob(o)));
}
const trustScore = suspicion => Math.round((1 - suspicion) * 100);

function zScore(x, mean, sd) { return sd > 0 ? (x - mean) / sd : 0; }
function stats(arr) {
  const n = arr.length; if (!n) return { mean: 0, sd: 0, n };
  const mean = arr.reduce((s, v) => s + v, 0) / n;
  return { mean, sd: Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1)), n };
}

function assess(ev, ctx = {}) {
  const sig = [], why = [];
  if (ev.mock) { sig.push('mockFlag'); why.push('Mock location detected'); }
  if (ev.rooted) { sig.push('rooted'); why.push('Rooted device'); }
  if (ev.devOptions) { sig.push('devOptions'); why.push('Developer options enabled'); }
  if (ev.integrityOk === false) { sig.push('integrityFail'); why.push('Play Integrity check failed'); }
  const skew = Math.abs((ev.serverT || Date.now()) - (ev.t || 0));
  if (skew > 120000) { sig.push('clockSkew'); why.push(`Device clock skew ${Math.round(skew / 1000)}s`); }
  if (ev.acc > 150) { sig.push('lowAccuracy'); why.push(`Low GPS accuracy ${Math.round(ev.acc)}m`); }
  if (ctx.last && impossibleJump(ctx.last, { lat: ev.lat, lng: ev.lng, acc: ev.acc, t: ev.serverT || ev.t })) {
    sig.push('impossibleJump'); why.push('Impossible location jump');
  }
  if (ctx.deviceIds && ev.deviceId && ctx.deviceIds.size && !ctx.deviceIds.has(ev.deviceId)) { sig.push('newDevice'); why.push('First-time device'); }
  let z = 0;
  if (ctx.history && ctx.history.minutes && ctx.history.minutes.length >= 5 && ev.minuteOfDay != null) {
    const s = stats(ctx.history.minutes); z = zScore(ev.minuteOfDay, s.mean, s.sd);
    if (Math.abs(z) > 3) why.push(`Unusual time (Z=${z.toFixed(1)})`);
  }
  const suspicion = updateSuspicion(ctx.suspicion, sig);
  const level = suspicion >= 0.6 ? 'HIGH' : suspicion >= 0.2 ? 'MEDIUM' : 'LOW';
  return { suspicion, trust: trustScore(suspicion), level, signals: sig, reasons: why, z };
}
module.exports = { assess, updateSuspicion, trustScore, zScore, stats, LR };
