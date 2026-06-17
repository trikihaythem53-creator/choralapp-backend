// src/utils/textCleaner.js

/**
 * Nettoie le HTML et extrait le texte propre (arabe + français)
 */
export function cleanLyrics(raw) {
  if (!raw) return null;

  let text = raw
    // Supprimer scripts et styles
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Remplacer <br> par retour ligne
    .replace(/<br\s*\/?>/gi, '\n')
    // Supprimer tous les tags HTML
    .replace(/<[^>]+>/g, '')
    // Décoder entités HTML
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    // Supprimer publicités typiques
    .replace(/\[.*?(ad|pub|sponsor|promoted|advertisement).*?\]/gi, '')
    .replace(/^.*?(click here|subscribe|follow us|share|like us).*$/gim, '')
    // Normaliser espaces et lignes
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  // Supprimer lignes parasites courantes
  const parasitePatterns = [
    /^https?:\/\/.+$/m,
    /^www\..+$/m,
    /^copyright.+$/im,
    /^all rights reserved.+$/im,
    /^paroles de la chanson.+$/im,
    /^\d+\s*vue/im,
    /^partager$/im,
    /^imprimer$/im,
  ];
  parasitePatterns.forEach(p => { text = text.replace(p, ''); });

  // Nettoyer les lignes vides multiples restantes
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text.length > 20 ? text : null;
}

/**
 * Détecter la langue dominante du texte
 */
export function detectLanguage(text) {
  if (!text) return 'unknown';
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars  = (text.match(/[a-zA-ZÀ-ÿ]/g) || []).length;
  const total       = arabicChars + latinChars || 1;

  if (arabicChars / total > 0.6) return 'ar';
  if (latinChars  / total > 0.6) return 'fr';
  return 'bi';
}

/**
 * Score de qualité des paroles (0.0 → 1.0)
 */
export function qualityScore(text, source) {
  const sourceScores = {
    manual:   1.0,
    api:      0.9,
    whisper:  0.85,
    scraping: 0.7,
    ocr:      0.6,
  };

  let score = sourceScores[source] || 0.5;

  if (!text) return 0;

  // Bonus si beaucoup de lignes (paroles complètes)
  const lines = text.split('\n').filter(l => l.trim()).length;
  if (lines > 20) score = Math.min(score + 0.05, 1.0);
  if (lines < 5)  score = Math.max(score - 0.2, 0);

  // Malus si trop de caractères spéciaux suspects
  const suspectChars = (text.match(/[#@$%^*{}<>]/g) || []).length;
  if (suspectChars > 10) score = Math.max(score - 0.15, 0);

  return Math.round(score * 100) / 100;
}

/**
 * Formater les paroles avec sections [Couplet] [Refrain] etc.
 */
export function formatLyricsWithSections(text, lang = 'fr') {
  if (!text) return text;

  const sectionsFr = { verse: 'Couplet', chorus: 'Refrain', bridge: 'Pont', intro: 'Introduction', outro: 'Outro' };
  const sectionsAr = { verse: 'مقطع', chorus: 'لازمة', bridge: 'جسر', intro: 'مقدمة', outro: 'خاتمة' };
  const sections   = lang === 'ar' ? sectionsAr : sectionsFr;

  // Remplacer les marqueurs anglais communs de Genius
  return text
    .replace(/\[Verse\s*(\d*)\]/gi, `[${sections.verse} $1]`)
    .replace(/\[Chorus\]/gi, `[${sections.chorus}]`)
    .replace(/\[Bridge\]/gi, `[${sections.bridge}]`)
    .replace(/\[Intro\]/gi, `[${sections.intro}]`)
    .replace(/\[Outro\]/gi, `[${sections.outro}]`)
    .replace(/\[Hook\]/gi, `[${sections.chorus}]`)
    .trim();
}
