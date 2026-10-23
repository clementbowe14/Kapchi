create type order_conversation_status as enum (
  'awaiting_admin',
  'awaiting_customer',
  'resolved'
);

create type message_delivery_job_status as enum (
  'pending',
  'leased',
  'retryable',
  'succeeded',
  'failed'
);

create type messaging_webhook_status as enum (
  'received',
  'processed',
  'rejected'
);

create table order_conversations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references orders(id) on delete cascade,
  thread_key text not null unique,
  status order_conversation_status not null default 'awaiting_admin',
  admin_unread boolean not null default false,
  version bigint not null default 0 check (version >= 0),
  last_message_at timestamptz,
  last_customer_message_at timestamptz,
  last_admin_message_at timestamptz,
  resolved_at timestamptz,
  resolved_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (thread_key <> ''),
  check ((status = 'resolved') = (resolved_at is not null))
);

insert into order_conversations (
  order_id,
  thread_key,
  status,
  admin_unread,
  last_message_at,
  last_customer_message_at,
  last_admin_message_at
)
select
  messages.order_id,
  'kapchi-order:' || messages.order_id::text,
  case
    when (array_agg(messages.direction order by messages.created_at desc, messages.id desc))[1] = 'inbound'
      then 'awaiting_admin'::order_conversation_status
    else 'awaiting_customer'::order_conversation_status
  end,
  (array_agg(messages.direction order by messages.created_at desc, messages.id desc))[1] = 'inbound',
  max(messages.created_at),
  max(messages.created_at) filter (where messages.direction = 'inbound'),
  max(messages.created_at) filter (where messages.sender_type = 'admin')
from order_messages messages
group by messages.order_id;

alter table order_messages
  add column conversation_id uuid references order_conversations(id) on delete cascade,
  add column idempotency_key text,
  add column provider_event_id text,
  add column reply_to_message_id uuid references order_messages(id) on delete set null,
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column last_attempt_at timestamptz,
  add column failed_at timestamptz,
  add column metadata jsonb not null default '{}'::jsonb,
  add constraint order_messages_idempotency_key_check
    check (idempotency_key is null or idempotency_key <> ''),
  add constraint order_messages_provider_event_id_check
    check (provider_event_id is null or provider_event_id <> ''),
  add constraint order_messages_metadata_object_check
    check (jsonb_typeof(metadata) = 'object');

update order_messages messages
set conversation_id = conversations.id
from order_conversations conversations
where conversations.order_id = messages.order_id;

alter table order_messages
  alter column conversation_id set not null;

create unique index order_messages_idempotency_idx
  on order_messages(idempotency_key)
  where idempotency_key is not null;
create unique index order_messages_provider_event_idx
  on order_messages(provider, provider_event_id)
  where provider is not null and provider_event_id is not null;
create index order_messages_conversation_created_idx
  on order_messages(conversation_id, created_at, id);
create index order_conversations_inbox_idx
  on order_conversations(status, admin_unread, last_message_at desc, id desc);

create table message_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  order_message_id uuid not null unique references order_messages(id) on delete cascade,
  status message_delivery_job_status not null default 'pending',
  idempotency_key text not null unique,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (idempotency_key <> ''),
  check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  )
);

create index message_delivery_jobs_ready_idx
  on message_delivery_jobs(next_attempt_at, created_at)
  where status in ('pending', 'retryable');

create table messaging_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  payload_hash text not null,
  status messaging_webhook_status not null default 'received',
  order_message_id uuid references order_messages(id) on delete set null,
  error_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, provider_event_id),
  check (provider <> ''),
  check (provider_event_id <> ''),
  check (payload_hash ~ '^[a-f0-9]{64}$')
);

create trigger order_conversations_set_updated_at
before update on order_conversations
for each row execute function set_updated_at();

create trigger message_delivery_jobs_set_updated_at
before update on message_delivery_jobs
for each row execute function set_updated_at();

update refund_effects
set status = 'pending',
    next_attempt_at = coalesce(next_attempt_at, now())
where effect_type = 'customer_notification'
  and requested
  and status = 'unsupported';
