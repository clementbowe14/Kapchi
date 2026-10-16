export {
  ADMIN_CAPABILITIES,
  ADMIN_CAPABILITY_MATRIX,
  STORE_ADMIN_ROLE,
  hasAdminCapability,
  hasStoreAdminRole,
  type AdminCapability
} from "./capabilities.js";
export { adminRoute, requireAdminCapability } from "./guards.js";
