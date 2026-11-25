/* ───────────── Gemini AI endpoint ─────────────
   Add this block inside route(), immediately after the /api/login handler
   and BEFORE the `const u = me(b);` line used by the remaining routes.
*/
if (p === '/api/gemini') {
  const u = me(b);
  if (!u) return json(res, 401, { error: 'سجّل دخول الأول' });
  if (auth[u.sap] && auth[u.sap].mustChange)
    return json(res, 403, { error: 'غيّر كلمة المرور المؤقتة أولاً' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json(res, 503, { error: 'مفتاح Gemini غير مضبوط في Railway' });
  const question = String(b.question || '').trim();
  if (!question || question.length > 4000)
    return json(res, 400, { error: 'السؤال فارغ أو أطول من الحد المسموح' });

  // Build a permission-filtered, minimized snapshot; never send passwords/tokens.
  const safe = view(u);
  const context = {
    user: { name: u.name || '', branch: u.branch || '', role: u.cls || (u.admin ? 'ADMIN' : '') },
    employees: (safe.employees || []).map(e => ({
      name: e.name, sap: e.sap, role: e.role, branch: e.branch,
      status: e.status, inBranch: e.inBranch, checkInTime: e.checkInTime,
      leaveType: e.leaveType, checkInAt: e.checkInAt
    })),
    branches: (safe.branches || []).map(x => ({ name: x.name, code: x.code })),
    fraudAlerts: (safe.fraudAlerts || []).slice(0, 80).map(x => ({
      empName: x.empName, branch: x.branch, title: x.title,
      detail: x.detail, time: x.time, ack: x.ack, sev: x.sev
    })),
    notifications: (safe.notifications || []).slice(0, 40).map(x => ({
      title: x.title, body: x.body, time: x.time, severity: x.severity
    }))
  };

  const model = String(process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const upstream = await fetch(endpoint, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text:
          'أنت مساعد BIM Enterprise OS. أجب بالعربية المصرية الواضحة والمهنية. اعتمد حصراً على بيانات السياق المرفقة عند السؤال عن النظام أو الموظفين أو الفروع. لا تخترع بيانات أو أرقاماً؛ إذا لم تتوفر المعلومة فقل ذلك بوضوح. احترم نطاق صلاحيات المستخدم ولا تكشف بيانات غير موجودة في السياق. لا تطلب كلمات مرور أو مفاتيح API.'
        }] },
        contents: [{ role: 'user', parts: [{ text: `بيانات النظام المسموح بها لهذا المستخدم:\n${JSON.stringify(context)}\n\nسؤال المستخدم: ${question}` }] }],
        generationConfig: { temperature: 0.35, maxOutputTokens: 1200 }
      })
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('Gemini API error:', upstream.status, payload.error && payload.error.message);
      return json(res, 502, { error: 'Gemini لم يتمكن من معالجة السؤال حالياً (' + upstream.status + ')' });
    }
    const answer = (payload.candidates || []).flatMap(c => c.content && c.content.parts || [])
      .map(x => x.text || '').join('\n').trim();
    if (!answer) return json(res, 502, { error: 'Gemini رجّع إجابة فارغة' });
    return json(res, 200, { ok: true, answer, model });
  } catch (e) {
    console.error('Gemini request failed:', e.message);
    return json(res, 502, { error: e.name === 'AbortError' ? 'انتهت مهلة الاتصال بـ Gemini' : 'تعذر الاتصال بخدمة Gemini' });
  } finally { clearTimeout(timeout); }
}
