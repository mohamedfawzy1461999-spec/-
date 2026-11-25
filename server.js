/* ───────────── Optical Decision + Math/AI Load & Fault Guard ───────────── */
const opticalNodes = new Map([
  ['sfu-cairo-1', { id: 'sfu-cairo-1', region: 'eg-cai', capacity: 8000, activeLoad: 0, latencyMs: 18, lossRate: 0.002, healthy: true, ewmaLoad: 0, ewmaLatency: 18, lastSeen: Date.now() }],
  ['sfu-alex-1',  { id: 'sfu-alex-1',  region: 'eg-aly', capacity: 7000, activeLoad: 0, latencyMs: 24, lossRate: 0.004, healthy: true, ewmaLoad: 0, ewmaLatency: 24, lastSeen: Date.now() }],
  ['sfu-edge-2',  { id: 'sfu-edge-2',  region: 'eu-edge', capacity: 10000, activeLoad: 0, latencyMs: 36, lossRate: 0.003, healthy: true, ewmaLoad: 0, ewmaLatency: 36, lastSeen: Date.now() }],
]);

const voiceRooms = new Map(); // roomId -> { id, title, createdBy, createdAt, nodeId, speakers: Set, raisedHands: Set, listenersCount: number, state: 'LIVE'|'DEGRADED'|'FAILOVER' }
const telemetryWindow = []; // [{ t, nodeId, loadRatio, latencyMs, lossRate, riskScore }]
const ALPHA = 0.35; // معامل التنعيم الأسي EWMA للتنبؤ السريع بالحمولة والكمون

function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }

// دالة قرار بصرية/مسارية (Optical Decision Cost Function):
// أقل تكلفة تعني مسار/عقدة أنسب وأكثر استقراراً
function scoreOpticalNode(n, preferredRegion) {
  if (!n || !n.healthy) return Number.POSITIVE_INFINITY;
  const util = clamp01(n.ewmaLoad);
  const latNorm = clamp01(n.ewmaLatency / 250);
  const lossNorm = clamp01(n.lossRate / 0.05);
  const regionPenalty = preferredRegion && n.region !== preferredRegion ? 0.12 : 0;
  // عقوبة غير خطية عند تجاوز 80% لتجنب التشبع المفاجئ
  const overloadPenalty = util > 0.8 ? Math.pow((util - 0.8) * 5, 2) : 0;
  return (0.45 * util) + (0.30 * latNorm) + (0.15 * lossNorm) + regionPenalty + overloadPenalty + (0.10 * clamp01(n.activeLoad / Math.max(1, n.capacity)));
}

function selectOpticalRoute(preferredRegion = 'eg-cai') {
  let best = null, bestScore = Number.POSITIVE_INFINITY;
  const ranked = [];
  for (const n of opticalNodes.values()) {
    const score = scoreOpticalNode(n, preferredRegion);
    ranked.push({ id: n.id, region: n.region, healthy: n.healthy, util: Number(n.ewmaLoad.toFixed(3)), latencyMs: Math.round(n.ewmaLatency), lossRate: n.lossRate, score: Number.isFinite(score) ? Number(score.toFixed(4)) : null });
    if (score < bestScore) { bestScore = score; best = n; }
  }
  ranked.sort((a, b) => (a.score ?? 1e9) - (b.score ?? 1e9));
  return { primary: best, ranked };
}

