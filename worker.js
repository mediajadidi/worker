/**
 * AJ Sports — Highlights API  (Cloudflare Worker)
 * ─────────────────────────────────────────────────────────────────────────────
 * • هایلایت‌ها را خودکار از کانال‌های یوتیوب (YouTube Data API v3) می‌گیرد.
 * • هر ویدیو را بر اساس عنوانش به تب مناسب (لیگ/تورنمنت) مسیریابی می‌کند.
 * • نتیجه را در KV نگه می‌دارد؛ کلید API فقط سمت سرور (Secret) است.
 * • همین Worker فایل‌های استاتیک سایت (public/) را هم سرو می‌کند.
 *
 * Endpoints
 *   GET  /api/tabs                 لیست تب‌ها
 *   GET  /api/highlights?tab=ID    ویدیوهای یک تب  (tab=latest | goals | شناسهٔ لیگ)
 *   GET  /api/health               وضعیت کانال‌ها/سهمیه (هندل‌های ناموفق را اینجا ببین)
 *   POST /api/refresh?tab=ID       رفرش دستی (نیازمند ADMIN_TOKEN)
 *
 * Bindings / env  (wrangler.toml)
 *   YOUTUBE_API_KEY   Secret  ← wrangler secret put YOUTUBE_API_KEY
 *   ADMIN_TOKEN       Secret  (اختیاری)
 *   CACHE             KV namespace
 *   ASSETS            Static assets
 *
 * سهمیهٔ یوتیوب: playlistItems / videos / channels هرکدام ۱ واحد (search.list = ۱۰۰ واحد،
 * پس عمداً استفاده نشده). سهمیهٔ پیش‌فرض ۱۰٬۰۰۰ واحد در روز است.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ═════════════════════════════ 1) تب‌ها (لیگ‌ها و تورنمنت‌ها) ═════════════════════════════
   keywords : اگر عنوان ویدیو با این regex بخورد، ویدیو به این تب می‌رود.
   priority : وقتی عنوان با چند تب می‌خورد، عدد بزرگ‌تر اول بررسی می‌شود.
   code     : مخفف نمایش‌داده‌شده کنار تب (وقتی لوگوی SVG نداریم). */
const TABS = [
  { id: 'premier-league',    title: 'لیگ برتر انگلیس',       en: 'Premier League',        code: 'PL',   keywords: /premier league|\bEPL\b/i },
  { id: 'champions-league',  title: 'لیگ قهرمانان اروپا',    en: 'UEFA Champions League', code: 'UCL',  keywords: /champions league|\bUCL\b/i },
  { id: 'la-liga',           title: 'لالیگا',                en: 'LaLiga',                code: 'LL',   keywords: /la ?liga/i },
  { id: 'serie-a',           title: 'سری آ',                 en: 'Serie A',               code: 'SA',   keywords: /serie ?a\b/i },
  { id: 'bundesliga',        title: 'بوندسلیگا',             en: 'Bundesliga',            code: 'BL',   keywords: /bundesliga/i },
  { id: 'ligue-1',           title: 'لیگ ۱ فرانسه',          en: 'Ligue 1',               code: 'L1',   keywords: /ligue ?1\b/i },
  { id: 'championship',      title: 'چمپیونشیپ انگلیس',      en: 'EFL Championship',      code: 'EFL',  keywords: /\bEFL\b|championship/i },
  { id: 'europa-league',     title: 'لیگ اروپا',             en: 'UEFA Europa League',    code: 'UEL',  keywords: /europa league|\bUEL\b/i },
  { id: 'conference-league', title: 'لیگ کنفرانس اروپا',     en: 'UEFA Conference League',code: 'UECL', keywords: /conference league|\bUECL\b/i },
  { id: 'fa-cup',            title: 'جام حذفی انگلیس',       en: 'FA Cup',                code: 'FAC',  keywords: /\bFA cup\b/i },
  { id: 'efl-cup',           title: 'جام اتحادیه انگلیس',    en: 'Carabao Cup',           code: 'CUP',  keywords: /carabao cup|efl cup|league cup/i },
  { id: 'acl-elite',         title: 'لیگ الیت آسیا',         en: 'AFC Champions League Elite', code: 'ACLE', priority: 5,
                                                              keywords: /acl ?elite|\bACLE\b|afc champions league|acl ?(2|two)\b/i },
  { id: 'persian-gulf',      title: 'لیگ برتر خلیج فارس',    en: 'Persian Gulf Pro League', code: 'PGPL',
                                                              keywords: /persian gulf pro league|iran pro league|\bPGPL\b|لیگ برتر|لیگ خلیج فارس|پرسپولیس|استقلال|سپاهان|تراکتور/i },
  { id: 'saudi',             title: 'لیگ عربستان',           en: 'Saudi Pro League',      code: 'SPL',  keywords: /saudi pro league|roshn saudi league|\bSPL\b|دوري روشن|دوری روشن/i },
  { id: 'eredivisie',        title: 'اردیویزی هلند',         en: 'Eredivisie',            code: 'ERE',  keywords: /eredivisie/i },
  { id: 'liga-portugal',     title: 'لیگ پرتغال',            en: 'Liga Portugal',         code: 'LPT',  keywords: /liga portugal|primeira liga|betclic/i },
  { id: 'super-lig',         title: 'سوپر لیگ ترکیه',        en: 'Süper Lig',             code: 'TSL',  keywords: /s[üu]per lig|trendyol/i },
  { id: 'scotland',          title: 'لیگ اسکاتلند',          en: 'Scottish Premiership',  code: 'SPFL', keywords: /scottish premiership|\bSPFL\b|cinch premiership/i },
  { id: 'mls',               title: 'ام‌ال‌اس آمریکا',        en: 'MLS',                   code: 'MLS',  keywords: /\bMLS\b|major league soccer/i },
  { id: 'libertadores',      title: 'کوپا لیبرتادورس',       en: 'Copa Libertadores',     code: 'LIB',  keywords: /libertadores|sudamericana/i },
  { id: 'national',          title: 'تیم‌های ملی',           en: 'International',         code: 'INT',  priority: -1,
                                                              keywords: /nations league|qualif|\bEURO ?20|copa am[eé]rica|\bAFCON\b|africa cup|asian cup|international friendl|national team|team melli|تیم ملی|world cup|\bFIFA\b/i },
];

