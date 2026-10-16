import type { Permission, Role } from "../../types/auth.js";

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value === "string" && value.length > 0) {
    return [value];
  }

  return [];
}

export function normalizeStoreRoles(claims: Record<string, unknown>): Role[] {
  return Array.from(
    new Set([
      ...readStringArray(claims.roles),
      ...readStringArray(claims.role),
      ...readStringArray((claims.metadata as Record<string, unknown> | undefined)?.roles),
      ...readStringArray((claims.public_metadata as Record<string, unknown> | undefined)?.roles)
    ]),
  );
}

export function normalizePermissions(
  claims: Record<string, unknown>,
): Permission[] {
  return Array.from(
    new Set([
      ...readStringArray(claims.permissions),
      ...readStringArray(
        (claims.metadata as Record<string, unknown> | undefined)?.permissions,
      ),
      ...readStringArray(
        (claims.public_metadata as Record<string, unknown> | undefined)?.permissions,
      )
    ]),
  );
}
