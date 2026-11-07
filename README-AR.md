# موقع انطلاقة — النشر على Vercel مع حفظ الحجوزات في Supabase

كل حجز يملؤه العميل في الفورم يُحفظ مباشرة في Supabase.
الجدول `bookings` يُنشأ تلقائياً عند أول حجز، ولا تحتاج كتابة أي أمر أو SQL.

## خطوات النشر

1. **ارفع المجلد إلى GitHub** (مستودع جديد) ثم في vercel.com اختر
   **Add New → Project** → اختر المستودع → **Deploy**
   (اترك Framework Preset على `Other`).

   > بديل بدون GitHub: من الطرفية داخل المجلد نفّذ `npx vercel` ثم `npx vercel --prod`.

2. **اربط Supabase بالمشروع:** من صفحة المشروع افتح تبويب **Storage** →
   اختر قاعدة **Supabase** الموجودة في حسابك (أو أنشئ واحدة) → **Connect Project**
   (فعّل Production و Preview و Development).
   هذه الخطوة تضيف بيانات الاتصال (`POSTGRES_URL` وغيرها) للمشروع تلقائياً.

3. **أعد النشر مرة واحدة:** Deployments → آخر نشر → **Redeploy**
   (متغيّرات البيئة لا تُقرأ إلا في نشر جديد).

4. **جرّب الفورم** من الموقع المنشور.

## كيف أرى الحجوزات؟

Supabase Dashboard → **Table Editor → bookings**
(أو من Vercel: Storage → Supabase → Open in Supabase).

## ملاحظات

- نقطة الاستقبال: `POST /api/bookings` (الملف `api/bookings.ts`)، والواجهة تستدعيها كما هي.
- الأمان: مفاتيح Supabase تبقى في السيرفر فقط ولا تظهر في الصفحة. وتم تفعيل Row Level Security على الجدول،
  فلا يمكن لأحد قراءة الحجوزات من الإنترنت. أنت تراها من لوحة Supabase فقط.
- الحماية من البوتات (honeypot)، والتحقق من الحقول في السيرفر، ومنع تكرار نفس الحجز عند إعادة الإرسال.
- مشاريع Supabase المجانية تتوقف تلقائياً بعد فترة بلا نشاط (حوالي أسبوع). إذا توقف المشروع فلن تُحفظ الحجوزات
  حتى تضغط **Restore** من لوحة Supabase.
- إذا ظهرت للزائر رسالة «تعذّر تثبيت الحجز» فغالباً لم تُربط القاعدة أو لم تُعِد النشر بعد الربط (الخطوتان 2 و3).
  تفاصيل الخطأ تظهر في Vercel → Logs.
- ملف `supabase/bookings.sql` اختياري، لإنشاء الجدول يدوياً فقط إن أردت.

## تسجيل الدخول والداشبورد

- زر «تسجيل الدخول» يستدعي `POST /api/login` ويستخدم **Supabase Auth** (بريد + كلمة مرور). الجلسة تُحفظ في كوكي HttpOnly آمن.
- أنشئ حسابك: Supabase → **Authentication → Users → Add user → Create new user** (فعّل Auto Confirm User).
- لعرض الحجوزات في `/dashboard.html` أضف في Vercel → Settings → Environment Variables:
  `ADMIN_EMAILS` = بريدك (يمكن عدة بريدات مفصولة بفاصلة)، ثم Redeploy.
- يحتاج أيضاً المتغيرات التي يضيفها تكامل Supabase تلقائياً: `SUPABASE_URL` و `SUPABASE_ANON_KEY` و `SUPABASE_SERVICE_ROLE_KEY`.

## لوحة التحكم: الصلاحيات
- `ADMIN_EMAILS`: المدراء. يرون كل شيء ويستطيعون تصدير CSV.
- `TEAM_EMAILS`: فريق العمل. عرض فقط (بدون تصدير). افصل بين البريدات بفاصلة.
- كل مستخدم يُنشأ من Supabase → Authentication → Users، ثم يُضاف بريده لأحد المتغيرين ويُعاد النشر.

## متابعة العملاء (مرة واحدة)
لتفعيل حفظ حالة العميل والملاحظات: Supabase → SQL Editor → الصق محتوى `supabase/leads-workflow.sql` → Run.
(بدونها تعمل اللوحة للعرض فقط وتظهر رسالة تنبيه.)
