create unique index orders_one_open_checkout_per_cart_idx
  on orders(cart_id)
  where cart_id is not null
    and status = 'pending_payment'
    and payment_status in ('unpaid', 'checkout_started');
