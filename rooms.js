'use strict';
/* غرف اجتماعات صوتية على طريقة Clubhouse: منصة متكلمين (حد أقصى 4) + جمهور + رفع إيد + المشرف يطلّع ويُنزّل. الصوت WebRTC بين الأجهزة والسيرفر بيمرر الإشارات بس. */
const rooms = new Map(), inbox = new Map(); let seq = 0;
const ok = body => ({ code: 200, body }), bad = (m, code = 400) => ({ code, body: { error: m } });
const nm = (st, sap) => ((st.employees || []).find(e => String(e.sap) === String(sap)) || {}).name || String(sap);
const view = (r, st) => ({ id: r.id, title: r.title, host: r.host, branch: r.branch,
  speakers: [...r.speakers].map(s => ({ sap: s, name: nm(st, s), mod: r.mods.has(s), muted: r.muted.has(s) })),
  audience: [...r.audience].map(s => ({ sap: s, name: nm(st, s), hand: r.hands.has(s) })) });
const canJoin = (u, r) => u.mgr || !r.branch || r.branch === u.branch;
const ice = () => [{ urls: 'stun:stun.l.google.com:19302' }, ...(process.env.TURN_URL ? [{ urls: process.env.TURN_URL, username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' }] : [])];
function drop(r, s) { r.speakers.delete(s); r.audience.delete(s); r.hands.delete(s); r.mods.delete(s); r.muted.delete(s); inbox.delete(s); }
function room(u, b, st) {
  const me = String(u.sap), a = b.act;
  if (a === 'create') {
    if (!u.mgr) return bad('للإدارة فقط', 403);
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 80) return bad('اكتب عنوان للغرفة');
    const id = 'r' + (++seq) + Date.now().toString(36);
    const r = { id, title: b.title.trim(), host: me, branch: typeof b.branch === 'string' ? b.branch.slice(0, 80) : '', mods: new Set([me]), speakers: new Set([me]), audience: new Set(), hands: new Set(), muted: new Set() };
    rooms.set(id, r); return ok({ room: view(r, st), ice: ice() });
  }
  if (a === 'list') return ok({ rooms: [...rooms.values()].filter(r => canJoin(u, r)).map(r => ({ id: r.id, title: r.title, n: r.speakers.size + r.audience.size })) });
  const r = rooms.get(b.id); if (!r || !canJoin(u, r)) return bad('الغرفة مش موجودة', 404);
  const inR = r.speakers.has(me) || r.audience.has(me), mod = r.mods.has(me) || u.admin, t = String(b.target || '');
  if (a === 'join') { if (!inR) { if (r.audience.size >= 25) return bad('الغرفة مليانة', 409); r.audience.add(me); } }
  else if (!inR) return bad('انت مش في الغرفة', 403);
  else if (a === 'leave') { if (r.host === me) { rooms.delete(r.id); return ok({ ended: true }); } drop(r, me); return ok({ left: true }); }
  else if (a === 'end') { if (!(r.host === me || u.admin)) return bad('للمضيف فقط', 403); rooms.delete(r.id); return ok({ ended: true }); }
  else if (a === 'hand') { if (r.audience.has(me)) { r.hands.has(me) ? r.hands.delete(me) : r.hands.add(me); } }
  else if (a === 'mute') { if (r.speakers.has(me)) { r.muted.has(me) ? r.muted.delete(me) : r.muted.add(me); } }
  else if (a === 'promote') { if (!mod) return bad('للمشرف فقط', 403); if (!r.audience.has(t)) return bad('مش في الجمهور'); if (r.speakers.size >= 4) return bad('المنصة مليانة (4)', 409); r.audience.delete(t); r.hands.delete(t); r.speakers.add(t); }
  else if (a === 'demote') { if (!mod) return bad('للمشرف فقط', 403); if (!r.speakers.has(t) || t === r.host) return bad('مينفعش'); r.speakers.delete(t); r.mods.delete(t); r.muted.delete(t); r.audience.add(t); }
  else if (a === 'signal') {
    if (!(r.speakers.has(t) || r.audience.has(t)) || JSON.stringify(b.data || '').length > 12000) return bad('إشارة غير صالحة');
    const q = inbox.get(t) || []; q.push({ room: r.id, from: me, data: b.data }); inbox.set(t, q.slice(-60)); return ok({ ok: true });
  } else if (a !== 'poll') return bad('إجراء غير معروف');
  const sig = inbox.get(me) || []; inbox.set(me, []);
  return ok({ room: view(r, st), signals: sig, ice: ice(), me });
}
module.exports = { room, _rooms: rooms };
