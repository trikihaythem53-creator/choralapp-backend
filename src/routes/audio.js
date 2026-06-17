// src/routes/audio.js
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { transcribeYouTube, transcribeUploadedAudio, formatSegmentsWithTimestamps } from '../services/audioTranscriptionService.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

if (!fs.existsSync('./tmp')) fs.mkdirSync('./tmp', { recursive: true });

const storage = multer.diskStorage({
  destination: './tmp/',
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp3','.mp4','.m4a','.wav','.ogg','.webm','.flac'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// ── POST /api/audio/youtube ────────────────────────────────────
router.post('/youtube', async (req, res) => {
  const { youtubeUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: 'URL YouTube requise' });

  try {
    logger.info(`Transcription YouTube: ${youtubeUrl}`);
    const result = await transcribeYouTube(youtubeUrl);
    res.json({
      ...result,
      segments_formatted: formatSegmentsWithTimestamps(result.segments),
    });
  } catch (err) {
    logger.error('YouTube error complet:', err);
    logger.error('Message:', err.message);
    logger.error('Stack:', err.stack);
    res.status(500).json({ 
      error: err.message || 'Erreur inconnue',
      details: err.stack?.slice(0, 300),
    });
  }
});

// ── POST /api/audio/upload ─────────────────────────────────────
router.post('/upload', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier audio requis' });

  try {
    logger.info(`Transcription upload: ${req.file.originalname}`);
    const result = await transcribeUploadedAudio(req.file.path, req.file.originalname);
    try { fs.unlinkSync(req.file.path); } catch {}
    res.json({
      ...result,
      segments_formatted: formatSegmentsWithTimestamps(result.segments),
    });
  } catch (err) {
    try { fs.unlinkSync(req.file?.path); } catch {}
    logger.error('Upload error complet:', err);
    res.status(500).json({ error: err.message || 'Erreur inconnue' });
  }
});

export default router;