/* تب‌های مجازی: از روی بقیه ساخته می‌شوند و هزینهٔ اضافه‌ای در سهمیه ندارند */
const VIRTUAL_TABS = [
  { id: 'latest', title: 'جدیدترین', en: 'Latest', code: 'NEW', virtual: true },
  { id: 'goals',  title: 'گل‌ها',    en: 'Goals',  code: 'GOL', virtual: true },
];
const ALL_TABS = [VIRTUAL_TABS[0], ...TABS, VIRTUAL_TABS[1]];
const ROUTE_ORDER = [...TABS].sort((a, b) => (b.priority || 0) - (a.priority || 0));
const FOCUS_LATEST = ['premier-league', 'champions-league', 'la-liga', 'serie-a', 'bundesliga', 'ligue-1'];

/* ═════════════════════════════ 2) کانال‌ها ═════════════════════════════
   handle     : هندل یوتیوب (@…)  ← با channels.list?forHandle به شناسه تبدیل می‌شود
   name       : regex نام مورد انتظار کانال؛ اگر هندل به کانال دیگری برسد، رد می‌شود (ایمنی)
   tabs       : تب‌هایی که این کانال اجازهٔ تغذیه‌شان را دارد
   dedicated  : true → ویدیوی بی‌مسیر به tabs[0] می‌رود (کانال خودِ لیگ/باشگاه)
                false → فقط اگر عنوان با keywords یک تب بخورد پذیرفته می‌شود (کانال‌های عمومی)
   max        : تعداد آخرین آپلودهایی که بررسی می‌شود (۱–۵۰)
   ⚠️ هندل‌ها را بعد از دپلوی با /api/health چک کن؛ هر کدام که پیدا نشود همان‌جا گزارش می‌شود. */
