// src/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { logger } from './utils/logger.js';
import lyricsRouter from './routes/lyrics.js';
import audioRouter  from './routes/audio.js';
import songsRouter  from './routes/songs.js';

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 200 }));

app.use('/api/lyrics', lyricsRouter);
app.use('/api/audio',  audioRouter);
app.use('/api/songs',  songsRouter);

app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// Diagnostic réseau OpenAI — teste si le serveur peut joindre OpenAI
app.get('/diagnose/openai', async (req, res) => {
  const https = await import('https');
  const start = Date.now();
  https.default.get('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}` },
    timeout: 10000,
  }, (resp) => {
    res.json({ reachable: true, statusCode: resp.statusCode, ms: Date.now() - start });
  }).on('error', (err) => {
    res.json({ reachable: false, error: err.message, code: err.code, ms: Date.now() - start });
  }).on('timeout', () => {
    res.json({ reachable: false, error: 'Timeout après 10s', code: 'TIMEOUT', ms: Date.now() - start });
  });
});

app.use((err, req, res, next) => {
  logger.error('Erreur serveur:', err);
  res.status(500).json({ error: err.message || 'Erreur interne' });
});

app.listen(PORT, () => {
  logger.info(`🎵 ChoralApp Backend démarré sur http://localhost:${PORT}`);
});

export default app;
