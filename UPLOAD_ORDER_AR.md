# ترتيب الرفع على GitHub (اسمح بالاستبدال لو الريبو فيه نسخة قديمة)

## الدفعة 1 — الملفات الأساسية (في الجذر)
1. package.json  ← معدّل (بيشغّل اختبار shift الجديد)
2. server.js  ← معدّل (نبض الحضور /api/attendance/presence، إنذار الخروج التلقائي، منع الانصراف قبل 9 ساعات)
3. auth.js
4. railway.json
5. .gitignore

## الدفعة 2 — فولدر engine (9 ملفات)
branches.js, ai.js, geo.js, live.js, ops-api.js, ops.js, optical.js, risk.js, rooms.js
(مفيش تغيير في الفولدر ده الجولة دي)

## الدفعة 3 — فولدر public
index.html  ← معدّل (الخروج بيتحسب على السيرفر، منع الانصراف المبكر، إشعارات الموظفين للإدارة بس)
sw.js, manifest.json, icon-192.png, icon-512.png

## الدفعة 4 — الباقي
test/ (7 ملفات منهم shift.test.js جديد)
.github/workflows/android.yml, scripts/credentials.js, capacitor.config.json, README.md, SETUP_AR.md, AUDIT_REPORT_AR.md
