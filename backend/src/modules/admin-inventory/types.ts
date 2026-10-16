export type InventoryActor = {
  authSubject: string;
  userId: string;
};

export type InventoryStockFilter = "all" | "available" | "low" | "out";

export type InventoryListQuery = {
  fabricId?: string;
  listingId?: string;
  lowStockThreshold: number;
  search?: string;
  stock: InventoryStockFilter;
};

export type FabricCreateInput = {
  colorHex?: string | null;
  colorName?: string | null;
  material?: string | null;
  name: string;
  quantityOnHand: number;
  sku: string;
};

export type FabricUpdateInput = {
  colorHex?: string | null;
  colorName?: string | null;
  material?: string | null;
  name?: string;
  sku?: string;
  status?: "active" | "archived";
};

export type FabricAdjustmentInput = {
  deltaOnHand: number;
  reason: string;
};

export type FabricListingLinkInput = {
  active: boolean;
  isDefault: boolean;
  sortOrder: number;
};

export type FabricRestockInput = {
  orderItemId: string;
  quantity: number;
  reason: string;
  usableUnitsConfirmed: true;
};

export type InventoryMutationResult<T> = {
  replayed: boolean;
  value: T;
};
