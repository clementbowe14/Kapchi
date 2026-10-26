import type { AuthContext } from "../../types/auth.js";

export const STORE_ADMIN_ROLE = "admin";

export const ADMIN_CAPABILITY_MATRIX = {
  "assets:read": {
    access: "read",
    resources: [
      "catalog assets",
      "private customization asset metadata",
      "private customization asset content"
    ]
  },
  "assets:write": {
    access: "write",
    resources: ["catalog listing images", "fabric images"]
  },
  "customers:read": {
    access: "read",
    resources: ["customer profiles", "customer contacts"]
  },
  "fulfillment:write": {
    access: "write",
    resources: ["fulfillment status", "tracking details"]
  },
  "inventory:read": {
    access: "read",
    resources: ["fabric pools", "inventory reservations"]
  },
  "inventory:write": {
    access: "write",
    resources: ["fabric pools", "stock adjustments", "listing fabric links"]
  },
  "messages:write": {
    access: "write",
    resources: ["order messages", "customer notifications"]
  },
  "order-notes:write": {
    access: "write",
    resources: ["internal order notes"]
  },
  "orders:read": {
    access: "read",
    resources: ["orders", "order items", "order exports", "nested order resources"]
  },
  "promotions:write": {
    access: "write",
    resources: ["promotions", "promotion eligibility"]
  },
  "refunds:write": {
    access: "write",
    resources: ["refund requests", "refund reconciliation"]
  },
  "reports:read": {
    access: "read",
    resources: ["sales analytics", "admin exports"]
  }
} as const;

export type AdminCapability = keyof typeof ADMIN_CAPABILITY_MATRIX;

export const ADMIN_CAPABILITIES = Object.freeze(
  Object.keys(ADMIN_CAPABILITY_MATRIX) as AdminCapability[],
);

export function hasStoreAdminRole(auth: AuthContext | null | undefined) {
  return auth?.roles.includes(STORE_ADMIN_ROLE) === true;
}

export function hasAdminCapability(
  auth: AuthContext | null | undefined,
  capability: AdminCapability,
) {
  return hasStoreAdminRole(auth) && capability in ADMIN_CAPABILITY_MATRIX;
}