function recordAiTelemetry(sample) {
  const now = Date.now();
  const n = opticalNodes.get(sample.nodeId);
  if (!n) return null;

  const load = clamp01(sample.loadRatio ?? (n.activeLoad / Math.max(1, n.capacity)));
  const latency = Math.max(1, Number(sample.latencyMs ?? n.latencyMs) || n.latencyMs);
  const loss = clamp01(sample.lossRate ?? n.lossRate);

  n.activeLoad = Math.max(0, Math.min(n.capacity * 1.2, Math.round(sample.activeLoad ?? n.activeLoad)));
  n.latencyMs = latency;
  n.lossRate = loss;
  n.lastSeen = now;

  n.ewmaLoad = (ALPHA * load) + ((1 - ALPHA) * n.ewmaLoad);
  n.ewmaLatency = (ALPHA * latency) + ((1 - ALPHA) * n.ewmaLatency);

  // مؤشر مخاطر مركب (0 إلى 1): يرفع الإنذار المبكر قبل التعطل
  const predictedLoad = clamp01(n.ewmaLoad + (load - n.ewmaLoad) * 0.5);
  const riskScore = Number(clamp01((predictedLoad * 0.5) + (clamp01(n.ewmaLatency / 220) * 0.3) + (clamp01(loss / 0.03) * 0.2)).toFixed(3));

  if (riskScore >= 0.85 || loss >= 0.04) {
    n.healthy = false;
  } else if (riskScore < 0.72) {
    n.healthy = true;
  }

  telemetryWindow.push({ t: now, nodeId: n.id, loadRatio: Number(load.toFixed(3)), latencyMs: latency, lossRate: loss, riskScore });
  if (telemetryWindow.length > 1000) telemetryWindow.splice(0, telemetryWindow.length - 1000);

  // إعادة توزيع الغرف تلقائياً لو العقدة الأساسية أصبحت غير سليمة
  if (!n.healthy) {
    const { primary } = selectOpticalRoute(n.region);
    if (primary && primary.id !== n.id) {
      for (const room of voiceRooms.values()) {
        if (room.nodeId === n.id) {
          room.nodeId = primary.id;
          room.state = 'FAILOVER';
        }
      }
    }
  }

  return { nodeId: n.id, healthy: n.healthy, riskScore, predictedLoad: Number(predictedLoad.toFixed(3)) };
}

function serializeRoom(room) {
  return {
    id: room.id,
    title: room.title,
    createdBy: room.createdBy,
    createdAt: room.createdAt,
    nodeId: room.nodeId,
    state: room.state,
    speakers: Array.from(room.speakers),
    raisedHands: Array.from(room.raisedHands),
    listenersCount: room.listenersCount,
    totalParticipants: room.speakers.size + room.listenersCount,
  };
}

// فحص دوري خفيف كل 15 ثانية لكشف العقد المتأخرة أو المتوقفة عن إرسال النبض
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const n of opticalNodes.values()) {
    if (n.healthy && now - n.lastSeen > 45000 && n.activeLoad > 0) {
      n.healthy = false;
      changed = true;
    }
  }
  if (changed) {
    for (const room of voiceRooms.values()) {
      const cur = opticalNodes.get(room.nodeId);
      if (!cur || !cur.healthy) {
        const { primary } = selectOpticalRoute();
        if (primary) { room.nodeId = primary.id; room.state = 'FAILOVER'; }
      }
    }
  }
}, 15000).unref();

