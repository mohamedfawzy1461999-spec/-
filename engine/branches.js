'use strict';
/* إحداثيات الفروع: استخراج من إحداثيات أو لينك جوجل ماب، وتثبيت تلقائي للفروع اللي لسه مالهاش لوكيشن حقيقي.
   الفرع اللي الأدمن ثبّته بنفسه (linkedByUser=true) عمره ما بيتغيّر تلقائي. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const inRegion = (lat, lng) => lat > 29.8 && lat < 31.2 && lng > 31.8 && lng < 32.8;   // حدود الإسماعيلية تقريباً (حماية من إحداثيات غلط)

// كود الفرع → إحداثيات مباشرة { lat, lng } أو لينك جوجل ماب
const BRANCH_LINKS = {
  E139: { lat: 30.611062, lng: 32.285785 },   // السوق التجاري
  E239: { lat: 30.608363, lng: 32.296672 },   // أم القرى
  E129: 'https://maps.app.goo.gl/N5JcRznymqPwWCXv9?g_st=aw',   // شارع المستشفى
  E128: 'https://maps.app.goo.gl/jXFNjkGdWKeCMPcs9?g_st=aw',   // شبين - الإسماعيلية
  E140: 'https://maps.app.goo.gl/nmtuj5mQaWZ6xq1f8?g_st=aw',   // الاستاد
  E103: 'https://maps.app.goo.gl/XxUVugJa6AidM7WU9?g_st=aw',   // هدى شعراوي
  E285: 'https://maps.app.goo.gl/6pmQUJDN4zX1LYwR7?g_st=aw',   // شارع بورسعيد
  E385: 'https://maps.app.goo.gl/u7QPQ2AVaB8mfC3m9?g_st=aw',   // التكنولوجيا
  E400: 'https://maps.app.goo.gl/TZNJ9kkMy2PCbrMR9?g_st=ac',   // صبري
  E137: 'https://maps.app.goo.gl/dLZvpfzZcD7hHysr5?g_st=ac',   // الشيخ زايد
};

function parseCoords(text) {
  const pats = [
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/g,
    /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/g,
    /center=(-?\d{1,3}\.\d+)(?:%2C|,)(-?\d{1,3}\.\d+)/g,
    /[?&]q=(-?\d{1,3}\.\d+)(?:%2C|,)(-?\d{1,3}\.\d+)/g,
    /^\s*(-?\d{1,3}\.\d+)\s*[,،\s]\s*(-?\d{1,3}\.\d+)\s*$/g,
  ];
  for (const re of pats) for (const m of String(text).matchAll(re)) {
    const lat = Number(m[1]), lng = Number(m[2]);
    if (inRegion(lat, lng)) return { lat, lng };
  }
  return null;
}

async function coordsFromLink(url, fetchFn = fetch) {
  const r = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8' } });
  const finalUrl = r.url, html = await r.text();
  let name = ''; try { name = decodeURIComponent((finalUrl.match(/\/maps\/place\/([^/]+)/) || [])[1] || '').replace(/\+/g, ' '); } catch {}
  return { name, coords: parseCoords(finalUrl) || parseCoords(html) };
}

const fmt = c => `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`;

/* يثبّت لوكيشن الفروع غير المثبّتة من الأدمن. direct فقط = من غير نت. بيرجّع الفروع اللي اتغيّرت. */
async function autoLocate(state, { network = true, fetchFn } = {}) {
  const changed = [];
  for (const b of (state && Array.isArray(state.branches) ? state.branches : [])) {
    if (!b || b.linkedByUser === true || !BRANCH_LINKS[b.code]) continue;
    let c = null; const link = BRANCH_LINKS[b.code];
    if (typeof link === 'object') c = link;
    else if (network) { try { c = (await coordsFromLink(link, fetchFn)).coords; } catch { c = null; } }
    if (!c) continue;
    const next = fmt(c);
    if (b.coords !== next) { b.coords = next; b.autoLocated = true; changed.push(b.name || b.code); }
  }
  return changed;
}

/* تثبيت يدوي من الأدمن: إحداثيات أو نص إحداثيات أو لينك */
async function locate(state, { code, name, lat, lng, text }, fetchFn) {
  const b = (state.branches || []).find(x => x && ((code && x.code === code) || (name && x.name === name)));
  if (!b) return { code: 404, body: { error: 'الفرع مش موجود' } };
  let c = null, place = '';
  if (lat != null && lng != null) { c = { lat: Number(lat), lng: Number(lng) }; if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng) || !inRegion(c.lat, c.lng)) c = null; }
  else if (text) {
    const t = String(text).trim(); c = parseCoords(t);
    if (!c && /^https?:\/\//.test(t)) { try { const r = await coordsFromLink(t, fetchFn); c = r.coords; place = r.name; } catch { /* يرجع للخطأ تحت */ } }
  }
  if (!c) return { code: 400, body: { error: 'مقدرتش أطلع إحداثيات داخل نطاق الإسماعيلية. ابعت lat و lng أو لينك جوجل ماب' } };
  b.coords = fmt(c); b.linkedByUser = true; delete b.autoLocated;
  return { code: 200, body: { ok: true, branch: b.name, coords: b.coords, place_name: place }, dirty: true };
}
module.exports = { parseCoords, coordsFromLink, autoLocate, locate, inRegion, BRANCH_LINKS };
