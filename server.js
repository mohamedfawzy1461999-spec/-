// BIM unified real-time server — zero dependencies (Node 18+).
// Push = Server-Sent Events, writes = POST. One source of truth for web + mobile.
const http = require("http"), fs = require("fs"), path = require("path");
const PORT = process.env.PORT || 3000;
const SYNC = process.env.SYNC_CODE || "BIM-ISMAILIA-2026";
const ADMIN_KEY = process.env.ADMIN_KEY || "";          // required for admin / area-manager sessions
const DATA = process.env.DATA_FILE || path.join(__dirname, "data.json");
const PUB = path.join(__dirname, "public");

let state = null;
try { state = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch (e) {}
let saveT = null;
const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => {
  fs.writeFile(DATA + ".tmp", JSON.stringify(state), err => { if (!err) fs.rename(DATA + ".tmp", DATA, () => {}); }); }, 300); };

// ---- roles & meeting permissions (the single place the rules live) ----
const cls = r => /مساعد/.test(r || "") ? "ASSISTANTS" : /مسئول|مسؤول/.test(r || "") ? "MANAGERS" : "STAFF";
const audOk = (a, c) => !a || a === "ALL" || a === c || (a === "MGR_ASSIST" && c !== "STAFF");
const canSee = (u, aud, scope) => u.mgr || (audOk(aud, u.cls) && (!scope || scope === "ALL" || scope === "كل الفروع" || scope === u.branch));

// identity is resolved from SERVER data, never from a role claimed by the client
function who(q) {
  if (!q || q.sync !== SYNC) return null;
  const e = state && (state.employees || []).find(x => String(x.sap) === String(q.sap));
  if (e) return { sap: e.sap, cls: cls(e.role), branch: e.branch, mgr: !!e.isAdminDelegate, admin: !!e.isAdminDelegate };
  if ((q.role === "admin" || q.role === "manager") && ADMIN_KEY && q.key === ADMIN_KEY)
    return { sap: q.sap, mgr: true, admin: q.role === "admin" };
  return null;
}

function view(u) {
  const s = { ...state };
  if (!u.admin) s.employees = (s.employees || []).map(({ password, ...e }) => e);
  const m = s.meeting || {};
  if (m.active && !canSee(u, m.audience, m.branchScope)) s.meeting = { active: false, audience: "ALL", branchScope: "ALL" };
  s.scheduledMeetings = (s.scheduledMeetings || []).filter(x => canSee(u, x.audience, x.scope));
  s.notifications = (s.notifications || []).filter(n => !n.aud || canSee(u, n.aud, n.scope));
  return s;
}

// ---- writes ----
const MGR_KEYS = ["meeting", "scheduledMeetings", "branches"];
const union = (cur, add, keyOf, front) => { const seen = new Set(cur.map(keyOf)); const fresh = add.filter(x => !seen.has(keyOf(x)));
  return (front ? [...fresh, ...cur] : [...cur, ...fresh]).slice(0, 500); };
function apply(u, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "employees") {
      for (const e of v) {
        const i = state.employees.findIndex(x => x.id === e.id);
        if (i < 0) { if (u.admin) state.employees.push(e); continue; }
        const old = state.employees[i];
        if (!(u.mgr || String(old.sap) === String(u.sap))) continue;           // employees edit only themselves
        const keep = u.admin ? {} : { password: old.password, role: old.role, branch: old.branch, isAdminDelegate: old.isAdminDelegate };
        state.employees[i] = { ...old, ...e, ...keep };
      }
    } else if (k === "chat") state.chat = union(state.chat || [], v, x => x.sender + "|" + x.text + "|" + x.time, false);
    else if (k === "notifications") state.notifications = union(state.notifications || [], v, x => x.id, true);
    else if (MGR_KEYS.includes(k)) { if (u.mgr) state[k] = v; }                // only managers/admins run meetings
    else if (k !== "syncCode") state[k] = v;
  }
}

// ---- SSE hub ----
const clients = new Set();
const send = (c, ev, data) => c.res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
function broadcast() { for (const c of clients) { const u = who(c.q); if (u) send(c, "state", view(u)); } }
setInterval(() => clients.forEach(c => c.res.write(": hb\n\n")), 25000);

const cors = { "Access-Control-Allow-Origin": process.env.ALLOW_ORIGIN || "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

  if (url.pathname === "/api/stream") {
    const q = Object.fromEntries(url.searchParams), u = who(q);
    if (!u) { res.writeHead(403, cors); return res.end("denied"); }
    res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const c = { res, q }; clients.add(c); req.on("close", () => clients.delete(c));
    return state ? send(c, "state", view(u)) : send(c, "empty", {});
  }

  if (url.pathname === "/api/state" && req.method === "POST") {
    let body = ""; req.on("data", d => { body += d; if (body.length > 15e6) req.destroy(); });
    return req.on("end", () => {
      let b; try { b = JSON.parse(body); } catch (e) { res.writeHead(400, cors); return res.end(); }
      const u = who(b.q); if (!u) { res.writeHead(403, cors); return res.end(); }
      if (!state && b.full && u.mgr) state = b.full;                           // first-run seed from a manager's device
      else if (state) apply(u, b.patch);
      if (state) { persist(); broadcast(); }
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, view: state ? view(u) : null }));
    });
  }

  let targetPath = url.pathname === "/" ? "index.html" : url.pathname;
  let f = path.join(PUB, targetPath);
  
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    f = path.join(PUB, "index.html");
  }

  if (!fs.existsSync(f)) { 
    res.writeHead(404, cors); 
    return res.end("not found"); 
  }

  res.writeHead(200, { ...cors, "Content-Type": MIME[path.extname(f)] || "application/octet-stream" }); 
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log("BIM server on :" + PORT));
