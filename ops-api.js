'use strict';
/* API محركات الهندسة والبحوث والتحقق البصري. السيرفر يحسب، والشرح قوالب عربية ثابتة (مش LLM)، والأدمن هو اللي يوافق. */
const O = require('../ops'), P = require('../optical'), AI = require('../ai'), LV = require('../live'), RM = require('../rooms');
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const num = v => typeof v === 'number' && Number.isFinite(v);
const ok = (body, dirty) => ({ code: 200, body, dirty: !!dirty }), bad = (m, code = 400) => ({ code, body: { error: m } });

function staffing({ lambda, mu, target }) {
  if (![lambda, mu, target].every(num) || lambda < 0 || mu <= 0 || target < 0) return bad('الوصول/الخدمة/الانتظار لازم أرقام صالحة');
  const r = O.minServers(lambda, mu, target);
  if (!r) return bad('مفيش حل ضمن 200 نقطة تسجيل', 422);
  return ok({ servers: r.c, rho: +r.rho.toFixed(3), pWait: +r.pWait.toFixed(3), wqMin: +r.wq.toFixed(2),
    explain: `محتاج ${r.c} نقطة تسجيل. نسبة الانشغال ${Math.round(r.rho * 100)}%، واحتمال إن الموظف يستنى ${Math.round(r.pWait * 100)}%، ومتوسط الانتظار ${r.wq.toFixed(2)} دقيقة (الهدف ${target}).` });
}
function schedule(u, b, state) {
  const need = { MORNING: b.needMorning, NIGHT: b.needNight };
  if (!int(b.days, 1, 31) || !int(need.MORNING, 0, 50) || !int(need.NIGHT, 0, 50)) return bad('الأيام 1-31 والاحتياج أعداد صحيحة');
  const names = {};
  for (const e of state.employees || []) if (e && e.sap != null && (!b.branch || e.branch === b.branch)) names[String(e.sap)] = e.name;
  if (!Object.keys(names).length) return bad('مفيش موظفين بالفرع ده', 422);
  let r; try { r = O.scheduleOptimal({ staff: Object.keys(names), days: b.days, shifts: ['MORNING', 'NIGHT'], need }); } catch (e) { return bad(e.message); }
  const id = 'plan_' + Date.now().toString(36);
  state.opsPlans = [{ id, t: Date.now(), by: String(u.sap), branch: b.branch || 'ALL', days: b.days, need, status: 'PENDING', result: r, names }, ...(state.opsPlans || [])].slice(0, 30);
  const miss = r.gaps.reduce((s, g) => s + g.missing, 0);
  return ok({ id, plan: r.plan, names, fairness: r.fairness, gaps: r.gaps,
    explain: `الجدول لـ${Object.keys(names).length} موظف على ${b.days} يوم. ` + (miss ? `فيه نقص ${miss} خانة (الموظفين مش كفاية).` : 'التغطية كاملة.') + ` الفرق بين أكتر وأقل موظف ${r.fairness} وردية، وتبديلات صباحي↔ليلي ${r.switches} (الجدولة الجشعة كانت ${r.baseline.switches}). الجدول مقترح وبانتظار موافقة الأدمن.`, switches: r.switches, baseline: r.baseline }, true);
}
function approve({ id, decision }, state) {
  const p = (state.opsPlans || []).find(x => x.id === id);
  if (!p) return bad('الخطة مش موجودة', 404);
  if (!['APPROVED', 'REJECTED'].includes(decision)) return bad('القرار غير صالح');
  p.status = decision; return ok({ id, status: p.status }, true);
}
function assign({ rows, cols, cost }) {
  const strs = a => Array.isArray(a) && a.length >= 1 && a.length <= 50 && a.every(x => typeof x === 'string' && x);
  if (!strs(rows) || !strs(cols) || rows.length > cols.length) return bad('الصفوف لازم <= الأعمدة (حد أقصى 50)');
  let r; try { r = O.hungarian(cost); } catch (e) { return bad(e.message); }
  if (cost.length !== rows.length || cost[0].length !== cols.length) return bad('أبعاد المصفوفة لا تطابق الأسماء');
  const pairs = r.assign.map((j, i) => ({ row: rows[i], col: cols[j], cost: cost[i][j] }));
  return ok({ pairs, total: r.cost, explain: `أقل تكلفة كلية ${r.cost}: ` + pairs.map(p => `${p.row}←${p.col}`).join('، ') });
}
function photo(u, b, state) {
  const { w, h, gray } = b;
  if (!int(w, 8, 128) || !int(h, 8, 128) || !Array.isArray(gray) || gray.length !== w * h || !gray.every(v => int(v, 0, 255))) return bad('بيانات الصورة غير صالحة');
  const store = (state.photoHashes ||= {}), key = String(u.sap), prev = (store[key] || []).filter(x => typeof x === 'string');
  let r; try { r = P.assessPhoto(Uint8Array.from(gray), w, h, prev); } catch (e) { return bad(e.message); }
  store[key] = [r.hash, ...prev].slice(0, 20);
  if (!r.ok) { const e = (state.employees || []).find(x => String(x.sap) === key) || {}; state.securityLog = [{ t: Date.now(), kind: 'PHOTO', sap: key, name: e.name, branch: e.branch, level: 'MEDIUM', reasons: r.reasons }, ...(state.securityLog || [])].slice(0, 1000); }
  return ok({ ok: r.ok, sharpness: r.sharpness, exposure: r.exposure, reasons: r.reasons,
    explain: r.ok ? 'الصورة سليمة: حادة وإضاءتها مناسبة ومش مكررة.' : 'تنبيه للأدمن: ' + r.reasons.join('، ') }, true);
}
/* ملخص ذكي موحّد: أرقام المحركات (Erlang + الجدولة + الصور + المخاطر + الحركة الحية) → النموذج اللغوي يلخّص ويقترح، والأدمن يقرر */
async function brief(b, state) {
  const now = Date.now(), sec = (state.securityLog || []).filter(x => now - x.t < 864e5), n = f => sec.filter(f).length;
  const plan = (state.opsPlans || [])[0], lv = LV.list(state).items;
  const stf = [b.lambda, b.mu, b.target].every(num) && b.mu > 0 && b.lambda >= 0 && b.target >= 0 ? O.minServers(b.lambda, b.mu, b.target) : null;
  const facts = { تنبيهات_أمان_عالية_24س: n(x => x.level === 'HIGH'), تنبيهات_متوسطة_24س: n(x => x.level === 'MEDIUM'), صور_مشبوهة_24س: n(x => x.kind === 'PHOTO'),
    آخر_جدول: plan ? { الحالة: plan.status, فرق_العدالة: plan.result.fairness, نقص: plan.result.gaps.length, تبديلات: plan.result.switches } : null,
    نقاط_تسجيل_مطلوبة: stf ? stf.c : null, بيشاركوا_موقعهم: lv.length, في_الطريق: lv.filter(x => x.status === 'في الطريق').length, واقفين_برا: lv.filter(x => x.status === 'واقف برا').length, وصلوا: lv.filter(x => x.inside).length };
  const q = typeof b.q === 'string' ? b.q.slice(0, 400) : '';
  const fb = Object.entries(facts).filter(([, v]) => v !== null).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('
');
  const a = await AI.ask('البيانات:
' + JSON.stringify(facts) + (q ? '
سؤال المدير: ' + q : '
اعمل ملخص تشغيل وأهم 3 توصيات.'), fb);
  return ok({ facts, text: a.text, llm: a.llm });
}
async function enrich(r) { if (r.code === 200 && r.body.explain) { const a = await AI.ask('نتيجة حساب (اشرحها للمدير في 3 سطور وانبّه على أي نقص):
' + r.body.explain, r.body.explain); r.body.explain = a.text; r.body.llm = a.llm; } return r; }
async function handle(p, u, b, state) {
  if (!state) return bad('loading', 503);
  if (p === '/api/ops/photo') return photo(u, b, state);
  if (p === '/api/ops/ping') return LV.ping(u, b, state);
  if (p === '/api/ops/stop') return LV.stop(u);
  if (p === '/api/ops/room') return RM.room(u, b, state);
  if (!u.mgr) return bad('للإدارة فقط', 403);
  if (p === '/api/ops/live') return ok(LV.list(state));
  if (p === '/api/ops/brief') return brief(b, state);
  if (p === '/api/ops/staffing') return enrich(staffing(b));
  if (p === '/api/ops/schedule') return enrich(schedule(u, b, state));
  if (p === '/api/ops/assign') return assign(b);
  if (p === '/api/ops/approve') return u.admin ? approve(b, state) : bad('للأدمن فقط', 403);
  return bad('not found', 404);
}
module.exports = { handle };
