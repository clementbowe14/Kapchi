create table assets (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'vercel_blob',
  storage_key text,
  url text,
  content_type text not null,
  byte_size integer not null check (byte_size >= 0),
  checksum text,
  visibility text not null default 'private',
  context text not null,
  status text not null default 'pending',
  authenticated_user_id uuid references users(id) on delete set null,
  created_by_auth_subject text,
  cart_id uuid references carts(id) on delete set null,
  listing_id uuid references listings(id) on delete set null,
  listing_customization_set_id uuid references listing_customization_sets(id) on delete set null,
  fabric_id uuid references fabrics(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (provider <> ''),
  check (storage_key is null or storage_key <> ''),
  check (url is null or url <> ''),
  check (content_type ~ '^image/(jpeg|png|webp)$'),
  check (visibility in ('private', 'public_catalog')),
  check (context in ('customization_image', 'catalog_listing_image', 'fabric_image')),
  check (status in ('pending', 'uploaded', 'attached', 'discarded', 'quarantined')),
  check (context <> 'customization_image' or visibility = 'private'),
  check (jsonb_typeof(metadata) = 'object'),
  check (
    status = 'pending'
    or (storage_key is not null and url is not null)
  )
);

create unique index assets_provider_storage_key_idx
  on assets(provider, storage_key)
  where storage_key is not null;
create index assets_cart_context_idx
  on assets(cart_id, context, created_at)
  where cart_id is not null;
create index assets_listing_context_idx
  on assets(listing_id, context, created_at)
  where listing_id is not null;
create index assets_listing_customization_context_idx
  on assets(listing_customization_set_id, context, created_at)
  where listing_customization_set_id is not null;
create index assets_fabric_context_idx
  on assets(fabric_id, context, created_at)
  where fabric_id is not null;
create index assets_authenticated_user_idx
  on assets(authenticated_user_id, created_at)
  where authenticated_user_id is not null;
create index assets_auth_subject_idx
  on assets(created_by_auth_subject, created_at)
  where created_by_auth_subject is not null;

alter table cart_items
  add column customization_asset_id uuid references assets(id) on delete set null;

alter table order_items
  add column customization_asset_id uuid references assets(id) on delete set null;

create index cart_items_customization_asset_idx
  on cart_items(customization_asset_id)
  where customization_asset_id is not null;
create index order_items_customization_asset_idx
  on order_items(customization_asset_id)
  where customization_asset_id is not null;

create trigger assets_set_updated_at
before update on assets
for each row execute function set_updated_at();
