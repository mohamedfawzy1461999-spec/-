# BIM — الحضور والانصراف (سيرفر + تطبيق)

## الهيكل
- `server.js` — السيرفر (بيحفظ البيانات في Postgres، وما بيقعش لو حصل خطأ)
- `public/` — التطبيق نفسه: index.html و sw.js و manifest.json والأيقونات
- `railway.json` — إعدادات Railway (فحص صحة + إعادة تشغيل تلقائي)
- `_old-postgres-version/` — النسخة القديمة (Express + Postgres)، متحفوظة للرجوع بس ومش بتشتغل مع الصفحة الحالية

## التشغيل على Railway (مرة واحدة)
1. في المشروع اضغط New ← Database ← Add PostgreSQL.
2. في خدمة التطبيق ← Variables ضيف:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `ADMIN_KEY` = مفتاح سري من عندك
   - (اختياري) `SYNC_CODE` لو عايز كود مزامنة غير الافتراضي
3. ارفع الملفات على GitHub وRailway هيبني تلقائي.
4. بعد ما يشتغل: ادخل بمدير من الجهاز اللي عليه البيانات الصح. أول دخول بيرفع البيانات للسيرفر مرة واحدة، وبعدها بتتحفظ في Postgres وما بتضيعش مع أي Deploy.

## تشغيل محلي
    npm install
    ADMIN_KEY=سري node server.js
ثم افتح http://localhost:3000

## موبايل (Capacitor)
الإعداد في `capacitor.config.json`. في index.html حط قبل أي سكريبت:
    <script>window.BIM_SERVER_URL="https://رابط-السيرفر";</script>
