// src/services/lyricsService.js
// Stratégie : aghanilyrics.com (confirmé fonctionnel depuis Render) + cache Supabase
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { supabase } from '../utils/supabase.js';
import { cleanLyrics, detectLanguage, qualityScore, formatLyricsWithSections } from '../utils/textCleaner.js';
import { logger } from '../utils/logger.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const GENIUS_TOKEN = process.env.GENIUS_TOKEN || "flW2DO1G8O3iu_ioi0-iuIgvpnIS-vFVdYy4xUGJt-uNIwFSxx00j6zpwF0oYj3c";
const HAPPI_KEY   = "hk1165-4Ql3s2bNtIM8v3IKHopnnFdVLUTusnsxLw";

// ── HTTP avec retry automatique et repli TLS ─────────────────────────────
async function httpGet(url, retries = 2) {
  const cfg = {
    timeout: 15000,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ar,fr;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
    },
  };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, cfg);
    } catch (e) {
      // Repli TLS pour sites avec certificats anciens
      if (/EPROTO|SSL|legacy sigalg/i.test(e.message || '')) {
        const https = await import('node:https');
        return await axios.get(url, { ...cfg, httpsAgent: new https.Agent({ minVersion: 'TLSv1', rejectUnauthorized: false }) });
      }
      // Retry sur timeout ou 5xx
      if (attempt < retries && (e.code === 'ECONNABORTED' || (e.response?.status >= 500))) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

// ── Normalisation arabe poussée ──────────────────────────────────────────
function norm(s = '') {
  return s.toLowerCase().trim()
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670]/g, '') // tachkil
    .replace(/[\u0300-\u036f]/g, '')        // accents latins
    .replace(/[أإآا]/g, 'ا')               // alef
    .replace(/[ىي]/g, 'ي')                  // ya
    .replace(/ة/g, 'ه')                     // ta marbuta
    .replace(/\s+/g, ' ');
}

function isArabic(text = '') {
  return /[\u0600-\u06FF]/.test(text);
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.9;
  const wA = new Set(a.split(/\s+/).filter(w => w.length > 1));
  const wB = new Set(b.split(/\s+/).filter(w => w.length > 1));
  let common = 0;
  wA.forEach(w => { if (wB.has(w)) common++; });
  return common / Math.max(wA.size, wB.size, 1);
}

function toSlug(s = '') {
  return s.toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Extraction paroles depuis une page HTML ──────────────────────────────
function extractLyrics($) {
  // Supprimer bruit
  $('script, style, nav, header, footer, iframe, .adsbygoogle, .sharedaddy, .jp-relatedposts, [class*="ad-"], [id*="ad-"]').remove();

  // Sélecteurs dans l'ordre de priorité
  const selectors = ['.entry-content', 'article .post-content', '.post-content', 'article', '.lyric', '.lyrics', '#lyric-body-text', '[class*="lyric"]'];
  for (const sel of selectors) {
    const el = $(sel).first();
    if (!el.length) continue;
    el.find('h1, h2, h3, script, style').remove();
    el.find('br').replaceWith('\n');
    const text = el.text().replace(/\n{3,}/g, '\n\n').trim();
    if (isQuality(text)) return text;
  }

  // Fallback : plus grand bloc de texte arabe
  let best = '';
  $('div, p, section').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > best.length && text.length < 12000 && isQuality(text)) best = text;
  });
  return best || null;
}

// ── Filtrage qualité ─────────────────────────────────────────────────────
function isQuality(text = '') {
  if (text.length < 100) return false;
  if (/advertisement|subscribe now|sign up|cookie/i.test(text)) return false;
  if (/[\u0600-\u06FF]/.test(text)) {
    const arabicRatio = (text.match(/[\u0600-\u06FF]/g) || []).length / Math.max(text.replace(/\s/g, '').length, 1);
    return arabicRatio > 0.2;
  }
  return true;
}

