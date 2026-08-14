export type PreferredContactMethod = "email" | "phone";

export type CartValidationStatus =
  | "valid"
  | "invalid"
  | "needs_reprice"
  | "unavailable";

export type CartCustomizationSummary = {
  fontOptionId: string | null;
  imageAssetId: string | null;
  line1: string;
  line2: string;
  trimOptionId: string | null;
};

export type CartLine = {
  cartItemId: string;
  currency: string;
  customizationSetId: string;
  customizationSummary: CartCustomizationSummary;
  fabricId: string | null;
  listingId: string;
  listingPriceVariantId: string;
  listingSlug: string;
  quantity: number;
  title: string;
  unitAmountCents: number;
  validationMessage?: string | null;
  validationStatus: CartValidationStatus;
};

export type CartWarning = {
  cartItemId: string;
  message: string;
  status: Exclude<CartValidationStatus, "valid">;
};

export type CartView = {
  cartId?: string;
  items: CartLine[];
  subtotalCents: number;
  warnings: CartWarning[];
};

export type CheckoutSessionResult = {
  checkoutSessionId?: string;
  checkoutSessionToken?: string;
  orderId: string;
  paymentStatus: string;
  publicOrderNumber?: string;
  url: string;
};

export type CheckoutStatusResult = {
  orderId: string;
  orderStatus?: string;
  paymentStatus: string;
  publicOrderNumber: string;
};

export type CheckoutFieldErrors = {
  email?: string;
  phone?: string;
};

export class CheckoutApiError extends Error {
  code: string;
  responseBody: Record<string, unknown>;
  status: number;

  constructor(
    code: string,
    status: number,
    message: string,
    responseBody: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CheckoutApiError";
    this.code = code;
    this.responseBody = responseBody;
    this.status = status;
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+0-9().\-\s]+$/;
const STRIPE_CHECKOUT_HOST = "checkout.stripe.com";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCartValidationStatus(value: unknown): value is CartValidationStatus {
  return (
    value === "valid" ||
    value === "invalid" ||
    value === "needs_reprice" ||
    value === "unavailable"
  );
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseCartLine(value: unknown): CartLine {
  if (!isRecord(value)) {
    throw new Error("Invalid cart response.");
  }

  const cartItemId = stringValue(value.cartItemId);
  const quantity = numberValue(value.quantity);
  const unitAmountCents = numberValue(value.unitAmountCents);
  const validationStatus = value.validationStatus;

  if (
    !cartItemId ||
    quantity === null ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    unitAmountCents === null ||
    !Number.isInteger(unitAmountCents) ||
    unitAmountCents < 0 ||
    !isCartValidationStatus(validationStatus)
  ) {
    throw new Error("Invalid cart response.");
  }

  const customizationSummary = isRecord(value.customizationSummary)
    ? value.customizationSummary
    : {};
  const customizationSetId = stringValue(value.customizationSetId);
  const listingId = stringValue(value.listingId);
  const listingPriceVariantId = stringValue(value.listingPriceVariantId);

  if (!customizationSetId || !listingId || !listingPriceVariantId) {
    throw new Error("Invalid cart response.");
  }

  return {
    cartItemId,
    currency: stringValue(value.currency, "USD"),
    customizationSetId,
    customizationSummary: {
      fontOptionId:
        typeof customizationSummary.fontOptionId === "string" ||
        customizationSummary.fontOptionId === null
          ? customizationSummary.fontOptionId
          : null,
      imageAssetId:
        typeof customizationSummary.imageAssetId === "string" ||
        customizationSummary.imageAssetId === null
          ? customizationSummary.imageAssetId
          : null,
      line1: stringValue(customizationSummary.line1),
      line2: stringValue(customizationSummary.line2),
      trimOptionId:
        typeof customizationSummary.trimOptionId === "string" ||
        customizationSummary.trimOptionId === null
          ? customizationSummary.trimOptionId
          : null,
    },
    fabricId: typeof value.fabricId === "string" ? value.fabricId : null,
    listingId,
    listingPriceVariantId,
    listingSlug: stringValue(value.listingSlug),
    quantity,
    title: stringValue(value.title, "Kapchi item"),
    unitAmountCents,
    validationMessage:
      typeof value.validationMessage === "string" ? value.validationMessage : null,
    validationStatus,
  };
}

export function buildCartItemMutation(line: CartLine, quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    throw new RangeError("Cart item quantity must be between 1 and 999.");
  }

  return {
    fabricId: line.fabricId,
    fontOptionId: line.customizationSummary.fontOptionId,
    imageAssetId: line.customizationSummary.imageAssetId,
    line1: line.customizationSummary.line1,
    line2: line.customizationSummary.line2,
    listingCustomizationSetId: line.customizationSetId,
    listingId: line.listingId,
    listingPriceVariantId: line.listingPriceVariantId,
    quantity,
    trimOptionId: line.customizationSummary.trimOptionId,
  };
}

function parseCartWarning(value: unknown): CartWarning | null {
  if (!isRecord(value)) {
    return null;
  }

  const status = value.status;
  const cartItemId = stringValue(value.cartItemId);
  const message = stringValue(value.message);

  if (!cartItemId || !isCartValidationStatus(status)) {
    return null;
  }

  if (status === "valid") {
    return null;
  }

  return { cartItemId, message, status };
}

export function parseCartView(value: unknown): CartView {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error("Invalid cart response.");
  }

