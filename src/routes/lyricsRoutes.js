/**
 * lyricsRoutes.js  (ou lyrics.js selon votre convention)
 * Route Express : /api/lyrics
 *
 * Placer dans : choralapp-backend/routes/lyricsRoutes.js
 * Puis dans app.js / server.js ajouter :
 *   const lyricsRoutes = require("./routes/lyricsRoutes");
 *   app.use("/api/lyrics", lyricsRoutes);
 *
 * ⚠️  Ne supprime PAS vos routes existantes.
 *     Si vous avez déjà un fichier routes/lyrics.js, remplacez uniquement
 *     les handlers POST /import et GET /search par ceux ci-dessous,
 *     en conservant le reste.
 */

const express = require("express");
const router  = express.Router();
const { searchLyrics } = require("../services/lyricsService");

// ─── GET /api/lyrics/search?q=… ──────────────────────────────────────────────
// Recherche simple : retourne une liste de suggestions (titre + artiste)
// Pour l'instant on renvoie un pseudo-résultat basé sur la requête,
// la vraie recherche se fait à l'import.
router.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ results: [] });

  // Tentative de décomposition "Titre - Artiste" ou "Artiste Titre"
  let title  = q;
  let artist = "";
  const dashMatch = q.match(/^(.+?)\s[-–]\s(.+)$/);
  if (dashMatch) {
    artist = dashMatch[1].trim();
    title  = dashMatch[2].trim();
  }

  // On renvoie plusieurs variantes pour que l'utilisateur choisisse
  const results = [
    { title, artist: artist || "Inconnu", source: "lyrics.ovh" },
  ];

  // Si on a un artiste détecté, ajouter version inversée
  if (artist) {
    results.push({ title: artist, artist: title, source: "lyrics.ovh" });
  }

  return res.json({ results });
});

// ─── POST /api/lyrics/import ──────────────────────────────────────────────────
// Corps attendu : { title: "…", artist: "…" }
// Répond      : { success, lyrics, source, confidence, language, youtubeUrl }
//            ou { success:false, needTranscription:true, youtubeUrl, error }
router.post("/import", async (req, res) => {
  const { title, artist } = req.body || {};

  if (!title) {
    return res.status(400).json({ success: false, error: "title requis" });
  }

  try {
    const result = await searchLyrics(title || "", artist || "");

    if (result.needTranscription || !result.lyrics) {
      return res.json({
        success:          false,
        needTranscription: true,
        youtubeUrl:       result.youtubeUrl,
        error:            "Paroles introuvables — transcription YouTube possible",
        trace: [
          { step: "lyrics.ovh",  status: "no_result" },
          { step: "Genius",      status: "no_result" },
          { step: "AZLyrics",    status: "no_result" },
          { step: "YouTube",     status: "fallback", message: result.youtubeUrl },
        ],
      });
    }

    return res.json({
      success:    true,
      lyrics:     result.lyrics,
      source:     result.source,
      confidence: result.score,
      score:      result.score,        // alias pour compatibilité frontend
      lang:       result.language,
      language:   result.language,
      youtubeUrl: result.youtubeUrl,
    });

  } catch (err) {
    console.error("[LYRICS] Erreur route /import :", err);
    return res.status(500).json({ success: false, error: "Erreur serveur interne" });
  }
});

module.exports = router;
