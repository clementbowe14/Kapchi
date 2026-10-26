-- Preserve purchased customization artwork and durably audit private reads.

alter table order_items
  drop constraint if exists order_items_customization_asset_id_fkey;

alter table order_items
  add constraint order_items_customization_asset_id_fkey
  foreign key (customization_asset_id) references assets(id) on delete restrict;

create type private_asset_access_outcome as enum (
  'denied',
  'failed',
  'opened'
);

create type private_asset_delivery_status as enum (
  'not_started',
  'streaming',
  'completed',
  'aborted',
  'failed'
);

create table admin_private_asset_access_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references users(id) on delete restrict,
  actor_auth_subject text not null,
  order_id uuid not null,
  order_item_id uuid not null,
  asset_id uuid,
  request_id text not null,
  disposition text not null,
  outcome private_asset_access_outcome not null,
  reason_code text,
  delivery_status private_asset_delivery_status not null default 'not_started',
  bytes_sent integer not null default 0 check (bytes_sent >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (actor_auth_subject <> ''),
  check (request_id <> ''),
  check (disposition in ('inline', 'attachment')),
  check (reason_code is null or reason_code <> '')
);

create index admin_private_asset_access_actor_idx
  on admin_private_asset_access_events(actor_user_id, created_at desc);
create index admin_private_asset_access_order_idx
  on admin_private_asset_access_events(order_id, order_item_id, created_at desc);
create index admin_private_asset_access_asset_idx
  on admin_private_asset_access_events(asset_id, created_at desc)
  where asset_id is not null;
create index admin_private_asset_access_request_idx
  on admin_private_asset_access_events(request_id);

create trigger admin_private_asset_access_set_updated_at
before update on admin_private_asset_access_events
for each row execute function set_updated_at();