const SOURCES = [
  /* ── رسمی لیگ‌ها/مسابقات ── */
  { handle: '@premierleague',          name: 'premier league',                 tabs: ['premier-league'], dedicated: true },
  { handle: '@LaLiga',                 name: 'la ?liga',                       tabs: ['la-liga'], dedicated: true },
  { handle: '@SerieA',                 name: 'serie a',                        tabs: ['serie-a'], dedicated: true },
  { handle: '@bundesliga',             name: 'bundesliga',                     tabs: ['bundesliga'], dedicated: true },
  { handle: '@ligue1',                 name: 'ligue 1',                        tabs: ['ligue-1'], dedicated: true },
  { handle: '@EFL',                    name: 'efl',                            tabs: ['championship', 'efl-cup'] },
  { handle: '@UEFA',                   name: 'uefa',                           tabs: ['champions-league', 'europa-league', 'conference-league', 'national'] },
  { handle: '@ChampionsLeague',        name: 'champions league|uefa',          tabs: ['champions-league'], dedicated: true },
  { handle: '@emiratesfacup',          name: 'fa cup',                         tabs: ['fa-cup'], dedicated: true },
  { handle: '@AFC',                    name: 'afc|asian football',             tabs: ['acl-elite', 'national'] },
  { handle: '@AFCChampionsLeague',     name: 'afc|champions league',           tabs: ['acl-elite'], dedicated: true },
  { handle: '@CONMEBOLLibertadores',   name: 'libertadores|conmebol',          tabs: ['libertadores'], dedicated: true },
  { handle: '@CONMEBOL',               name: 'conmebol',                       tabs: ['libertadores', 'national'] },
  { handle: '@FIFA',                   name: 'fifa',                           tabs: ['national'] },
  { handle: '@mls',                    name: 'mls|major league soccer',        tabs: ['mls'], dedicated: true },
  { handle: '@eredivisie',             name: 'eredivisie',                     tabs: ['eredivisie'], dedicated: true },
  { handle: '@ligaportugal',           name: 'liga portugal',                  tabs: ['liga-portugal'], dedicated: true },
  { handle: '@trendyolsuperlig',       name: 'l[iı]g|trendyol',                tabs: ['super-lig'], dedicated: true },
  { handle: '@spfl',                   name: 'spfl|scottish',                  tabs: ['scotland'], dedicated: true },
  { handle: '@SaudiProLeague',         name: 'saudi|spl|roshn',                tabs: ['saudi'], dedicated: true },
  { handle: '@RoshnSaudiLeague',       name: 'saudi|roshn',                    tabs: ['saudi'], dedicated: true },

  /* ── رسانه‌ها و پخش‌کننده‌های معتبر (عمومی؛ فقط عنوان‌هایی که اسم لیگ دارند) ── */
  { handle: '@SkySportsPremierLeague', name: 'sky sports',                     tabs: ['premier-league'] },
  { handle: '@SkySportsFootball',      name: 'sky sports',                     tabs: ['premier-league', 'championship', 'efl-cup', 'fa-cup', 'scotland', 'europa-league'] },
  { handle: '@NBCSports',              name: 'nbc sports',                     tabs: ['premier-league'] },
  { handle: '@CBSSportsGolazo',        name: 'cbs sports|golazo',              tabs: ['champions-league', 'europa-league', 'conference-league', 'serie-a', 'national'] },
  { handle: '@tntsports',              name: 'tnt sports',                     tabs: ['champions-league', 'europa-league', 'conference-league'] },
  { handle: '@ESPNFC',                 name: 'espn',                           tabs: ['la-liga', 'bundesliga', 'serie-a', 'ligue-1', 'mls', 'champions-league', 'europa-league', 'national'] },
  { handle: '@beINSPORTSUSA',          name: 'bein',                           tabs: ['la-liga', 'serie-a', 'ligue-1', 'super-lig', 'saudi', 'champions-league'] },
  { handle: '@BBCSport',               name: 'bbc sport',                      tabs: ['fa-cup'] },

  /* ── ایران (منابع فارسی) ── */
  { handle: '@varzesh3',               name: 'varzesh|ورزش',                   tabs: ['persian-gulf', 'acl-elite', 'national'], dedicated: false },
  { handle: '@PersepolisFC',           name: 'persepolis|پرسپولیس',            tabs: ['persian-gulf', 'acl-elite'], dedicated: true },
  { handle: '@EsteghlalFC',            name: 'esteghlal|استقلال',              tabs: ['persian-gulf', 'acl-elite'], dedicated: true },

  /* ── باشگاه‌ها (تیم‌های بزرگ؛ عنوان به لیگ/جام درست مسیریابی می‌شود) ── */
  { handle: '@arsenal',                name: 'arsenal',                        tabs: ['premier-league', 'champions-league', 'fa-cup', 'efl-cup'], dedicated: true },
  { handle: '@mancity',                name: 'manchester city|man city',       tabs: ['premier-league', 'champions-league', 'fa-cup', 'efl-cup'], dedicated: true },
  { handle: '@LiverpoolFC',            name: 'liverpool',                      tabs: ['premier-league', 'champions-league', 'fa-cup', 'efl-cup'], dedicated: true },
  { handle: '@manutd',                 name: 'manchester united|man utd',      tabs: ['premier-league', 'europa-league', 'fa-cup', 'efl-cup', 'champions-league'], dedicated: true },
  { handle: '@chelseafc',              name: 'chelsea',                        tabs: ['premier-league', 'conference-league', 'champions-league', 'fa-cup', 'efl-cup'], dedicated: true },
  { handle: '@SpursOfficial',          name: 'tottenham|spurs',                tabs: ['premier-league', 'europa-league', 'champions-league', 'fa-cup', 'efl-cup'], dedicated: true },
  { handle: '@realmadrid',             name: 'real madrid',                    tabs: ['la-liga', 'champions-league'], dedicated: true },
  { handle: '@fcbarcelona',            name: 'barcelona|barça',                tabs: ['la-liga', 'champions-league'], dedicated: true },
  { handle: '@atleticodemadrid',       name: 'atl[eé]tico',                    tabs: ['la-liga', 'champions-league'], dedicated: true },
  { handle: '@juventus',               name: 'juventus',                       tabs: ['serie-a', 'champions-league'], dedicated: true },
  { handle: '@acmilan',                name: 'milan',                          tabs: ['serie-a', 'champions-league'], dedicated: true },
  { handle: '@inter',                  name: 'inter',                          tabs: ['serie-a', 'champions-league'], dedicated: true },
  { handle: '@sscnapoli',              name: 'napoli',                         tabs: ['serie-a', 'champions-league'], dedicated: true },
  { handle: '@officialasroma',         name: 'roma',                           tabs: ['serie-a', 'europa-league'], dedicated: true },
  { handle: '@fcbayern',               name: 'bayern',                         tabs: ['bundesliga', 'champions-league'], dedicated: true },
  { handle: '@bvb',                    name: 'borussia|bvb|dortmund',          tabs: ['bundesliga', 'champions-league'], dedicated: true },
  { handle: '@psg',                    name: 'paris|psg',                      tabs: ['ligue-1', 'champions-league'], dedicated: true },
  { handle: '@OM',                     name: 'marseille|om',                   tabs: ['ligue-1', 'europa-league'], dedicated: true },
  { handle: '@OL',                     name: 'lyon|olympique',                 tabs: ['ligue-1', 'europa-league'], dedicated: true },
  { handle: '@AFCAjax',                name: 'ajax',                           tabs: ['eredivisie', 'champions-league', 'europa-league'], dedicated: true },
  { handle: '@PSV',                    name: 'psv',                            tabs: ['eredivisie', 'champions-league', 'europa-league'], dedicated: true },
  { handle: '@Feyenoord',              name: 'feyenoord',                      tabs: ['eredivisie', 'champions-league', 'europa-league'], dedicated: true },
  { handle: '@slbenfica',              name: 'benfica',                        tabs: ['liga-portugal', 'champions-league', 'europa-league'], dedicated: true },
  { handle: '@fcporto',                name: 'porto',                          tabs: ['liga-portugal', 'champions-league', 'europa-league'], dedicated: true },
  { handle: '@SportingCP',             name: 'sporting',                       tabs: ['liga-portugal', 'champions-league', 'europa-league'], dedicated: true },
  { handle: '@galatasaray',            name: 'galatasaray',                    tabs: ['super-lig', 'champions-league', 'europa-league'], dedicated: true },
  { handle: '@fenerbahce',             name: 'fenerbah',                       tabs: ['super-lig', 'europa-league', 'conference-league'], dedicated: true },
  { handle: '@Besiktas',               name: 'be[sş]ikta[sş]',                 tabs: ['super-lig', 'europa-league', 'conference-league'], dedicated: true },
  { handle: '@celticfc',               name: 'celtic',                         tabs: ['scotland', 'champions-league', 'europa-league'], dedicated: true },
  { handle: '@RangersFC',              name: 'rangers',                        tabs: ['scotland', 'europa-league'], dedicated: true },
  { handle: '@intermiamicf',           name: 'inter miami',                    tabs: ['mls'], dedicated: true },
  { handle: '@LAFC',                   name: 'lafc|los angeles',               tabs: ['mls'], dedicated: true },
];

