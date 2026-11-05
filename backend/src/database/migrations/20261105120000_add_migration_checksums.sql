-- add migration content checksums
alter table schema_migrations
  add column if not exists checksum text;

create table if not exists asset_upload_callbacks (
  nonce text primary key,
  asset_id uuid not null unique references assets(id) on delete cascade,
  business_fingerprint text not null,
  completion_fingerprint text,
  completed_result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days')
);