// ── Table de translittération artistes ──────────────────────────────────
const ARAB_ARTISTS = {
  'محمد فؤاد':'mohammad-fouad','عمرو دياب':'amr-diab','تامر حسني':'tamer-hosny',
  'نانسي عجرم':'nancy-ajram','هاني شاكر':'hani-shaker','محمد منير':'mohammed-mounir',
  'وائل كفوري':'wael-kfoury','أم كلثوم':'om-kalthoum','عبد الحليم حافظ':'abdel-halim-hafez',
  'كاظم الساهر':'kazem-al-saher','ماجد المهندس':'majid-al-mohandis',
  'راشد الماجد':'rashed-al-majed','حسين الجسمي':'hussain-al-jasmi','محمد عبده':'mohammed-abdo',
  'فيروز':'fairuz','ميادة الحناوي':'mayada-el-hennawy','صباح فخري':'sabah-fakhri',
  'وردة الجزائرية':'warda','سميرة سعيد':'samira-said',
  'بلطي':'balti','صابر الرباعي':'saber-rebai','لطفي بوشناق':'lotfi-bouchnak',
  'لطيفة':'latifa','لطيفة العرفاوي':'latifa','آمال المثلوثي':'emel-mathlouthi',
  'نوردو':'nordo','علاء':'ala','كافون':'kafon','أماني السويسي':'amani-swissi',
  'هند صبري':'hend-sabry','زازا':'zaza','جي جي آ':'gga','الصادق ثريا':'sadek-thraya',
  'الشاب خالد':'cheb-khaled','الشاب مامي':'cheb-mami','سولكينغ':'soolking',
  'الشابة الزهوانية':'cheba-zahouania',
  'سعد لمجرد':'saad-lamjarred','حاتم عمور':'hatim-ammor','أسماء لمنور':'asma-lmnawar',
  'منال':'manal','مسلم':'muslim','دوزي':'douzi',
  'أيمن الأعتر':'ayman-alatar','أحمد فكرون':'ahmed-fakroun','محمد حسن':'mohamed-hassan',
  'سامي يوسف':'sami-yusuf',
};

// ══════════════════════════════════════════════════════════════
// PIPELINE PRINCIPAL
// ══════════════════════════════════════════════════════════════
export async function importLyricsPipeline(title, artist) {
  logger.info(`Pipeline: "${title}" / "${artist}"`);
  const trace = [];

  // ── ÉTAPE 1 : Cache Supabase ─────────────────────────────────
  try {
    const cacheKey = `${norm(title)}|${norm(artist)}`;
    const { data: cached } = await supabase
      .from('lyrics_imports')
      .select('*')
      .eq('cache_key', cacheKey)
      .eq('status', 'completed')
      .single();

    if (cached?.lyrics) {
      logger.info(`✅ Cache Supabase hit: "${title}"`);
      trace.push({ step: 'cache', status: 'found' });
      return { lyrics: cached.lyrics, lang: cached.lang, source: 'cache', provider: 'Cache Supabase', score: 1, trace };
    }
  } catch {}

  // ── ÉTAPE 2 : aghanilyrics.com (confirmé fonctionnel depuis Render) ──
  try {
    logger.info('→ aghanilyrics.com…');
    const result = await scrapeAghaniLyrics(title, artist);
    if (result?.lyrics) {
      const cleaned = cleanLyrics(result.lyrics);
      if (cleaned && cleaned.length > 100) {
        const lang  = detectLanguage(cleaned);
        const score = qualityScore(cleaned, 'scraping');
        trace.push({ step: 'aghanilyrics', status: 'found', provider: result.provider });
        logger.info(`✅ aghanilyrics.com — ${result.provider}`);

        // Sauvegarder en cache
        try {
          const cacheKey = `${norm(title)}|${norm(artist)}`;
          await supabase.from('lyrics_imports').upsert({
            cache_key: cacheKey, title, artist: artist || '',
            lyrics: formatLyricsWithSections(cleaned, lang),
            lang, source: 'aghanilyrics', provider: result.provider,
            score, approved: true, status: 'completed',
          }, { onConflict: 'cache_key' });
        } catch {}

        return { lyrics: formatLyricsWithSections(cleaned, lang), lang, source: 'aghanilyrics', provider: result.provider, score, trace };
      }
    }
    trace.push({ step: 'aghanilyrics', status: 'no_result', detail: result?.detail });
  } catch (e) {
    trace.push({ step: 'aghanilyrics', status: 'error', message: e.message });
    logger.warn(`✗ aghanilyrics: ${e.message}`);
  }

  logger.warn(`❌ Aucune parole pour "${title}"`);
  return { lyrics: null, trace };
}