/* ═════════════════════════════ 3) قوانین فیلتر عنوان ═════════════════════════════ */
/* عنوان باید نشانهٔ «هایلایت/گل/خلاصه» داشته باشد (چند زبان) */
const HIGHLIGHT_RE = /highlights?|\bgoals?\b|\bgols?\b|recap|extended|r[ée]sum[ée]n?|zusammenfassung|sintesi|samenvatting|[öo]zet|melhores momentos|خلاصه|هایلایت|گل‌ها|گلها/i;
/* محتواهایی که هایلایت نیستند */
const EXCLUDE_RE = /#shorts|press conference|preview|prediction|podcast|reaction|trailer|behind the scenes|interview|training|full match|full game|replay|efootball|ea sports fc|fifa ?2\d|football manager|gameplay|unboxing|\blive\b|livestream|watch ?along|fantasy|women|femenin|f[ée]minin|frauen|\bWSL\b|\bNWSL\b/i;
/* تب «گل‌ها» */
const GOAL_RE = /\bgoals?\b|golazo|screamer|bicycle kick|volley|گل/i;

/* ═════════════════════════════ 4) ابزارها ═════════════════════════════ */
const YT_BASE = 'https://www.googleapis.com/youtube/v3';
const DAY = 86_400_000;
const VID_RE = /^[\w-]{11}$/;

