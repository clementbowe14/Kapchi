create type order_fulfillment_status as enum (
  'queued',
  'in_progress',
  'ready_to_ship',
  'partially_shipped',
  'shipped',
  'completed',
  'cancelled'
);

create type shipment_status as enum (
  'label_pending',
  'label_purchased',
  'in_transit',
  'delivered',
  'completed',
  'voided',
  'failed'
);

alter table orders
  add column fulfillment_queued_at timestamptz,
  add column ready_to_ship_at timestamptz,
  add column shipped_at timestamptz,
  add column completed_at timestamptz;

create table order_fulfillments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  fulfillment_number integer not null default 1 check (fulfillment_number > 0),
  status order_fulfillment_status not null default 'queued',
  assigned_to_user_id text,
  due_at timestamptz,
  ready_to_ship_at timestamptz,
  shipped_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  order_snapshot jsonb not null,
  shipping_name_snapshot text,
  shipping_address_snapshot jsonb not null,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, fulfillment_number),
  check (jsonb_typeof(order_snapshot) = 'object'),
  check (jsonb_typeof(shipping_address_snapshot) = 'object'),
  check (jsonb_typeof(metadata) = 'object'),
  check (status <> 'ready_to_ship' or ready_to_ship_at is not null),
  check (status not in ('shipped', 'completed') or shipped_at is not null),
  check (status <> 'completed' or completed_at is not null),
  check (status <> 'cancelled' or cancelled_at is not null)
);

create table order_fulfillment_items (
  id uuid primary key default gen_random_uuid(),
  fulfillment_id uuid not null references order_fulfillments(id) on delete cascade,
  order_item_id uuid not null references order_items(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  item_snapshot jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fulfillment_id, order_item_id),
  check (jsonb_typeof(item_snapshot) = 'object'),
  check (jsonb_typeof(metadata) = 'object')
);

create table shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  fulfillment_id uuid references order_fulfillments(id) on delete set null,
  shipment_number integer not null default 1 check (shipment_number > 0),
  status shipment_status not null default 'label_pending',
  carrier text,
  carrier_service text,
  tracking_number text,
  tracking_url text,
  postage_amount_cents integer check (postage_amount_cents is null or postage_amount_cents >= 0),
  currency char(3) not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  package_weight_ounces numeric(10, 2) check (package_weight_ounces is null or package_weight_ounces > 0),
  package_length_inches numeric(10, 2) check (package_length_inches is null or package_length_inches > 0),
  package_width_inches numeric(10, 2) check (package_width_inches is null or package_width_inches > 0),
  package_height_inches numeric(10, 2) check (package_height_inches is null or package_height_inches > 0),
  package_description text,
  ship_from_snapshot jsonb,
  ship_to_name_snapshot text,
  ship_to_address_snapshot jsonb not null,
  label_provider text,
  label_provider_shipment_id text,
  label_url text,
  label_file_object_key text,
  label_purchased_at timestamptz,
  label_voided_at timestamptz,
  export_batch_id text,
  exported_at timestamptz,
  imported_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  completed_at timestamptz,
  label_metadata jsonb not null default '{}'::jsonb,
  export_metadata jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, shipment_number),
  check (tracking_url is null or tracking_url ~* '^https?://'),
  check (jsonb_typeof(ship_from_snapshot) = 'object' or ship_from_snapshot is null),
  check (jsonb_typeof(ship_to_address_snapshot) = 'object'),
  check (jsonb_typeof(label_metadata) = 'object'),
  check (jsonb_typeof(export_metadata) = 'object'),
  check (jsonb_typeof(metadata) = 'object'),
  check (status <> 'label_purchased' or label_purchased_at is not null),
  check (status not in ('in_transit', 'delivered', 'completed') or shipped_at is not null),
  check (status not in ('delivered', 'completed') or delivered_at is not null),
  check (status <> 'completed' or completed_at is not null),
  check (status <> 'voided' or label_voided_at is not null)
);

create table shipment_items (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references shipments(id) on delete cascade,
  order_item_id uuid not null references order_items(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  item_snapshot jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (shipment_id, order_item_id),
  check (jsonb_typeof(item_snapshot) = 'object'),
  check (jsonb_typeof(metadata) = 'object')
);

create index order_fulfillments_order_idx
  on order_fulfillments(order_id, created_at);
create index order_fulfillments_queue_idx
  on order_fulfillments(status, due_at, created_at)
  where status in ('queued', 'in_progress', 'ready_to_ship');
create index order_fulfillments_assignee_idx
  on order_fulfillments(assigned_to_user_id, status, due_at)
  where assigned_to_user_id is not null
    and status in ('queued', 'in_progress', 'ready_to_ship');

create index orders_fulfillment_queue_idx
  on orders(fulfillment_status, paid_at, created_at)
  where payment_status = 'paid'
    and fulfillment_status in ('queued', 'in_progress', 'ready_to_ship');
create index orders_shipment_completion_idx
  on orders(shipped_at, completed_at)
  where shipped_at is not null or completed_at is not null;

create index order_fulfillment_items_fulfillment_idx
  on order_fulfillment_items(fulfillment_id);
create index order_fulfillment_items_order_item_idx
  on order_fulfillment_items(order_item_id);

create index shipments_order_idx
  on shipments(order_id, created_at);
create index shipments_fulfillment_idx
  on shipments(fulfillment_id, created_at)
  where fulfillment_id is not null;
create index shipments_shipping_queue_idx
  on shipments(status, label_purchased_at, exported_at, created_at)
  where status in ('label_pending', 'label_purchased');
create index shipments_tracking_idx
  on shipments(carrier, tracking_number)
  where tracking_number is not null;
create index shipments_export_batch_idx
  on shipments(export_batch_id, exported_at)
  where export_batch_id is not null;
create index shipments_shipped_at_idx
  on shipments(shipped_at)
  where shipped_at is not null;

create index shipment_items_shipment_idx
  on shipment_items(shipment_id);
create index shipment_items_order_item_idx
  on shipment_items(order_item_id);

create trigger order_fulfillments_set_updated_at
before update on order_fulfillments
for each row execute function set_updated_at();

create trigger order_fulfillment_items_set_updated_at
before update on order_fulfillment_items
for each row execute function set_updated_at();

create trigger shipments_set_updated_at
before update on shipments
for each row execute function set_updated_at();
