'use strict';
/* تحقق بصري لصور الحضور — تشتغل على بيانات رمادية (Uint8 0-255) سواء من canvas أو من السيرفر */
function gray(rgba) { if (!rgba || !Number.isInteger(rgba.length) || rgba.length === 0 || rgba.length % 4) throw new TypeError('بيانات RGBA غير صالحة'); const n = rgba.length / 4, g = new Uint8Array(n); for (let i = 0; i < n; i++) g[i] = (0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2]) | 0; return g; }
/* حدة الصورة: تباين Laplacian — قيمة قليلة = صورة ضبابية/مصوّرة من شاشة */
function sharpness(g, w, h) {
  validateImage(g, w, h);
  if (w < 3 || h < 3) return 0;
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]; s += l; s2 += l * l; n++;
  }
  const m = s / n; return s2 / n - m * m;
}
function exposure(g) { if (!g || !g.length) throw new TypeError('الصورة فارغة'); let t = 0, dark = 0, bright = 0; for (const v of g) { t += v; if (v < 30) dark++; if (v > 225) bright++; } return { mean: t / g.length, darkRatio: dark / g.length, brightRatio: bright / g.length }; }
/* بصمة متوسطة aHash 8×8 لاكتشاف إعادة استخدام نفس الصورة */
function aHash(g, w, h) {
  validateImage(g, w, h);
  const cells = new Float64Array(64), cnt = new Float64Array(64);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = ((y * 8 / h) | 0) * 8 + ((x * 8 / w) | 0); cells[c] += g[y * w + x]; cnt[c]++; }
  const avg = cells.map((v, i) => v / cnt[i]), mean = avg.reduce((a, b) => a + b, 0) / 64;
  return avg.map(v => (v >= mean ? 1 : 0)).join('');
}
const hamming = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) throw new TypeError('البصمتان غير متوافقتين'); let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };
/* حكم الجودة — تنبيه للأدمن فقط */
function assessPhoto(g, w, h, prevHashes = []) {
  validateImage(g, w, h);
  if (!Array.isArray(prevHashes)) throw new TypeError('prevHashes يجب أن تكون مصفوفة');
  const sh = sharpness(g, w, h), ex = exposure(g), hash = aHash(g, w, h), reasons = [];
  if (sh < 40) reasons.push('الصورة ضبابية أو مصوّرة من شاشة');
  if (ex.mean < 40 || ex.darkRatio > 0.6) reasons.push('إضاءة ضعيفة جدًا');
  if (ex.mean > 215 || ex.brightRatio > 0.5) reasons.push('إضاءة زائدة');
  if (prevHashes.some(p => hamming(p, hash) <= 3)) reasons.push('صورة مشابهة جدًا لصورة سابقة (احتمال إعادة استخدام)');
  return { ok: reasons.length === 0, sharpness: +sh.toFixed(1), exposure: ex, hash, reasons };
}
function validateImage(g, w, h) { if (!g || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || g.length !== w * h) throw new RangeError('أبعاد الصورة لا تطابق بيانات البكسل'); }
module.exports = { gray, sharpness, exposure, aHash, hamming, assessPhoto };
