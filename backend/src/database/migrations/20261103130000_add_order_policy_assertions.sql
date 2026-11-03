create or replace function validate_order_policy_documents(value jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  document jsonb;
  document_key text;
  seen_keys text[] := array[]::text[];
begin
  if jsonb_typeof(value) <> 'array' or jsonb_array_length(value) <> 4 then
    return false;
  end if;

  for document in select element from jsonb_array_elements(value) element loop
    if jsonb_typeof(document) <> 'object'
      or (select count(*) from jsonb_object_keys(document)) <> 5 then
      return false;
    end if;

    document_key := document->>'key';
    if document_key is null
      or document_key = any(seen_keys)
      or document_key not in ('shipping', 'returns', 'privacy', 'terms')
      or document->>'role' is null
      or document->>'role' not in ('agreement', 'acknowledgment', 'notice')
      or (document_key = 'terms' and document->>'role' <> 'agreement')
      or (document_key = 'returns' and document->>'role' <> 'acknowledgment')
      or (document_key in ('shipping', 'privacy') and document->>'role' <> 'notice')
      or document->>'version' is null
      or length(document->>'version') not between 1 and 64
      or document->>'digest' is null
      or document->>'digest' !~ '^[a-f0-9]{64}$'
      or document->>'path' is null
      or length(document->>'path') not between 1 and 256
      or document->>'path' !~ '^/policies/' then
      return false;
    end if;

    seen_keys := array_append(seen_keys, document_key);
  end loop;

  return cardinality(seen_keys) = 4;
end;
$$;

create or replace function validate_order_policy_assertions(value jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
begin
  return jsonb_typeof(value) = 'object'
    and value = '{"returnsAcknowledged": true, "termsAgreed": true}'::jsonb;
end;
$$;

create table order_policy_assertions (
  order_id uuid primary key references orders(id) on delete restrict,
  schema_version smallint not null,
  bundle_version varchar(64) not null,
  effective_date date not null,
  checkout_statement_version varchar(64) not null,
  checkout_statement_digest char(64) not null,
  documents jsonb not null,
  assertions jsonb not null,
  statement_submitted_at timestamptz not null default clock_timestamp(),
  constraint order_policy_assertions_schema_version_check
    check (schema_version = 1),
  constraint order_policy_assertions_bundle_version_check
    check (length(bundle_version) between 1 and 64),
  constraint order_policy_assertions_statement_version_check
    check (length(checkout_statement_version) between 1 and 64),
  constraint order_policy_assertions_statement_digest_check
    check (checkout_statement_digest ~ '^[a-f0-9]{64}$'),
  constraint order_policy_assertions_documents_check
    check (validate_order_policy_documents(documents)),
  constraint order_policy_assertions_assertions_check
    check (validate_order_policy_assertions(assertions))
);

create or replace function reject_order_policy_assertion_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'order policy assertions are append-only'
    using errcode = '55000';
end;
$$;

create trigger order_policy_assertions_reject_update_or_delete
before update or delete on order_policy_assertions
for each row execute function reject_order_policy_assertion_change();
