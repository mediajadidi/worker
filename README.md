# AJ Sports — هایلایت خودکار (Cloudflare Worker)

```
wrangler.toml      تنظیمات دپلوی
worker.js          API + جمع‌آوری خودکار از یوتیوب (+ سرو سایت)
public/index.html  سایت
.dev.vars.example  نمونهٔ متغیرهای محلی
```

## دپلوی (۵ دقیقه)
1. کلید API: Google Cloud Console → فعال‌کردن **YouTube Data API v3** → Create credentials → API key
   (محدودیتِ *API restriction* = فقط YouTube Data API v3؛ محدودیت Referrer نگذار، چون سرور صدا می‌زند).
2. `npm i`
3. `npx wrangler kv namespace create CACHE` ← `id` چاپ‌شده را در `wrangler.toml` جایگزین کن.
4. `npx wrangler secret put YOUTUBE_API_KEY`  (کلید را همین‌جا وارد کن؛ داخل کد/فایل نمی‌رود)
5. `npx wrangler deploy`

بعد از دپلوی: `https://<name>.<account>.workers.dev/api/health` را باز کن.
هر هندلی که پیدا نشده باشد (`failed`) همان‌جا با دلیلش لیست می‌شود؛ هندل درست را در `SOURCES` بالای `worker.js` اصلاح کن.

اجرای محلی: `.dev.vars.example` را به `.dev.vars` کپی و کلید را پر کن، سپس `npx wrangler dev`.

## افزودن لیگ / کانال
* کانال جدید: یک خط به `SOURCES` (هندل، نام مورد انتظار کانال، تب‌هایی که تغذیه می‌کند).
* لیگ جدید: یک آیتم به `TABS` (id، عنوان، کلمات کلیدی عنوان ویدیو).
* لوگو: فایل SVG/PNG را در `public/logos/` بگذار و در `index.html` داخل `LOGO_OVERRIDES` ثبتش کن (خودکار سفید می‌شود).
  لوگوی رسمی لیگ‌ها علامت تجاری صاحبانشان است؛ فایل رسمی را خودت از brand kit هر لیگ تهیه کن.

## سهمیه و رفتار
* فقط `channels / playlistItems / videos` (هرکدام ۱ واحد) استفاده شده؛ `search.list` (۱۰۰ واحد) نه.
* هر ۱۵ دقیقه cron بخشی از کانال‌ها را می‌چرخاند؛ مصرف معمول ≈ ۳ تا ۵ هزار واحد در روز از ۱۰ هزار.
* فقط ویدیوهای **قابل embed**، عمومی، غیر زنده، بین ۱ تا ۴۵ دقیقه (بدون Shorts و بازی کامل) پذیرفته می‌شوند.
* با اتمام سهمیه، Worker یک ساعت به یوتیوب درخواست نمی‌دهد و داده‌های قبلی را نشان می‌دهد.
* رفرش دستی: `curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" "https://…/api/refresh?tab=la-liga"`
* پلن Free ورکرز کار می‌کند، ولی سقف CPU آن کم است؛ اگر خطای CPU دیدی پلن Paid ($5) بگیر.

## توجه
* پخش داخل WebView اپ فقط با صفحهٔ **https** کار می‌کند (نه `file://`).
* اگر کاربران شما به یوتیوب دسترسی مستقیم ندارند (فیلترینگ)، پلیر و تصاویر بدون VPN بالا نمی‌آیند.
