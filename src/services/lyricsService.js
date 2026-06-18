// src/services/lyricsService.js
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { cleanLyrics, detectLanguage, qualityScore, formatLyricsWithSections } from '../utils/textCleaner.js';
import { logger } from '../utils/logger.js';

const GENIUS_TOKEN = process.env.GENIUS_TOKEN || "flW2DO1G8O3iu_ioi0-iuIgvpnIS-vFVdYy4xUGJt-uNIwFSxx00j6zpwF0oYj3c";
const HAPPI_KEY   = "hk1165-4Ql3s2bNtIM8v3IKHopnnFdVLUTusnsxLw";
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Requête HTTP avec repli TLS auto ────────────────────────────────────
async function httpGet(url) {
  const cfg = { timeout: 12000, headers: { 'User-Agent': UA, 'Accept-Language': 'ar,fr;q=0.9,en;q=0.8' } };
  try {
    return await axios.get(url, cfg);
  } catch (e) {
    if (/EPROTO|SSL|unsupported protocol|legacy sigalg/i.test(e.message || '')) {
      const https = await import('node:https');
      return await axios.get(url, { ...cfg, httpsAgent: new https.Agent({ minVersion: 'TLSv1', rejectUnauthorized: false }) });
    }
    throw e;
  }
}

// ── Normalisation texte pour matching ────────────────────────────────────
function norm(s = '') {
  return s.toLowerCase().trim()
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670]/g, '') // diacritiques arabes
    .replace(/[\u0300-\u036f]/g, '')         // accents latins
    .replace(/[أإآا]/g, 'ا')                 // variantes alef
    .replace(/[ىي]/g, 'ي')                   // variantes ya
    .replace(/ة/g, 'ه')                      // ta marbuta
    .replace(/\s+/g, ' ');
}

// ── Table de translittération pour artistes arabes courants ─────────────
const ARAB_ARTISTS = {
  // Égyptiens
  'محمد فؤاد': 'mohammad-fouad',
  'عمرو دياب': 'amr-diab',
  'تامر حسني': 'tamer-hosny',
  'نانسي عجرم': 'nancy-ajram',
  'هاني شاكر': 'hani-shaker',
  'محمد منير': 'mohammed-mounir',
  'وائل كفوري': 'wael-kfoury',
  'أم كلثوم': 'om-kalthoum',
  'عبد الحليم حافظ': 'abdel-halim-hafez',

  // Khalijis
  'كاظم الساهر': 'kazem-al-saher',
  'ماجد المهندس': 'majid-al-mohandis',
  'راشد الماجد': 'rashed-al-majed',
  'عبد الله الرويشد': 'abdallah-al-rowishd',
  'حسين الجسمي': 'hussain-al-jasmi',
  'محمد عبده': 'mohammed-abdo',

  // Syriens/Libanais
  'فيروز': 'fairuz',
  'ميادة الحناوي': 'mayada-el-hennawy',
  'صباح فخري': 'sabah-fakhri',
  'وردة الجزائرية': 'warda',
  'سميرة سعيد': 'samira-said',

  // Tunisiens
  'بلطي': 'balti',
  'صابر الرباعي': 'saber-rebai',
  'لطفي بوشناق': 'lotfi-bouchnak',
  'لطيفة': 'latifa',
  'لطيفة العرفاوي': 'latifa',
  'آمال المثلوثي': 'emel-mathlouthi',
  'نوردو': 'nordo',
  'علاء': 'ala',
  'كافون': 'kafon',
  'أماني السويسي': 'amani-swissi',
  'هند صبري': 'hend-sabry',
  'زازا': 'zaza',
  'جي جي آ': 'gga',
  'الصادق ثريا': 'sadek-thraya',
  'سامي يوسف': 'sami-yusuf',

  // Algériens
  'الشاب خالد': 'cheb-khaled',
  'الشاب مامي': 'cheb-mami',
  'سولكينغ': 'soolking',
  'دي جي سنايك': 'dj-snake',
  'ريم ك': 'rimk',
  'الشابة الزهوانية': 'cheba-zahouania',

  // Marocains
  'سعد لمجرد': 'saad-lamjarred',
  'حاتم عمور': 'hatim-ammor',
  'أسماء لمنور': 'asma-lmnawar',
  'منال': 'manal',
  'مسلم': 'muslim',
  'دوزي': 'douzi',

  // Libyens
  'أيمن الأعتر': 'ayman-alatar',
  'أحمد فكرون': 'ahmed-fakroun',
  'محمد حسن': 'mohamed-hassan',
};

