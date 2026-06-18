// src/routes/lyrics.js
import express from 'express';
import { importLyricsPipeline, searchSongs, searchYouTubeUrl, scrapeGenericLyricsPage } from '../services/lyricsService.js';
import { cleanLyrics, detectLanguage, qualityScore } from '../utils/textCleaner.js';
import { supabase } from '../utils/supabase.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// ── GET /api/lyrics/search?q=titre+artiste ─────────────────────
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Paramètre q requis' });

  try {
    const results = await searchSongs(q);
    res.json({ results, count: results.length });
  } catch (err) {
    logger.error('Recherche échouée:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/lyrics/import ────────────────────────────────────
// Body: { title, artist, lang }
router.post('/import', async (req, res) => {
  const { title, artist, lang = 'auto' } = req.body;
  if (!title) return res.status(400).json({ error: 'Titre requis' });

  try {
    logger.info(`Import demandé: "${title}" - "${artist}"`);
    const [result, youtubeUrl] = await Promise.all([
      importLyricsPipeline(title, artist || '', lang),
      searchYouTubeUrl(title, artist || ''),
    ]);

    if (!result) {
      return res.status(404).json({
        error: 'Paroles introuvables',
        suggestion: 'Essayez avec le nom de l\'artiste ou via YouTube',
        youtubeUrl,
      });
    }

    // Sauvegarder dans la table lyrics_imports pour validation admin
    const { data: saved } = await supabase.from('lyrics_imports').insert({
      title,
      artist:     artist || '',
      lyrics:     result.lyrics,
      lang:       result.lang,
      source:     result.source,
      provider:   result.provider,
      score:      result.score,
      approved:   result.score >= 0.9, // Auto-approuver si score élevé
      status:     'completed',
    }).select().single();

    res.json({
      ...result,
      id:          saved?.id,
      autoApproved: result.score >= 0.9,
      youtubeUrl,
    });
  } catch (err) {
    logger.error('Import échoué:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/lyrics/pending ────────────────────────────────────
// Paroles en attente de validation admin
router.get('/pending', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('lyrics_imports')
      .select('*')
      .eq('approved', false)
      .eq('status', 'completed')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ results: data, count: data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/lyrics/:id/approve ──────────────────────────────
// Admin approuve les paroles
router.post('/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { lyrics, songId } = req.body; // lyrics peut être modifié par l'admin

  try {
    // 1. Marquer comme approuvé
    await supabase.from('lyrics_imports').update({
      approved:  true,
      lyrics:    lyrics, // Version finale editée par admin
      source:    'manual', // Si admin a modifié → source = manual
      score:     1.0,
    }).eq('id', id);

    // 2. Si songId fourni → mettre à jour la chanson
    if (songId) {
      const { data: importData } = await supabase
        .from('lyrics_imports').select('*').eq('id', id).single();

      const updateData = importData.lang === 'ar'
        ? { lyrics_ar: lyrics || importData.lyrics }
        : { lyrics_fr: lyrics || importData.lyrics };

      await supabase.from('songs').update(updateData).eq('id', songId);
    }

    res.json({ success: true, message: 'Paroles approuvées et publiées' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/lyrics/:id/reject ───────────────────────────────
router.post('/:id/reject', async (req, res) => {
  try {
    await supabase.from('lyrics_imports').update({ approved: false, status: 'rejected' }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/lyrics/import-from-url ───────────────────────────
// Permet de coller un lien direct (Smule, ou tout site de paroles) pour en extraire le texte
router.post('/import-from-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requise' });

  try {
    logger.info(`Import depuis URL: ${url}`);
    const raw = await scrapeGenericLyricsPage(url);
    if (!raw) {
      return res.status(404).json({ error: 'Aucune parole détectée sur cette page' });
    }
    const cleaned = cleanLyrics(raw);
    if (!cleaned) {
      return res.status(404).json({ error: 'Le texte extrait ne ressemble pas à des paroles' });
    }
    const lang = detectLanguage(cleaned);
    const score = qualityScore(cleaned, 'scraping');

    res.json({
      lyrics: cleaned,
      lang,
      source: 'scraping',
      provider: new URL(url).hostname.replace('www.', ''),
      score,
    });
  } catch (err) {
    logger.error('Import depuis URL échoué:', err.message);
    res.status(500).json({ error: 'Impossible de lire cette page — vérifiez le lien' });
  }
});

export default router;
