create unique index carts_one_active_authenticated_user_idx
  on carts(authenticated_user_id)
  where authenticated_user_id is not null
    and status = 'active';