const keyOf = s => (s.handle || s.id).toLowerCase();
const byDateDesc = (a, b) => (a.publishedAt < b.publishedAt) - (a.publishedAt > b.publishedAt);
const dedupe = list => { const seen = new Set(); return list.filter(v => !seen.has(v.id) && seen.add(v.id)); };
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
const decode = s => (s || '').replace(/&(amp|lt|gt|quot|apos|#39);/g, m => ENT[m]);

function cfg(env) {
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };
  return {
    ttl: n(env.REFRESH_MINUTES, 45) * 60_000,      // اگر cron کار نکند، بعد از این مدت با اولین بازدید رفرش می‌شود
    budget: n(env.SUBREQUEST_BUDGET, 40),           // سقف fetch به یوتیوب در هر اجرا (پلن Free: ۵۰)
    maxPerTab: n(env.MAX_PER_TAB, 40),
    maxLatest: n(env.MAX_LATEST, 60),
    minDur: n(env.MIN_DURATION_SEC, 60),            // کوتاه‌تر از این = Shorts/کلیپ
    maxDur: n(env.MAX_DURATION_SEC, 45 * 60),       // بلندتر از این = بازی کامل/برنامه
  };
}

function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}

async function pool(items, n, fn) {
  const q = items.slice();
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}

/* ── ذخیره‌سازی: KV (سراسری). بدون KV فقط حافظهٔ موقت isolate (برای تست) ── */
const mem = new Map();
async function kvGet(env, key) {
  if (env.CACHE) { try { return await env.CACHE.get(key, { type: 'json' }); } catch { return null; } }
  return mem.get(key) ?? null;
}
async function kvPut(env, key, val) {
  if (env.CACHE) return env.CACHE.put(key, JSON.stringify(val));
  mem.set(key, val);
}

