-- Story Reels schema. Safe to run many times.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A proven competitor story video, uploaded once, analyzed once, reused for many new reels.
CREATE TABLE IF NOT EXISTS story_references (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  video_path   text NOT NULL,          -- relative to DATA_DIR
  notes        text,                   -- pasted caption / story text / why it went viral
  analysis     jsonb,                  -- Gemini breakdown
  status       text NOT NULL DEFAULT 'uploaded', -- uploaded | analyzing | ready | failed
  error        text,
  cost_usd     numeric(10,4) NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One new original reel generated from a reference.
CREATE TABLE IF NOT EXISTS projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id  uuid NOT NULL REFERENCES story_references(id) ON DELETE CASCADE,
  title         text NOT NULL DEFAULT 'New reel',
  status        text NOT NULL DEFAULT 'writing',
  -- writing | story_review | characters | characters_review | frames | frames_review
  -- | clips | rendering | done | failed
  error         text,
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  story         jsonb,                 -- Claude's new original story (editable)
  music_path    text,
  final_path    text,
  cost_usd      numeric(10,4) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_reference_idx ON projects(reference_id);

-- Generated files: character reference images, scene start frames, scene video clips.
CREATE TABLE IF NOT EXISTS assets (
  id              bigserial PRIMARY KEY,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            text NOT NULL,       -- character | frame | clip
  ref             text NOT NULL,       -- character key, or scene index as text
  status          text NOT NULL DEFAULT 'pending', -- pending | generating | ready | failed
  path            text,
  remote_url      text,
  fal_endpoint    text,
  fal_request_id  text,
  prompt          text,
  error           text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind, ref)
);

CREATE TABLE IF NOT EXISTS jobs (
  id            bigserial PRIMARY KEY,
  type          text NOT NULL,         -- analyze | write | characters | frames | clips | render
  reference_id  uuid REFERENCES story_references(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES projects(id) ON DELETE CASCADE,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  attempts      int NOT NULL DEFAULT 0,
  error         text,
  run_after     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, run_after, id);