// ══════════════════════════════════════════════════════════════
// SCRAPING AGHANILYRICS — URL directe artiste
// ══════════════════════════════════════════════════════════════
async function scrapeAghaniLyrics(title, artist) {
  const slug = ARAB_ARTISTS[artist?.trim()] || toSlug(artist || '');
  if (!slug || slug.length < 2) {
    return { lyrics: null, detail: `Artiste "${artist}" manquant ou non reconnu — renseignez le nom en anglais dans le champ Compositeur` };
  }

  const artistUrl = `https://aghanilyrics.com/allsongslyrics.php?songslyrics=${slug}`;
  logger.info(`  URL: ${artistUrl}`);

  const res = await httpGet(artistUrl);
  const $ = cheerio.load(res.data);

  const songLinks = [];
  $('a[href*="songlyrics.php"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (!text) return;
    const url = href.startsWith('http') ? href : `https://aghanilyrics.com/${href.replace(/^\//, '')}`;
    songLinks.push({ url, text });
  });

  logger.info(`  ${songLinks.length} chansons pour "${slug}"`);
  if (!songLinks.length) return { lyrics: null, detail: `Artiste "${slug}" introuvable` };

  // Matcher par titre
  const titleNorm = norm(title);
  const scored = songLinks.map(s => ({ ...s, score: similarity(titleNorm, norm(s.text)) }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  logger.info(`  Match: "${best.text}" — score ${best.score.toFixed(2)}`);

  const top3 = scored.slice(0, 3).map(s => `"${s.text}" (${s.score.toFixed(2)})`).join(', ');
  logger.info(`  Top 3: ${top3}`);

  if (best.score < 0.15) {
    return { lyrics: null, detail: `Score trop faible — top 3: ${top3}` };
  }

  const pageRes = await httpGet(best.url);
  const $$ = cheerio.load(pageRes.data);
  const lyrics = extractLyrics($$);

  if (!lyrics) return { lyrics: null, detail: 'Page trouvée mais paroles non extraites' };
  return { lyrics, provider: `aghanilyrics.com — ${best.text}` };
}

// ══════════════════════════════════════════════════════════════
// RECHERCHE SUGGESTIONS
// ══════════════════════════════════════════════════════════════
export async function searchSongs(query) {
  const results = [];
  try {
    const r = await axios.get('https://api.happi.dev/v1/music', { params: { q: query, limit: 8 }, headers: { 'x-happi-key': HAPPI_KEY }, timeout: 8000 });
    (r.data.result || []).forEach(t => results.push({ title: t.track, artist: t.artist, source: 'happi', cover: null }));
  } catch {}
  try {
    const r = await axios.get(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=6`, { timeout: 8000 });
    (r.data.data || []).forEach(t => results.push({ title: t.title, artist: t.artist?.name || '', source: 'deezer', cover: t.album?.cover_small || null }));
  } catch {}
  try {
    const r = await axios.get(`https://api.genius.com/search?q=${encodeURIComponent(query)}&per_page=6`, { headers: { Authorization: `Bearer ${GENIUS_TOKEN}` }, timeout: 8000 });
    (r.data.response?.hits || []).forEach(h => results.push({ title: h.result.title, artist: h.result.primary_artist.name, source: 'genius', cover: h.result.song_art_image_thumbnail_url || null }));
  } catch {}
  const seen = new Set();
  return results.filter(r => { const k = r.title.toLowerCase().trim(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
}

export async function searchYouTubeUrl() { return null; }
