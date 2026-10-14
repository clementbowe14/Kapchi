import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

export async function expireStaleFabricReservations(
  client: Queryable,
  fabricId?: string,
) {
  const result = await client.query<{
    expired_count: number | string;
    released_quantity: number | string;
  }>(
    `
      with expired as (
        update fabric_reservations
        set status = 'expired'
        where status = 'active'
          and expires_at <= now()
          and ($1::uuid is null or fabric_id = $1::uuid)
        returning fabric_id, quantity
      ), totals as (
        select fabric_id, sum(quantity)::integer as quantity
        from expired
        group by fabric_id
      ), updated_fabrics as (
        update fabrics f
        set quantity_reserved = greatest(0, f.quantity_reserved - totals.quantity)
        from totals
        where f.id = totals.fabric_id
        returning f.id
      )
      select
        count(*)::integer as expired_count,
        coalesce(sum(quantity), 0)::integer as released_quantity
      from expired
    `,
    [fabricId ?? null],
  );
  const row = result.rows[0];
  return {
    expiredCount: Number(row?.expired_count ?? 0),
    releasedQuantity: Number(row?.released_quantity ?? 0)
  };
}
