create extension if not exists pgcrypto;

create type listing_status as enum ('draft', 'active', 'archived');
create type listing_type as enum ('graduation_stole', 'accessory', 'other');

create type customization_kind as enum (
  'blank',
  'text_short',
  'text_long',
  'text_image',
  'text_image_trim'
);

create type fabric_status as enum ('active', 'archived');
create type fabric_reservation_status as enum ('active', 'released', 'converted', 'expired');

create type cart_status as enum ('active', 'checkout_started', 'converted', 'abandoned');
create type uploaded_asset_status as enum ('uploaded', 'attached', 'discarded', 'quarantined');
create type cart_item_validation_status as enum ('valid', 'invalid', 'needs_reprice', 'unavailable');

create type order_status as enum (
  'pending_payment',
  'paid',
  'in_production',
  'ready_to_ship',
  'shipped',
  'completed',
  'cancelled',
  'refunded'
);
create type payment_status as enum (
  'unpaid',
  'checkout_started',
  'paid',
  'failed',
  'refunded',
  'partially_refunded'
);
create type fulfillment_status as enum (
  'not_started',
  'queued',
  'in_progress',
  'ready_to_ship',
  'shipped',
  'delivered',
  'cancelled'
);
create type preferred_contact_method as enum ('email', 'sms', 'phone');
create type order_event_actor_type as enum ('customer', 'admin', 'system', 'stripe');

create type order_message_sender_type as enum ('customer', 'admin', 'system');
create type message_channel as enum ('email', 'sms', 'internal_note', 'system');
create type message_direction as enum ('inbound', 'outbound', 'internal');
create type message_status as enum ('draft', 'queued', 'sent', 'failed');

create table listings (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  subtitle text,
  description text,
  listing_type listing_type not null default 'other',
  status listing_status not null default 'draft',
  base_price_cents integer not null check (base_price_cents >= 0),
  currency char(3) not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  requires_fabric boolean not null default false,
  stripe_product_id text unique,
  default_stripe_price_id text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'archived') = (archived_at is not null) or status <> 'archived')
);

