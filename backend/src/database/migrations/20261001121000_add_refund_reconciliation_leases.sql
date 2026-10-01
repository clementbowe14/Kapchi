alter table refund_operations
  add column last_reconciliation_error_code text,
  add column reconciliation_lease_owner text,
  add column reconciliation_lease_expires_at timestamptz,
  add constraint refund_operations_reconciliation_lease_pair
    check (
      (reconciliation_lease_owner is null and reconciliation_lease_expires_at is null)
      or
      (reconciliation_lease_owner is not null and reconciliation_lease_expires_at is not null)
    );

