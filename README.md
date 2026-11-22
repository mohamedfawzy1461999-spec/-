# تشغيل السيرفر
    ADMIN_KEY=مفتاح-سري SYNC_CODE=BIM-ISMAILIA-2026 node server.js
افتح http://localhost:3000 — أول أدمن/مدير يدخل بيرفع البيانات للسيرفر (مرة واحدة)، وبعدها كل الأجهزة بتتزامن لايف.
في نسخة الموبايل حط قبل أي سكريبت في index.html:  <script>window.BIM_SERVER_URL="https://رابط-السيرفر";</script>

# تحويله لتطبيق موبايل (Capacitor)
    npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios @capacitor/push-notifications
    npx cap add android && npx cap add ios && npx cap sync
    npx cap open android   # أو ios (محتاج Mac / Codemagic)
