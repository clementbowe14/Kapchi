"use client";

import Image from "next/image";
import Link from "next/link";
import { ImageIcon, ShoppingCart, Type, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CustomizationImageUpload } from "./CustomizationImageUpload";
import { buildApiUrl } from "@/lib/api";
import { publishCartInvalidation } from "@/lib/cart-state";
import { parseCartView, readCheckoutApiError } from "@/lib/checkout";
import type {
  CustomizationPackage,
  GraduationStoleDetail,
  ListingMedia,
} from "@/lib/listings";

export const CUSTOMIZATION_POLICY_NOTICE =
  "Only customizations included in your selected package will be produced. Requests for unpaid additions will be rejected; update your package before checkout.";
const CART_REQUEST_TIMEOUT_MS = 15_000;
const PRODUCTION_ESTIMATE_QUALIFIER =
  "This is an estimate, not a guaranteed delivery date. Shipping time is additional; weekends, holidays, destination, and carrier delays may affect timing.";

function createIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type ConfiguratorState = {
  fabricId: string | null;
  fontId: string | null;
  imageAssetId: string | null;
  imageName: string | null;
  packageId: string | null;
  priorityCode: string | null;
  text: string;
  trimId: string | null;
};

type Action =
  | { package: CustomizationPackage; type: "select_package" }
  | { type: "select_fabric"; value: string }
  | { type: "set_font"; value: string }
  | {
      type: "set_image";
      value: { assetId: string; filename: string } | null;
    }
  | { type: "set_text"; value: string }
  | { type: "set_priority"; value: string }
  | { type: "set_trim"; value: string };

export const initialConfiguratorState: ConfiguratorState = {
  fabricId: null,
  fontId: null,
  imageAssetId: null,
  imageName: null,
  packageId: null,
  priorityCode: null,
  text: "",
  trimId: null,
};

function initializeConfiguratorState(
  listing: GraduationStoleDetail,
): ConfiguratorState {
  const defaultFabric = listing.fabrics.find(
    (fabric) => fabric.availability.status !== "unavailable",
  );

  return {
    ...initialConfiguratorState,
    fabricId: defaultFabric?.id ?? null,
  };
}

export function configuratorReducer(
  state: ConfiguratorState,
  action: Action,
): ConfiguratorState {
  switch (action.type) {
    case "select_package":
      return {
        ...state,
        fontId:
          action.package.capabilities.text &&
          action.package.fonts.some((font) => font.id === state.fontId)
            ? state.fontId
            : null,
        imageAssetId:
          action.package.capabilities.image && action.package.id === state.packageId
            ? state.imageAssetId
            : null,
        imageName:
          action.package.capabilities.image && action.package.id === state.packageId
            ? state.imageName
            : null,
        packageId: action.package.id,
        priorityCode:
          action.package.productionPriorities.find((option) => option.isDefault)
            ?.code ?? null,
        text: action.package.capabilities.text ? state.text : "",
        trimId:
          action.package.capabilities.trim &&
          action.package.trims.some((trim) => trim.id === state.trimId)
            ? state.trimId
            : null,
      };
    case "select_fabric":
      return { ...state, fabricId: action.value };
    case "set_font":
      return { ...state, fontId: action.value };
    case "set_image":
      return {
        ...state,
        imageAssetId: action.value?.assetId ?? null,
        imageName: action.value?.filename ?? null,
      };
    case "set_text":
      return { ...state, text: action.value };
    case "set_priority":
      return { ...state, priorityCode: action.value };
    case "set_trim":
      return { ...state, trimId: action.value };
  }
}

function formatMoney(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    currency,
    style: "currency",
  }).format(cents / 100);
}

