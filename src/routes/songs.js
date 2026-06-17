// src/routes/songs.js
import express from 'express';
import { supabase } from '../utils/supabase.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// ── GET /api/songs ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('songs').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/songs/:id/apply-import ──────────────────────────
// Appliquer des paroles importées à une chanson existante
router.post('/:id/apply-import', async (req, res) => {
  const { importId, lang } = req.body;

  try {
    const { data: importData } = await supabase
      .from('lyrics_imports').select('*').eq('id', importId).single();
    if (!importData) return res.status(404).json({ error: 'Import introuvable' });

    const field = lang === 'ar' || importData.lang === 'ar' ? 'lyrics_ar' : 'lyrics_fr';
    await supabase.from('songs').update({ [field]: importData.lyrics }).eq('id', req.params.id);

    res.json({ success: true, field, lyrics: importData.lyrics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/songs/stats ───────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const { data: songs } = await supabase.from('songs').select('lang, shared_all, shared_with, shared_groups');
    const { data: imports } = await supabase.from('lyrics_imports').select('source, score, approved');

    res.json({
      total:       songs?.length || 0,
      arabic:      songs?.filter(s => s.lang === 'ar').length || 0,
      french:      songs?.filter(s => s.lang === 'fr').length || 0,
      bilingual:   songs?.filter(s => s.lang === 'bi').length || 0,
      shared:      songs?.filter(s => s.shared_all || s.shared_with?.length > 0).length || 0,
      imports: {
        total:    imports?.length || 0,
        approved: imports?.filter(i => i.approved).length || 0,
        pending:  imports?.filter(i => !i.approved).length || 0,
        avgScore: imports?.length ? (imports.reduce((a,i) => a + (i.score||0), 0) / imports.length).toFixed(2) : 0,
        bySources: imports?.reduce((acc, i) => {
          acc[i.source] = (acc[i.source] || 0) + 1;
          return acc;
        }, {}),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
