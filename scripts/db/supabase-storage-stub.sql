-- Minimal stand-in for the schema the Supabase Storage service creates, so migrations that add buckets and storage
-- policies apply in a disposable test database. Shapes follow storage-api; only what migrations reference is here.
-- Applied as supabase_admin before the migrations by scripts/db/run-pg-sql-tests.mjs. Never applied to a real project.
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_admin;
GRANT USAGE ON SCHEMA storage TO postgres, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 text PRIMARY KEY,
  name               text NOT NULL UNIQUE,
  owner              uuid,
  owner_id           text,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  public             boolean DEFAULT false,
  avif_autodetection boolean DEFAULT false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id        text REFERENCES storage.buckets (id),
  name             text,
  owner            uuid,
  owner_id         text,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  metadata         jsonb,
  user_metadata    jsonb,
  version          text,
  path_tokens      text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
  LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)] $$;
CREATE OR REPLACE FUNCTION storage.extension(name text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT reverse(split_part(reverse(name), '.', 1)) $$;

ALTER TABLE storage.buckets OWNER TO supabase_admin;
ALTER TABLE storage.objects OWNER TO supabase_admin;
GRANT ALL ON storage.buckets, storage.objects TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.buckets, storage.objects TO anon, authenticated;
-- Supabase lets the postgres role manage storage policies and buckets.
GRANT ALL ON SCHEMA storage TO postgres;
