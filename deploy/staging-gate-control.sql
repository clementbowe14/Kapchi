-- Bootstrap this schema only in a physically separate workflow control
-- database. The application DATABASE_URL and migration role must never be
-- able to connect to this database.
--
-- Usage:
--   psql "$STAGING_GATE_DATABASE_URL" \
--     --set=control_database_id="$(openssl rand -hex 32)" \
--     --file=deploy/staging-gate-control.sql

\if :{?control_database_id}
\else
\echo 'control_database_id is required'
\quit 1
\endif

begin;

create schema if not exists staging_gate_control;
revoke all on schema staging_gate_control from public;

create table if not exists staging_gate_control.control_plane (
  singleton boolean primary key default true check (singleton),
  environment text not null check (environment = 'staging'),
  purpose text not null check (purpose = 'kapchi-staging-release-gate'),
  installation_id text not null check (installation_id ~ '^[0-9a-f]{64}$'),
  installed_at timestamptz not null default now()
);

insert into staging_gate_control.control_plane (
  singleton, environment, purpose, installation_id
) values (
  true, 'staging', 'kapchi-staging-release-gate', :'control_database_id'
)
on conflict (singleton) do update
set installation_id = excluded.installation_id,
    installed_at = now();

create table if not exists staging_gate_control.attempts (
  attempt_id text primary key check (attempt_id ~ '^stg_[A-Za-z0-9][A-Za-z0-9_-]{7,95}$'),
  candidate_sha text not null check (candidate_sha ~ '^[0-9a-f]{40}$'),
  owner_token_hash text not null check (owner_token_hash ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('preparing', 'active', 'cleanup-pending', 'cleaned', 'failed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finalized_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '24 hours'),
  check ((state in ('cleaned', 'failed')) = (finalized_at is not null))
);

create table if not exists staging_gate_control.resource_intents (
  resource_intent_id bigint generated always as identity primary key,
  intent_id text not null unique check (intent_id ~ '^intent_[0-9a-f]{32}$'),
  attempt_id text not null references staging_gate_control.attempts(attempt_id) on delete restrict,
  provider text not null check (provider in ('alias', 'database', 'redis', 'stripe', 'clerk', 'blob', 'messaging')),
  namespace text not null check (namespace ~ '^kapchi-stg-[a-z0-9-]+-[0-9a-f]{12}$'),
  idempotency_key text not null,
  target_identity text not null,
  expected_account_hash text not null check (expected_account_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'creation-pending' check (state in (
    'creation-pending', 'bound', 'cleanup-pending', 'cleaned', 'terminal-isolated', 'cleanup-failed'
  )),
  intent_recorded_at timestamptz not null default now(),
  provider_call_started_at timestamptz,
  provider_handle text,
  provider_handle_hash text check (provider_handle_hash is null or provider_handle_hash ~ '^[0-9a-f]{64}$'),
  resource_created_at timestamptz,
  bound_at timestamptz,
  cleanup_started_at timestamptz,
  cleanup_verified_at timestamptz,
  absence_verified boolean not null default false,
  terminal_state_verified boolean not null default false,
  cleanup_outcome text check (cleanup_outcome is null or cleanup_outcome in ('already_clean', 'deleted', 'terminal_isolated')),
  evidence_digest text check (evidence_digest is null or evidence_digest ~ '^[0-9a-f]{64}$'),
  unique (provider, idempotency_key),
  check (provider_call_started_at is null or provider_call_started_at >= intent_recorded_at),
  check (bound_at is null or (
    provider_handle is not null and provider_handle_hash is not null and
    provider_call_started_at is not null and resource_created_at is not null and
    bound_at >= provider_call_started_at
  )),
  check (cleanup_started_at is null or cleanup_started_at >= intent_recorded_at),
  check (cleanup_verified_at is null or (cleanup_started_at is not null and cleanup_verified_at >= cleanup_started_at)),
  check (state <> 'cleaned' or (
    absence_verified and cleanup_verified_at is not null and
    cleanup_outcome in ('already_clean', 'deleted') and evidence_digest is not null
  )),
  check (state <> 'terminal-isolated' or (
    provider in ('stripe', 'messaging') and terminal_state_verified and
    cleanup_verified_at is not null and cleanup_outcome = 'terminal_isolated' and
    evidence_digest is not null
  ))
);

create index if not exists staging_gate_resource_intents_expiry
  on staging_gate_control.resource_intents (state, intent_recorded_at);

create index if not exists staging_gate_resource_intents_attempt_provider_namespace
  on staging_gate_control.resource_intents (attempt_id, provider, namespace);

create table if not exists staging_gate_control.alias_intents (
  alias_intent_id bigint generated always as identity primary key,
  intent_id text not null unique check (intent_id ~ '^alias_[0-9a-f]{32}$'),
  attempt_id text not null references staging_gate_control.attempts(attempt_id) on delete restrict,
  candidate_sha text not null check (candidate_sha ~ '^[0-9a-f]{40}$'),
  projects jsonb not null,
  prior_targets jsonb not null,
  requested_targets jsonb not null,
  state text not null default 'pending' check (state in ('pending', 'complete', 'restored')),
  created_at timestamptz not null,
  storefront_assigned_at timestamptz,
  api_assigned_at timestamptz,
  completed_at timestamptz,
  restored_at timestamptz,
  check ((completed_at is not null) = (state = 'complete')),
  check ((restored_at is not null) = (state = 'restored')),
  check (state <> 'complete' or (storefront_assigned_at is not null and api_assigned_at is not null))
);

create index if not exists staging_gate_alias_intents_unfinished
  on staging_gate_control.alias_intents (state, created_at);

create or replace function staging_gate_control.protect_terminal_alias_intent()
returns trigger
language plpgsql
as $$
begin
  if old.state in ('complete', 'restored') then
    if tg_op = 'DELETE' then
      raise exception 'terminal staging alias intents are immutable';
    end if;
    if new is distinct from old then
      raise exception 'terminal staging alias intents are immutable';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists staging_gate_alias_intent_terminal_immutable
  on staging_gate_control.alias_intents;
create trigger staging_gate_alias_intent_terminal_immutable
before update or delete on staging_gate_control.alias_intents
for each row execute function staging_gate_control.protect_terminal_alias_intent();

create or replace function staging_gate_control.protect_cleanup_tombstone()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and old.state in ('cleaned', 'terminal-isolated') then
    if old.cleanup_verified_at <= now() - interval '30 days' and old.evidence_digest is not null then
      return old;
    end if;
    raise exception 'staging gate cleanup tombstones require 30-day retention and evidence';
  end if;
  if old.state in ('cleaned', 'terminal-isolated') and new is distinct from old then
    raise exception 'staging gate cleanup tombstones are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists staging_gate_resource_tombstone_immutable
  on staging_gate_control.resource_intents;
create trigger staging_gate_resource_tombstone_immutable
before update or delete on staging_gate_control.resource_intents
for each row execute function staging_gate_control.protect_cleanup_tombstone();

revoke all on all tables in schema staging_gate_control from public;
revoke all on all sequences in schema staging_gate_control from public;

comment on schema staging_gate_control is
  'Physically dedicated Kapchi staging release-gate control plane; never expose this database to the deployed application.';

commit;
