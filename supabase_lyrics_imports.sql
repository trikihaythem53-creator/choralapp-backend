-- =============================================
-- Table lyrics_imports — Supabase SQL Editor
-- =============================================

create table if not exists lyrics_imports (
  id           uuid primary key default gen_random_uuid(),
  title        text default '',
  artist       text default '',
  lyrics       text default '',
  segments     jsonb,           -- Timestamps Whisper
  lang         text default 'ar',
  source       text default 'api',    -- api | scraping | whisper | ocr | manual
  provider     text default '',       -- genius | deezer | musixmatch | openai-whisper
  score        float default 0.0,     -- 0.0 → 1.0
  approved     boolean default false,
  status       text default 'pending', -- pending | processing | completed | failed | rejected
  progress     int default 0,
  error_message text,
  created_by   text,                  -- uid admin
  song_id      uuid references songs(id) on delete set null,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- Index pour les requêtes fréquentes
create index if not exists idx_lyrics_imports_approved on lyrics_imports(approved);
create index if not exists idx_lyrics_imports_status   on lyrics_imports(status);
create index if not exists idx_lyrics_imports_score    on lyrics_imports(score);

-- RLS
alter table lyrics_imports enable row level security;

create policy "lyrics_imports_select" on lyrics_imports
  for select using (true);

create policy "lyrics_imports_insert" on lyrics_imports
  for insert with check (true);

create policy "lyrics_imports_update" on lyrics_imports
  for update using (true);

-- Trigger updated_at
create trigger lyrics_imports_updated_at
  before update on lyrics_imports
  for each row execute function update_updated_at();
