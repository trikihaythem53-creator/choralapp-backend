// src/services/lyricsService.js
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { cleanLyrics, detectLanguage, qualityScore, formatLyricsWithSections } from '../utils/textCleaner.js';
import { logger } from '../utils/logger.js';

const GENIUS_TOKEN  = process.env.GENIUS_TOKEN  || "flW2DO1G8O3iu_ioi0-iuIgvpnIS-vFVdYy4xUGJt-uNIwFSxx00j6zpwF0oYj3c";
const HAPPI_KEY     = "hk1165-4Ql3s2bNtIM8v3IKHopnnFdVLUTusnsxLw";
const MUSIXMATCH_KEY = process.env.MUSIXMATCH_KEY;

// ══════════════════════════════════════════════════════════════
// PIPELINE PRINCIPAL
// ══════════════════════════════════════════════════════════════

export async function importLyricsPipeline(title, artist, lang = 'auto') {
  logger.info(`Pipeline lyrics: "${title}" by "${artist}"`);
  const results = [];

  // ── ÉTAPE 1 : Happi.dev (arabe + français) ─────────────────
  logger.info('Étape 1a: Happi.dev...');
  const happi = await tryHappi(title, artist);
  if (happi) {
    results.push({ ...happi, source: 'api', provider: 'happi', score: qualityScore(happi.lyrics, 'api') });
    if (happi.lyrics.length > 100) {
      logger.info(`✅ Trouvé via Happi.dev`);
      return formatResult(results[0]);
    }
  }

  // ── ÉTAPE 2 : Genius API ────────────────────────────────────
  logger.info('Étape 1b: Genius API...');
  const genius = await tryGenius(title, artist);
  if (genius) {
    results.push({ ...genius, source: 'api', provider: 'genius', score: qualityScore(genius.lyrics, 'api') });
    if (genius.lyrics.length > 100) {
      logger.info(`✅ Trouvé via Genius`);
      return formatResult(results[results.length - 1]);
    }
  }

  // ── ÉTAPE 3 : Lyrics.ovh (français) ────────────────────────
  logger.info('Étape 1c: Lyrics.ovh...');
  const ovh = await tryLyricsOvh(title, artist);
  if (ovh) {
    results.push({ ...ovh, source: 'api', provider: 'lyrics.ovh', score: qualityScore(ovh.lyrics, 'api') });
    if (ovh.lyrics.length > 100) {
      logger.info(`✅ Trouvé via Lyrics.ovh`);
      return formatResult(results[results.length - 1]);
    }
  }

  // ── ÉTAPE 4 : Scraping sites arabes ────────────────────────
  logger.info('Étape 2: Scraping...');
  const isArabic = /[\u0600-\u06FF]/.test(title + artist);
  const sources  = isArabic ? getArabicSources(title, artist) : getFrenchSources(title, artist);

  for (const src of sources) {
    try {
      logger.info(`  Scraping: ${src.name}...`);
      const lyrics = await scrapeURL(src.url, src.selector);
      if (lyrics && lyrics.length > 50) {
        const cleaned = cleanLyrics(lyrics);
        if (cleaned) {
          logger.info(`✅ Trouvé via ${src.name}`);
          return formatResult({ lyrics: cleaned, source: 'scraping', provider: src.name, score: qualityScore(cleaned, 'scraping'), lang: detectLanguage(cleaned) });
        }
      }
    } catch {}
  }

  // Retourner le meilleur résultat même partiel
  const best = results.sort((a, b) => b.score - a.score)[0];
  if (best) return formatResult(best);

  logger.warn(`❌ Aucune parole trouvée pour "${title}"`);
  return null;
}

// ══════════════════════════════════════════════════════════════
// RECHERCHE
// ══════════════════════════════════════════════════════════════

// ── Recherche YouTube (sans clé API — scraping résultats) ──────
export async function searchYouTubeUrl(title, artist) {
  try {
    const query = encodeURIComponent(`${title} ${artist}`.trim());
    const res = await axios.get(`https://www.youtube.com/results?search_query=${query}`, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
    });
    const match = res.data.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (match) {
      const videoId = match[1];
      logger.info(`YouTube trouvé: https://www.youtube.com/watch?v=${videoId}`);
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    return null;
  } catch (e) {
    logger.warn('YouTube search error:', e.message);
    return null;
  }
}

export async function searchSongs(query) {
  const results = [];

  // Happi.dev search
  try {
    const res  = await axios.get('https://api.happi.dev/v1/music', {
      params: { q: query, limit: 8, apikey: HAPPI_KEY },
      timeout: 8000,
    });
    (res.data.result || []).forEach(t => results.push({
      title: t.track, artist: t.artist,
      source: 'happi', cover: null,
      happiUrl: t.api_lyrics,
    }));
  } catch (e) { logger.warn('Happi search error:', e.message); }

  // Deezer
  try {
    const res  = await axios.get(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=6`, { timeout: 8000 });
    (res.data.data || []).forEach(t => results.push({
      title: t.title, artist: t.artist?.name || '',
      source: 'deezer', cover: t.album?.cover_small || null,
    }));
  } catch {}

  // Genius
  try {
    const res = await axios.get(`https://api.genius.com/search?q=${encodeURIComponent(query)}&per_page=6`, {
      headers: { Authorization: `Bearer ${GENIUS_TOKEN}` },
      timeout: 8000,
    });
    (res.data.response?.hits || []).forEach(h => results.push({
      title: h.result.title, artist: h.result.primary_artist.name,
      source: 'genius', geniusUrl: h.result.url,
      cover: h.result.song_art_image_thumbnail_url || null,
    }));
  } catch {}

  // Dédoublonner
  const seen = new Set();
  return results.filter(r => {
    const key = r.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 12);
}

