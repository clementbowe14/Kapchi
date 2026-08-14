alter table carts
  add column revision integer not null default 0
    check (revision >= 0);

create table cart_add_idempotency_keys (
  cart_id uuid not null references carts(id) on delete cascade,
  idempotency_key text not null,
  request_fingerprint char(64) not null,
  cart_item_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (cart_id, idempotency_key),
  check (length(idempotency_key) between 1 and 128),
  check (request_fingerprint ~ '^[0-9a-f]{64}$')
);

comment on column cart_add_idempotency_keys.cart_item_id is
  'Historical response identifier; intentionally retained after the cart item is deleted.';
