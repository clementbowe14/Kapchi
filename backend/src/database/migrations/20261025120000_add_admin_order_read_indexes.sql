create index orders_admin_created_idx
  on orders(created_at desc, id desc);

create index orders_admin_payment_created_idx
  on orders(payment_status, created_at desc, id desc);

create index orders_admin_fulfillment_created_idx
  on orders(fulfillment_status, created_at desc, id desc);

create index order_items_admin_fabric_order_idx
  on order_items(fabric_id, order_id)
  where fabric_id is not null;