function handleVoiceAndOptical(pathname, req, res) {
  if (pathname === '/api/ops/optical-status' && req.method === 'GET') {
    const u = who(Object.fromEntries(new URL(req.url, 'http://x').searchParams));
    if (!u) return json(res, 401, { error: 'سجّل دخول الأول' });
    const { primary, ranked } = selectOpticalRoute();
    const recent = telemetryWindow.slice(-25);
    const avgRisk = recent.length ? Number((recent.reduce((s, x) => s + x.riskScore, 0) / recent.length).toFixed(3)) : 0;
    return json(res, 200, {
      ok: true,
      recommendedNode: primary ? primary.id : null,
      avgRisk,
      nodes: ranked,
      roomsCount: voiceRooms.size,
      activeSseClients: clients.size,
      recentTelemetry: recent,
    });
  }

  if (pathname === '/api/ops/telemetry' && req.method === 'POST') {
    return readJson(req, res, async b => {
      const u = me(b);
      if (!u || !u.mgr) return json(res, 403, { error: 'للإدارة فقط' });
      const resAi = recordAiTelemetry(b);
      if (!resAi) return json(res, 404, { error: 'عقدة غير موجودة' });
      const { primary, ranked } = selectOpticalRoute();
      return json(res, 200, { ok: true, telemetry: resAi, recommendedNode: primary ? primary.id : null, nodes: ranked });
    });
  }

  if (pathname === '/api/voice/rooms' && req.method === 'GET') {
    const u = who(Object.fromEntries(new URL(req.url, 'http://x').searchParams));
    if (!u) return json(res, 401, { error: 'سجّل دخول الأول' });
    return json(res, 200, { ok: true, rooms: Array.from(voiceRooms.values()).map(serializeRoom) });
  }

  if (pathname === '/api/voice/room' && req.method === 'POST') {
    return readJson(req, res, async b => {
      const u = me(b);
      if (!u) return json(res, 401, { error: 'سجّل دخول الأول' });
      const action = String(b.action || 'join');
      const preferredRegion = String(b.region || 'eg-cai');

      if (action === 'create') {
        const title = String(b.title || '').trim().slice(0, 100) || `غرفة ${u.name || u.sap}`;
        const { primary } = selectOpticalRoute(preferredRegion);
        if (!primary) return json(res, 503, { error: 'لا توجد عقدة SFU متاحة حالياً' });
        const id = 'room_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const room = {
          id,
          title,
          createdBy: String(u.sap),
          createdAt: Date.now(),
          nodeId: primary.id,
          speakers: new Set([String(u.sap)]),
          raisedHands: new Set(),
          listenersCount: 0,
          state: 'LIVE',
        };
        voiceRooms.set(id, room);
        primary.activeLoad += 1;
        recordAiTelemetry({ nodeId: primary.id, activeLoad: primary.activeLoad });
        return json(res, 200, { ok: true, room: serializeRoom(room), sfuNode: primary.id });
      }

      const room = voiceRooms.get(String(b.roomId || ''));
      if (!room) return json(res, 404, { error: 'الغرفة غير موجودة' });
      const sap = String(u.sap);

      if (action === 'join') {
        if (!room.speakers.has(sap)) room.listenersCount += 1;
        const n = opticalNodes.get(room.nodeId);
        if (n) { n.activeLoad += 1; recordAiTelemetry({ nodeId: n.id, activeLoad: n.activeLoad }); }
      } else if (action === 'leave') {
        if (room.speakers.has(sap)) room.speakers.delete(sap);
        else if (room.listenersCount > 0) room.listenersCount -= 1;
        room.raisedHands.delete(sap);
        const n = opticalNodes.get(room.nodeId);
        if (n && n.activeLoad > 0) { n.activeLoad -= 1; recordAiTelemetry({ nodeId: n.id, activeLoad: n.activeLoad }); }
      } else if (action === 'raise-hand') {
        room.raisedHands.add(sap);
      } else if (action === 'promote-speaker') {
        if (!u.mgr && room.createdBy !== sap) return json(res, 403, { error: 'صلاحية إدارة الغرفة مطلوبة' });
        const target = String(b.targetSap || sap);
        if (room.speakers.size >= 16) return json(res, 409, { error: 'اكتمل حد المتحدثين في الغرفة' });
        room.raisedHands.delete(target);
        room.speakers.add(target);
        if (room.listenersCount > 0) room.listenersCount -= 1;
      } else if (action === 'demote-listener') {
        if (!u.mgr && room.createdBy !== sap) return json(res, 403, { error: 'صلاحية إدارة الغرفة مطلوبة' });
        const target = String(b.targetSap || sap);
        if (room.speakers.delete(target)) room.listenersCount += 1;
      } else if (action === 'close') {
        if (!u.mgr && room.createdBy !== sap) return json(res, 403, { error: 'صلاحية إغلاق الغرفة مطلوبة' });
        const n = opticalNodes.get(room.nodeId);
        const total = room.speakers.size + room.listenersCount;
        if (n) { n.activeLoad = Math.max(0, n.activeLoad - total); recordAiTelemetry({ nodeId: n.id, activeLoad: n.activeLoad }); }
        voiceRooms.delete(room.id);
        return json(res, 200, { ok: true, closed: room.id });
      } else {
        return json(res, 400, { error: 'إجراء غير معروف' });
      }

      const { primary } = selectOpticalRoute();
      return json(res, 200, { ok: true, room: serializeRoom(room), recommendedNode: primary ? primary.id : room.nodeId });
    });
  }

  return null;
}
