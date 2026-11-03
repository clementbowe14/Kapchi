-- Durable receipt ledger for intent-specific admin order commands.

create table admin_order_mutation_receipts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  command text not null check (command = 'confirm_shipment'),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  source_event_id uuid not null references order_events(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (order_id, idempotency_key)
);

create index admin_order_mutation_receipts_source_event_idx
  on admin_order_mutation_receipts(source_event_id);
