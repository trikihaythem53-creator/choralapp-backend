// src/services/lyricsService.js
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { cleanLyrics, detectLanguage, qualityScore, formatLyricsWithSections } from '../utils/textCleaner.js';
import { logger } from '../utils/logger.js';

const GENIUS_TOKEN = process.env.GENIUS_TOKEN || "flW2DO1G8O3iu_ioi0-iuIgvpnIS-vFVdYy4xUGJt-uNIwFSxx00j6zpwF0oYj3c";
const HAPPI_KEY     = "hk1165-4Ql3s2bNtIM8v3IKHopnnFdVLUTusnsxLw";

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ══════════════════════════════════════════════════════════════
// PIPELINE PRINCIPAL — Happi.dev → Genius → Deezer → Lyrics.ovh → Scraping
// Couvre arabe, français et anglais
// ══════════════════════════════════════════════════════════════

export async function importLyricsPipeline(title, artist) {
  logger.info(`Pipeline lyrics: "${title}" by "${artist}"`);

  const steps = [
    { name: 'scraping',   fn: tryScraping },
    { name: 'happi',      fn: tryHappi },
    { name: 'genius',     fn: tryGenius },
    { name: 'deezer',     fn: tryDeezer },
    { name: 'lyrics.ovh', fn: tryLyricsOvh },
  ];

  const partial = [];
  const trace = []; // journal détaillé de chaque étape, utile pour diagnostiquer

  for (const step of steps) {
    try {
      logger.info(`→ Tentative: ${step.name}...`);
      const result = await step.fn(title, artist);
      if (result && result.lyrics && result.lyrics.length > 30) {
        const cleaned = cleanLyrics(result.lyrics);
        if (cleaned && cleaned.length > 30) {
          const score = qualityScore(cleaned, step.name === 'scraping' ? 'scraping' : 'api');
          const lang  = detectLanguage(cleaned);
          partial.push({ lyrics: cleaned, lang, source: step.name, provider: result.provider || step.name, score });
          trace.push({ step: step.name, status: 'partial', length: cleaned.length });

          if (cleaned.length > 100) {
            logger.info(`✅ Paroles trouvées via ${step.name} (${result.provider || ''})`);
            return formatResult(partial[partial.length - 1], trace);
          }
        } else {
          trace.push({ step: step.name, status: 'empty_after_clean' });
        }
      } else {
        trace.push({ step: step.name, status: 'no_result', subTrace: result?.subTrace });
      }
    } catch (e) {
      const status = e.response?.status;
      trace.push({ step: step.name, status: 'error', message: e.message, httpStatus: status });
      logger.warn(`✗ ${step.name} échoué (${status || 'no-status'}): ${e.message}`);
    }
  }

  if (partial.length) {
    const best = partial.sort((a, b) => b.score - a.score)[0];
    logger.info(`⚠️ Résultat partiel retenu via ${best.source}`);
    return formatResult(best, trace);
  }

  logger.warn(`❌ Aucune parole trouvée pour "${title}" (${artist})`);
  logger.warn('Trace complète:', JSON.stringify(trace));
  return { lyrics: null, trace }; // null lyrics mais trace renvoyée pour diagnostic
}

function formatResult({ lyrics, lang, source, provider, score }, trace) {
  return {
    lyrics: formatLyricsWithSections(lyrics, lang),
    lang,
    source,
    provider,
    score,
    trace,
  };
}

// ══════════════════════════════════════════════════════════════
// RECHERCHE YOUTUBE — appelée uniquement si des paroles ont été trouvées
// ══════════════════════════════════════════════════════════════

