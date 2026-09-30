create index if not exists orders_currency_created_at_idx
  on orders(currency, created_at, id);

create index if not exists orders_paid_currency_created_at_idx
  on orders(currency, created_at, id)
  where payment_status in ('paid', 'partially_refunded', 'refunded');
