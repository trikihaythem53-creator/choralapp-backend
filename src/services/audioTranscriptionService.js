// src/services/audioTranscriptionService.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import OpenAI from 'openai';
import ffmpeg from 'fluent-ffmpeg';
import { logger } from '../utils/logger.js';
import { detectLanguage, qualityScore } from '../utils/textCleaner.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR   = path.join(__dirname, '../../tmp');
const COOKIES_PATH = path.join(TMP_DIR, 'youtube_cookies.txt');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Écrire les cookies YouTube depuis la variable d'environnement (si fournie)
// YOUTUBE_COOKIES doit contenir le contenu complet du fichier cookies.txt exporté
if (process.env.YOUTUBE_COOKIES) {
  try {
    fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES);
    logger.info('Cookies YouTube chargés depuis YOUTUBE_COOKIES');
  } catch (e) {
    logger.warn('Impossible d\'écrire les cookies YouTube:', e.message);
  }
}

// Initialiser OpenAI avec la clé directement
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ══════════════════════════════════════════════════════════════
// TRANSCRIPTION YOUTUBE avec yt-dlp
// ══════════════════════════════════════════════════════════════

export async function transcribeYouTube(youtubeUrl) {
  logger.info(`Transcription YouTube: ${youtubeUrl}`);
  const jobId   = Date.now();
  const outPath = path.join(TMP_DIR, `yt_${jobId}.mp3`);

  try {
    // Télécharger avec yt-dlp
    logger.info('Téléchargement avec yt-dlp...');
    await downloadWithYtDlp(youtubeUrl, outPath);

    if (!fs.existsSync(outPath)) throw new Error('Téléchargement échoué');

    // Transcrire avec Whisper
    logger.info('Transcription Whisper AI...');
    const result = await transcribeWithWhisper(outPath);

    cleanup(outPath);
    return {
      lyrics:   result.text,
      segments: result.segments,
      lang:     result.language || detectLanguage(result.text),
      source:   'whisper',
      provider: 'openai-whisper',
      score:    qualityScore(result.text, 'whisper'),
    };
  } catch (err) {
    cleanup(outPath);
    logger.error('Erreur YouTube:', err.message);

    // Message clair si le problème vient des cookies expirés/manquants
    if (err.message.includes('Sign in to confirm') || err.message.includes('bot')) {
      throw new Error('⚠️ Les cookies YouTube ont expiré — l\'admin technique doit les renouveler (voir /diagnose/youtube-cookies)');
    }
    throw new Error(err.message);
  }
}

