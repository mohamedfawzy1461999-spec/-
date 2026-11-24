'use strict';
/* هندسة صناعية وبحوث عمليات — بدون مكتبات */
/* Erlang C: احتمال الانتظار وزمن الانتظار عند نقاط التسجيل. lambda: وصول/دقيقة، mu: خدمة/دقيقة لكل نقطة، c: عدد النقاط */
function erlangC(lambda, mu, c) {
  if (![lambda, mu, c].every(Number.isFinite) || lambda < 0 || mu <= 0 || !Number.isInteger(c) || c < 1)
    throw new RangeError('lambda>=0 وmu>0 وc عدد صحيح موجب مطلوبين');
  const a = lambda / mu, rho = a / c;
  if (rho >= 1) return { stable: false, rho, pWait: 1, wq: Infinity };
  let sum = 0, term = 1;
  for (let k = 0; k < c; k++) { if (k > 0) term *= a / k; sum += term; }
  const last = (Math.pow(a, c) / factorial(c)) / (1 - rho);
  const pWait = last / (sum + last);
  return { stable: true, rho, pWait, wq: pWait / (c * mu - lambda) };   // wq بالدقايق
}
function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
/* أقل عدد نقاط تسجيل يحقق متوسط انتظار <= targetMin */
function minServers(lambda, mu, targetMin, maxC = 200) {
  if (![lambda, mu, targetMin, maxC].every(Number.isFinite) || lambda < 0 || mu <= 0 || targetMin < 0 || !Number.isInteger(maxC) || maxC < 1)
    throw new RangeError('مدخلات minServers غير صالحة');
  for (let c = Math.max(1, Math.floor(lambda / mu) + 1); c <= maxC; c++) { const r = erlangC(lambda, mu, c); if (r.stable && r.wq <= targetMin) return { c, ...r }; }
  return null;
}
/* الخوارزمية المجرية (تعيين بأقل تكلفة) — مصفوفة مربعة أو مستطيلة n<=m. تعيد {assign[i]=j, cost} */
function hungarian(cost) {
  if (!Array.isArray(cost) || cost.length === 0 || !Array.isArray(cost[0]) || cost[0].length === 0)
    throw new TypeError('مصفوفة التكلفة لا يمكن أن تكون فارغة');
  const n = cost.length, m = cost[0].length;
  if (n > m) throw new Error('عدد الصفوف لازم <= الأعمدة');
  if (cost.some(row => !Array.isArray(row) || row.length !== m || row.some(x => !Number.isFinite(x))))
    throw new TypeError('مصفوفة التكلفة يجب أن تكون مستطيلة وتحتوي أرقاماً محددة');
  const u = Array(n + 1).fill(0), v = Array(m + 1).fill(0), p = Array(m + 1).fill(0), way = Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const minv = Array(m + 1).fill(Infinity), used = Array(m + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const assign = Array(n).fill(-1); for (let j = 1; j <= m; j++) if (p[j]) assign[p[j] - 1] = j - 1;
  return { assign, cost: assign.reduce((s, j, i) => s + cost[i][j], 0) };
}
/* جدولة ورديات جشعة مع قيود: تغطية مطلوبة لكل وردية، أقصى أيام عمل متتالية، راحة بين الورديات. موافقة الأدمن مطلوبة قبل التنفيذ. */
function scheduleShifts({ staff, days, shifts, need, maxConsecutive = 6 }) {
  if (!Array.isArray(staff) || !Array.isArray(shifts) || !need || typeof need !== 'object' ||
      !Number.isInteger(days) || days < 0 || !Number.isInteger(maxConsecutive) || maxConsecutive < 1 ||
      staff.some(s => typeof s !== 'string' || !s) || new Set(staff).size !== staff.length)
    throw new TypeError('مدخلات جدولة الورديات غير صالحة');
  if (Object.values(need).some(v => !Number.isInteger(v) || v < 0)) throw new RangeError('الاحتياج يجب أن يكون أعداداً صحيحة غير سالبة');
  const plan = {}, load = Object.fromEntries(staff.map(s => [s, 0])), streak = Object.fromEntries(staff.map(s => [s, 0])), gaps = [];
  for (let d = 0; d < days; d++) {
    plan[d] = {}; const worked = new Set();
    for (const sh of shifts) {
      const pick = staff.filter(s => !worked.has(s) && streak[s] < maxConsecutive).sort((a, b) => load[a] - load[b] || a.localeCompare(b)).slice(0, need[sh] || 0);
      plan[d][sh] = pick; pick.forEach(s => { worked.add(s); load[s]++; });
      if (pick.length < (need[sh] || 0)) gaps.push({ day: d, shift: sh, missing: (need[sh] || 0) - pick.length });
    }
    for (const s of staff) streak[s] = worked.has(s) ? streak[s] + 1 : 0;
  }
  const loads = Object.values(load);
  return { plan, load, gaps, fairness: loads.length ? Math.max(...loads) - Math.min(...loads) : 0 };
}
/* جدولة مثلى يوم بيوم: كل يوم مسألة تعيين (Hungarian) تقلل الحمل + تمنع التبديل بين الصباحي والليلي (التبديل محتاج موافقة أدمن) + تقلل الأيام المتتالية */
function countSwitches(plan, days) { let n = 0; const last = {}; for (let d = 0; d < days; d++) for (const [sh, list] of Object.entries(plan[d] || {})) for (const s of list) { if (last[s] && last[s] !== sh) n++; last[s] = sh; } return n; }
function scheduleOptimal(args) {
  const base = scheduleShifts(args);   // يتحقق من المدخلات ويدي خط أساس للمقارنة
  const { days, shifts, need, maxConsecutive = 6 } = args, staff = [...args.staff].sort();
  const load = Object.fromEntries(staff.map(s => [s, 0])), streak = { ...load }, last = {}, plan = {}, gaps = [];
  for (let d = 0; d < days; d++) {
    plan[d] = {}; shifts.forEach(sh => { plan[d][sh] = []; });
    const slots = shifts.flatMap(sh => Array((need[sh] || 0)).fill(sh)), elig = staff.filter(s => streak[s] < maxConsecutive);
    const use = slots.slice(0, elig.length), worked = new Set();
    shifts.forEach(sh => { const miss = (need[sh] || 0) - use.filter(x => x === sh).length; if (miss > 0) gaps.push({ day: d, shift: sh, missing: miss }); });
    if (use.length) {
      const { assign } = hungarian(use.map(sh => elig.map(s => load[s] * 10 + (last[s] && last[s] !== sh ? 25 : 0) + streak[s] * 2)));
      assign.forEach((j, i) => { const s = elig[j]; plan[d][use[i]].push(s); worked.add(s); load[s]++; last[s] = use[i]; });
    }
    for (const s of staff) streak[s] = worked.has(s) ? streak[s] + 1 : 0;
  }
  const L = Object.values(load), fairness = L.length ? Math.max(...L) - Math.min(...L) : 0;
  return { plan, load, gaps, fairness, switches: countSwitches(plan, days), baseline: { fairness: base.fairness, switches: countSwitches(base.plan, days), gaps: base.gaps.length } };
}
module.exports = { erlangC, minServers, hungarian, scheduleShifts, scheduleOptimal };
