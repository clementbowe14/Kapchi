-- Guard admin lifecycle commands with optimistic concurrency.

alter table orders
  add column revision integer not null default 0,
  add constraint orders_revision_nonnegative check (revision >= 0);

comment on column orders.revision is
  'Incremented once for every accepted admin lifecycle mutation.';
