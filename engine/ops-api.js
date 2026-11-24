'use strict';
const O = require('../ops'), P = require('../optical'), AI = require('../ai'), LV = require('../live'), RM = require('../rooms');
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const num = v => typeof v === 'number' && Number.isFinite(v);
const ok = (body, dirty) => ({ code: 200, body, dirty: !!dirty }), bad = (m, code = 400) => ({ code, body: { error: m } });

function staffing({ lambda, mu, target }) {
  if (![lambda, mu, target].every(num) || lambda < 0 || mu <= 0 || target < 0) return bad('Invalid parameters');
  const r = O.minServers(lambda, mu, target);
  if (!r) return bad('No feasible solution within 200 servers', 422);
  return ok({
    servers: r.c,
    rho: +r.rho.toFixed(3),
    pWait: +r.pWait.toFixed(3),
    wqMin: +r.wq.toFixed(2),
    explain: `Need ${r.c} servers. Utilization ${Math.round(r.rho * 100)}%, wait probability ${Math.round(r.pWait * 100)}%, avg wait ${r.wq.toFixed(2)} min (target ${target}).`
  });
}

function schedule(u, b, state) {
  const need = { MORNING: b.needMorning, NIGHT: b.needNight };
  if (!int(b.days, 1, 31) || !int(need.MORNING, 0, 50) || !int(need.NIGHT, 0, 50)) return bad('Invalid days or shift requirements');
  const names = {};
  for (const e of state.employees || []) if (e && e.sap != null && (!b.branch || e.branch === b.branch)) names[String(e.sap)] = e.name;
  if (!Object.keys(names).length) return bad('No employees found for branch', 422);
  let r;
  try {
    r = O.scheduleOptimal({ staff: Object.keys(names), days: b.days, shifts: ['MORNING', 'NIGHT'], need });
  } catch (e) {
    return bad(e.message);
  }
  const id = 'plan_' + Date.now().toString(36);
  state.opsPlans = [{ id, t: Date.now(), by: String(u.sap), branch: b.branch || 'ALL', days: b.days, need, status: 'PENDING', result: r, names }, ...(state.opsPlans || [])].slice(0, 30);
  const miss = r.gaps.reduce((s, g) => s + g.missing, 0);
  return ok({
    id,
    plan: r.plan,
    names,
    fairness: r.fairness,
    gaps: r.gaps,
    explain: `Schedule for ${Object.keys(names).length} staff over ${b.days} days. ` +
      (miss ? `Missing ${miss} slots (insufficient staff).` : 'Full coverage.') +
      ` Fairness spread ${r.fairness} shifts, morning/night switches ${r.switches} (greedy baseline ${r.baseline.switches}). Pending admin approval.`,
    switches: r.switches,
    baseline: r.baseline
  }, true);
}

function approve({ id, decision }, state) {
  const p = (state.opsPlans || []).find(x => x.id === id);
  if (!p) return bad('Plan not found', 404);
  if (!['APPROVED', 'REJECTED'].includes(decision)) return bad('Invalid decision');
  p.status = decision;
  return ok({ id, status: p.status }, true);
}

function assign({ rows, cols, cost }) {
  const strs = a => Array.isArray(a) && a.length >= 1 && a.length <= 50 && a.every(x => typeof x === 'string' && x);
  if (!strs(rows) || !strs(cols) || rows.length > cols.length) return bad('Rows must be <= columns (max 50)');
  let r;
  try {
    r = O.hungarian(cost);
  } catch (e) {
    return bad(e.message);
  }
  if (cost.length !== rows.length || cost[0].length !== cols.length) return bad('Cost matrix dimensions mismatch');
  const pairs = r.assign.map((j, i) => ({ row: rows[i], col: cols[j], cost: cost[i][j] }));
  return ok({
    pairs,
    total: r.cost,
    explain: `Minimum total cost ${r.cost}: ` + pairs.map(p => `${p.row}->${p.col}`).join(', ')
  });
}

