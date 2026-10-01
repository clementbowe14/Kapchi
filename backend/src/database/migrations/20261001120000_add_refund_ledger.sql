create type refund_status as enum ('pending', 'succeeded', 'failed');
create type refund_pending_reason as enum (
  'reserved',
  'provider_pending',
  'requires_action',
  'unknown_outcome',
  'provider_conflict'
);
create type refund_origin as enum ('kapchi', 'stripe_external');
create type refund_effect_type as enum ('restock', 'customer_notification');
create type refund_effect_status as enum (
  'not_requested',
  'unsupported',
  'pending',
  'succeeded',
  'failed'
);
create type payment_reconciliation_status as enum (
  'current',
  'stale',
  'failed',
  'conflicted'
);

create table payment_reconciliation_state (
  order_id uuid primary key references orders(id) on delete cascade,
  payment_intent_id text not null unique,
  provider_account_id text not null,
  livemode boolean not null,
  latest_charge_id text,
  stripe_api_version text,
  captured_amount_cents integer not null check (captured_amount_cents >= 0),
  provider_refunded_amount_cents integer not null default 0
    check (provider_refunded_amount_cents >= 0),
  currency char(3) not null check (currency ~ '^[a-z]{3}$'),
  provider_payment_status text not null,
  reconciliation_status payment_reconciliation_status not null default 'stale',
  last_reconciliation_error_code text,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (provider_account_id <> ''),
  check (payment_intent_id <> ''),
  check (provider_payment_status <> ''),
  check (
    reconciliation_status <> 'current'
    or last_reconciled_at is not null
  )
);

create table refund_operations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete restrict,
  payment_intent_id text not null,
  provider_account_id text not null,
  livemode boolean not null,
  amount_cents integer not null check (amount_cents > 0),
  currency char(3) not null check (currency ~ '^[a-z]{3}$'),
  reason_code text not null,
  reason_note text,
  actor_user_id uuid references users(id) on delete restrict,
  actor_auth_subject text,
  origin refund_origin not null,
  status refund_status not null,
  pending_reason refund_pending_reason,
  provider_refund_id text,
  client_idempotency_key text not null unique,
  provider_idempotency_key text not null unique,
  request_fingerprint text not null,
  fingerprint_version smallint not null default 1 check (fingerprint_version > 0),
  provider_failure_code text,
  provider_failure_message text,
  provider_created_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  provider_attempt_count integer not null default 0 check (provider_attempt_count >= 0),
  provider_attempt_started_at timestamptz,
  dispatch_ever_claimed boolean not null default false,
  dispatch_lease_owner text,
  dispatch_lease_expires_at timestamptz,
  reconciliation_attempt_count integer not null default 0
    check (reconciliation_attempt_count >= 0),
  last_reconciliation_attempt_at timestamptz,
  next_reconciliation_at timestamptz,
  manual_review_required boolean not null default false,
  restock_requested boolean not null default false,
  notification_requested boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (payment_intent_id <> ''),
  check (provider_account_id <> ''),
  check (reason_code in ('requested_by_customer', 'duplicate', 'fraudulent', 'other')),
  check (client_idempotency_key <> ''),
  check (provider_idempotency_key <> ''),
  check (request_fingerprint <> ''),
  check (
    (origin = 'stripe_external' and actor_user_id is null and actor_auth_subject is null)
    or
    (origin = 'kapchi' and actor_user_id is not null and actor_auth_subject is not null)
  ),
  check (
    (status = 'pending' and pending_reason is not null and succeeded_at is null and failed_at is null)
    or
    (status = 'succeeded' and pending_reason is null and succeeded_at is not null and failed_at is null)
    or
    (status = 'failed' and pending_reason is null and failed_at is not null and succeeded_at is null)
  ),
  check (
    (dispatch_lease_owner is null and dispatch_lease_expires_at is null)
    or
    (dispatch_lease_owner is not null and dispatch_lease_expires_at is not null)
  )
);

create unique index refund_operations_provider_refund_idx
  on refund_operations(provider_account_id, livemode, provider_refund_id)
  where provider_refund_id is not null;
create index refund_operations_order_status_idx
  on refund_operations(order_id, status, created_at);
create index refund_operations_payment_status_idx
  on refund_operations(payment_intent_id, status, created_at);
create index refund_operations_reconciliation_queue_idx
  on refund_operations(next_reconciliation_at, created_at)
  where status = 'pending';
create index refund_operations_manual_review_idx
  on refund_operations(created_at)
  where manual_review_required;

create table refund_effects (
  id uuid primary key default gen_random_uuid(),
  refund_operation_id uuid not null references refund_operations(id) on delete cascade,
  effect_type refund_effect_type not null,
  requested boolean not null,
  status refund_effect_status not null,
  idempotency_key text not null unique,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  next_attempt_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (refund_operation_id, effect_type),
  check (idempotency_key <> ''),
  check (
    (requested and status <> 'not_requested')
    or
    (not requested and status = 'not_requested')
  )
);

alter table order_events add column transition_key text;
create unique index order_events_transition_key_idx
  on order_events(transition_key)
  where transition_key is not null;

alter table stripe_webhook_events
  drop constraint stripe_webhook_events_check;
alter type stripe_webhook_processing_status
  rename to stripe_webhook_processing_status_legacy;
create type stripe_webhook_processing_status as enum (
  'received',
  'processing',
  'retryable',
  'unmatched',
  'processed',
  'exhausted'
);
alter table stripe_webhook_events
  alter column processing_status drop default;
alter table stripe_webhook_events
  alter column processing_status type stripe_webhook_processing_status
  using (
    case processing_status::text
      when 'failed' then 'retryable'
      else processing_status::text
    end
  )::stripe_webhook_processing_status;
alter table stripe_webhook_events
  alter column processing_status set default 'received';
drop type stripe_webhook_processing_status_legacy;
alter table stripe_webhook_events
  add constraint stripe_webhook_events_processed_timestamp
  check (processing_status <> 'processed' or processed_at is not null);

alter table stripe_webhook_events
  alter column payload drop not null,
  add column projection_version smallint not null default 1,
  add column event_projection jsonb,
  add column raw_payload_sha256 text,
  add column provider_account_id text,
  add column livemode_verified boolean,
  add column attempt_count integer not null default 0,
  add column next_attempt_at timestamptz,
  add column lease_owner text,
  add column lease_expires_at timestamptz,
  add column last_error_code text,
  add column manual_review_required boolean not null default false,
  add constraint stripe_webhook_events_projection_object
    check (event_projection is null or jsonb_typeof(event_projection) = 'object'),
  add constraint stripe_webhook_events_attempt_count
    check (attempt_count >= 0),
  add constraint stripe_webhook_events_lease_pair
    check (
      (lease_owner is null and lease_expires_at is null)
      or
      (lease_owner is not null and lease_expires_at is not null)
    );

create index stripe_webhook_events_retry_queue_idx
  on stripe_webhook_events(next_attempt_at, received_at)
  where processing_status in ('received', 'retryable', 'unmatched');

create trigger payment_reconciliation_state_set_updated_at
before update on payment_reconciliation_state
for each row execute function set_updated_at();

create trigger refund_operations_set_updated_at
before update on refund_operations
for each row execute function set_updated_at();

create trigger refund_effects_set_updated_at
before update on refund_effects
for each row execute function set_updated_at();
