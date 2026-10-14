-- Shared fabric availability and audited inventory operations.

create table fabric_inventory_events (
  id uuid primary key default gen_random_uuid(),
  fabric_id uuid not null references fabrics(id) on delete restrict,
  listing_id uuid references listings(id) on delete set null,
  order_item_id uuid references order_items(id) on delete set null,
  event_type text not null,
  source text not null,
  actor_user_id uuid references users(id) on delete restrict,
  actor_auth_subject text,
  idempotency_key text unique,
  request_fingerprint text,
  delta_on_hand integer not null default 0,
  delta_sold integer not null default 0,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (event_type in (
    'fabric_created',
    'fabric_updated',
    'fabric_archived',
    'listing_linked',
    'stock_adjusted',
    'return_restocked',
    'payment_consumed'
  )),
  check (source in ('admin', 'system')),
  check (jsonb_typeof(metadata) = 'object'),
  check (
    (source = 'admin' and actor_user_id is not null and actor_auth_subject is not null)
    or (source = 'system' and actor_user_id is null and actor_auth_subject is null)
  ),
  check (
    (idempotency_key is null and request_fingerprint is null)
    or (idempotency_key is not null and idempotency_key <> '' and request_fingerprint is not null)
  )
);

create index fabric_inventory_events_fabric_idx
  on fabric_inventory_events(fabric_id, created_at desc);
create index fabric_inventory_events_order_item_idx
  on fabric_inventory_events(order_item_id, created_at desc)
  where order_item_id is not null;
create index fabric_inventory_events_actor_idx
  on fabric_inventory_events(actor_user_id, created_at desc)
  where actor_user_id is not null;

create view fabric_inventory_availability as
select
  f.id,
  f.sku,
  f.name,
  f.color_name,
  f.color_hex,
  f.material,
  f.status,
  f.quantity_on_hand,
  f.quantity_reserved as stored_reserved_quantity,
  f.quantity_sold,
  coalesce(reservations.order_reserved_quantity, 0)::integer
    as order_reserved_quantity,
  coalesce(reservations.cart_held_quantity, 0)::integer
    as cart_held_quantity,
  (
    coalesce(reservations.order_reserved_quantity, 0)
    + coalesce(reservations.cart_held_quantity, 0)
  )::integer as counted_reserved_quantity,
  greatest(
    f.quantity_on_hand
      - coalesce(reservations.order_reserved_quantity, 0)
      - coalesce(reservations.cart_held_quantity, 0),
    0
  )::integer as available_quantity,
  f.created_at,
  f.updated_at
from fabrics f
left join lateral (
  select
    coalesce(sum(fr.quantity) filter (where fr.order_id is not null), 0)
      as order_reserved_quantity,
    coalesce(sum(fr.quantity) filter (
      where fr.order_id is null and fr.cart_id is not null
    ), 0) as cart_held_quantity
  from fabric_reservations fr
  where fr.fabric_id = f.id
    and fr.status = 'active'
    and fr.expires_at > now()
) reservations on true;
