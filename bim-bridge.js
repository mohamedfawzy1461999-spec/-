/* BIM bridge — يتضاف قبل </body> في ملف الـ HTML
   1) بوابة دخول بتقفل التطبيق لحد ما السيرفر يوافق
   2) تغيير كلمة المرور في أول دخول
   3) تحويل أزرار الحضور/الانصراف للسيرفر (مع اللوكيشن)
   4) أي عنصر عليه data-admin-only بيتشال من الصفحة لو المستخدم مش أدمن
   5) أي عنصر عليه data-manager-only بيتشال لو المستخدم موظف عادي */
(function () {
  'use strict';
  var TOKEN_KEY = 'bim_token';
  var BIM = (window.BIM = { user: null });

  /* ---------- API ---------- */
  BIM.api = function (path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    var t = localStorage.getItem(TOKEN_KEY);
    if (t) headers.Authorization = 'Bearer ' + t;
    return fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && path !== '/login') { BIM.logout(); }
        if (!r.ok) { var e = new Error(data.error || 'حصل خطأ'); e.status = r.status; e.data = data; throw e; }
        return data;
      });
    });
  };
  BIM.logout = function () {
    localStorage.removeItem(TOKEN_KEY);
    location.reload();
  };

  /* ---------- واجهة البوابة ---------- */
  var css = document.createElement('style');
  css.textContent =
    '#bimGate{position:fixed;inset:0;z-index:99999;background:#0f1115;display:flex;align-items:center;justify-content:center;padding:20px;direction:rtl;font-family:inherit}' +
    '#bimGate .box{width:100%;max-width:360px;background:#171a21;border:1px solid #2a2f3a;border-radius:16px;padding:22px;color:#fff}' +
    '#bimGate h2{margin:0 0 4px;font-size:20px}#bimGate p{margin:0 0 14px;color:#9aa3b2;font-size:13px}' +
    '#bimGate input{width:100%;box-sizing:border-box;margin:6px 0;padding:12px;border-radius:10px;border:1px solid #333a47;background:#0f1115;color:#fff;font-size:15px}' +
    '#bimGate button{width:100%;margin-top:10px;padding:12px;border:0;border-radius:10px;background:#c8102e;color:#fff;font-size:16px;font-weight:700}' +
    '#bimGate .err{color:#ff7b8a;font-size:13px;min-height:18px;margin-top:6px}' +
    '#bimToast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:99998;background:#222;color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;max-width:90%;display:none;direction:rtl}';
  document.head.appendChild(css);

  var gate = document.createElement('div');
  gate.id = 'bimGate';
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(gate); });
  if (document.body) document.body.appendChild(gate);

  function toast(msg) {
    var t = document.getElementById('bimToast');
    if (!t) { t = document.createElement('div'); t.id = 'bimToast'; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = 'none'; }, 4000);
  }
  BIM.toast = toast;

  function showLogin(msg) {
    gate.innerHTML =
      '<div class="box"><h2>تسجيل الدخول</h2><p>اسم المستخدم (زي 90004853M) وكلمة المرور</p>' +
      '<input id="bimU" autocomplete="username" placeholder="اسم المستخدم أو الكود">' +
      '<input id="bimP" type="password" autocomplete="current-password" placeholder="كلمة المرور">' +
      '<div class="err" id="bimE">' + (msg || '') + '</div><button id="bimGo">دخول</button></div>';
    gate.style.display = 'flex';
    var go = function () {
      var b = document.getElementById('bimGo'); b.disabled = true;
      BIM.api('/login', { method: 'POST', body: { username: document.getElementById('bimU').value, password: document.getElementById('bimP').value } })
        .then(function (r) { localStorage.setItem(TOKEN_KEY, r.token); return enter(r.user); })
        .catch(function (e) { document.getElementById('bimE').textContent = e.message; b.disabled = false; });
    };
    document.getElementById('bimGo').onclick = go;
    document.getElementById('bimP').onkeydown = function (e) { if (e.key === 'Enter') go(); };
  }

  function showChangePassword(user) {
    gate.innerHTML =
      '<div class="box"><h2>غيّر كلمة المرور</h2><p>أول دخول: اختار كلمة مرور جديدة (8 حروف/أرقام على الأقل، مش الكود).</p>' +
      '<input id="bimO" type="password" placeholder="كلمة المرور الحالية (الكود)">' +
      '<input id="bimN" type="password" autocomplete="new-password" placeholder="كلمة المرور الجديدة">' +
      '<div class="err" id="bimE"></div><button id="bimGo">حفظ</button></div>';
    gate.style.display = 'flex';
    document.getElementById('bimGo').onclick = function () {
      BIM.api('/change-password', { method: 'POST', body: { old_password: document.getElementById('bimO').value, new_password: document.getElementById('bimN').value } })
        .then(function () { user.must_change = false; return enter(user); })
        .catch(function (e) { document.getElementById('bimE').textContent = e.message; });
    };
  }

  function applyRoles(u) {
    var isAdmin = !!u.is_admin, isMgr = isAdmin || u.role !== 'staff';
    document.querySelectorAll('[data-admin-only]').forEach(function (el) { if (!isAdmin) el.remove(); });
    document.querySelectorAll('[data-manager-only]').forEach(function (el) { if (!isMgr) el.remove(); });
  }

  function enter(user) {
    if (user.must_change) { showChangePassword(user); return Promise.resolve(); }
    BIM.user = user;
    applyRoles(user);
    gate.style.display = 'none';
    document.dispatchEvent(new CustomEvent('bim:login', { detail: user }));
    return Promise.resolve();
  }

  /* ---------- اللوكيشن: كل حاجة (كاميرا/صورة/بصمة/تسجيل) مقفولة إلا جوه الفرع ---------- */
  function getPosition() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('الجهاز مش بيدعم اللوكيشن'));
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }); },
        function () { reject(new Error('فعّل اللوكيشن للمتصفح (دقة عالية) وجرّب تاني')); },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  // بيسأل السيرفر: أنا جوه نطاق فرعي؟ لو أيوه بيرجّع إثبات صالح 3 دقايق
  BIM.verifyLocation = function () {
    return getPosition().then(function (pos) {
      return BIM.api('/geo-verify', { method: 'POST', body: { lat: pos.lat, lng: pos.lng, accuracy: pos.acc } })
        .then(function (r) { BIM._geo = { proof: r.proof, lat: pos.lat, lng: pos.lng, acc: pos.acc, t: Date.now() }; return BIM._geo; });
    }).catch(function (e) { BIM._geo = null; toast(e.message); throw e; });
  };
  BIM.requireInside = function () {
    if (BIM.user && BIM.user.is_admin) return Promise.resolve(null); // الأدمن مش تابع لفرع
    if (BIM._geo && Date.now() - BIM._geo.t < 150000) return Promise.resolve(BIM._geo);
    return BIM.verifyLocation();
  };

  // قفل الكاميرا والمايك: getUserMedia
  var md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    var origGUM = md.getUserMedia.bind(md);
    md.getUserMedia = function (c) {
      if (!BIM.user) return Promise.reject(new DOMException('سجّل الدخول الأول', 'NotAllowedError'));
      return BIM.requireInside().then(function () { return origGUM(c); }, function () {
        return Promise.reject(new DOMException('برّه نطاق الفرع', 'NotAllowedError'));
      });
    };
  }
  // قفل البصمة (WebAuthn / Face Unlock)
  if (navigator.credentials) ['get', 'create'].forEach(function (m) {
    var orig = navigator.credentials[m] && navigator.credentials[m].bind(navigator.credentials);
    if (!orig) return;
    navigator.credentials[m] = function (o) {
      return BIM.requireInside().then(function () { return orig(o); }, function () {
        return Promise.reject(new DOMException('برّه نطاق الفرع', 'NotAllowedError'));
      });
    };
  });
  // قفل رفع/تصوير الصور (input type=file)
  var passFile = null;
  document.addEventListener('click', function (ev) {
    var el = ev.target;
    if (!el || el.tagName !== 'INPUT' || el.type !== 'file') return;
    if (passFile === el) { passFile = null; return; }
    ev.preventDefault(); ev.stopImmediatePropagation();
    BIM.requireInside().then(function () { passFile = el; el.click(); }).catch(function () {});
  }, true);

  /* ---------- التقاط صورة سيلفي ---------- */
  BIM.capturePhoto = function () {
    return new Promise(function (resolve, reject) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }).then(function (stream) {
        var ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;direction:rtl';
        var v = document.createElement('video');
        v.autoplay = true; v.playsInline = true; v.muted = true; v.srcObject = stream;
        v.style.cssText = 'width:100%;max-width:420px;border-radius:12px;transform:scaleX(-1)';
        var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px';
        function mk(t, bg) { var b = document.createElement('button'); b.textContent = t; b.style.cssText = 'padding:12px 22px;border:0;border-radius:10px;font-size:16px;font-weight:700;color:#fff;background:' + bg; return b; }
        var ok = mk('📸 التقط', '#c8102e'), no = mk('إلغاء', '#444');
        function done() { stream.getTracks().forEach(function (t) { t.stop(); }); ov.remove(); }
        ok.onclick = function () {
          var w = 480, h = Math.round((v.videoHeight || 640) * w / (v.videoWidth || 480));
          var c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(v, 0, 0, w, h);
          var data = c.toDataURL('image/jpeg', 0.6); done(); resolve(data);
        };
        no.onclick = function () { done(); reject(new Error('اتلغى التصوير')); };
        row.appendChild(ok); row.appendChild(no); ov.appendChild(v); ov.appendChild(row); document.body.appendChild(ov);
      }).catch(function () { reject(new Error('الكاميرا مش متاحة')); });
    });
  };

  /* ---------- الحضور والانصراف ---------- */
  function act(kind) {
    return BIM.verifyLocation().then(function (g) {
      toast('✅ إنت جوه الفرع — صوّر نفسك');
      return BIM.capturePhoto().then(function (photo) {
        return BIM.api('/' + kind, { method: 'POST', body: { lat: g.lat, lng: g.lng, accuracy: g.acc, proof: g.proof, photo: photo } });
      });
    }).then(function (r) {
      if (kind === 'checkout' && r.short_shift) toast('تم الانصراف — لسه ما كملتش 9 ساعات');
      else toast(kind === 'checkin' ? 'تم تسجيل الحضور ✅' : 'تم تسجيل الانصراف ✅');
      document.dispatchEvent(new CustomEvent('bim:attendance', { detail: { kind: kind, result: r } }));
    }).catch(function (e) { toast(e.message); });
  }
  BIM.checkin = function () { return act('checkin'); };
  BIM.checkout = function () { return act('checkout'); };

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('button,[role=button],a');
    if (!btn) return;
    var action = btn.getAttribute('data-bim-action');
    if (!action) {
      var txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^تسجيل حضور(ي)?$/.test(txt)) action = 'checkin';
      else if (/^تسجيل انصراف(ي)?$/.test(txt)) action = 'checkout';
    }
    if (!action) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    act(action);
  }, true);

  /* ---------- أدمن: تثبيت لوكيشن فرع من موقعك الحالي ---------- */
  function adminLocator() {
    var b = document.createElement('button');
    b.textContent = '📍'; b.title = 'تثبيت لوكيشن فرع';
    b.style.cssText = 'position:fixed;bottom:90px;left:12px;z-index:99990;width:46px;height:46px;border-radius:50%;border:0;background:#c8102e;color:#fff;font-size:20px;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    b.onclick = function () {
      BIM.api('/branches').then(function (list) {
        var msg = 'اكتب رقم الفرع اللي إنت واقف فيه دلوقتي:\n' + list.map(function (x, i) { return (i + 1) + ') ' + x.name + (x.lat ? ' ✅' : ' ❌'); }).join('\n');
        var n = parseInt(prompt(msg), 10);
        if (!n || !list[n - 1]) return;
        getPosition().then(function (pos) {
          if (pos.acc > 50 && !confirm('دقة الموقع ' + Math.round(pos.acc) + ' متر (ضعيفة). تكمّل؟')) return;
          return BIM.api('/branches/' + list[n - 1].id + '/locate', { method: 'POST', body: { lat: pos.lat, lng: pos.lng } })
            .then(function () { toast('تم تثبيت لوكيشن ' + list[n - 1].name + ' ✅'); });
        }).catch(function (e) { toast(e.message); });
      });
    };
    document.body.appendChild(b);
  }
  document.addEventListener('bim:login', function (e) { if (e.detail.is_admin) adminLocator(); });

  /* ---------- تشغيل ---------- */
  if (localStorage.getItem(TOKEN_KEY)) {
    BIM.api('/me').then(function (r) { return enter(r.user); }).catch(function () { showLogin(); });
  } else {
    showLogin();
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
})();
