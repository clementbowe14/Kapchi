create type transactional_notification_kind as enum (
  'order.confirmed',
  'order.cancelled',
  'refund.completed',
  'order.shipped',
  'order.delivered'
);

create type transactional_notification_intent_status as enum (
  'pending',
  'leased',
  'retryable',
  'queued',
  'succeeded',
  'failed'
);

create table transactional_notification_intents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  kind transactional_notification_kind not null,
  idempotency_key text not null unique,
  source_type text not null,
  source_id uuid not null,
  payload_version smallint not null default 1 check (payload_version > 0),
  payload jsonb not null,
  payload_hash char(64) not null,
  recipient_channel message_channel,
  recipient_address text,
  recipient_failure_code text,
  status transactional_notification_intent_status not null default 'pending',
  materialization_attempt_count integer not null default 0
    check (materialization_attempt_count >= 0),
  max_materialization_attempts integer not null default 5
    check (max_materialization_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_failure_code text,
  order_message_id uuid unique references order_messages(id) on delete restrict,
  queued_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (idempotency_key <> '' and length(idempotency_key) <= 200),
  check (source_type <> '' and length(source_type) <= 80),
  check (jsonb_typeof(payload) = 'object'),
  check (payload_hash ~ '^[a-f0-9]{64}$'),
  check (recipient_channel is null or recipient_channel in ('email', 'sms')),
  check (
    (recipient_channel is null and recipient_address is null)
    or (recipient_channel is not null and recipient_address is not null and recipient_address <> '')
  ),
  check (
    recipient_failure_code is null
    or recipient_failure_code in (
      'MESSAGE_CONTACT_UNAVAILABLE',
      'MESSAGE_SMS_CONSENT_UNAVAILABLE'
    )
  ),
  check (
    last_failure_code is null
    or last_failure_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  check (
    (status = 'leased' and lease_owner is not null and lease_expires_at is not null)
    or (status <> 'leased' and lease_owner is null and lease_expires_at is null)
  ),
  check (status not in ('queued', 'succeeded') or order_message_id is not null),
  check (order_message_id is null or status in ('queued', 'succeeded', 'failed')),
  check (queued_at is null or order_message_id is not null),
  check ((status = 'succeeded') = (succeeded_at is not null)),
  check ((status = 'failed') = (failed_at is not null)),
  check (status <> 'succeeded' or failed_at is null),
  check (status <> 'failed' or succeeded_at is null)
);

create index transactional_notification_intents_ready_idx
  on transactional_notification_intents(next_attempt_at, created_at, id)
  where status in ('pending', 'retryable');
create index transactional_notification_intents_expired_lease_idx
  on transactional_notification_intents(lease_expires_at, created_at, id)
  where status = 'leased';
create index transactional_notification_intents_order_idx
  on transactional_notification_intents(order_id, created_at, id);
create index transactional_notification_intents_admin_status_idx
  on transactional_notification_intents(status, kind, last_failure_code, created_at desc, id desc);
create unique index transactional_notification_intents_source_idx
  on transactional_notification_intents(kind, source_type, source_id);

alter table refund_effects
  add column transactional_notification_intent_id uuid unique
    references transactional_notification_intents(id) on delete restrict;

create index refund_effects_notification_intent_idx
  on refund_effects(transactional_notification_intent_id)
  where transactional_notification_intent_id is not null;

create trigger transactional_notification_intents_set_updated_at
before update on transactional_notification_intents
for each row execute function set_updated_at();
