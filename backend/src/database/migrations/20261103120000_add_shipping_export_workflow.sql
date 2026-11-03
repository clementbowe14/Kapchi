-- Durable, provider-neutral shipping export workflow for Pirate Ship CSV batches.

alter table orders
  add column shipping_address_status text not null default 'missing',
  add column shipping_address_issue_code text,
  add constraint orders_shipping_address_status_check
    check (shipping_address_status in ('valid', 'missing', 'invalid')),
  add constraint orders_shipping_address_issue_check
    check (
      shipping_address_status <> 'valid' or shipping_address_issue_code is null
    ) not valid;

update orders
set shipping_address_status = case
      when nullif(btrim(shipping_name), '') is not null
        and nullif(btrim(shipping_address->>'line1'), '') is not null
        and nullif(btrim(shipping_address->>'city'), '') is not null
        and shipping_address->>'state' ~ '^[A-Za-z]{2}$'
        and shipping_address->>'postalCode' ~ '^\d{5}(-\d{4})?$'
        and upper(shipping_address->>'country') = 'US'
      then 'valid'
      else 'missing'
    end,
    shipping_address_issue_code = case
      when nullif(btrim(shipping_name), '') is not null
        and nullif(btrim(shipping_address->>'line1'), '') is not null
        and nullif(btrim(shipping_address->>'city'), '') is not null
        and shipping_address->>'state' ~ '^[A-Za-z]{2}$'
        and shipping_address->>'postalCode' ~ '^\d{5}(-\d{4})?$'
        and upper(shipping_address->>'country') = 'US'
      then null
      else 'ADDRESS_NOT_COLLECTED'
    end;

alter table orders validate constraint orders_shipping_address_issue_check;

create table shipping_export_batches (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'pirate_ship' check (provider = 'pirate_ship'),
  format text not null default 'csv' check (format = 'csv'),
  mapping_version smallint not null default 1 check (mapping_version = 1),
  status text not null default 'prepared'
    check (status in ('prepared', 'cancelled', 'expired')),
  actor_user_id uuid not null references users(id) on delete restrict,
  actor_auth_subject text not null check (actor_auth_subject <> ''),
  request_id text not null check (request_id <> ''),
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  row_count integer not null check (row_count between 1 and 100),
  file_sha256 text not null check (file_sha256 ~ '^[a-f0-9]{64}$'),
  file_size_bytes integer not null check (file_size_bytes between 1 and 1048576),
  issued_count integer not null default 0 check (issued_count >= 0),
  first_issued_at timestamptz,
  last_issued_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 days'),
  cancelled_at timestamptz,
  purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, idempotency_key_hash),
  check (expires_at > created_at),
  check (status <> 'cancelled' or cancelled_at is not null),
  check (status <> 'expired' or purged_at is not null)
);

create table shipping_export_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references shipping_export_batches(id) on delete restrict,
  order_id uuid not null references orders(id) on delete restrict,
  shipment_id uuid not null references shipments(id) on delete restrict,
  row_number integer not null check (row_number between 1 and 100),
  row_snapshot jsonb,
  row_sha256 text not null check (row_sha256 ~ '^[a-f0-9]{64}$'),
  reconciliation_token_hash text not null
    check (reconciliation_token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (batch_id, order_id),
  unique (batch_id, shipment_id),
  unique (batch_id, row_number),
  unique (batch_id, order_id, shipment_id),
  check (row_snapshot is null or jsonb_typeof(row_snapshot) = 'object')
);

create table shipping_export_active_memberships (
  order_id uuid primary key references orders(id) on delete restrict,
  shipment_id uuid not null unique references shipments(id) on delete restrict,
  batch_id uuid not null references shipping_export_batches(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (batch_id, order_id, shipment_id)
    references shipping_export_batch_items(batch_id, order_id, shipment_id)
    on delete restrict
);

create table shipping_export_mutation_receipts (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references shipping_export_batches(id) on delete restrict,
  command text not null check (command in ('cancel', 'release')),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  source_audit_event_id uuid not null references admin_audit_events(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (batch_id, command, idempotency_key)
);

alter table shipments
  add column active_shipping_export_batch_id uuid
    references shipping_export_batches(id) on delete restrict;

create index shipments_active_shipping_export_batch_idx
  on shipments(active_shipping_export_batch_id)
  where active_shipping_export_batch_id is not null;
create index shipping_export_batches_status_expiry_idx
  on shipping_export_batches(status, expires_at, created_at);
create index shipping_export_batches_actor_idx
  on shipping_export_batches(actor_user_id, created_at desc);
create index shipping_export_batch_items_order_idx
  on shipping_export_batch_items(order_id, created_at desc);
create index shipping_export_batch_items_shipment_idx
  on shipping_export_batch_items(shipment_id, created_at desc);
create index shipping_export_receipts_batch_idx
  on shipping_export_mutation_receipts(batch_id, created_at desc);

alter table admin_order_mutation_receipts
  drop constraint admin_order_mutation_receipts_command_check,
  add constraint admin_order_mutation_receipts_command_check
    check (command in ('confirm_shipment', 'correct_shipping_address'));

create trigger shipping_export_batches_set_updated_at
before update on shipping_export_batches
for each row execute function set_updated_at();

create trigger shipping_export_active_memberships_set_updated_at
before update on shipping_export_active_memberships
for each row execute function set_updated_at();

comment on column shipments.export_batch_id is
  'Legacy free-form export identifier. New shipping exports use active_shipping_export_batch_id.';
comment on column shipping_export_batch_items.row_snapshot is
  'Minimal immutable CSV row snapshot. Purged after 30 days; never regenerated from order data.';