async function fetchCart(input: RequestInfo | URL, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    CART_REQUEST_TIMEOUT_MS,
  );

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function ProductGallery({ images, title }: { images: ListingMedia[]; title: string }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeImage = images[activeIndex] ?? null;

  return (
    <section aria-label={`${title} images`} className="min-w-0">
      <div className="relative aspect-[4/5] overflow-hidden bg-slate-100">
        {activeImage ? (
          <Image
            alt={activeImage.alt ?? title}
            className="object-cover"
            fill
            priority
            sizes="(min-width: 1024px) 52vw, 100vw"
            src={activeImage.url}
            unoptimized={activeImage.url.startsWith("http")}
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-[#b49872]/10 text-sm font-semibold text-[#8f734f]">
            Kapchi
          </div>
        )}
      </div>
      {images.length > 1 ? (
        <div className="mt-3 grid grid-cols-4 gap-3" role="group" aria-label="Choose product image">
          {images.map((image, index) => (
            <button
              aria-label={`Show image ${index + 1} of ${images.length}`}
              aria-pressed={activeIndex === index}
              className={`relative aspect-square overflow-hidden border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] ${
                activeIndex === index ? "border-[#8f734f]" : "border-transparent"
              }`}
              key={`${image.url}-${index}`}
              onClick={() => setActiveIndex(index)}
              type="button"
            >
              <Image
                alt=""
                className="object-cover"
                fill
                sizes="12vw"
                src={image.url}
                unoptimized={image.url.startsWith("http")}
              />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function availabilityLabel(status: string, quantity: number | null) {
  if (status === "unavailable") return "Unavailable";
  if (status === "low_stock") return quantity === null ? "Low stock" : `${quantity} left`;
  if (quantity !== null) return `${quantity} available`;
  return "Available";
}

export function StoleConfigurator({ listing }: { listing: GraduationStoleDetail }) {
  const [state, dispatch] = useReducer(
    configuratorReducer,
    listing,
    initializeConfiguratorState,
  );
  const [addState, setAddState] = useState<"idle" | "adding" | "success">("idle");
  const [addError, setAddError] = useState("");
  const [guestCartId, setGuestCartId] = useState<string | null>(null);
  const [guestCartState, setGuestCartState] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const addGuard = useRef(false);
  const guestCartPreparation = useRef<Promise<string | null> | null>(null);
  const pendingAdd = useRef<{ idempotencyKey: string; payloadKey: string } | null>(
    null,
  );
  const selectedPackage =
    listing.customizationPackages.find((item) => item.id === state.packageId) ?? null;
  const selectedVariant = useMemo(() => {
    if (!selectedPackage) return null;

    if (selectedPackage.capabilities.trim) {
      if (!state.trimId) return null;

      const exactVariant = selectedPackage.priceVariants.find(
        (variant) => variant.trimOptionId === state.trimId,
      );
      if (exactVariant) return exactVariant;

      const hasTrimSpecificPricing = selectedPackage.priceVariants.some(
        (variant) => variant.trimOptionId !== null,
      );
      return hasTrimSpecificPricing
        ? null
        : (selectedPackage.priceVariants.find(
            (variant) => variant.trimOptionId === null,
          ) ?? null);
    }

    return (
      selectedPackage.priceVariants.find(
        (variant) => variant.trimOptionId === null,
      ) ?? selectedPackage.priceVariants[0] ?? null
    );
  }, [selectedPackage, state.trimId]);
  const selectedPriority =
    selectedPackage?.productionPriorities.find(
      (option) => option.code === state.priorityCode,
    ) ?? null;
  const listingGallery = listing.gallery.length
    ? listing.gallery
    : listing.primaryImage
      ? [listing.primaryImage]
      : [];
  const selectedFabric = listing.fabrics.find(
    (fabric) => fabric.id === state.fabricId,
  );
  const gallery = selectedFabric?.image
    ? [
        selectedFabric.image,
        ...listingGallery.filter(
          (image) => image.url !== selectedFabric.image?.url,
        ),
      ]
    : listingGallery;
  const configurationError = (() => {
    if (!state.fabricId) return "Choose an available fabric.";
    if (!selectedPackage) return "Choose a customization level.";
    if (!selectedPriority) {
      return "This customization option is temporarily unavailable because we can't calculate its production time. Choose another option or contact Kapchi.";
    }
    if (!selectedVariant) return "Finish choosing this customization.";

    const textLength = Array.from(state.text).length;
    if (
      selectedPackage.requirements.text &&
      textLength < Math.max(1, selectedPackage.limits.minChars ?? 0)
    ) {
      return "Enter the text for your stole.";
    }
    if (selectedPackage.requirements.image && !state.imageAssetId) {
      return "Upload the image for your stole.";
    }
    if (selectedPackage.requirements.trim && !state.trimId) {
      return "Choose a trim for your stole.";
    }

    return null;
  })();
  const addPayload =
    selectedPackage && selectedVariant && selectedPriority
      ? {
          fabricId: state.fabricId,
          fontOptionId: state.fontId,
          imageAssetId: state.imageAssetId,
          line1: state.text.trim(),
          line2: "",
          listingCustomizationSetId: selectedPackage.id,
          listingId: listing.id,
          listingPriceVariantId: selectedVariant.id,
          priorityCode: selectedPriority.code,
          quantity: 1,
          trimOptionId: state.trimId,
        }
      : null;
  const addPayloadKey = addPayload ? JSON.stringify(addPayload) : "";

  useEffect(() => {
    pendingAdd.current = null;
  }, [addPayloadKey]);

  async function prepareGuestCart() {
    if (guestCartId) return guestCartId;
    if (guestCartPreparation.current) return guestCartPreparation.current;

    setGuestCartState("loading");
    const preparation = (async () => {
      try {
        const response = await fetchCart(buildApiUrl("/cart/"), {
          cache: "no-store",
          credentials: "include",
        });
        if (!response.ok) throw await readCheckoutApiError(response);

        const cart = parseCartView(await response.json());
        if (!cart.cartId) {
          throw new Error("Cart response did not include an identifier.");
        }

        setGuestCartId(cart.cartId);
        setGuestCartState("idle");
        return cart.cartId;
      } catch {
        setGuestCartState("error");
        return null;
      }
    })();

    guestCartPreparation.current = preparation;
    try {
      return await preparation;
    } finally {
      if (guestCartPreparation.current === preparation) {
        guestCartPreparation.current = null;
      }
    }
  }

  function selectPackage(customizationPackage: CustomizationPackage) {
    dispatch({ package: customizationPackage, type: "select_package" });
    setAddError("");
    setAddState("idle");
    if (customizationPackage.capabilities.image) {
      void prepareGuestCart();
    }
  }

  async function addToCart() {
    if (addGuard.current || configurationError || !addPayload) return;

    addGuard.current = true;
    setAddError("");
    setAddState("adding");
    const attempt =
      pendingAdd.current?.payloadKey === addPayloadKey
        ? pendingAdd.current
        : { idempotencyKey: createIdempotencyKey(), payloadKey: addPayloadKey };
    pendingAdd.current = attempt;
    let outcomeIsAmbiguous = true;

    try {
      const response = await fetchCart(buildApiUrl("/cart/items"), {
        body: JSON.stringify(addPayload),
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.idempotencyKey,
        },
        method: "POST",
      });

      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          outcomeIsAmbiguous = false;
          pendingAdd.current = null;
        }
        throw await readCheckoutApiError(response);
      }

      outcomeIsAmbiguous = false;
      pendingAdd.current = null;
      publishCartInvalidation();
      setAddState("success");

      try {
        const cart = parseCartView(await response.json());
        if (cart.cartId) {
          setGuestCartId(cart.cartId);
        }
      } catch {
        // The 2xx confirms the mutation; the invalidation refreshes canonical state.
      }
    } catch {
      if (outcomeIsAmbiguous) {
        publishCartInvalidation();
      }
      setAddState("idle");
      setAddError(
        "We could not confirm that this item was added. Check your cart before trying again.",
      );
    } finally {
      addGuard.current = false;
    }
  }

  return (
    <main className="bg-white">
      <div className="mx-auto grid w-full max-w-7xl gap-10 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1.08fr)_minmax(22rem,0.92fr)] lg:px-8 lg:py-12">
        <ProductGallery
          images={gallery}
          key={state.fabricId ?? "listing-gallery"}
          title={listing.title}
        />

        <div className="min-w-0 space-y-8 lg:sticky lg:top-24 lg:self-start">
          <header className="border-b border-slate-200 pb-6">
            <p className="text-xs font-semibold uppercase text-[#8f734f]">Graduation stoles</p>
            <h1 className="mt-2 text-3xl font-semibold text-slate-950 sm:text-4xl">{listing.title}</h1>
            {listing.subtitle ? <p className="mt-3 text-lg text-slate-600">{listing.subtitle}</p> : null}
            {listing.description ? <p className="mt-4 text-sm leading-7 text-slate-600">{listing.description}</p> : null}
            <p className="mt-5 text-xl font-semibold text-[#8f734f]">
              From {formatMoney(listing.fromPriceCents, listing.currency)}
            </p>
          </header>

          <fieldset className="space-y-3">
            <legend className="text-lg font-semibold text-slate-950">Choose a fabric</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {listing.fabrics.map((fabric) => {
                const unavailable = fabric.availability.status === "unavailable";
                return (
                  <label
                    className={`grid cursor-pointer grid-cols-[4.5rem_1fr] overflow-hidden border bg-white focus-within:ring-2 focus-within:ring-[#b49872] ${
                      state.fabricId === fabric.id ? "border-[#8f734f]" : "border-slate-200"
                    } ${unavailable ? "cursor-not-allowed opacity-55" : ""}`}
                    key={fabric.id}
                  >
                    <span className="relative min-h-20 bg-slate-100">
                      {fabric.image ? (
                        <Image
                          alt={fabric.image.alt ?? `${fabric.name} fabric`}
                          className="object-cover"
                          fill
                          sizes="72px"
                          src={fabric.image.url}
                          unoptimized={fabric.image.url.startsWith("http")}
                        />
                      ) : (
                        <span
                          aria-label={`${fabric.name} color swatch`}
                          className="block h-full min-h-20"
                          role="img"
                          style={{ backgroundColor: fabric.colorHex ?? "#e2e8f0" }}
                        />
                      )}
                    </span>
                    <span className="flex min-w-0 items-start gap-2 p-3">
                      <input
                        checked={state.fabricId === fabric.id}
                        disabled={unavailable}
                        name="fabric"
                        onChange={() => dispatch({ type: "select_fabric", value: fabric.id })}
                        type="radio"
                        value={fabric.id}
                      />
                      <span className="min-w-0">
                        <span className="block font-semibold text-slate-900">{fabric.name}</span>
                        {fabric.materialDescription ? <span className="mt-1 block text-xs text-slate-500">{fabric.materialDescription}</span> : null}
                        <span className="mt-1 block text-xs font-medium text-slate-600">
                          {availabilityLabel(fabric.availability.status, fabric.availability.availableQuantity)}
                        </span>
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-lg font-semibold text-slate-950">Choose your customization</legend>
            <div className="grid gap-3">
              {listing.customizationPackages.map((customizationPackage) => {
                const amounts = customizationPackage.priceVariants.map((variant) => variant.unitAmountCents);
                const fromAmount = amounts.length ? Math.min(...amounts) : null;
                return (
                  <label
                    className={`flex cursor-pointer items-start gap-3 border p-4 focus-within:ring-2 focus-within:ring-[#b49872] ${
                      state.packageId === customizationPackage.id ? "border-[#8f734f] bg-[#b49872]/5" : "border-slate-200"
                    }`}
                    key={customizationPackage.id}
                  >
                    <input
                      checked={state.packageId === customizationPackage.id}
                      name="customization-package"
                      onChange={() => selectPackage(customizationPackage)}
                      type="radio"
                      value={customizationPackage.id}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap justify-between gap-2">
                        <span className="font-semibold text-slate-950">{customizationPackage.name}</span>
                        {fromAmount !== null ? <span className="font-semibold text-[#8f734f]">{formatMoney(fromAmount, listing.currency)}</span> : null}
                      </span>
                      <span className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
                        {customizationPackage.capabilities.text ? <span>Text</span> : null}
                        {customizationPackage.capabilities.image ? <span>Image</span> : null}
                        {customizationPackage.capabilities.trim ? <span>Trim</span> : null}
                        {!customizationPackage.capabilities.text && !customizationPackage.capabilities.image && !customizationPackage.capabilities.trim ? <span>No customization</span> : null}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {selectedPackage ? (
            selectedPackage.productionPriorities.length ? (
              <fieldset
                aria-describedby="production-estimate-qualifier"
                className="space-y-3 border-t border-slate-200 pt-6"
              >
                <legend className="text-lg font-semibold text-slate-950">
                  Choose production priority
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {selectedPackage.productionPriorities.map((priority) => (
                    <label
                      className={`flex min-h-12 cursor-pointer items-center justify-between gap-3 border px-4 py-3 focus-within:ring-2 focus-within:ring-[#b49872] ${
                        state.priorityCode === priority.code
                          ? "border-[#8f734f] bg-[#b49872]/5"
                          : "border-slate-200"
                      }`}
                      key={priority.code}
                    >
                      <span className="flex items-center gap-3">
                        <input
                          checked={state.priorityCode === priority.code}
                          name="production-priority"
                          onChange={() =>
                            dispatch({
                              type: "set_priority",
                              value: priority.code,
                            })
                          }
                          type="radio"
                          value={priority.code}
                        />
                        <span className="font-semibold text-slate-900">
                          {priority.label}
                        </span>
                      </span>
                      <span className="text-sm text-slate-600">
                        {priority.minimumBusinessDays ===
                        priority.maximumBusinessDays
                          ? priority.minimumBusinessDays
                          : `${priority.minimumBusinessDays}-${priority.maximumBusinessDays}`} {priority.maximumBusinessDays === 1 ? "business day" : "business days"}
                      </span>
                    </label>
                  ))}
                </div>
                {selectedPriority ? (
                  <p
                    aria-live="polite"
                    className="min-h-6 text-sm font-semibold text-slate-900"
                  >
                    Estimated production time: {selectedPriority.minimumBusinessDays === selectedPriority.maximumBusinessDays ? selectedPriority.minimumBusinessDays : `${selectedPriority.minimumBusinessDays}-${selectedPriority.maximumBusinessDays}`} {selectedPriority.maximumBusinessDays === 1 ? "business day" : "business days"}.
                  </p>
                ) : null}
                <p
                  className="text-xs leading-5 text-slate-600"
                  id="production-estimate-qualifier"
                >
                  {PRODUCTION_ESTIMATE_QUALIFIER}
                </p>
              </fieldset>
            ) : (
              <p
                className="border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900"
                role="alert"
              >
                This customization option is temporarily unavailable because we
                can&apos;t calculate its production time. Choose another option or
                contact Kapchi.
              </p>
            )
          ) : null}

          <p className="border-l-4 border-[#b49872] bg-[#b49872]/8 px-4 py-3 text-sm leading-6 text-slate-700">
            {listing.policyNotice}
          </p>

          {selectedPackage?.capabilities.text ? (
            <section aria-labelledby="text-customization-heading" className="space-y-4 border-t border-slate-200 pt-6">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-950" id="text-customization-heading"><Type aria-hidden="true" className="h-5 w-5" /> Add text</h2>
              <label className="block text-sm font-semibold text-slate-800">
                Stole text
                <input
                  className="mt-2 min-h-11 w-full border border-slate-300 px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]"
                  maxLength={selectedPackage.limits.maxChars ?? undefined}
                  onChange={(event) => dispatch({ type: "set_text", value: event.target.value })}
                  value={state.text}
                />
              </label>
              {selectedPackage.limits.maxChars ? <p className="text-right text-xs text-slate-500">{state.text.length} / {selectedPackage.limits.maxChars}</p> : null}
              {selectedPackage.fonts.length ? (
                <label className="block text-sm font-semibold text-slate-800">
                  Font
                  <select className="mt-2 min-h-11 w-full border border-slate-300 bg-white px-3" onChange={(event) => dispatch({ type: "set_font", value: event.target.value })} value={state.fontId ?? ""}>
                    <option value="">Choose a font</option>
                    {selectedPackage.fonts.map((font) => <option key={font.id} value={font.id}>{font.name}</option>)}
                  </select>
                </label>
              ) : null}
            </section>
          ) : null}

          {selectedPackage?.capabilities.image ? (
            <section aria-labelledby="image-customization-heading" className="space-y-3 border-t border-slate-200 pt-6">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-950" id="image-customization-heading"><ImageIcon aria-hidden="true" className="h-5 w-5" /> Add an image</h2>
              {guestCartState === "loading" ? (
                <p aria-live="polite" className="text-sm text-slate-600">Preparing image upload...</p>
              ) : guestCartState === "error" || !guestCartId ? (
                <div className="space-y-2">
                  <p className="text-sm text-rose-700" role="alert">Image upload is not ready.</p>
                  <button className="min-h-11 border border-slate-300 px-4 text-sm font-semibold text-slate-800" onClick={() => void prepareGuestCart()} type="button">Retry image upload</button>
                </div>
              ) : (
                <CustomizationImageUpload
                  acceptedContentTypes={
                    selectedPackage.limits.imageAllowedMimeTypes.length
                      ? selectedPackage.limits.imageAllowedMimeTypes
                      : undefined
                  }
                  cartId={guestCartId}
                  customizationSetId={selectedPackage.id}
                  key={selectedPackage.id}
                  listingId={listing.id}
                  maxBytes={selectedPackage.limits.imageMaxBytes}
                  onUploaded={(asset) =>
                    dispatch({
                      type: "set_image",
                      value: { assetId: asset.assetId, filename: asset.filename },
                    })
                  }
                />
              )}
              {state.imageName ? <p className="text-sm text-slate-600">Selected image: {state.imageName}</p> : null}
            </section>
          ) : null}

          {selectedPackage?.capabilities.trim ? (
            <fieldset className="space-y-3 border-t border-slate-200 pt-6">
              <legend className="flex items-center gap-2 text-lg font-semibold text-slate-950"><WandSparkles aria-hidden="true" className="h-5 w-5" /> Choose trim</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {selectedPackage.trims.map((trim) => (
                  <label className={`flex min-h-12 cursor-pointer items-center gap-3 border px-3 ${state.trimId === trim.id ? "border-[#8f734f]" : "border-slate-200"}`} key={trim.id}>
                    <input checked={state.trimId === trim.id} name="trim" onChange={() => dispatch({ type: "set_trim", value: trim.id })} type="radio" value={trim.id} />
                    <span aria-hidden="true" className="h-6 w-6 border border-black/10" style={{ backgroundColor: trim.colorHex ?? "#e2e8f0" }} />
                    <span className="text-sm font-semibold text-slate-800">{trim.name}{trim.widthMm ? `, ${trim.widthMm} mm` : ""}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <div className="border-t border-slate-200 pt-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase text-slate-500">Selected price</p>
              <p aria-live="polite" className="mt-1 text-xl font-semibold text-slate-950">
                {selectedVariant ? formatMoney(selectedVariant.unitAmountCents, selectedVariant.currency) : "Choose a package"}
              </p>
            </div>
            <button
              className="inline-flex min-h-12 items-center gap-2 rounded-lg bg-[#8f734f] px-6 text-sm font-semibold text-white transition hover:bg-[#765d3e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
              disabled={Boolean(configurationError) || addState === "adding"}
              onClick={() => void addToCart()}
              type="button"
            >
              <ShoppingCart aria-hidden="true" className="h-5 w-5" />
              {addState === "adding" ? "Adding..." : "Add to cart"}
            </button>
            </div>
            {configurationError ? (
              <p className="mt-3 text-sm text-slate-600">{configurationError}</p>
            ) : null}
            {addState === "success" ? (
              <p className="mt-3 text-sm font-semibold text-emerald-700" role="status">
                Added to your cart. <Link className="underline underline-offset-4" href="/cart">View cart</Link>
              </p>
            ) : null}
            {addError ? (
              <p className="mt-3 text-sm text-rose-700" role="alert">
                {addError} <Link className="font-semibold underline underline-offset-4" href="/cart">View cart</Link>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