// ── Slugifier un nom pour aghanilyrics.com ───────────────────────────────
function toAghaniSlug(s = '') {
  const cleaned = s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned;
}

// ══════════════════════════════════════════════════════════════
// PIPELINE PRINCIPAL
// ══════════════════════════════════════════════════════════════
export async function importLyricsPipeline(title, artist) {
  logger.info(`Pipeline: "${title}" / "${artist}"`);
  const trace = [];
  const isArabic = /[\u0600-\u06FF]/.test(title + artist);

  const steps = isArabic
    ? [
        { name: 'aghanilyrics', fn: tryAghaniLyrics },
        { name: 'happi',        fn: tryHappi },
        { name: 'genius',       fn: tryGenius },
        { name: 'deezer',       fn: tryDeezer },
        { name: 'lyrics.ovh',   fn: tryLyricsOvh },
      ]
    : [
        { name: 'happi',        fn: tryHappi },
        { name: 'genius',       fn: tryGenius },
        { name: 'lyrics.ovh',   fn: tryLyricsOvh },
        { name: 'deezer',       fn: tryDeezer },
      ];

  for (const step of steps) {
    try {
      logger.info(`→ ${step.name}…`);
      const result = await step.fn(title, artist);
      if (!result?.lyrics || result.lyrics.length < 30) {
        trace.push({ step: step.name, status: 'no_result', detail: result?.detail });
        continue;
      }
      const cleaned = cleanLyrics(result.lyrics);
      if (!cleaned || cleaned.length < 30) {
        trace.push({ step: step.name, status: 'empty_after_clean' });
        continue;
      }
      const lang  = detectLanguage(cleaned);
      const score = qualityScore(cleaned, step.name === 'aghanilyrics' ? 'scraping' : 'api');
      logger.info(`✅ ${step.name} — ${result.provider}`);
      trace.push({ step: step.name, status: 'found', provider: result.provider });
      return { lyrics: formatLyricsWithSections(cleaned, lang), lang, source: step.name, provider: result.provider, score, trace };
    } catch (e) {
      trace.push({ step: step.name, status: 'error', message: e.message, httpStatus: e.response?.status });
      logger.warn(`✗ ${step.name}: ${e.message}`);
    }
  }

  logger.warn(`❌ Aucune parole pour "${title}"`);
  return { lyrics: null, trace };
}

// ══════════════════════════════════════════════════════════════
// AGHANILYRICS.COM — stratégie URL directe par artiste
// 1. Construire l'URL artiste avec le slug anglais du nom
// 2. Scraper la liste de ses chansons
// 3. Matcher la chanson par titre
// 4. Scraper la page chanson
// ══════════════════════════════════════════════════════════════
async function tryAghaniLyrics(title, artist) {
  // Résoudre le slug : table de translittération d'abord, puis slugification si latin
  let slug = ARAB_ARTISTS[artist?.trim()] || toAghaniSlug(artist);
  if (!slug || slug.length < 2) {
    return { lyrics: null, detail: 'Artiste absent — impossible de chercher sur aghanilyrics' };
  }

  const artistUrl = `https://aghanilyrics.com/allsongslyrics.php?songslyrics=${slug}`;
  logger.info(`  aghanilyrics: ${artistUrl}`);

  const res = await httpGet(artistUrl);
  const $ = cheerio.load(res.data);

  // Collecter tous les liens de chansons de l'artiste
  const songLinks = [];
  $('a[href*="songlyrics.php"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    const fullUrl = href.startsWith('http') ? href : `https://aghanilyrics.com/${href.replace(/^\//, '')}`;
    if (text) songLinks.push({ url: fullUrl, text });
  });

  if (!songLinks.length) {
    return { lyrics: null, detail: `Artiste "${slug}" non trouvé sur aghanilyrics` };
  }

  // Matcher par titre (normalisation poussée)
  const titleNorm = norm(title);
  const match = songLinks
    .map(s => ({ ...s, score: similarity(titleNorm, norm(s.text)) }))
    .sort((a, b) => b.score - a.score)[0];

  logger.info(`  meilleur match: "${match.text}" (score: ${match.score.toFixed(2)})`);

  if (match.score < 0.3) {
    return { lyrics: null, detail: `Aucune chanson proche de "${title}" (meilleur: "${match.text}" score ${match.score.toFixed(2)})` };
  }

  // Scraper la page de la chanson
  const pageRes = await httpGet(match.url);
  const $$ = cheerio.load(pageRes.data);
  const lyrics = extractLyricsFromPage($$);

  if (!lyrics) return { lyrics: null, detail: 'Page chanson trouvée mais paroles non extraites' };
  return { lyrics, provider: 'aghanilyrics.com' };
}

