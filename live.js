'use strict';
const G = require('./geo');
const live = new Map(), TTL = 6e5;
const ok = body => ({ code: 200, body }), bad = (m, code = 400) => ({ code, body: { error: m } });
function ping(u, b, state) {
  const lat = b.lat, lng = b.lng, k = String(u.sap), prev = live.get(k);
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return bad('Invalid coordinates');
  if (prev && Date.now() - prev.t < 4000) return bad('Too fast', 429);
  const e = (state.employees || []).find(x => String(x.sap) === k);
  live.set(k, { lat, lng, acc: Number(b.acc) || 0, speed: Number.isFinite(b.speed) && b.speed >= 0 ? b.speed : null, t: Date.now(), name: e ? e.name : k, branch: e ? e.branch : '' });
  return ok({ ok: true });
}
const stop = u => { live.delete(String(u.sap)); return ok({ ok: true }); };
function list(state) {
  const now = Date.now(), items = [], used = new Set();
  for (const [sap, v] of live) {
    if (now - v.t > TTL) { live.delete(sap); continue; }
    const br = (state.branches || []).find(x => x && x.name === v.branch), [blat, blng] = String(br && br.coords || '').split(',').map(parseFloat);
    let dist = null, inside = false, eta = null, status = 'sharing';
    if (Number.isFinite(blat) && Number.isFinite(blng)) {
      used.add(v.branch); dist = Math.round(G.haversine({ lat: v.lat, lng: v.lng }, { lat: blat, lng: blng })); inside = dist <= Number(br.radiusMeters || 150);
      const sp = v.speed && v.speed > 1 ? v.speed : null; status = inside ? 'arrived' : sp ? 'en_route' : 'outside';
      if (!inside && sp) eta = Math.max(1, Math.round((dist / sp) / 60));
    }
    items.push({ sap, name: v.name, branch: v.branch, lat: v.lat, lng: v.lng, dist, inside, etaMin: eta, status, ageSec: Math.round((now - v.t) / 1000) });
  }
  const branches = [...used].map(n => { const br = state.branches.find(x => x.name === n), [lat, lng] = br.coords.split(',').map(parseFloat); return { name: n, lat, lng, radius: Number(br.radiusMeters || 150) }; });
  return { items, branches };
}
module.exports = { ping, stop, list, _live: live };
