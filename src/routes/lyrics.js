// src/routes/lyrics.js
import express from 'express';
import { importLyricsPipeline, searchSongs, searchYouTubeUrl } from '../services/lyricsService.js';
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

    if (!result) {
      // Aucune parole trouvée → on ne propose PAS de lien YouTube
      return res.status(404).json({
        error: 'Paroles introuvables sur le web',
        suggestion: 'Essayez le mode Manuel pour saisir les paroles vous-même',
      });
    }

    // Paroles trouvées → on cherche maintenant le lien YouTube en complément
    const youtubeUrl = await searchYouTubeUrl(title, artist || '').catch(() => null);

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
      youtubeUrl,   // présent seulement car les paroles ont été trouvées
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

export default router;
