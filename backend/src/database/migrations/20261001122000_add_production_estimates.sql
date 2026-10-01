create table listing_production_estimate_rules (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null,
  listing_customization_set_id uuid not null,
  priority_code varchar(32) not null,
  label varchar(80) not null,
  minimum_business_days integer not null,
  maximum_business_days integer not null,
  revision integer not null,
  is_default boolean not null default false,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  deactivated_at timestamptz,
  foreign key (listing_customization_set_id, listing_id)
    references listing_customization_sets(id, listing_id) on delete cascade,
  unique (listing_customization_set_id, priority_code, revision),
  check (priority_code ~ '^[a-z][a-z0-9_]{0,31}$'),
  check (btrim(label) <> ''),
  check (minimum_business_days >= 0),
  check (maximum_business_days >= minimum_business_days),
  check (revision > 0),
  check (sort_order >= 0),
  check (not is_default or active),
  check ((active and deactivated_at is null) or (not active and deactivated_at is not null))
);

create unique index listing_production_estimate_rules_active_code_idx
  on listing_production_estimate_rules(listing_customization_set_id, priority_code)
  where active;

create unique index listing_production_estimate_rules_active_default_idx
  on listing_production_estimate_rules(listing_customization_set_id)
  where active and is_default;

create index listing_production_estimate_rules_listing_idx
  on listing_production_estimate_rules(listing_id, listing_customization_set_id, sort_order)
  where active;

create function enforce_production_estimate_rule_revision_immutability()
returns trigger as $$
begin
  if old.active = true
    and new.active = false
    and new.is_default = false
    and new.deactivated_at is not null
    and new.id is not distinct from old.id
    and new.listing_id is not distinct from old.listing_id
    and new.listing_customization_set_id is not distinct from old.listing_customization_set_id
    and new.priority_code is not distinct from old.priority_code
    and new.label is not distinct from old.label
    and new.minimum_business_days is not distinct from old.minimum_business_days
    and new.maximum_business_days is not distinct from old.maximum_business_days
    and new.revision is not distinct from old.revision
    and new.sort_order is not distinct from old.sort_order
    and new.created_at is not distinct from old.created_at
  then
    return new;
  end if;

  raise exception 'production estimate rule revisions are immutable; deactivate and insert a new revision';
end;
$$ language plpgsql;

create trigger listing_production_estimate_rules_enforce_revision_immutability
before update on listing_production_estimate_rules
for each row execute function enforce_production_estimate_rule_revision_immutability();

alter table cart_items
  add column production_priority_code varchar(32),
  add column production_estimate_snapshot jsonb,
  add constraint cart_items_production_estimate_pair_check check (
    (production_priority_code is null) = (production_estimate_snapshot is null)
  ),
  add constraint cart_items_production_estimate_object_check check (
    production_estimate_snapshot is null
    or jsonb_typeof(production_estimate_snapshot) = 'object'
  ),
  add constraint cart_items_production_priority_code_check check (
    production_priority_code is null
    or production_priority_code ~ '^[a-z][a-z0-9_]{0,31}$'
  ),
  add constraint cart_items_production_estimate_code_check check (
    production_estimate_snapshot is null
    or production_priority_code = production_estimate_snapshot ->> 'priorityCode'
  );

alter table order_items
  add column production_priority_code varchar(32),
  add column production_estimate_snapshot jsonb,
  add constraint order_items_production_estimate_pair_check check (
    (production_priority_code is null) = (production_estimate_snapshot is null)
  ),
  add constraint order_items_production_estimate_object_check check (
    production_estimate_snapshot is null
    or jsonb_typeof(production_estimate_snapshot) = 'object'
  ),
  add constraint order_items_production_priority_code_check check (
    production_priority_code is null
    or production_priority_code ~ '^[a-z][a-z0-9_]{0,31}$'
  ),
  add constraint order_items_production_estimate_code_check check (
    production_estimate_snapshot is null
    or production_priority_code = production_estimate_snapshot ->> 'priorityCode'
  );
