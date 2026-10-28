import { AdminOrderError } from "./errors.js";
import type {
  AdminOrderMutationCommand,
  FulfillmentStatus,
  OrderStatus,
  PaymentStatus
} from "./types.js";

export type AdminOrderLifecycleState = {
  fulfillmentStatus: FulfillmentStatus;
  orderStatus: OrderStatus;
  paidAt: string | null;
  paymentStatus: PaymentStatus;
};

export type AdminOrderLifecycleTarget = {
  eventType: "order.production_started" | "order.ready_to_ship";
  fulfillmentStatus: FulfillmentStatus;
  orderStatus: OrderStatus;
};

const paidStatuses = new Set<PaymentStatus>(["paid", "partially_refunded"]);

function transitionConflict(
  command: AdminOrderMutationCommand,
  state: AdminOrderLifecycleState,
) {
  throw new AdminOrderError(
    "ORDER_TRANSITION_NOT_ALLOWED",
    `The ${command} command is not allowed from order status ${state.orderStatus}, payment status ${state.paymentStatus}, and fulfillment status ${state.fulfillmentStatus}.`,
    409,
  );
}

export function resolveAdminOrderTransition(
  command: AdminOrderMutationCommand,
  state: AdminOrderLifecycleState,
): AdminOrderLifecycleTarget {
  if (!paidStatuses.has(state.paymentStatus) || state.paidAt === null) {
    transitionConflict(command, state);
  }

  if (command === "start_production") {
    if (state.orderStatus !== "paid" || state.fulfillmentStatus !== "queued") {
      transitionConflict(command, state);
    }
    return {
      eventType: "order.production_started",
      fulfillmentStatus: "in_progress",
      orderStatus: "in_production"
    };
  }

  if (
    state.orderStatus !== "in_production" ||
    state.fulfillmentStatus !== "in_progress"
  ) {
    transitionConflict(command, state);
  }
  return {
    eventType: "order.ready_to_ship",
    fulfillmentStatus: "ready_to_ship",
    orderStatus: "ready_to_ship"
  };
}
