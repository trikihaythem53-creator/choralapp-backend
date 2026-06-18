// src/routes/lyrics.js
import express from 'express';
import { importLyricsPipeline, searchSongs } from '../services/lyricsService.js';
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
// Body: { title, artist }
router.post('/import', async (req, res) => {
  const { title, artist } = req.body;
  if (!title) return res.status(400).json({ error: 'Titre requis' });

  try {
    logger.info(`Import demandé: "${title}" - "${artist}"`);
    const result = await importLyricsPipeline(title, artist || '');

    if (!result || !result.lyrics) {
      // Aucune parole trouvée → on ne propose PAS de lien YouTube
      // La trace détaille pourquoi chaque source a échoué (utile pour diagnostiquer)
      return res.status(404).json({
        error: 'Paroles introuvables sur le web',
        suggestion: 'Essayez le mode Manuel pour saisir les paroles vous-même',
        trace: result?.trace || [],
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
      approved:   result.score >= 0.9,
      status:     'completed',
    }).select().single();

    res.json({
      ...result,
      id:           saved?.id,
      autoApproved: result.score >= 0.9,
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

// ── GET /api/lyrics/debug-fetch?url=... ────────────────────────
// Outil de diagnostic : renvoie un extrait du HTML brut reçu d'une URL,
// pour identifier le bon sélecteur CSS quand le scraping échoue silencieusement.
router.get('/debug-fetch', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Paramètre url requis' });

  try {
    const axios = (await import('axios')).default;
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    const html = String(response.data);
    res.json({
      status: response.status,
      length: html.length,
      // les 3000 premiers caractères pour voir la structure générale
      preview: html.slice(0, 3000),
      // cherche des indices de blocage anti-bot courants
      looksBlocked: /captcha|cloudflare|access denied|just a moment|enable javascript/i.test(html),
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      httpStatus: err.response?.status,
      bodyPreview: String(err.response?.data || '').slice(0, 1000),
    });
  }
});

export default router;
