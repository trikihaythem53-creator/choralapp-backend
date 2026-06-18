// src/services/lyricsService.js
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { cleanLyrics, detectLanguage, qualityScore, formatLyricsWithSections } from '../utils/textCleaner.js';
import { logger } from '../utils/logger.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function httpGet(url) {
  const cfg = { timeout: 15000, headers: { 'User-Agent': UA, 'Accept-Language': 'ar,fr;q=0.9,en;q=0.8' } };
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

function norm(s = '') {
  return s.toLowerCase().trim()
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[أإآا]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.9;
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 1));
  let common = 0;
  wordsA.forEach(w => { if (wordsB.has(w)) common++; });
  return common / Math.max(wordsA.size, wordsB.size, 1);
}

function toSlug(s = '') {
  return s.toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Table artistes arabes → slug aghanilyrics.com ────────────────────────
const ARAB_ARTISTS = {
  // Égyptiens
  'محمد فؤاد': 'mohammad-fouad', 'عمرو دياب': 'amr-diab', 'تامر حسني': 'tamer-hosny',
  'نانسي عجرم': 'nancy-ajram', 'هاني شاكر': 'hani-shaker', 'محمد منير': 'mohammed-mounir',
  'وائل كفوري': 'wael-kfoury', 'أم كلثوم': 'om-kalthoum', 'عبد الحليم حافظ': 'abdel-halim-hafez',
  // Khalijis
  'كاظم الساهر': 'kazem-al-saher', 'ماجد المهندس': 'majid-al-mohandis',
  'راشد الماجد': 'rashed-al-majed', 'حسين الجسمي': 'hussain-al-jasmi', 'محمد عبده': 'mohammed-abdo',
  // Syriens/Libanais
  'فيروز': 'fairuz', 'ميادة الحناوي': 'mayada-el-hennawy', 'صباح فخري': 'sabah-fakhri',
  'وردة الجزائرية': 'warda', 'سميرة سعيد': 'samira-said',
  // Tunisiens
  'بلطي': 'balti', 'صابر الرباعي': 'saber-rebai', 'لطفي بوشناق': 'lotfi-bouchnak',
  'لطيفة': 'latifa', 'لطيفة العرفاوي': 'latifa', 'آمال المثلوثي': 'emel-mathlouthi',
  'نوردو': 'nordo', 'علاء': 'ala', 'كافون': 'kafon', 'أماني السويسي': 'amani-swissi',
  'هند صبري': 'hend-sabry', 'زازا': 'zaza', 'جي جي آ': 'gga', 'الصادق ثريا': 'sadek-thraya',
  // Algériens
  'الشاب خالد': 'cheb-khaled', 'الشاب مامي': 'cheb-mami', 'سولكينغ': 'soolking',
  'الشابة الزهوانية': 'cheba-zahouania',
  // Marocains
  'سعد لمجرد': 'saad-lamjarred', 'حاتم عمور': 'hatim-ammor', 'أسماء لمنور': 'asma-lmnawar',
  'منال': 'manal', 'مسلم': 'muslim', 'دوزي': 'douzi',
  // Libyens
  'أيمن الأعتر': 'ayman-alatar', 'أحمد فكرون': 'ahmed-fakroun', 'محمد حسن': 'mohamed-hassan',
  // Autres
  'سامي يوسف': 'sami-yusuf',
};

// ══════════════════════════════════════════════════════════════
// PIPELINE — aghanilyrics.com uniquement (stratégie URL directe)
// ══════════════════════════════════════════════════════════════
export async function importLyricsPipeline(title, artist) {
  logger.info(`Pipeline: "${title}" / "${artist}"`);
  const trace = [];

  try {
    logger.info('→ aghanilyrics.com…');
    const result = await tryAghaniLyrics(title, artist);
    if (result?.lyrics && result.lyrics.length > 30) {
      const cleaned = cleanLyrics(result.lyrics);
      if (cleaned && cleaned.length > 30) {
        const lang  = detectLanguage(cleaned);
        const score = qualityScore(cleaned, 'scraping');
        logger.info(`✅ Trouvé — ${result.provider}`);
        trace.push({ step: 'aghanilyrics', status: 'found', provider: result.provider });
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
// AGHANILYRICS — URL directe artiste + match titre
// ══════════════════════════════════════════════════════════════
async function tryAghaniLyrics(title, artist) {
  // Résoudre le slug artiste
  const slug = ARAB_ARTISTS[artist?.trim()] || toSlug(artist || '');
  if (!slug || slug.length < 2) {
    return { lyrics: null, detail: 'Artiste manquant — renseignez le compositeur en anglais ou en arabe' };
  }

  // 1. Scraper la page artiste
  const artistUrl = `https://aghanilyrics.com/allsongslyrics.php?songslyrics=${slug}`;
  logger.info(`  URL artiste: ${artistUrl}`);
  const res = await httpGet(artistUrl);
  const $ = cheerio.load(res.data);

  // Collecter tous les liens de chansons
  const songLinks = [];
  $('a[href*="songlyrics.php"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (!text) return;
    const url = href.startsWith('http') ? href : `https://aghanilyrics.com/${href.replace(/^\//, '')}`;
    songLinks.push({ url, text });
  });

  logger.info(`  ${songLinks.length} chansons trouvées pour "${slug}"`);
  if (!songLinks.length) {
    return { lyrics: null, detail: `Artiste "${slug}" introuvable sur aghanilyrics.com` };
  }

  // 2. Matcher par titre
  const titleNorm = norm(title);
  const scored = songLinks.map(s => ({ ...s, score: similarity(titleNorm, norm(s.text)) }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  logger.info(`  Meilleur match: "${best.text}" (score: ${best.score.toFixed(2)})`);

  if (best.score < 0.25) {
    return { lyrics: null, detail: `Aucune chanson proche de "${title}" — meilleur: "${best.text}" (${best.score.toFixed(2)})` };
  }

  // 3. Scraper la page chanson
  const pageRes = await httpGet(best.url);
  const $$ = cheerio.load(pageRes.data);
  const lyrics = extractLyrics($$);

  if (!lyrics) return { lyrics: null, detail: 'Page trouvée mais paroles non extraites' };
  return { lyrics, provider: `aghanilyrics.com (${best.text})` };
}

function extractLyrics($) {
  for (const sel of ['.entry-content', 'article .post-content', '.post-content', 'article']) {
    const el = $(sel).first();
    if (!el.length) continue;
    el.find('script, style, .sharedaddy, .jp-relatedposts, nav, iframe, .adsbygoogle, h1, h2, h3').remove();
    el.find('br').replaceWith('\n');
    const text = el.text().replace(/\n{3,}/g, '\n\n').trim();
    const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
    if (arabicChars > 20 && text.length > 100) return text;
  }
  let best = '';
  $('div, p').each((_, el) => {
    const text = $(el).text().trim();
    const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
    if (arabicChars > 30 && text.length > best.length && text.length < 10000) best = text;
  });
  return best.length > 100 ? best : null;
}

// ══════════════════════════════════════════════════════════════
// RECHERCHE suggestions (inchangé)
// ══════════════════════════════════════════════════════════════
const GENIUS_TOKEN = process.env.GENIUS_TOKEN || "flW2DO1G8O3iu_ioi0-iuIgvpnIS-vFVdYy4xUGJt-uNIwFSxx00j6zpwF0oYj3c";
const HAPPI_KEY   = "hk1165-4Ql3s2bNtIM8v3IKHopnnFdVLUTusnsxLw";

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