// ── Extraction paroles depuis une page aghanilyrics ──────────────────────
function extractLyricsFromPage($) {
  // Essayer les sélecteurs dans l'ordre
  const selectors = [
    '.entry-content',
    'article .post-content',
    '.post-content',
    'article',
  ];

  for (const sel of selectors) {
    const el = $(sel).first();
    if (!el.length) continue;
    // Nettoyer les éléments parasites (scripts, styles, publicités, navigation)
    el.find('script, style, .sharedaddy, .jp-relatedposts, nav, .navigation, iframe, .adsbygoogle').remove();
    el.find('br').replaceWith('\n');
    const text = el.text().replace(/\n{3,}/g, '\n\n').trim();
    const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
    if (arabicChars > 20 && text.length > 100) return text;
  }

  // Fallback : plus grand bloc de texte arabe
  let best = '';
  $('div, p, section').each((_, el) => {
    const text = $(el).text().trim();
    const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
    if (arabicChars > 30 && text.length > best.length && text.length < 10000) best = text;
  });
  return best.length > 100 ? best : null;
}

// ── Similarité entre deux chaînes (0-1) ─────────────────────────────────
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.9;
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 1));
  let common = 0;
  wordsA.forEach(w => { if (wordsB.has(w)) common++; });
  const total = Math.max(wordsA.size, wordsB.size, 1);
  return common / total;
}

// ══════════════════════════════════════════════════════════════
// APIs
// ══════════════════════════════════════════════════════════════
async function tryHappi(title, artist) {
  const r = await axios.get('https://api.happi.dev/v1/music', {
    params: { q: `${title} ${artist}`.trim(), limit: 1 },
    headers: { 'x-happi-key': HAPPI_KEY }, timeout: 10000,
  });
  const track = r.data?.result?.[0];
  if (!track?.api_lyrics) return null;
  const lr = await axios.get(track.api_lyrics, { headers: { 'x-happi-key': HAPPI_KEY }, timeout: 10000 });
  const lyrics = lr.data?.result?.lyrics;
  return lyrics ? { lyrics, provider: 'Happi.dev' } : null;
}

async function tryGenius(title, artist) {
  const r = await axios.get('https://api.genius.com/search', {
    params: { q: `${title} ${artist}`.trim() },
    headers: { Authorization: `Bearer ${GENIUS_TOKEN}` }, timeout: 10000,
  });
  const hit = r.data?.response?.hits?.[0]?.result;
  if (!hit?.url) return null;
  const page = await httpGet(hit.url);
  const $ = cheerio.load(page.data);
  let text = '';
  $('[data-lyrics-container="true"]').each((_, el) => { text += $(el).text() + '\n'; });
  return text.trim() ? { lyrics: text.trim(), provider: 'Genius' } : null;
}

async function tryDeezer(title, artist) {
  const s = await axios.get('https://api.deezer.com/search', {
    params: { q: `${title} ${artist}`.trim(), limit: 1 }, timeout: 10000,
  });
  const track = s.data?.data?.[0];
  if (!track?.id) return null;
  let token, cookies;
  try {
    const t = await httpGet('https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=');
    token = t.data?.results?.checkForm;
    cookies = (t.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  } catch { return null; }
  if (!token) return null;
  try {
    const lr = await axios.get('https://www.deezer.com/ajax/gw-light.php', {
      params: { method: 'song.getLyrics', input: 3, api_version: '1.0', api_token: token, sng_id: track.id },
      headers: { 'User-Agent': UA, Cookie: cookies }, timeout: 10000,
    });
    const lyrics = lr.data?.results?.LYRICS_TEXT;
    return lyrics ? { lyrics, provider: 'Deezer' } : null;
  } catch { return null; }
}

async function tryLyricsOvh(title, artist) {
  if (!artist) return null;
  const r = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, { timeout: 15000 });
  const lyrics = r.data?.lyrics;
  return lyrics ? { lyrics, provider: 'Lyrics.ovh' } : null;
}

// ══════════════════════════════════════════════════════════════
// RECHERCHE (suggestions)
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