/* ── YouTube client ── */
class YTError extends Error {
  constructor(status, reason) { super(`YouTube API ${status} ${reason}`); this.status = status; this.reason = reason; }
}
async function yt(env, path, params) {
  if (!env.YOUTUBE_API_KEY) throw new YTError(500, 'missingApiKey');
  const url = new URL(`${env.YT_API_BASE || YT_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('key', env.YOUTUBE_API_KEY);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let reason = 'http' + res.status;
    try { const j = await res.json(); reason = j?.error?.errors?.[0]?.reason || j?.error?.status || reason; } catch { /* noop */ }
    throw new YTError(res.status, reason);
  }
  return res.json();
}
const isQuota = e => e instanceof YTError && (e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded' || e.reason === 'rateLimitExceeded');
const isAuth = e => e instanceof YTError && (e.reason === 'keyInvalid' || e.reason === 'API_KEY_INVALID' || e.reason === 'ipRefererBlocked' || e.reason === 'accessNotConfigured' || e.reason === 'missingApiKey');

/* هندل → شناسهٔ کانال + playlist آپلودها (+ آواتار). نتیجه ۳۰ روز کش می‌شود؛ ناموفق‌ها ۲۴ ساعت. */
async function resolveChannel(env, src, book) {
  const key = keyOf(src);
  const hit = book.channels[key];
  const now = Date.now();
  if (hit && ((hit.ok && now - hit.at < 30 * DAY) || (!hit.ok && now - hit.at < DAY))) return hit;

  const params = { part: 'snippet,contentDetails', fields: 'items(id,snippet(title,thumbnails/default/url),contentDetails/relatedPlaylists/uploads)' };
  if (src.handle) params.forHandle = src.handle; else params.id = src.id;
  const data = await yt(env, 'channels', params);
  const it = data.items?.[0];
  let rec;
  if (!it) rec = { ok: false, at: now, why: 'not_found' };
  else {
    const title = it.snippet?.title || '';
    const uploads = it.contentDetails?.relatedPlaylists?.uploads;
    if (src.name && !new RegExp(src.name, 'i').test(title)) rec = { ok: false, at: now, why: 'name_mismatch', title };
    else if (!uploads) rec = { ok: false, at: now, why: 'no_uploads', title };
    else rec = { ok: true, at: now, id: it.id, title, avatar: it.snippet?.thumbnails?.default?.url || '', uploads };
  }
  book.channels[key] = rec;
  book.dirty = true;
  return rec;
}

async function fetchUploads(env, rec, max) {
  const data = await yt(env, 'playlistItems', {
    part: 'snippet,contentDetails',
    playlistId: rec.uploads,
    maxResults: Math.min(Math.max(max || 30, 1), 50),
    fields: 'items(snippet/title,contentDetails(videoId,videoPublishedAt))',
  });
  return (data.items || [])
    .map(i => ({ id: i.contentDetails?.videoId, title: decode(i.snippet?.title), publishedAt: i.contentDetails?.videoPublishedAt || '' }))
    .filter(v => VID_RE.test(v.id || '') && v.title && v.title !== 'Private video' && v.title !== 'Deleted video');
}

async function fetchDetails(env, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const data = await yt(env, 'videos', {
      part: 'snippet,contentDetails,status',
      id: ids.slice(i, i + 50).join(','),
      fields: 'items(id,snippet(title,publishedAt,liveBroadcastContent,thumbnails(medium/url,high/url,standard/url,maxres/url)),contentDetails/duration,status(embeddable,privacyStatus))',
    });
    for (const it of data.items || []) out.set(it.id, it);
  }
  return out;
}

/* عنوان → تب. برای کانال‌های عمومی اگر تبی نخورد، ویدیو حذف می‌شود. */
function routeTitle(title, src) {
  for (const t of ROUTE_ORDER) if (src.tabs.includes(t.id) && t.keywords.test(title)) return t.id;
  return src.dedicated ? src.tabs[0] : null;
}
const passTitle = title => !EXCLUDE_RE.test(title) && HIGHLIGHT_RE.test(title);

/* ═════════════════════════════ 5) موتور رفرش ═════════════════════════════
   هر اجرا فقط تعدادی از کانال‌ها را (به ترتیب قدیمی‌ترین رفرش) پردازش می‌کند تا
   از سقف subrequest و سهمیه بیرون نزنیم؛ در چند اجرای cron همهٔ کانال‌ها چرخش می‌کنند. */
let inflight = null;
function refreshCoalesced(env, opts) {
  if (!inflight) inflight = refreshRun(env, opts).finally(() => { inflight = null; });
  return inflight;
}

async function refreshRun(env, opts = {}) {
  const C = cfg(env);
  const now = Date.now();
  const report = { at: new Date(now).toISOString(), channels: 0, newVideos: 0, errors: [] };
  const meta = (await kvGet(env, 'meta')) || { chan: {}, focusAt: {}, lastRun: 0, quotaUntil: 0 };
  meta.chan ||= {}; meta.focusAt ||= {};

  if (!env.YOUTUBE_API_KEY) { report.skipped = 'missing_api_key'; return report; }
  if (meta.quotaUntil && now < meta.quotaUntil) { report.skipped = 'quota_backoff'; return report; }

  const book = { channels: (await kvGet(env, 'channels')) || {}, dirty: false };
  const focus = new Set(opts.focus || []);
  let aborted = false;

  try {
    /* 1) انتخاب کانال‌ها به ترتیب اولویت، در حد بودجهٔ subrequest */
    const ordered = SOURCES
      .map(s => ({ s, key: keyOf(s) }))
      .sort((a, b) => {
        const fa = a.s.tabs.some(t => focus.has(t)) ? 0 : 1;
        const fb = b.s.tabs.some(t => focus.has(t)) ? 0 : 1;
        return fa - fb || (meta.chan[a.key] || 0) - (meta.chan[b.key] || 0);
      });
    const picked = [];
    let cost = 0;
    for (const it of ordered) {
      const rec = book.channels[it.key];
      const fresh = rec && ((rec.ok && now - rec.at < 30 * DAY) || (!rec.ok && now - rec.at < DAY));
      if (fresh && !rec.ok) { meta.chan[it.key] = now; continue; }   // ناموفقِ اخیر: بدون هزینه رد شو
      const c = fresh ? 1 : 2;                                        // resolve + uploads
      if (cost + c > C.budget - 6) break;                             // ۶ تا برای videos.list
      picked.push(it); cost += c;
    }

    /* 2) آپلودهای اخیر هر کانال → فیلتر عنوان → مسیریابی */
    const cands = [];
    await pool(picked, 6, async ({ s, key }) => {
      if (aborted) return;
      try {
        const rec = await resolveChannel(env, s, book);
        if (!rec.ok) { report.errors.push(`${s.handle}: ${rec.why}${rec.title ? ` (${rec.title})` : ''}`); meta.chan[key] = Date.now(); return; }
        const items = await fetchUploads(env, rec, s.max || 30);
        report.channels++;
        for (const v of items) {
          if (!passTitle(v.title)) continue;
          const tab = routeTitle(v.title, s);
          if (tab) cands.push({ ...v, tab, channel: rec.title, avatar: rec.avatar });
        }
        meta.chan[key] = Date.now();
      } catch (e) {
        if (isQuota(e)) { aborted = true; meta.quotaUntil = Date.now() + 60 * 60_000; }
        else if (isAuth(e)) aborted = true;
        else if (e instanceof YTError && e.status === 404) { book.channels[key] = { ok: false, at: Date.now(), why: 'playlist_not_found' }; book.dirty = true; }
        report.errors.push(`${s.handle}: ${e.message}`);
      }
    });

    /* 3) فقط ویدیوهای جدید را جزئیات بگیر (embeddable / مدت / زنده نبودن …) */
    const docs = new Map();
    const tabsInvolved = [...new Set(cands.map(c => c.tab))];
    await Promise.all(tabsInvolved.map(async t => docs.set(t, (await kvGet(env, 'tab:' + t)) || { videos: [], rejected: [] })));

    const fresh = new Map();
    for (const c of cands) {
      const doc = docs.get(c.tab);
      if (fresh.has(c.id) || doc.videos.some(v => v.id === c.id) || doc.rejected.includes(c.id)) continue;
      fresh.set(c.id, c);
    }

    const accepted = [];
    if (fresh.size && !aborted) {
      const details = await fetchDetails(env, [...fresh.keys()]);
      for (const [id, c] of fresh) {
        const doc = docs.get(c.tab);
        const d = details.get(id);
        const dur = parseDuration(d?.contentDetails?.duration);
        const ok = d && d.status?.embeddable === true && d.status?.privacyStatus === 'public'
          && d.snippet?.liveBroadcastContent === 'none' && dur >= C.minDur && dur <= C.maxDur;
        if (!ok) { doc.rejected.push(id); doc.touched = true; continue; }
        const th = d.snippet.thumbnails || {};
        const v = {
          id,
          title: decode(d.snippet.title) || c.title,
          thumb: (th.high || th.medium || {}).url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          thumbHd: (th.maxres || th.standard || th.high || {}).url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          channel: c.channel,
          avatar: c.avatar,
          publishedAt: d.snippet.publishedAt || c.publishedAt,
          duration: dur,
          tab: c.tab,
        };
        doc.videos.push(v); doc.touched = true;
        accepted.push(v);
      }
    }
    report.newVideos = accepted.length;

    /* 4) نوشتن فقط برای تب‌هایی که تغییر کرده‌اند */
    for (const [tabId, doc] of docs) {
      if (!doc.touched) continue;
      delete doc.touched;
      doc.videos = dedupe(doc.videos).sort(byDateDesc).slice(0, C.maxPerTab);
      doc.rejected = doc.rejected.slice(-300);
      doc.updatedAt = now;
      await kvPut(env, 'tab:' + tabId, doc);
    }

    /* 5) تب‌های مجازی: جدیدترین و گل‌ها (ادغام تدریجی) */
    for (const [key, test] of [['latest', () => true], ['goals', v => GOAL_RE.test(v.title)]]) {
      const doc = (await kvGet(env, key)) || { videos: [] };
      const add = accepted.filter(test);
      if (!add.length && doc.updatedAt) continue;
      doc.videos = dedupe([...add, ...doc.videos]).sort(byDateDesc).slice(0, C.maxLatest);
      doc.updatedAt = now;
      await kvPut(env, key, doc);
    }
  } finally {
    if (book.dirty) await kvPut(env, 'channels', book.channels);
    meta.lastRun = now;
    meta.last = { at: report.at, channels: report.channels, newVideos: report.newVideos, aborted: aborted || undefined, errors: report.errors.slice(0, 15) };
    for (const t of focus) meta.focusAt[t] = now;
    await kvPut(env, 'meta', meta);
  }
  if (aborted) report.aborted = true;
  return report;
}

/* ═════════════════════════════ 6) HTTP ═════════════════════════════ */
const corsHeaders = env => ({
  'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'vary': 'Origin',
});
const json = (env, data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(env), ...extra },
});
const pubTab = t => ({ id: t.id, title: t.title, en: t.en, code: t.code });
const focusFor = tab => (tab.id === 'latest' || tab.id === 'goals') ? FOCUS_LATEST : [tab.id];

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(x, y) : a === b;
}

async function handleHighlights(url, env, ctx) {
  const tab = ALL_TABS.find(t => t.id === (url.searchParams.get('tab') || 'latest'));
  if (!tab) return json(env, { ok: false, error: 'unknown_tab' }, 404);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 100, 1), 100);
  const key = tab.virtual ? tab.id : 'tab:' + tab.id;
  const C = cfg(env);
  const now = Date.now();

  let [doc, meta] = await Promise.all([kvGet(env, key), kvGet(env, 'meta')]);
  const hasKey = !!env.YOUTUBE_API_KEY;
  const firstEver = !meta;
  const firstForTab = !doc && !(meta?.focusAt?.[tab.id] > now - 10 * 60_000);
  const stale = meta && now - (meta.lastRun || 0) > C.ttl;

  if (hasKey && (firstEver || firstForTab)) {
    // اولین بازدید: منتظر می‌مانیم تا کاربر صفحهٔ خالی نبیند
    await refreshCoalesced(env, { focus: focusFor(tab) }).catch(e => console.error('refresh', e.message));
    doc = await kvGet(env, key);
  } else if (hasKey && stale) {
    ctx.waitUntil(refreshCoalesced(env, { focus: focusFor(tab) }).catch(e => console.error('refresh', e.message)));
  }

  const videos = (doc?.videos || []).slice(0, limit);
  return json(env, {
    ok: true,
    tab: pubTab(tab),
    updatedAt: doc?.updatedAt || null,
    count: videos.length,
    videos,
    ...(hasKey ? {} : { warning: 'missing_api_key' }),
  }, 200, { 'cache-control': videos.length ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' : 'no-store' });
}

async function handleHealth(env) {
  const [meta, channels, latest] = await Promise.all([kvGet(env, 'meta'), kvGet(env, 'channels'), kvGet(env, 'latest')]);
  const book = channels || {};
  const tabDocs = await Promise.all(TABS.map(t => kvGet(env, 'tab:' + t.id)));
  const failed = SOURCES.filter(s => book[keyOf(s)] && !book[keyOf(s)].ok)
    .map(s => ({ handle: s.handle, why: book[keyOf(s)].why, foundTitle: book[keyOf(s)].title }));
  return json(env, {
    ok: true,
    apiKey: !!env.YOUTUBE_API_KEY,
    kvBound: !!env.CACHE,
    adminEnabled: !!env.ADMIN_TOKEN,
    lastRun: meta?.lastRun ? new Date(meta.lastRun).toISOString() : null,
    quotaBackoffUntil: meta?.quotaUntil > Date.now() ? new Date(meta.quotaUntil).toISOString() : null,
    lastReport: meta?.last || null,
    channels: {
      total: SOURCES.length,
      ok: SOURCES.filter(s => book[keyOf(s)]?.ok).length,
      notResolvedYet: SOURCES.filter(s => !book[keyOf(s)]).length,
      failed,
    },
    latest: latest?.videos?.length || 0,
    tabs: TABS.map((t, i) => ({ id: t.id, videos: tabDocs[i]?.videos?.length || 0, newest: tabDocs[i]?.videos?.[0]?.publishedAt || null })),
  }, 200, { 'cache-control': 'no-store' });
}

async function handleRefresh(request, url, env) {
  if (!env.ADMIN_TOKEN) return json(env, { ok: false, error: 'not_found' }, 404);
  const auth = request.headers.get('authorization') || '';
  if (!(await safeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`))) return json(env, { ok: false, error: 'unauthorized' }, 401);
  const tabId = url.searchParams.get('tab');
  const tab = tabId ? ALL_TABS.find(t => t.id === tabId) : null;
  if (tabId && !tab) return json(env, { ok: false, error: 'unknown_tab' }, 404);
  const report = await refreshCoalesced(env, { focus: tab ? focusFor(tab) : [] });
  return json(env, { ok: true, report }, 200, { 'cache-control': 'no-store' });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
    try {
      switch (url.pathname) {
        case '/api/tabs':       return json(env, { ok: true, tabs: ALL_TABS.map(pubTab) }, 200, { 'cache-control': 'public, max-age=3600' });
        case '/api/highlights': return await handleHighlights(url, env, ctx);
        case '/api/health':     return await handleHealth(env);
        case '/api/refresh':    return await handleRefresh(request, url, env);
        default:                return json(env, { ok: false, error: 'not_found' }, 404);
      }
    } catch (e) {
      console.error('unhandled', e && e.message);
      return json(env, { ok: false, error: 'internal_error' }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshCoalesced(env, {}).then(r => console.log('cron', JSON.stringify(r))).catch(e => console.error('cron', e.message)));
  },
};