  const subtotalCents = numberValue(value.subtotalCents);

  if (
    subtotalCents === null ||
    !Number.isInteger(subtotalCents) ||
    subtotalCents < 0
  ) {
    throw new Error("Invalid cart response.");
  }

  return {
    cartId: typeof value.cartId === "string" ? value.cartId : undefined,
    items: value.items.map(parseCartLine),
    subtotalCents,
    warnings: Array.isArray(value.warnings)
      ? value.warnings.map(parseCartWarning).filter((warning) => warning !== null)
      : [],
  };
}

export function cartNeedsReview(cart: CartView) {
  return (
    cart.warnings.length > 0 ||
    cart.items.some((item) => item.validationStatus !== "valid")
  );
}

export function getCartLineIssue(cart: CartView, line: CartLine) {
  const warning = cart.warnings.find(
    (candidate) => candidate.cartItemId === line.cartItemId,
  );

  if (warning?.message) {
    return warning.message;
  }

  if (line.validationMessage) {
    return line.validationMessage;
  }

  switch (warning?.status ?? line.validationStatus) {
    case "needs_reprice":
      return "The price for this item changed. Remove it and add it again to continue.";
    case "unavailable":
      return "This item is no longer available. Remove it to continue.";
    case "invalid":
      return "This item's customization needs review. Remove it and add it again to continue.";
    default:
      return null;
  }
}

export function formatCheckoutMoney(cents: number, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", {
      currency: currency.toUpperCase(),
      style: "currency",
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function validateCheckoutContact({
  customerEmail,
  customerPhone,
  isSignedIn,
  preferredContactMethod,
}: {
  customerEmail: string;
  customerPhone: string;
  isSignedIn: boolean;
  preferredContactMethod: PreferredContactMethod;
}): CheckoutFieldErrors {
  const errors: CheckoutFieldErrors = {};
  const email = customerEmail.trim();
  const phone = customerPhone.trim();

  if (!email) {
    errors.email = "Enter your email address.";
  } else if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    errors.email = "Enter a valid email address.";
  }

  const phoneRequired = !isSignedIn || preferredContactMethod === "phone";
  const phoneDigits = phone.replace(/\D/g, "");

  if (phoneRequired && !phone) {
    errors.phone = "Enter your phone number.";
  } else if (
    phone &&
    (phone.length > 64 ||
      phoneDigits.length < 7 ||
      phoneDigits.length > 15 ||
      !PHONE_PATTERN.test(phone) ||
      (phone.includes("+") && !phone.startsWith("+")) ||
      phone.split("+").length > 2)
  ) {
    errors.phone = "Enter a valid phone number with at least 7 digits.";
  }

  return errors;
}

export function getSafeHostedCheckoutUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (host !== STRIPE_CHECKOUT_HOST &&
        !host.endsWith(`.${STRIPE_CHECKOUT_HOST}`))
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

export async function readCheckoutApiError(response: Response) {
  let body: Record<string, unknown> = {};

  try {
    const value: unknown = await response.json();
    if (isRecord(value)) {
      body = value;
    }
  } catch {
    // The status code still provides a safe fallback when the body is absent.
  }

  const code = stringValue(body.error, `HTTP_${response.status}`);
  const message = stringValue(body.message, "The request could not be completed.");
  return new CheckoutApiError(code, response.status, message, body);
}

export function checkoutErrorMessage(error: unknown) {
  if (error instanceof CheckoutApiError) {
    switch (error.code) {
      case "CART_NOT_FOUND":
        return "Your cart is empty or has expired. Add an item before checking out.";
      case "CART_NEEDS_REVIEW":
        return "Your cart changed and needs review. Check the affected items below.";
      case "CHECKOUT_ALREADY_COMPLETE":
        return "This checkout may already be complete. Check its payment status before trying again.";
      case "CHECKOUT_PROVIDER_ERROR":
        return "Stripe is temporarily unavailable. Your details are still here, so you can try again.";
      case "CHECKOUT_CATALOG_UNAVAILABLE":
        return "Secure checkout is unavailable for one or more items. Please contact Kapchi support.";
      case "CART_CLAIM_CONFLICT":
        return "We could not merge your guest cart with your account. Your account cart has been loaded instead.";
      case "VALIDATION_ERROR":
        return "Check your contact details and try again.";
      case "INVALID_CHECKOUT_URL":
        return "We could not open secure checkout. Refresh your cart and try again.";
      case "UNAUTHORIZED":
      case "FORBIDDEN":
        return "Your account session could not be verified. Sign in again and retry.";
    }

    if (error.status === 502 || error.status >= 500) {
      return "Checkout is temporarily unavailable. Your details are still here, so you can try again.";
    }
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return "Checkout took too long to respond. Your details are still here, so you can try again.";
  }

  return "We could not reach checkout. Check your connection and try again.";
}

export function isRetryableCheckoutError(error: unknown) {
  if (error instanceof CheckoutApiError) {
    if (
      error.code === "INVALID_CHECKOUT_URL" ||
      error.code === "CHECKOUT_CATALOG_UNAVAILABLE"
    ) {
      return false;
    }

    return (
      error.code === "CHECKOUT_PROVIDER_ERROR" ||
      error.status === 408 ||
      error.status === 429 ||
      error.status === 502 ||
      error.status >= 500
    );
  }

  return true;
}
