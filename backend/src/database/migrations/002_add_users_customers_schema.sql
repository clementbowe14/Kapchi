-- Depends on 001_create_commerce_schema.sql for pgcrypto, set_updated_at(),
-- commerce tables, and preferred_contact_method.

create table users (
  id uuid primary key default gen_random_uuid(),
  auth_provider text not null default 'clerk',
  auth_subject text not null,
  email text,
  phone text,
  display_name text,
  avatar_url text,
  disabled_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (auth_provider, auth_subject),
  check (auth_provider <> ''),
  check (auth_subject <> ''),
  check (email is null or email = lower(email)),
  check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  check (phone is null or phone <> ''),
  check (display_name is null or display_name <> ''),
  check (avatar_url is null or avatar_url <> '')
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  email text,
  phone text,
  full_name text,
  preferred_contact_method preferred_contact_method,
  stripe_customer_id text unique,
  first_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_id is not null or email is not null or phone is not null or stripe_customer_id is not null),
  check (email is null or email = lower(email)),
  check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  check (phone is null or phone <> ''),
  check (full_name is null or full_name <> ''),
  check (stripe_customer_id is null or stripe_customer_id <> ''),
  check (
    preferred_contact_method is null
    or (preferred_contact_method = 'email' and email is not null)
    or (preferred_contact_method in ('sms', 'phone') and phone is not null)
  )
);

create table customer_contacts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  label text,
  contact_name text,
  email text,
  phone text,
  preferred_contact_method preferred_contact_method,
  is_primary boolean not null default false,
  accepts_marketing boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, customer_id),
  check (email is not null or phone is not null),
  check (email is null or email = lower(email)),
  check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  check (phone is null or phone <> ''),
  check (label is null or label <> ''),
  check (contact_name is null or contact_name <> ''),
  check (
    preferred_contact_method is null
    or (preferred_contact_method = 'email' and email is not null)
    or (preferred_contact_method in ('sms', 'phone') and phone is not null)
  )
);

alter table carts
  add column authenticated_user_id uuid references users(id) on delete set null,
  add column customer_id uuid references customers(id) on delete set null,
  add column customer_contact_id uuid,
  add constraint carts_customer_contact_fkey
    foreign key (customer_contact_id, customer_id)
    references customer_contacts(id, customer_id)
    on delete set null (customer_contact_id);

alter table uploaded_assets
  add column authenticated_user_id uuid references users(id) on delete set null;

alter table orders
  add column authenticated_user_id uuid references users(id) on delete set null,
  add column customer_id uuid references customers(id) on delete set null,
  add column customer_contact_id uuid,
  add constraint orders_customer_contact_fkey
    foreign key (customer_contact_id, customer_id)
    references customer_contacts(id, customer_id)
    on delete set null (customer_contact_id);

alter table order_events
  add column actor_user_id uuid references users(id) on delete set null;

alter table order_messages
  add column sender_authenticated_user_id uuid references users(id) on delete set null;

create index users_email_idx
  on users(email)
  where email is not null;
create index users_phone_idx
  on users(phone)
  where phone is not null;
create index users_created_at_idx
  on users(created_at);

create unique index customers_one_per_user_idx
  on customers(user_id)
  where user_id is not null;
create index customers_email_idx
  on customers(email)
  where email is not null;
create index customers_phone_idx
  on customers(phone)
  where phone is not null;
create index customers_preferred_contact_idx
  on customers(preferred_contact_method)
  where preferred_contact_method is not null;
create index customers_created_at_idx
  on customers(created_at);

create unique index customer_contacts_primary_idx
  on customer_contacts(customer_id)
  where is_primary;
create index customer_contacts_customer_idx
  on customer_contacts(customer_id, created_at);
create index customer_contacts_email_idx
  on customer_contacts(email)
  where email is not null;
create index customer_contacts_phone_idx
  on customer_contacts(phone)
  where phone is not null;

create index carts_authenticated_user_idx
  on carts(authenticated_user_id, status)
  where authenticated_user_id is not null;
create index carts_customer_idx
  on carts(customer_id, status)
  where customer_id is not null;
create index carts_customer_contact_idx
  on carts(customer_contact_id)
  where customer_contact_id is not null;

create index uploaded_assets_authenticated_user_idx
  on uploaded_assets(authenticated_user_id, created_at)
  where authenticated_user_id is not null;

create index orders_authenticated_user_idx
  on orders(authenticated_user_id, created_at)
  where authenticated_user_id is not null;
create index orders_customer_idx
  on orders(customer_id, created_at)
  where customer_id is not null;
create index orders_customer_contact_idx
  on orders(customer_contact_id)
  where customer_contact_id is not null;

create index order_events_actor_user_idx
  on order_events(actor_user_id, created_at)
  where actor_user_id is not null;

create index order_messages_sender_authenticated_user_idx
  on order_messages(sender_authenticated_user_id, created_at)
  where sender_authenticated_user_id is not null;

create trigger users_set_updated_at
before update on users
for each row execute function set_updated_at();

create trigger customers_set_updated_at
before update on customers
for each row execute function set_updated_at();

create trigger customer_contacts_set_updated_at
before update on customer_contacts
for each row execute function set_updated_at();