export async function searchYouTubeUrl(title, artist) {
  try {
    const query = encodeURIComponent(`${title} ${artist}`.trim());
    const res = await axios.get(`https://www.youtube.com/results?search_query=${query}`, {
      timeout: 8000,
      headers: { 'User-Agent': UA },
    });
    const match = res.data.match(/"videoId":"([\w-]{11})"/);
    return match ? `https://www.youtube.com/watch?v=${match[1]}` : null;
  } catch (e) {
    logger.warn('Recherche YouTube échouée:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// RECHERCHE MULTI-SOURCES (suggestions pour l'onglet "Recherche auto")
// ══════════════════════════════════════════════════════════════

export async function searchSongs(query) {
  const results = [];

  try {
    const res = await axios.get('https://api.happi.dev/v1/music', {
      params: { q: query, limit: 8 },
      headers: { 'x-happi-key': HAPPI_KEY },
      timeout: 8000,
    });
    (res.data.result || []).forEach(t => results.push({ title: t.track, artist: t.artist, source: 'happi', cover: null }));
  } catch (e) { logger.warn('Happi search error:', e.message); }

  try {
    const res = await axios.get(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=6`, { timeout: 8000 });
    (res.data.data || []).forEach(t => results.push({ title: t.title, artist: t.artist?.name || '', source: 'deezer', cover: t.album?.cover_small || null }));
  } catch (e) { logger.warn('Deezer search error:', e.message); }

  try {
    const res = await axios.get(`https://api.genius.com/search?q=${encodeURIComponent(query)}&per_page=6`, {
      headers: { Authorization: `Bearer ${GENIUS_TOKEN}` },
      timeout: 8000,
    });
    (res.data.response?.hits || []).forEach(h => results.push({ title: h.result.title, artist: h.result.primary_artist.name, source: 'genius', cover: h.result.song_art_image_thumbnail_url || null }));
  } catch (e) { logger.warn('Genius search error:', e.message); }

  const seen = new Set();
  return results.filter(r => {
    const key = r.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 12);
}

// ══════════════════════════════════════════════════════════════
// ÉTAPE 1 : Happi.dev — couvre arabe, français, anglais
// ══════════════════════════════════════════════════════════════

async function tryHappi(title, artist) {
  const res = await axios.get('https://api.happi.dev/v1/music', {
    params: { q: `${title} ${artist}`.trim(), limit: 1 },
    headers: { 'x-happi-key': HAPPI_KEY },
    timeout: 8000,
  });
  const track = res.data?.result?.[0];
  if (!track?.api_lyrics) return null;

  const lyricsRes = await axios.get(track.api_lyrics, { headers: { 'x-happi-key': HAPPI_KEY }, timeout: 8000 });
  const lyrics = lyricsRes.data?.result?.lyrics;
  return lyrics ? { lyrics, provider: 'Happi.dev' } : null;
}

// ══════════════════════════════════════════════════════════════
// ÉTAPE 2 : Genius API — fort en anglais, correct en français/arabe
// ══════════════════════════════════════════════════════════════

async function tryGenius(title, artist) {
  const res = await axios.get('https://api.genius.com/search', {
    params: { q: `${title} ${artist}`.trim() },
    headers: { Authorization: `Bearer ${GENIUS_TOKEN}` },
    timeout: 8000,
  });
  const hit = res.data?.response?.hits?.[0]?.result;
  if (!hit?.url) return null;

  const lyrics = await scrapeGeniusPage(hit.url);
  return lyrics ? { lyrics, provider: 'Genius' } : null;
}

async function scrapeGeniusPage(url) {
  const res = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': UA } });
  const $ = cheerio.load(res.data);
  let text = '';
  $('[data-lyrics-container="true"]').each((_, el) => { text += $(el).text() + '\n'; });
  return text.trim() || null;
}

// ══════════════════════════════════════════════════════════════
// ÉTAPE 3 : Deezer — endpoint interne non officiel (gratuit, sans clé)
// ══════════════════════════════════════════════════════════════

async function tryDeezer(title, artist) {
  const searchRes = await axios.get('https://api.deezer.com/search', {
    params: { q: `${title} ${artist}`.trim(), limit: 1 },
    timeout: 8000,
  });
  const track = searchRes.data?.data?.[0];
  if (!track?.id) return null;

  // L'endpoint interne de Deezer nécessite de conserver les cookies de session
  // entre la requête de jeton et la requête de paroles, sinon le serveur refuse.
  let token, cookies;
  try {
    const tokenRes = await axios.get('https://www.deezer.com/ajax/gw-light.php', {
      params: { method: 'deezer.getUserData', input: 3, api_version: '1.0', api_token: '' },
      timeout: 8000,
      headers: { 'User-Agent': UA },
    });
    token = tokenRes.data?.results?.checkForm;
    cookies = (tokenRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  } catch { return null; }
  if (!token) return null;

  try {
    const lyricsRes = await axios.get('https://www.deezer.com/ajax/gw-light.php', {
      params: { method: 'song.getLyrics', input: 3, api_version: '1.0', api_token: token, sng_id: track.id },
      timeout: 8000,
      headers: { 'User-Agent': UA, Cookie: cookies },
    });
    const lyrics = lyricsRes.data?.results?.LYRICS_TEXT;
    return lyrics ? { lyrics, provider: 'Deezer' } : null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// ÉTAPE 4 : Lyrics.ovh — simple, gratuit, surtout français/anglais
// ══════════════════════════════════════════════════════════════

async function tryLyricsOvh(title, artist) {
  if (!artist) return null;
  // lyrics.ovh est parfois lent à répondre — on lui laisse plus de marge qu'aux autres
  const res = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, { timeout: 15000 });
  const lyrics = res.data?.lyrics;
  return lyrics ? { lyrics, provider: 'Lyrics.ovh' } : null;
}

// ══════════════════════════════════════════════════════════════
// ÉTAPE 5 : Scraping de sites web — arabe, français, anglais
// ══════════════════════════════════════════════════════════════

async function tryScraping(title, artist) {
  const isArabic = /[\u0600-\u06FF]/.test(title + artist);
  const subTrace = [];

  // ── 1. Sources directes (URL construite, pas de recherche — plus fiable) ──
  const directSources = isArabic ? [] : getDirectLatinSources(title, artist);
  for (const src of directSources) {
    try {
      const lyrics = await scrapeURL(src.url, src.selector);
      if (lyrics) return { lyrics, provider: src.name, subTrace };
      subTrace.push({ source: src.name, status: 'no_result' });
    } catch (e) {
      subTrace.push({ source: src.name, status: 'error', message: e.message });
    }
  }

  // ── 2. aghanilyrics.com — riche en dialecte tunisien/maghrébin ──
  if (isArabic) {
    try {
      const aghani = await tryAghaniLyrics(title, artist);
      if (aghani?.lyrics) return { lyrics: aghani.lyrics, provider: 'aghanilyrics.com', subTrace };
      subTrace.push({ source: 'aghanilyrics.com', status: 'no_result' });
    } catch (e) {
      subTrace.push({ source: 'aghanilyrics.com', status: 'error', message: e.message });
    }

    for (const src of getArabicSearchSources(title, artist)) {
      try {
        const lyrics = await scrapeURL(src.url, src.selector);
        if (lyrics) return { lyrics, provider: src.name, subTrace };
        subTrace.push({ source: src.name, status: 'no_result' });
      } catch (e) {
        subTrace.push({ source: src.name, status: 'error', message: e.message });
      }
    }
  } else {
    for (const src of getLatinSearchSources(title, artist)) {
      try {
        const lyrics = await scrapeURL(src.url, src.selector);
        if (lyrics) return { lyrics, provider: src.name, subTrace };
        subTrace.push({ source: src.name, status: 'no_result' });
      } catch (e) {
        subTrace.push({ source: src.name, status: 'error', message: e.message });
      }
    }
  }

  // ── 3. Dernier recours : recherche Google généraliste (souvent rate-limited) ──
  try {
    const generic = await tryGenericWebSearch(title, artist);
    if (generic?.lyrics) return { lyrics: generic.lyrics, provider: generic.source, subTrace };
    subTrace.push({ source: 'recherche générique', status: 'no_result' });
  } catch (e) {
    subTrace.push({ source: 'recherche générique', status: 'error', message: e.message });
  }

  return { lyrics: null, subTrace };
}

// ── Normalisation pour construire des slugs d'URL ───────────────────────
function slugify(str = '') {
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // accents
    .replace(/[^a-z0-9]+/g, '')        // tout sauf lettres/chiffres (pas d'espace ni tiret)
    .trim();
}
function dashify(str = '') {
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Sources directes pour l'anglais/français — URL devinée, pas de recherche ──
// Plus fiable qu'un formulaire de recherche qui peut changer ou être protégé.
function getDirectLatinSources(title, artist) {
  if (!artist) return [];
  const artistSlug = slugify(artist);
  const titleSlug   = slugify(title);
  const artistDash  = dashify(artist);
  const titleDash   = dashify(title);

  return [
    {
      name: 'azlyrics.com',
      url: `https://www.azlyrics.com/lyrics/${artistSlug}/${titleSlug}.html`,
      selector: null, // structure spéciale : entre commentaires HTML, gérée à part
      special: 'azlyrics',
    },
    {
      name: 'lyrics.com',
      url: `https://www.lyrics.com/lyric/${titleDash}/${artistDash}`,
      selector: '#lyric-body-text',
    },
  ];
}

// ── Sources arabes avec moteur de recherche interne ─────────────────────
function getArabicSearchSources(title, artist) {
  const q = encodeURIComponent(`${title} ${artist} كلمات`);
  return [
    { name: 'lyrics.az',        url: `https://lyrics.az/search/?q=${q}`,           selector: '.lyrics-body' },
    { name: 'arabiclyrics.net', url: `https://www.arabiclyrics.net/search?q=${q}`, selector: '.lyric' },
  ];
}

// ── Sources françaises/anglaises avec moteur de recherche interne ──────
function getLatinSearchSources(title, artist) {
  const q = encodeURIComponent(`${title} ${artist}`);
  return [
    { name: 'paroles.net', url: `https://www.paroles.net/recherche?q=${q}`, selector: '.song-text' },
  ];
}

// ── Scraping simple avec sélecteur connu (ou gestion spéciale AZLyrics) ──
async function scrapeURL(url, selectorOrConfig) {
  const res = await fetchWithTlsFallback(url);

  // Cas spécial AZLyrics : les paroles sont entre commentaires HTML, pas dans une balise
  if (selectorOrConfig && typeof selectorOrConfig === 'object' && selectorOrConfig.special === 'azlyrics') {
    const match = res.data.match(/<!-- Usage of azlyrics\.com content[^>]*-->([\s\S]*?)<\/div>/i);
    if (match) {
      const text = match[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
      return text.length > 50 ? text : null;
    }
    return null;
  }

  const $ = cheerio.load(res.data);
  const text = $(selectorOrConfig).first().text().trim();
  return text.length > 50 ? text : null;
}

// ── Requête HTTP avec repli automatique sur TLS ancien ──────────────────
// Certains sites (ex: arabiclyrics.net) utilisent une configuration TLS obsolète
// que Node.js refuse par défaut (EPROTO / unsupported protocol). On retente alors
// avec un agent HTTPS explicitement permissif, uniquement pour ce cas précis.
async function fetchWithTlsFallback(url) {
  try {
    return await axios.get(url, { timeout: 10000, headers: { 'User-Agent': UA } });
  } catch (e) {
    const isTlsIssue = /EPROTO|unsupported protocol|SSL routines/i.test(e.message || '');
    if (!isTlsIssue) throw e;

    const https = await import('node:https');
    const legacyAgent = new https.Agent({
      minVersion: 'TLSv1',
      rejectUnauthorized: false, // certains de ces serveurs ont aussi des certificats non standards
    });
    return await axios.get(url, { timeout: 10000, headers: { 'User-Agent': UA }, httpsAgent: legacyAgent });
  }
}

// ── aghanilyrics.com — riche en dialecte tunisien/maghrébin ────────────
async function tryAghaniLyrics(title, artist) {
  const query = `${title} ${artist}`.trim();
  const normalize = (s) => s.toLowerCase().normalize('NFKD').replace(/[\u064B-\u065F\u0670]/g, '').trim();
  const titleNorm = normalize(title);
  const headers = { 'User-Agent': UA };

  let candidates = [];

  for (const param of ['q', 's', 'search', 'keyword']) {
    try {
      const searchUrl = `https://aghanilyrics.com/site-search.php?${param}=${encodeURIComponent(query)}`;
      const res = await axios.get(searchUrl, { timeout: 7000, headers });
      const $ = cheerio.load(res.data);
      $('a[href*="songlyrics.php"]').each((_, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        if (href && text) candidates.push({ href: href.startsWith('http') ? href : `https://aghanilyrics.com/${href.replace(/^\//, '')}`, text });
      });
      if (candidates.length) break;
    } catch {}
  }

  if (!candidates.length) {
    try {
      const gUrl = `https://www.google.com/search?q=site:aghanilyrics.com+${encodeURIComponent(query)}`;
      const res = await axios.get(gUrl, { timeout: 7000, headers });
      const $ = cheerio.load(res.data);
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const match = href.match(/^\/url\?q=([^&]+)/);
        if (match) {
          const decoded = decodeURIComponent(match[1]);
          if (decoded.includes('aghanilyrics.com/songlyrics.php')) candidates.push({ href: decoded, text: '' });
        }
      });
    } catch {}
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const aMatch = normalize(a.text).includes(titleNorm) ? 0 : 1;
    const bMatch = normalize(b.text).includes(titleNorm) ? 0 : 1;
    return aMatch - bMatch;
  });

  const pageRes = await axios.get(candidates[0].href, { timeout: 8000, headers });
  const $$ = cheerio.load(pageRes.data);

  let lyricsText = '';
  $$('h2').each((_, el) => {
    const heading = $$(el).text();
    if (heading.includes('كلمات')) lyricsText = $$(el).parent().text().replace(heading, '').trim();
  });

  if (!lyricsText || lyricsText.length < 50) {
    let bestBlock = '';
    $$('div, p, section').each((_, el) => {
      const text = $$(el).text().trim();
      const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
      if (arabicChars > 50 && text.length < 4000 && text.length > bestBlock.length) bestBlock = text;
    });
    lyricsText = bestBlock;
  }

  return lyricsText ? { lyrics: lyricsText } : null;
}

// ── Recherche web générique — dernier recours, tous domaines ───────────
async function tryGenericWebSearch(title, artist) {
  const query = encodeURIComponent(`${title} ${artist} كلمات lyrics`.trim());
  const res = await axios.get(`https://www.google.com/search?q=${query}`, {
    timeout: 8000,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,ar;q=0.8,en;q=0.7',
    },
  });
  const $ = cheerio.load(res.data);

  const links = [];
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/^\/url\?q=([^&]+)/);
    if (match) links.push(decodeURIComponent(match[1]));
  });

  const PRIORITY_DOMAINS = ['aghanilyrics.com', 'arabiclyrics.net', 'lyrics.az', 'lyricstranslate.com', 'paroles.net', 'genius.com'];
  const sorted = links
    .filter(l => l.startsWith('http') && !l.includes('google.com'))
    .sort((a, b) => {
      const aPriority = PRIORITY_DOMAINS.some(d => a.includes(d)) ? 0 : 1;
      const bPriority = PRIORITY_DOMAINS.some(d => b.includes(d)) ? 0 : 1;
      return aPriority - bPriority;
    })
    .slice(0, 5);

  for (const url of sorted) {
    try {
      const lyrics = await scrapeGenericLyricsPage(url);
      if (lyrics && lyrics.length > 80) return { lyrics, source: new URL(url).hostname.replace('www.', '') };
    } catch {}
  }
  return null;
}

// ── Scraping générique — essaie plusieurs sélecteurs courants ──────────
export async function scrapeGenericLyricsPage(url) {
  const res = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': UA } });
  const $ = cheerio.load(res.data);

  const SELECTORS = [
    '.lyrics', '.lyric', '.lyrics-body', '.song-text', '.lyric-body',
    '[class*="lyric"]', '[class*="Lyric"]', '[data-lyrics]',
    '.song-lyrics', '#lyrics',
  ];
  for (const sel of SELECTORS) {
    const text = $(sel).first().text().trim();
    if (text && text.length > 80) return text;
  }

  let bestBlock = '';
  $('div, p, section').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > bestBlock.length && text.length < 5000 && (text.match(/\n/g) || []).length > 4) bestBlock = text;
  });
  return bestBlock.length > 80 ? bestBlock : null;
}
