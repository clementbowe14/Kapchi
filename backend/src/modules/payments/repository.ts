import type { Pool, PoolClient } from "pg";
import { getDatabasePool } from "../../database/index.js";
import type { CheckoutOrderItemRow, CheckoutOrderRow } from "./types.js";

export class PaymentsRepository {
  constructor(private readonly pool: Pick<Pool, "connect"> = getDatabasePool()) {}

  async withTransaction<T>(callback: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const result = await callback(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async findOrderForCheckout(client: PoolClient, orderId: string) {
    const result = await client.query<CheckoutOrderRow>(
      `
        select
          id,
          status,
          payment_status,
          customer_email,
          subtotal_cents,
          shipping_cents,
          tax_cents,
          discount_cents,
          total_cents,
          currency
        from orders
        where id = $1
        for update
      `,
      [orderId],
    );

    return result.rows[0] ?? null;
  }

  async findOrderItemsForCheckout(client: PoolClient, orderId: string) {
    const result = await client.query<CheckoutOrderItemRow>(
      `
        select
          id,
          order_id,
          quantity,
          unit_amount_cents,
          total_amount_cents,
          currency,
          listing_snapshot
        from order_items
        where order_id = $1
        order by created_at asc, id asc
      `,
      [orderId],
    );

    return result.rows;
  }

  async markCheckoutStarted(
    client: PoolClient,
    input: {
      checkoutExpiresAt: Date | null;
      orderId: string;
      stripeCheckoutSessionId: string;
      stripeCustomerId: string | null;
    },
  ) {
    await client.query(
      `
        update orders
        set
          payment_status = 'checkout_started',
          stripe_checkout_session_id = $2,
          stripe_customer_id = $3,
          checkout_expires_at = $4,
          updated_at = now()
        where id = $1
      `,
      [
        input.orderId,
        input.stripeCheckoutSessionId,
        input.stripeCustomerId,
        input.checkoutExpiresAt
      ],
    );
  }
}
