'use strict';
const R = 6371008.8;
const rad = d => d * Math.PI / 180;

function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const insideCircle = (p, c, radiusM) => haversine(p, c) <= radiusM;

function insidePolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lat > p.lat) !== (b.lat > p.lat) &&
        p.lng < (b.lng - a.lng) * (p.lat - a.lat) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

function speed(a, b) {
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return Infinity;
  return haversine(a, b) / dt;
}

function impossibleJump(a, b, maxMps = 70) {
  const slack = (a.acc || 0) + (b.acc || 0);
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return true;
  return Math.max(0, haversine(a, b) - slack) / dt > maxMps;
}

class Kalman {
  constructor(q = 1e-5) { this.q = q; this.x = null; this.p = 1; }
  update(z, accM) {
    const r = Math.max(1, accM || 10) ** 2 * 1e-10;
    if (this.x === null) { this.x = z; this.p = r; return z; }
    this.p += this.q * 1e-5;
    const k = this.p / (this.p + r);
    this.x += k * (z - this.x); this.p *= (1 - k);
    return this.x;
  }
}
module.exports = { haversine, insideCircle, insidePolygon, speed, impossibleJump, Kalman };
