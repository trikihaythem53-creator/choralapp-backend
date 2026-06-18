// src/services/lyricsService.js
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { cleanLyrics, detectLanguage, qualityScore, formatLyricsWithSections } from '../utils/textCleaner.js';
import { logger } from '../utils/logger.js';

const GENIUS_TOKEN = process.env.GENIUS_TOKEN || "flW2DO1G8O3iu_ioi0-iuIgvpnIS-vFVdYy4xUGJt-uNIwFSxx00j6zpwF0oYj3c";
const HAPPI_KEY   = "hk1165-4Ql3s2bNtIM8v3IKHopnnFdVLUTusnsxLw";
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ══════════════════════════════════════════════════════════════
// REQUÊTE HTTP — avec repli automatique sur TLS ancien
// ══════════════════════════════════════════════════════════════
async function httpGet(url, extraHeaders = {}) {
  const config = {
    timeout: 12000,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ar,fr;q=0.9,en;q=0.8',
      ...extraHeaders,
    },
  };
  try {
    return await axios.get(url, config);
  } catch (e) {
    if (/EPROTO|unsupported protocol|SSL routines|legacy sigalg/i.test(e.message || '')) {
      const https = await import('node:https');
      const agent = new https.Agent({ minVersion: 'TLSv1', rejectUnauthorized: false });
      return await axios.get(url, { ...config, httpsAgent: agent });
    }
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════
// PIPELINE PRINCIPAL
// ══════════════════════════════════════════════════════════════
export async function importLyricsPipeline(title, artist) {
  logger.info(`Pipeline lyrics: "${title}" by "${artist}"`);
  const trace = [];

  // Pour l'arabe : scraping en premier (sites spécialisés bien fournis)
  // Pour le reste : APIs d'abord
  const isArabic = /[\u0600-\u06FF]/.test(title + artist);

  const steps = isArabic ? [
    { name: 'scraping',   fn: tryArabicScraping },
    { name: 'happi',      fn: tryHappi },
    { name: 'genius',     fn: tryGenius },
    { name: 'deezer',     fn: tryDeezer },
    { name: 'lyrics.ovh', fn: tryLyricsOvh },
  ] : [
    { name: 'happi',      fn: tryHappi },
    { name: 'genius',     fn: tryGenius },
    { name: 'lyrics.ovh', fn: tryLyricsOvh },
    { name: 'deezer',     fn: tryDeezer },
    { name: 'scraping',   fn: tryLatinScraping },
  ];

  for (const step of steps) {
    try {
      logger.info(`→ ${step.name}...`);
      const result = await step.fn(title, artist);
      if (!result?.lyrics || result.lyrics.length < 30) {
        trace.push({ step: step.name, status: 'no_result', subTrace: result?.subTrace });
        continue;
      }
      const cleaned = cleanLyrics(result.lyrics);
      if (!cleaned || cleaned.length < 30) {
        trace.push({ step: step.name, status: 'empty_after_clean' });
        continue;
      }
      const lang  = detectLanguage(cleaned);
      const score = qualityScore(cleaned, step.name === 'scraping' ? 'scraping' : 'api');
      trace.push({ step: step.name, status: 'found', provider: result.provider });
      logger.info(`✅ Trouvé via ${step.name} — ${result.provider}`);
      return {
        lyrics:   formatLyricsWithSections(cleaned, lang),
        lang, source: step.name, provider: result.provider, score, trace,
      };
    } catch (e) {
      trace.push({ step: step.name, status: 'error', message: e.message, httpStatus: e.response?.status });
      logger.warn(`✗ ${step.name}: ${e.message}`);
    }
  }

  logger.warn(`❌ Aucune parole pour "${title}"`);
  return { lyrics: null, trace };
}

// ══════════════════════════════════════════════════════════════
// SCRAPING ARABE — stratégie en 3 niveaux
// ══════════════════════════════════════════════════════════════
async function tryArabicScraping(title, artist) {
  const subTrace = [];

  // Niveau 1 : Google site:aghanilyrics.com (très fiable — paroles tunisiennes/arabes)
  try {
    const result = await searchViaGoogle(title, artist, 'aghanilyrics.com');
    if (result?.lyrics) return { ...result, subTrace };
    subTrace.push({ source: 'aghanilyrics.com (Google)', status: 'no_result' });
  } catch (e) {
    subTrace.push({ source: 'aghanilyrics.com (Google)', status: 'error', message: e.message });
  }

  // Niveau 2 : Google site:lyrics.az (bonne couverture arabe)
  try {
    const result = await searchViaGoogle(title, artist, 'lyrics.az');
    if (result?.lyrics) return { ...result, subTrace };
    subTrace.push({ source: 'lyrics.az (Google)', status: 'no_result' });
  } catch (e) {
    subTrace.push({ source: 'lyrics.az (Google)', status: 'error', message: e.message });
  }

  // Niveau 3 : Google site:arabiclyrics.net
  try {
    const result = await searchViaGoogle(title, artist, 'arabiclyrics.net');
    if (result?.lyrics) return { ...result, subTrace };
    subTrace.push({ source: 'arabiclyrics.net (Google)', status: 'no_result' });
  } catch (e) {
    subTrace.push({ source: 'arabiclyrics.net (Google)', status: 'error', message: e.message });
  }

  return { lyrics: null, subTrace };
}

// ══════════════════════════════════════════════════════════════
// RECHERCHE GOOGLE CIBLÉE — site:{domain} titre artiste
// Trouve l'URL exacte sur un site de paroles connu, puis scrape cette page
// ══════════════════════════════════════════════════════════════
async function searchViaGoogle(title, artist, domain) {
  const q = encodeURIComponent(`site:${domain} ${title} ${artist}`.trim());
  const res = await httpGet(`https://www.google.com/search?q=${q}&num=5&hl=ar`);
  const $ = cheerio.load(res.data);

  // Extraire les liens résultats Google
  const urls = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/^\/url\?q=([^&]+)/);
    if (match) {
      const decoded = decodeURIComponent(match[1]);
      if (decoded.includes(domain) && !decoded.includes('google') && decoded.startsWith('http')) {
        urls.push(decoded);
      }
    }
  });

  if (!urls.length) return null;

  // Scraper la première page trouvée
  for (const url of urls.slice(0, 3)) {
    try {
      const lyrics = await scrapeLyricsPage(url);
      if (lyrics && lyrics.length > 50) {
        return { lyrics, provider: domain };
      }
    } catch {}
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// SCRAPING D'UNE PAGE CHANSON — sélecteurs multi-sites
// ══════════════════════════════════════════════════════════════
async function scrapeLyricsPage(url) {
  const res = await httpGet(url);
  const html = res.data;
  const $ = cheerio.load(html);

  // Sélecteurs CSS par site (du plus spécifique au plus générique)
  const SELECTORS = [
    // aghanilyrics.com — le contenu est dans un article WordPress standard
    'article .entry-content p',
    '.entry-content',
    'article p',
    // lyrics.az
    '.lyrics-body',
    '.lyric-content',
    // arabiclyrics.net
    '.lyric',
    '.lyrics',
    // génériques
    '#lyric-body-text',
    '.song-text',
    '[class*="lyric"]',
    '[class*="Lyric"]',
  ];

  for (const sel of SELECTORS) {
    const el = $(sel);
    if (!el.length) continue;
    // Reconstruire le texte en respectant les sauts de ligne (<br>, <p>)
    const text = extractTextWithLineBreaks($, el.first());
    if (text && text.length > 80 && hasArabicContent(text)) return text;
    // Si pas arabe, prendre quand même si assez long
    if (text && text.length > 150) return text;
  }

  // Fallback : plus grand bloc de texte avec du contenu arabe
  let best = '';
  $('div, section, article').each((_, el) => {
    const text = $(el).text().trim();
    const arabicRatio = (text.match(/[\u0600-\u06FF]/g) || []).length / Math.max(text.replace(/\s/g, '').length, 1);
    if (arabicRatio > 0.3 && text.length > best.length && text.length < 8000) {
      best = text;
    }
  });
  return best.length > 80 ? best : null;
}

function extractTextWithLineBreaks($, el) {
  // Remplace <br> par \n, puis extrait le texte
  el.find('br').replaceWith('\n');
  return el.text().replace(/\n{3,}/g, '\n\n').trim();
}

function hasArabicContent(text) {
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return arabicChars > 10;
}

// ══════════════════════════════════════════════════════════════
// SCRAPING LATIN (français / anglais)
// ══════════════════════════════════════════════════════════════
async function tryLatinScraping(title, artist) {
  const subTrace = [];
  for (const domain of ['paroles.net', 'genius.com', 'azlyrics.com']) {
    try {
      const result = await searchViaGoogle(title, artist, domain);
      if (result?.lyrics) return { ...result, subTrace };
      subTrace.push({ source: `${domain} (Google)`, status: 'no_result' });
    } catch (e) {
      subTrace.push({ source: `${domain} (Google)`, status: 'error', message: e.message });
    }
  }
  return { lyrics: null, subTrace };
}

// ══════════════════════════════════════════════════════════════
// APIs
// ══════════════════════════════════════════════════════════════
async function tryHappi(title, artist) {
  const r = await axios.get('https://api.happi.dev/v1/music', {
    params: { q: `${title} ${artist}`.trim(), limit: 1 },
    headers: { 'x-happi-key': HAPPI_KEY },
    timeout: 10000,
  });
  const track = r.data?.result?.[0];
  if (!track?.api_lyrics) return null;
  const lr = await axios.get(track.api_lyrics, { headers: { 'x-happi-key': HAPPI_KEY }, timeout: 10000 });
  const lyrics = lr.data?.result?.lyrics;
  return lyrics ? { lyrics, provider: 'Happi.dev' } : null;
}

async function tryGenius(title, artist) {
  const res = await axios.get('https://api.genius.com/search', {
    params: { q: `${title} ${artist}`.trim() },
    headers: { Authorization: `Bearer ${GENIUS_TOKEN}` },
    timeout: 10000,
  });
  const hit = res.data?.response?.hits?.[0]?.result;
  if (!hit?.url) return null;
  const page = await httpGet(hit.url);
  const $ = cheerio.load(page.data);
  let text = '';
  $('[data-lyrics-container="true"]').each((_, el) => { text += $(el).text() + '\n'; });
  return text.trim() ? { lyrics: text.trim(), provider: 'Genius' } : null;
}

async function tryDeezer(title, artist) {
  const s = await axios.get('https://api.deezer.com/search', {
    params: { q: `${title} ${artist}`.trim(), limit: 1 },
    timeout: 10000,
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
    const lr = await httpGet(`https://www.deezer.com/ajax/gw-light.php?method=song.getLyrics&input=3&api_version=1.0&api_token=${token}&sng_id=${track.id}`, { Cookie: cookies });
    const lyrics = lr.data?.results?.LYRICS_TEXT;
    return lyrics ? { lyrics, provider: 'Deezer' } : null;
  } catch { return null; }
}

async function tryLyricsOvh(title, artist) {
  if (!artist) return null;
  const res = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, { timeout: 15000 });
  const lyrics = res.data?.lyrics;
  return lyrics ? { lyrics, provider: 'Lyrics.ovh' } : null;
}

// ══════════════════════════════════════════════════════════════
// RECHERCHE (suggestions pour l'onglet "Recherche auto")
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

export async function searchYouTubeUrl(title, artist) { return null; } // désactivé pour l'instant
