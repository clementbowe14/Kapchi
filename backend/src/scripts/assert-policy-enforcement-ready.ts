import { closeDatabasePool, getDatabasePool } from "../database/index.js";
import { CheckoutRepository } from "../modules/payments/checkout-repository.js";
import {
  enforceLegacyPolicySessions,
  type LegacyPolicyEnforcementStore
} from "../modules/payments/legacy-policy-enforcement.js";
import { createStripeClient } from "../modules/payments/stripe-client.js";

type LegacyPolicyRow = {
  id: string;
  stripe_checkout_session_id: string;
};

function parseExpirationMode(arguments_: string[]) {
  if (arguments_.length === 0) {
    return false;
  }
  if (arguments_.length === 1 && arguments_[0] === "--expire") {
    return true;
  }
  return null;
}

async function main() {
  const expire = parseExpirationMode(process.argv.slice(2));
  if (expire === null) {
    console.error(JSON.stringify({
      event: "checkout.policy.enforcement_preflight",
      resultCode: "INVALID_ARGUMENT"
    }));
    process.exitCode = 2;
    return;
  }

  const pool = getDatabasePool();
  const repository = new CheckoutRepository(pool);
  const store: LegacyPolicyEnforcementStore = {
    async listSessionBearingOrdersWithoutEvidence() {
      const result = await pool.query<LegacyPolicyRow>(
        `
          select o.id, o.stripe_checkout_session_id
          from orders o
          left join order_policy_assertions opa on opa.order_id = o.id
          where opa.order_id is null
            and o.status = 'pending_payment'
            and o.payment_status in ('unpaid', 'checkout_started', 'failed')
            and o.stripe_checkout_session_id is not null
          order by o.created_at asc, o.id asc
        `,
      );
      return result.rows.map((row) => ({
        orderId: row.id,
        stripeCheckoutSessionId: row.stripe_checkout_session_id
      }));
    },
    retireExpiredSession(orderId, session) {
      return repository.retireTerminalCheckout(
        orderId,
        session,
        "provider_session_expired",
      );
    }
  };

  try {
    const stripe = expire ? createStripeClient() : null;
    const result = await enforceLegacyPolicySessions({
      expire,
      ...(stripe
        ? {
            provider: {
              async expire(sessionId: string) {
                await stripe.checkout.sessions.expire(sessionId);
              },
              async retrieve(sessionId: string) {
                const session = await stripe.checkout.sessions.retrieve(sessionId);
                return {
                  expiresAt:
                    typeof session.expires_at === "number"
                      ? new Date(session.expires_at * 1000)
                      : null,
                  id: session.id,
                  paymentStatus: session.payment_status,
                  status: session.status
                };
              }
            }
          }
        : {}),
      store
    });

    console.info(JSON.stringify({
      event: "checkout.policy.enforcement_preflight",
      mode: expire ? "expire" : "read_only",
      ...result
    }));
    if (result.resultCode !== "READY") {
      process.exitCode = 1;
    }
  } catch {
    console.error(JSON.stringify({
      event: "checkout.policy.enforcement_preflight",
      mode: expire ? "expire" : "read_only",
      resultCode: "CHECK_FAILED"
    }));
    process.exitCode = 1;
  } finally {
    await closeDatabasePool();
  }
}

await main();
