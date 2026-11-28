alter table orders
  add column guest_analytics_digest text,
  add constraint orders_guest_analytics_digest_format_check
    check (guest_analytics_digest ~ '^[0-9a-f]{64}$');

create index orders_guest_analytics_digest_created_at_idx
  on orders (guest_analytics_digest, created_at)
  where guest_analytics_digest is not null;
