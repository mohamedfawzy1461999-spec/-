// روابط (أو إحداثيات مباشرة { lat, lng }) للفروع. السيرفر بيحاول يطلع منها الإحداثيات تلقائياً أول ما يشتغل
// (لو الفرع لسه ملوش لوكيشن). لو فشل، الأدمن يثبّت اللوكيشن من زرار 📍 جوه التطبيق.
module.exports = {
  E139: { lat: 30.611062, lng: 32.285785 },   // السوق التجاري (من الرابط الصح اللي بعتّه: maps.app.goo.gl/aC9rmKxwksnmGQmj9)
  E239: { lat: 30.608363, lng: 32.296672 },   // أم القرى (محسوبة من كود الموقع J75W+8MV في رابط: maps.app.goo.gl/ruvmtQbekrJmqfZo8)
  E129: 'https://maps.app.goo.gl/N5JcRznymqPwWCXv9?g_st=aw',   // شارع المستشفى
  E128: 'https://maps.app.goo.gl/jXFNjkGdWKeCMPcs9?g_st=aw',   // شبين - الإسماعيلية
  E140: 'https://maps.app.goo.gl/nmtuj5mQaWZ6xq1f8?g_st=aw',   // الاستاد
  E103: 'https://maps.app.goo.gl/XxUVugJa6AidM7WU9?g_st=aw',   // هدى شعراوي
  E285: 'https://maps.app.goo.gl/6pmQUJDN4zX1LYwR7?g_st=aw',   // شارع بورسعيد
  E385: 'https://maps.app.goo.gl/u7QPQ2AVaB8mfC3m9?g_st=aw',   // التكنولوجيا
  E400: 'https://maps.app.goo.gl/TZNJ9kkMy2PCbrMR9?g_st=ac',   // صبري
  E137: 'https://maps.app.goo.gl/dLZvpfzZcD7hHysr5?g_st=ac',   // الشيخ زايد
};
