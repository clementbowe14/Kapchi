create type stripe_webhook_processing_status as enum (
  'received',
  'processing',
  'processed',
  'failed'
);

create table stripe_webhook_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  event_type text not null,
  api_version text,
  livemode boolean not null,
  order_id uuid references orders(id) on delete set null,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  processing_status stripe_webhook_processing_status not null default 'received',
  processing_error text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (stripe_event_id <> ''),
  check (event_type <> ''),
  check (api_version is null or api_version <> ''),
  check (stripe_checkout_session_id is null or stripe_checkout_session_id <> ''),
  check (stripe_payment_intent_id is null or stripe_payment_intent_id <> ''),
  check (jsonb_typeof(payload) = 'object'),
  check (processing_status <> 'processed' or processed_at is not null)
);

create index stripe_webhook_events_order_idx
  on stripe_webhook_events(order_id, received_at)
  where order_id is not null;
create index stripe_webhook_events_event_type_idx
  on stripe_webhook_events(event_type, received_at);
create index stripe_webhook_events_processing_status_idx
  on stripe_webhook_events(processing_status, received_at);

create trigger stripe_webhook_events_set_updated_at
before update on stripe_webhook_events
for each row execute function set_updated_at();
