-- Audit non-order admin mutations without duplicating domain or financial ledgers.

create table admin_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references users(id) on delete restrict,
  actor_auth_subject text not null,
  capability text not null,
  action text not null,
  target_type text not null,
  target_id text,
  request_id text not null,
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (actor_auth_subject <> ''),
  check (capability in (
    'assets:write',
    'fulfillment:write',
    'inventory:write',
    'messages:write',
    'order-notes:write',
    'promotions:write'
  )),
  check (action <> ''),
  check (target_type <> ''),
  check (request_id <> ''),
  check (idempotency_key is null or idempotency_key <> ''),
  check (jsonb_typeof(metadata) = 'object')
);

create unique index admin_audit_events_idempotency_idx
  on admin_audit_events(capability, action, idempotency_key)
  where idempotency_key is not null;

create index admin_audit_events_actor_idx
  on admin_audit_events(actor_user_id, created_at desc);
create index admin_audit_events_target_idx
  on admin_audit_events(target_type, target_id, created_at desc);
create index admin_audit_events_request_idx
  on admin_audit_events(request_id, created_at desc);