async function downloadWithYtDlp(url, outputPath) {
  const hasCookies = fs.existsSync(COOKIES_PATH);
  const cookiesArg = hasCookies ? `--cookies "${COOKIES_PATH}"` : '';

  // Client "android" contourne souvent la détection bot de YouTube
  // --js-runtimes deno active le runtime JS requis par les nouvelles protections YouTube
  const cmd = `yt-dlp -x --audio-format mp3 --audio-quality 5 --no-playlist ` +
    `${cookiesArg} ` +
    `--extractor-args "youtube:player_client=android,web" ` +
    `--js-runtimes deno ` +
    `--user-agent "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" ` +
    `-o "${outputPath}" "${url}"`;
  logger.info(`Commande yt-dlp... (cookies: ${hasCookies ? 'oui' : 'non'})`);
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 120000 });
    if (stderr) logger.warn('yt-dlp stderr:', stderr.slice(0, 500));
  } catch (err) {
    // Fallback : réessayer avec le client web simple + cookies si disponibles
    logger.warn('Échec avec client android, nouvelle tentative avec client web...');
    const fallbackCmd = `yt-dlp -x --audio-format mp3 --audio-quality 5 --no-playlist ` +
      `${cookiesArg} ` +
      `--js-runtimes deno ` +
      `-o "${outputPath}" "${url}"`;
    try {
      await execAsync(fallbackCmd, { timeout: 120000 });
    } catch (err2) {
      throw new Error(`yt-dlp échoué: ${err2.message}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════
// TRANSCRIPTION AUDIO UPLOADÉ
// ══════════════════════════════════════════════════════════════

export async function transcribeUploadedAudio(filePath, originalName) {
  logger.info(`Transcription upload: ${originalName}`);
  const jobId   = Date.now();
  const mp3Path = path.join(TMP_DIR, `upload_${jobId}.mp3`);

  try {
    await convertToMp3(filePath, mp3Path);
    const result = await transcribeWithWhisper(mp3Path);
    cleanup(mp3Path);

    return {
      lyrics:   result.text,
      segments: result.segments,
      lang:     result.language || detectLanguage(result.text),
      source:   'whisper',
      provider: 'openai-whisper',
      score:    qualityScore(result.text, 'whisper'),
    };
  } catch (err) {
    cleanup(mp3Path);
    throw new Error(`Transcription échouée: ${err.message}`);
  }
}

async function convertToMp3(inputPath, outputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.mp3') { fs.copyFileSync(inputPath, outputPath); return; }
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('libmp3lame').audioBitrate(128).format('mp3')
      .on('end', resolve).on('error', reject).save(outputPath);
  });
}

async function transcribeWithWhisper(audioPath) {
  const stats  = fs.statSync(audioPath);
  const sizeMB = stats.size / (1024 * 1024);
  logger.info(`Envoi à Whisper (${sizeMB.toFixed(1)}MB)...`);

  if (sizeMB > 25) throw new Error(`Fichier trop grand (${sizeMB.toFixed(1)}MB, max 25MB)`);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      logger.info(`Tentative ${attempt}/3 d'appel à l'API OpenAI...`);
      const transcription = await openai.audio.transcriptions.create({
        file:            fs.createReadStream(audioPath),
        model:           'whisper-1',
        response_format: 'verbose_json',
        timestamp_granularities: ['segment'],
        prompt:          'أغنية عربية أو أنشودة إسلامية أو أغنية فرنسية.',
      }, { timeout: 120000 });

      const segments = (transcription.segments || []).map(s => ({
        start: s.start, end: s.end, text: s.text.trim(),
      }));

      const text = segments.length > 0
        ? segments.map(s => s.text).join('\n')
        : transcription.text;

      logger.info(`✅ Whisper a répondu avec succès (${text.length} caractères)`);
      return { text: text.trim(), segments, language: transcription.language };

    } catch (err) {
      lastError = err;
      const code = err.code || err.cause?.code || 'UNKNOWN';
      logger.error(`Tentative ${attempt}/3 échouée [${code}]: ${err.message}`);

      // Diagnostic précis de la cause
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        throw new Error('DNS introuvable — impossible de résoudre api.openai.com. Vérifiez votre connexion internet ou DNS.');
      }
      if (code === 'ECONNREFUSED') {
        throw new Error('Connexion refusée par api.openai.com — un firewall ou proxy bloque probablement la requête.');
      }
      if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
        if (attempt < 3) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
        throw new Error('Timeout de connexion à OpenAI — le réseau local bloque probablement l\'accès (firewall/FAI). Essayez avec un VPN ou déployez le backend sur un serveur cloud (Railway, Render).');
      }
      if (err.status === 401) {
        throw new Error('Clé API OpenAI invalide ou expirée — vérifiez OPENAI_API_KEY dans le fichier .env');
      }
      if (err.status === 429) {
        throw new Error('Quota OpenAI dépassé ou limite de débit atteinte — vérifiez votre solde sur platform.openai.com/usage');
      }
      if (attempt < 3) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
    }
  }

  throw new Error(`Connexion à OpenAI impossible après 3 tentatives: ${lastError?.message || 'erreur inconnue'}`);
}

function cleanup(...paths) {
  paths.forEach(p => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {} });
}

export function formatSegmentsWithTimestamps(segments) {
  if (!segments?.length) return '';
  return segments.map(s => `[${fmt(s.start)}] ${s.text}`).join('\n');
}

function fmt(sec) {
  const m = Math.floor(sec/60), s = Math.floor(sec%60);
  return `${m}:${String(s).padStart(2,'0')}`;
}
