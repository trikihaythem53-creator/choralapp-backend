// src/utils/supabase.js
import { createClient } from '@supabase/supabase-js';

// ⚠️ On utilise la SERVICE ROLE KEY côté backend (accès complet, jamais exposée au frontend)
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
