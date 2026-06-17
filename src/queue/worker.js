// src/queue/worker.js
import 'dotenv/config';
import { Worker, Queue } from 'bullmq';
import { logger } from '../utils/logger.js';
import { transcribeYouTube, transcribeUploadedAudio } from '../services/audioTranscriptionService.js';
import { supabase } from '../utils/supabase.js';

const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' };

export const audioQueue = new Queue('audio-transcription', { connection });

// ── Worker ─────────────────────────────────────────────────────
const worker = new Worker('audio-transcription', async (job) => {
  logger.info(`Traitement job ${job.id}: ${job.name}`);

  const { jobId, type, data } = job.data;

  try {
    // Mettre à jour le statut en "processing"
    await updateJobStatus(jobId, 'processing', 0);

    let result;

    if (type === 'youtube') {
      await job.updateProgress(10);
      result = await transcribeYouTube(data.youtubeUrl);
    } else if (type === 'upload') {
      await job.updateProgress(10);
      result = await transcribeUploadedAudio(data.filePath, data.originalName);
    } else {
      throw new Error(`Type inconnu: ${type}`);
    }

    await job.updateProgress(80);

    // Sauvegarder le résultat dans Supabase
    const { data: saved, error } = await supabase
      .from('lyrics_imports')
      .update({
        status:     'completed',
        lyrics:     result.lyrics,
        segments:   result.segments,
        lang:       result.lang,
        source:     result.source,
        provider:   result.provider,
        score:      result.score,
        approved:   false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .select()
      .single();

    if (error) throw error;

    await job.updateProgress(100);
    logger.info(`✅ Job ${job.id} terminé (score: ${result.score})`);
    return saved;

  } catch (err) {
    logger.error(`❌ Job ${job.id} échoué:`, err.message);
    await updateJobStatus(jobId, 'failed', 0, err.message);
    throw err;
  }

}, { connection, concurrency: 2 });

worker.on('completed', job => logger.info(`Job ${job.id} complété`));
worker.on('failed',    (job, err) => logger.error(`Job ${job.id} échoué: ${err.message}`));

async function updateJobStatus(jobId, status, progress, error = null) {
  await supabase.from('lyrics_imports').update({
    status,
    progress,
    error_message: error,
    updated_at: new Date().toISOString(),
  }).eq('id', jobId);
}

logger.info('🎵 Worker BullMQ démarré — en attente de jobs audio...');

export default worker;