function photo(u, b, state) {
  const { w, h, gray } = b;
  if (!int(w, 8, 128) || !int(h, 8, 128) || !Array.isArray(gray) || gray.length !== w * h || !gray.every(v => int(v, 0, 255))) return bad('Invalid image data');
  const store = (state.photoHashes ||= {}), key = String(u.sap), prev = (store[key] || []).filter(x => typeof x === 'string');
  let r;
  try {
    r = P.assessPhoto(Uint8Array.from(gray), w, h, prev);
  } catch (e) {
    return bad(e.message);
  }
  store[key] = [r.hash, ...prev].slice(0, 20);
  if (!r.ok) {
    const e = (state.employees || []).find(x => String(x.sap) === key) || {};
    state.securityLog = [{ t: Date.now(), kind: 'PHOTO', sap: key, name: e.name, branch: e.branch, level: 'MEDIUM', reasons: r.reasons }, ...(state.securityLog || [])].slice(0, 1000);
  }
  return ok({
    ok: r.ok,
    sharpness: r.sharpness,
    exposure: r.exposure,
    reasons: r.reasons,
    explain: r.ok ? 'Photo valid: sharp, well-exposed, and not duplicated.' : 'Admin alert: ' + r.reasons.join(', ')
  }, true);
}

async function brief(b, state) {
  const now = Date.now(), sec = (state.securityLog || []).filter(x => now - x.t < 864e5), n = f => sec.filter(f).length;
  const plan = (state.opsPlans || [])[0], lv = LV.list(state).items;
  const stf = [b.lambda, b.mu, b.target].every(num) && b.mu > 0 && b.lambda >= 0 && b.target >= 0 ? O.minServers(b.lambda, b.mu, b.target) : null;
  const facts = {
    high_security_alerts_24h: n(x => x.level === 'HIGH'),
    medium_security_alerts_24h: n(x => x.level === 'MEDIUM'),
    suspicious_photos_24h: n(x => x.kind === 'PHOTO'),
    latest_plan: plan ? { status: plan.status, fairness: plan.result.fairness, gaps: plan.result.gaps.length, switches: plan.result.switches } : null,
    required_servers: stf ? stf.c : null,
    sharing_location: lv.length,
    en_route: lv.filter(x => x.status === 'en_route').length,
    outside: lv.filter(x => x.status === 'outside').length,
    arrived: lv.filter(x => x.inside).length
  };
  const q = typeof b.q === 'string' ? b.q.slice(0, 400) : '';
  const fb = Object.entries(facts).filter(([, v]) => v !== null).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
  const a = await AI.ask('Data:\n' + JSON.stringify(facts) + (q ? '\nManager question: ' + q : '\nProvide an operations summary and top 3 recommendations.'), fb);
  return ok({ facts, text: a.text, llm: a.llm });
}

async function enrich(r) {
  if (r.code === 200 && r.body.explain) {
    const a = await AI.ask('Calculation result (explain to manager in 3 lines and highlight any gaps):\n' + r.body.explain, r.body.explain);
    r.body.explain = a.text;
    r.body.llm = a.llm;
  }
  return r;
}

async function handle(p, u, b, state) {
  if (!state) return bad('loading', 503);
  if (p === '/api/ops/photo') return photo(u, b, state);
  if (p === '/api/ops/ping') return LV.ping(u, b, state);
  if (p === '/api/ops/stop') return LV.stop(u);
  if (p === '/api/ops/room') return RM.room(u, b, state);
  if (!u.mgr) return bad('Forbidden', 403);
  if (p === '/api/ops/live') return ok(LV.list(state));
  if (p === '/api/ops/brief') return brief(b, state);
  if (p === '/api/ops/staffing') return enrich(staffing(b));
  if (p === '/api/ops/schedule') return enrich(schedule(u, b, state));
  if (p === '/api/ops/assign') return assign(b);
  if (p === '/api/ops/approve') return u.admin ? approve(b, state) : bad('Forbidden', 403);
  return bad('not found', 404);
}

module.exports = { handle };