// ══════════════════════════════════════════════════════════════
// SOURCES
// ══════════════════════════════════════════════════════════════

// ── Happi.dev — arabe + français ──────────────────────────────
async function tryHappi(title, artist) {
  try {
    // Recherche
    const searchRes = await axios.get('https://api.happi.dev/v1/music', {
      params: { q: `${title} ${artist}`, limit: 1, apikey: HAPPI_KEY },
      timeout: 8000,
    });
    const track = searchRes.data.result?.[0];
    if (!track) return null;

    // Récupérer les paroles
    const lyricsRes = await axios.get(track.api_lyrics, {
      params: { apikey: HAPPI_KEY },
      timeout: 8000,
    });
    const lyrics = lyricsRes.data.result?.lyrics;
    if (!lyrics || lyrics.length < 20) return null;

    logger.info(`Happi trouvé: ${track.track} - ${track.artist}`);
    return { lyrics: cleanLyrics(lyrics), lang: detectLanguage(lyrics) };
  } catch (e) {
    logger.warn('Happi error:', e.message);
    return null;
  }
}

// ── Genius ─────────────────────────────────────────────────────
async function tryGenius(title, artist) {
  try {
    const searchRes = await axios.get(
      `https://api.genius.com/search?q=${encodeURIComponent(title + ' ' + artist)}&per_page=3`,
      { headers: { Authorization: `Bearer ${GENIUS_TOKEN}` }, timeout: 8000 }
    );
    const hit = searchRes.data.response?.hits?.[0];
    if (!hit) return null;

    const lyrics = await scrapeGeniusPage(hit.result.url);
    if (!lyrics) return null;

    const lang = detectLanguage(lyrics);
    return { lyrics: formatLyricsWithSections(cleanLyrics(lyrics), lang), lang };
  } catch { return null; }
}

// ── Lyrics.ovh ─────────────────────────────────────────────────
async function tryLyricsOvh(title, artist) {
  try {
    const res  = await axios.get(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
      { timeout: 6000 }
    );
    const lyrics = res.data.lyrics;
    if (!lyrics || lyrics.length < 30) return null;
    return { lyrics: cleanLyrics(lyrics), lang: detectLanguage(lyrics) };
  } catch { return null; }
}

// ── Sources arabes ─────────────────────────────────────────────
function getArabicSources(title, artist) {
  const q = encodeURIComponent(`${title} ${artist} كلمات`);
  return [
    { name: 'lyrics-az',   url: `https://lyrics.az/search/?q=${q}`,              selector: '.lyrics-body' },
    { name: 'arab-lyrics', url: `https://www.arabiclyrics.net/search?q=${q}`,     selector: '.lyric' },
    { name: 'shazam',      url: `https://www.shazam.com/search?q=${encodeURIComponent(title+' '+artist)}`, selector: '.lyrics' },
  ];
}

// ── Sources françaises ─────────────────────────────────────────
function getFrenchSources(title, artist) {
  const q = encodeURIComponent(`${title} ${artist}`);
  return [
    { name: 'paroles.net', url: `https://www.paroles.net/recherche?q=${q}`, selector: '.song-text' },
    { name: 'greatsong',   url: `https://www.greatsong.net/paroles-${encodeURIComponent(artist.replace(/\s/g,'-'))}.html`, selector: '.lyric-body' },
  ];
}

// ── Scraping simple ────────────────────────────────────────────
async function scrapeURL(url, selector) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36', 'Accept-Language': 'ar,fr;q=0.9' },
    });
    const $ = cheerio.load(res.data);
    return selector ? $(selector).text().trim() : null;
  } catch { return null; }
}

// ── Genius page scraping ───────────────────────────────────────
async function scrapeGeniusPage(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    });
    const $ = cheerio.load(res.data);
    const containers = $('[data-lyrics-container="true"]');
    if (containers.length > 0) {
      let lyrics = '';
      containers.each((_, el) => {
        $(el).find('br').replaceWith('\n');
        lyrics += $(el).text() + '\n\n';
      });
      return lyrics.trim();
    }
    return null;
  } catch { return null; }
}

function formatResult(result) {
  const lang = result.lang || detectLanguage(result.lyrics);
  return {
    lyrics:      formatLyricsWithSections(result.lyrics, lang),
    lang,
    source:      result.source,
    provider:    result.provider,
    score:       result.score,
    approved:    false,
    needsReview: result.score < 0.85,
  };
}