create table listing_images (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  image_url text not null,
  alt_text text,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create table customization_sets (
  id uuid primary key default gen_random_uuid(),
  kind customization_kind not null unique,
  label text not null,
  description text,
  requires_text boolean not null default false,
  requires_image boolean not null default false,
  requires_trim boolean not null default false,
  default_max_chars integer check (default_max_chars is null or default_max_chars > 0),
  created_at timestamptz not null default now()
);

create table listing_customization_sets (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  customization_set_id uuid not null references customization_sets(id),
  enabled boolean not null default true,
  price_delta_cents integer not null default 0,
  max_chars integer check (max_chars is null or max_chars > 0),
  min_chars integer not null default 0 check (min_chars >= 0),
  image_max_bytes integer check (image_max_bytes is null or image_max_bytes > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (listing_id, customization_set_id),
  unique (id, listing_id),
  check (max_chars is null or min_chars <= max_chars)
);

create table font_options (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  css_family text not null,
  preview_text text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table listing_customization_fonts (
  listing_customization_set_id uuid not null references listing_customization_sets(id) on delete cascade,
  font_option_id uuid not null references font_options(id),
  primary key (listing_customization_set_id, font_option_id)
);

create table trim_options (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color_name text,
  color_hex text check (color_hex is null or color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  price_delta_cents integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table listing_customization_trims (
  listing_customization_set_id uuid not null references listing_customization_sets(id) on delete cascade,
  trim_option_id uuid not null references trim_options(id),
  primary key (listing_customization_set_id, trim_option_id)
);

create table listing_price_variants (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  listing_customization_set_id uuid not null,
  trim_option_id uuid references trim_options(id),
  variant_key text not null,
  unit_amount_cents integer not null check (unit_amount_cents >= 0),
  currency char(3) not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  stripe_product_id text not null,
  stripe_price_id text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  replaced_at timestamptz,
  unique (id, listing_id, listing_customization_set_id),
  foreign key (listing_customization_set_id, listing_id)
    references listing_customization_sets(id, listing_id),
  check (variant_key <> ''),
  check ((active and replaced_at is null) or (not active))
);

create table fabrics (
  id uuid primary key default gen_random_uuid(),
  sku text unique,
  name text not null,
  color_name text,
  color_hex text check (color_hex is null or color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  material text,
  status fabric_status not null default 'active',
  quantity_on_hand integer not null default 0 check (quantity_on_hand >= 0),
  quantity_reserved integer not null default 0 check (quantity_reserved >= 0),
  quantity_sold integer not null default 0 check (quantity_sold >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (quantity_reserved <= quantity_on_hand)
);

create table listing_fabrics (
  listing_id uuid not null references listings(id) on delete cascade,
  fabric_id uuid not null references fabrics(id),
  active boolean not null default true,
  is_default boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (listing_id, fabric_id)
);

create table carts (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  guest_token_hash text,
  status cart_status not null default 'active',
  currency char(3) not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  subtotal_cents integer not null default 0 check (subtotal_cents >= 0),
  converted_order_id uuid,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_id is not null or guest_token_hash is not null)
);

create table uploaded_assets (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  cart_id uuid references carts(id) on delete cascade,
  object_key text not null unique,
  original_filename text,
  content_type text,
  byte_size integer check (byte_size is null or byte_size >= 0),
  status uploaded_asset_status not null default 'uploaded',
  created_at timestamptz not null default now(),
  check (user_id is not null or cart_id is not null)
);

create table cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references carts(id) on delete cascade,
  listing_id uuid not null references listings(id),
  listing_customization_set_id uuid not null,
  listing_price_variant_id uuid not null,
  fabric_id uuid,
  quantity integer not null check (quantity > 0),
  unit_amount_cents integer not null check (unit_amount_cents >= 0),
  currency char(3) not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  customization_payload jsonb not null default '{}'::jsonb,
  validation_status cart_item_validation_status not null default 'valid',
  validation_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (listing_customization_set_id, listing_id)
    references listing_customization_sets(id, listing_id),
  foreign key (listing_price_variant_id, listing_id, listing_customization_set_id)
    references listing_price_variants(id, listing_id, listing_customization_set_id),
  foreign key (listing_id, fabric_id)
    references listing_fabrics(listing_id, fabric_id),
  check (jsonb_typeof(customization_payload) = 'object')
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  public_order_number text not null unique,
  user_id text,
  cart_id uuid references carts(id) on delete set null,
  status order_status not null default 'pending_payment',
  payment_status payment_status not null default 'unpaid',
  fulfillment_status fulfillment_status not null default 'not_started',
  customer_email text,
  customer_phone text,
  preferred_contact_method preferred_contact_method,
  shipping_name text,
  shipping_address jsonb,
  subtotal_cents integer not null default 0 check (subtotal_cents >= 0),
  shipping_cents integer not null default 0 check (shipping_cents >= 0),
  tax_cents integer not null default 0 check (tax_cents >= 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  total_cents integer not null default 0 check (total_cents >= 0),
  currency char(3) not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  stripe_customer_id text,
  checkout_expires_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(shipping_address) = 'object' or shipping_address is null),
  check (total_cents = subtotal_cents + shipping_cents + tax_cents - discount_cents),
  check ((payment_status = 'paid') = (paid_at is not null) or payment_status <> 'paid'),
  check ((status = 'cancelled') = (cancelled_at is not null) or status <> 'cancelled')
);

alter table carts
  add constraint carts_converted_order_id_fkey
  foreign key (converted_order_id) references orders(id) on delete set null;

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  listing_id uuid references listings(id) on delete set null,
  listing_price_variant_id uuid references listing_price_variants(id) on delete set null,
  fabric_id uuid references fabrics(id) on delete set null,
  quantity integer not null check (quantity > 0),
  unit_amount_cents integer not null check (unit_amount_cents >= 0),
  total_amount_cents integer not null check (total_amount_cents >= 0),
  currency char(3) not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  stripe_product_id text,
  stripe_price_id text,
  listing_snapshot jsonb not null,
  fabric_snapshot jsonb,
  customization_snapshot jsonb not null default '{}'::jsonb,
  production_notes text,
  created_at timestamptz not null default now(),
  check (total_amount_cents = unit_amount_cents * quantity),
  check (jsonb_typeof(listing_snapshot) = 'object'),
  check (jsonb_typeof(fabric_snapshot) = 'object' or fabric_snapshot is null),
  check (jsonb_typeof(customization_snapshot) = 'object')
);

create table fabric_reservations (
  id uuid primary key default gen_random_uuid(),
  fabric_id uuid not null references fabrics(id),
  cart_id uuid references carts(id) on delete set null,
  cart_item_id uuid references cart_items(id) on delete set null,
  order_id uuid references orders(id) on delete set null,
  order_item_id uuid references order_items(id) on delete set null,
  quantity integer not null check (quantity > 0),
  status fabric_reservation_status not null default 'active',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cart_id is not null or order_id is not null),
  check (status <> 'active' or expires_at is not null)
);

create table order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  actor_type order_event_actor_type not null,
  actor_id text,
  event_type text not null,
  from_value text,
  to_value text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (event_type <> ''),
  check (jsonb_typeof(metadata) = 'object')
);

create table order_messages (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  sender_type order_message_sender_type not null,
  sender_user_id text,
  channel message_channel not null,
  direction message_direction not null,
  status message_status not null default 'draft',
  to_address text,
  from_address text,
  subject text,
  body text not null,
  provider text,
  provider_message_id text,
  provider_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  check (body <> ''),
  check (direction <> 'internal' or channel = 'internal_note')
);

insert into customization_sets (
  kind,
  label,
  description,
  requires_text,
  requires_image,
  requires_trim,
  default_max_chars
) values
  ('blank', 'Blank', 'Non-personalized item.', false, false, false, null),
  ('text_short', 'Short text', 'Short text personalization.', true, false, false, 40),
  ('text_long', 'Long text', 'Longer text personalization.', true, false, false, 120),
  ('text_image', 'Text and image', 'Text personalization with uploaded image.', true, true, false, 120),
  ('text_image_trim', 'Text, image, and trim', 'Text personalization with uploaded image and trim.', true, true, true, 120);

create unique index listing_images_primary_idx
  on listing_images(listing_id)
  where is_primary;
create index listing_images_listing_sort_idx
  on listing_images(listing_id, sort_order);

create index listings_active_idx
  on listings(status, listing_type);
create index listings_stripe_product_idx
  on listings(stripe_product_id)
  where stripe_product_id is not null;

create index listing_customization_sets_listing_idx
  on listing_customization_sets(listing_id, enabled, sort_order);
create index font_options_active_idx
  on font_options(active, name);
create index trim_options_active_idx
  on trim_options(active, name);

create unique index listing_price_variants_active_key_idx
  on listing_price_variants(listing_id, variant_key)
  where active;
create index listing_price_variants_listing_active_idx
  on listing_price_variants(listing_id, active);

create index fabrics_status_idx
  on fabrics(status, name);
create index listing_fabrics_listing_idx
  on listing_fabrics(listing_id, active, sort_order);
create unique index listing_fabrics_default_idx
  on listing_fabrics(listing_id)
  where is_default;

create index carts_user_active_idx
  on carts(user_id, status)
  where user_id is not null;
create index carts_guest_active_idx
  on carts(guest_token_hash, status)
  where guest_token_hash is not null;
create unique index carts_one_active_user_idx
  on carts(user_id)
  where status = 'active' and user_id is not null;
create unique index carts_one_active_guest_idx
  on carts(guest_token_hash)
  where status = 'active' and guest_token_hash is not null;

create index uploaded_assets_user_idx
  on uploaded_assets(user_id, created_at)
  where user_id is not null;
create index uploaded_assets_cart_idx
  on uploaded_assets(cart_id, created_at)
  where cart_id is not null;

create index cart_items_cart_idx
  on cart_items(cart_id);
create index cart_items_listing_idx
  on cart_items(listing_id);
create index cart_items_validation_idx
  on cart_items(validation_status);

create index orders_lookup_email_idx
  on orders(public_order_number, customer_email);
create index orders_lookup_phone_idx
  on orders(public_order_number, customer_phone);
create index orders_status_idx
  on orders(status, fulfillment_status, created_at);
create index orders_user_idx
  on orders(user_id, created_at)
  where user_id is not null;

create index order_items_order_idx
  on order_items(order_id);
create index order_items_listing_idx
  on order_items(listing_id)
  where listing_id is not null;

create index fabric_reservations_active_idx
  on fabric_reservations(fabric_id, status, expires_at);
create index fabric_reservations_cart_idx
  on fabric_reservations(cart_id, status)
  where cart_id is not null;
create index fabric_reservations_order_idx
  on fabric_reservations(order_id, status)
  where order_id is not null;
create unique index fabric_reservations_active_cart_item_idx
  on fabric_reservations(cart_item_id)
  where status = 'active' and cart_item_id is not null;

create index order_events_order_idx
  on order_events(order_id, created_at);
create index order_events_type_idx
  on order_events(event_type, created_at);

create index order_messages_order_idx
  on order_messages(order_id, created_at);
create index order_messages_status_idx
  on order_messages(status, created_at);
create unique index order_messages_provider_message_idx
  on order_messages(provider, provider_message_id)
  where provider is not null and provider_message_id is not null;

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger listings_set_updated_at
before update on listings
for each row execute function set_updated_at();

create trigger listing_customization_sets_set_updated_at
before update on listing_customization_sets
for each row execute function set_updated_at();

create trigger font_options_set_updated_at
before update on font_options
for each row execute function set_updated_at();

create trigger trim_options_set_updated_at
before update on trim_options
for each row execute function set_updated_at();

create trigger fabrics_set_updated_at
before update on fabrics
for each row execute function set_updated_at();

create trigger carts_set_updated_at
before update on carts
for each row execute function set_updated_at();

create trigger cart_items_set_updated_at
before update on cart_items
for each row execute function set_updated_at();

create trigger orders_set_updated_at
before update on orders
for each row execute function set_updated_at();

create trigger fabric_reservations_set_updated_at
before update on fabric_reservations
for each row execute function set_updated_at();
