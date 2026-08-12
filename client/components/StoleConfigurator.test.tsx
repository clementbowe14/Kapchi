import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ImgHTMLAttributes } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraduationStoleDetail } from "@/lib/listings";
import {
  configuratorReducer,
  CUSTOMIZATION_POLICY_NOTICE,
  initialConfiguratorState,
  StoleConfigurator,
} from "./StoleConfigurator";

type MockImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  fill?: boolean;
  priority?: boolean;
  src: string | { src: string };
  unoptimized?: boolean;
};

vi.mock("next/image", () => ({
  default: ({ alt, fill, priority, src, unoptimized, ...props }: MockImageProps) => {
    void priority;
    void unoptimized;

    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        {...props}
        alt={alt ?? ""}
        data-fill={fill || undefined}
        src={typeof src === "string" ? src : src.src}
      />
    );
  },
}));

vi.mock("./CustomizationImageUpload", () => ({
  CustomizationImageUpload: ({
    onUploaded,
  }: {
    onUploaded?: (asset: {
      assetId: string;
      byteSize: number;
      contentType: string;
      filename: string;
    }) => void;
  }) => (
    <button
      onClick={() =>
        onUploaded?.({
          assetId: "asset-1",
          byteSize: 1024,
          contentType: "image/png",
          filename: "crest.png",
        })
      }
      type="button"
    >
      Upload test image
    </button>
  ),
}));

const fetchMock = vi.fn();

function cartResponse() {
  return new Response(
    JSON.stringify({ cartId: "cart-1", items: [], subtotalCents: 0 }),
    { headers: { "Content-Type": "application/json" }, status: 200 },
  );
}

const basePackage = {
  capabilities: { image: false, text: true, trim: false },
  fonts: [{ id: "serif", name: "Serif" }],
  id: "text-short",
  kind: "text_short",
  limits: {
    imageAllowedMimeTypes: [],
    imageMaxBytes: null,
    imageMaxHeightPx: null,
    imageMaxWidthPx: null,
    imageMinHeightPx: null,
    imageMinWidthPx: null,
    maxChars: 40,
    minChars: 0,
  },
  name: "Text (short)",
  priceDeltaCents: 5000,
  priceVariants: [
    {
      currency: "USD",
      fontOptionId: null,
      id: "text-short-price",
      trimOptionId: null,
      unitAmountCents: 20000,
      variantKey: null,
    },
  ],
  requirements: { image: false, text: true, trim: false },
  trims: [],
};

const noCustomizationPackage = {
  ...basePackage,
  capabilities: { image: false, text: false, trim: false },
  fonts: [],
  id: "blank",
  kind: "blank",
  limits: {
    ...basePackage.limits,
    maxChars: null,
  },
  name: "No customization",
  priceDeltaCents: 0,
  priceVariants: [
    {
      ...basePackage.priceVariants[0],
      id: "blank-price",
      unitAmountCents: 15000,
    },
  ],
  requirements: { image: false, text: false, trim: false },
};

const listing: GraduationStoleDetail = {
  availability: { availableQuantity: 5, label: null, status: "available" },
  basePriceCents: 15000,
  currency: "USD",
  customizationPackages: [
    noCustomizationPackage,
    basePackage,
    {
      ...basePackage,
      id: "text-long",
      kind: "text_long",
      limits: { ...basePackage.limits, maxChars: 120 },
      name: "Text (long)",
      priceVariants: [
        {
          ...basePackage.priceVariants[0],
          id: "text-long-price",
          unitAmountCents: 21000,
        },
      ],
    },
    {
      ...basePackage,
      capabilities: { image: true, text: true, trim: false },
      id: "text-image",
      kind: "text_image",
      limits: {
        ...basePackage.limits,
        imageAllowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
        imageMaxBytes: 1000000,
        maxChars: 120,
      },
      name: "Text (long) and Image",
      priceVariants: [
        {
          ...basePackage.priceVariants[0],
          id: "text-image-price",
          unitAmountCents: 22000,
        },
      ],
      requirements: { image: true, text: true, trim: false },
    },
    {
      ...basePackage,
      capabilities: { image: true, text: true, trim: true },
      fonts: [{ id: "serif", name: "Serif" }],
      id: "full",
      kind: "text_image_trim",
      limits: {
        imageAllowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
        imageMaxBytes: 1000000,
        imageMaxHeightPx: null,
        imageMaxWidthPx: null,
        imageMinHeightPx: null,
        imageMinWidthPx: null,
        maxChars: 24,
        minChars: 1,
      },
      name: "Text (long) + Image + Trim",
      priceVariants: [
        {
          currency: "USD",
          fontOptionId: null,
          id: "full-price",
          trimOptionId: "gold",
          unitAmountCents: 24000,
          variantKey: "full-gold",
        },
      ],
      requirements: { image: true, text: true, trim: true },
      trims: [
        {
          colorHex: "#d4a941",
          id: "gold",
          name: "Gold",
          priceDeltaCents: 0,
          widthMm: 12,
        },
      ],
    },
  ],
  description: "A woven stole.",
  fabrics: [
    {
      availability: { availableQuantity: 4, label: null, status: "available" },
      colorHex: "#001f3f",
      id: "navy",
      image: { alt: "Navy woven fabric", url: "https://example.com/navy.jpg" },
      materialDescription: "Woven cotton",
      name: "Navy",
    },
    {
      availability: { availableQuantity: 3, label: null, status: "available" },
      colorHex: "#d4a941",
      id: "gold-fabric",
      image: { alt: "Gold woven fabric", url: "https://example.com/gold.jpg" },
      materialDescription: null,
      name: "Gold",
    },
  ],
  fromPriceCents: 15000,
  gallery: [],
  id: "listing-1",
  isCustomizable: true,
  listingType: "graduation_stole",
  policyNotice: CUSTOMIZATION_POLICY_NOTICE,
  primaryImage: null,
  slug: "heritage-stole",
  subtitle: "Honor your heritage",
  title: "Heritage Stole",
};

describe("StoleConfigurator", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders fabric images, customization levels, and policy", () => {
    render(<StoleConfigurator listing={listing} />);

    const fabricGroup = screen.getByRole("group", { name: "Choose a fabric" });
    expect(within(fabricGroup).getByRole("img", { name: "Navy woven fabric" })).toHaveAttribute("src", "https://example.com/navy.jpg");
    expect(within(fabricGroup).getByRole("img", { name: "Gold woven fabric" })).toHaveAttribute("src", "https://example.com/gold.jpg");
    expect(screen.getByRole("radio", { name: /Gold/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /No customization/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Text \(short\)/ })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", {
        name: /^Text \(long\)\$210\.00Text$/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Text \(long\) and Image/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Text \(long\) \+ Image \+ Trim/ })).toBeInTheDocument();
    expect(screen.getByText(CUSTOMIZATION_POLICY_NOTICE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to cart" })).toBeDisabled();
  });

  it("shows the selected fabric image in the product gallery", async () => {
    const user = userEvent.setup();
    render(<StoleConfigurator listing={listing} />);

    const gallery = screen.getByRole("region", { name: `${listing.title} images` });
    expect(screen.getByRole("radio", { name: /Navy/ })).toBeChecked();
    expect(within(gallery).getByRole("img", { name: "Navy woven fabric" })).toHaveAttribute(
      "src",
      "https://example.com/navy.jpg",
    );
    expect(within(gallery).queryByRole("img", { name: "Gold woven fabric" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Gold/ }));

    expect(
      within(
        screen.getByRole("region", { name: `${listing.title} images` }),
      ).getByRole("img", { name: "Gold woven fabric" }),
    ).toHaveAttribute("src", "https://example.com/gold.jpg");
  });

  it("reveals only entitled controls and hides them after switching packages", async () => {
    const user = userEvent.setup();
    render(<StoleConfigurator listing={listing} />);

    expect(screen.queryByRole("heading", { name: "Add text" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Text \(long\) \+ Image \+ Trim/ }));
    expect(screen.getByRole("heading", { name: "Add text" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Add an image" })).toBeInTheDocument();
    const trimGroup = screen.getByRole("group", { name: "Choose trim" });
    expect(screen.getByText("Choose a package")).toBeInTheDocument();
    await user.click(within(trimGroup).getByRole("radio", { name: /Gold/ }));
    expect(screen.getAllByText("$240.00")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Stole text"), { target: { value: "Class of 2026" } });
    await user.click(screen.getByRole("radio", { name: /No customization/ }));
    expect(screen.queryByLabelText("Stole text")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Custom image")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Choose trim" })).not.toBeInTheDocument();
  });

  it("sanitizes unauthorized state when a package changes", () => {
    const dirtyState = {
      ...initialConfiguratorState,
      fontId: "serif",
      imageName: "crest.png",
      packageId: "full",
      text: "Class of 2026",
      trimId: "gold",
    };

    expect(configuratorReducer(dirtyState, { package: basePackage, type: "select_package" })).toMatchObject({
      fontId: "serif",
      imageName: null,
      packageId: "text-short",
      text: "Class of 2026",
      trimId: null,
    });

    expect(
      configuratorReducer(dirtyState, {
        package: noCustomizationPackage,
        type: "select_package",
      }),
    ).toMatchObject({
      fontId: null,
      imageName: null,
      packageId: "blank",
      text: "",
      trimId: null,
    });

    const differentTextAndTrimPackage = {
      ...basePackage,
      capabilities: { image: false, text: true, trim: true },
      fonts: [{ id: "sans", name: "Sans" }],
      id: "different-options",
      trims: [
        {
          colorHex: "#ffffff",
          id: "white",
          name: "White",
          priceDeltaCents: 0,
          widthMm: 8,
        },
      ],
    };

    expect(
      configuratorReducer(dirtyState, {
        package: differentTextAndTrimPackage,
        type: "select_package",
      }),
    ).toMatchObject({
      fontId: null,
      imageName: null,
      packageId: "different-options",
      text: "Class of 2026",
      trimId: null,
    });
  });

  it.each([
    {
      expected: {
        fontOptionId: null,
        imageAssetId: null,
        line1: "",
        listingCustomizationSetId: "blank",
        listingPriceVariantId: "blank-price",
        trimOptionId: null,
      },
      packageName: /No customization/,
    },
    {
      expected: {
        fontOptionId: null,
        imageAssetId: null,
        line1: "Class of 2026",
        listingCustomizationSetId: "text-short",
        listingPriceVariantId: "text-short-price",
        trimOptionId: null,
      },
      packageName: /Text \(short\)/,
      text: "Class of 2026",
    },
    {
      expected: {
        fontOptionId: null,
        imageAssetId: null,
        line1: "Class of 2026 with honors",
        listingCustomizationSetId: "text-long",
        listingPriceVariantId: "text-long-price",
        trimOptionId: null,
      },
      packageName: /^Text \(long\)\$210\.00Text$/,
      text: "Class of 2026 with honors",
    },
    {
      expected: {
        fontOptionId: null,
        imageAssetId: "asset-1",
        line1: "Class of 2026",
        listingCustomizationSetId: "text-image",
        listingPriceVariantId: "text-image-price",
        trimOptionId: null,
      },
      image: true,
      packageName: /Text \(long\) and Image/,
      text: "Class of 2026",
    },
    {
      expected: {
        fontOptionId: null,
        imageAssetId: "asset-1",
        line1: "Class of 2026",
        listingCustomizationSetId: "full",
        listingPriceVariantId: "full-price",
        trimOptionId: "gold",
      },
      image: true,
      packageName: /Text \(long\) \+ Image \+ Trim/,
      text: "Class of 2026",
      trim: true,
    },
  ])(
    "adds the $expected.listingCustomizationSetId level with only its entitled metadata",
    async ({ expected, image, packageName, text, trim }) => {
      const user = userEvent.setup();
      if (image) {
        fetchMock.mockResolvedValueOnce(cartResponse());
      }
      fetchMock.mockResolvedValueOnce(cartResponse());
      render(<StoleConfigurator listing={listing} />);

      await user.click(screen.getByRole("radio", { name: packageName }));
      if (text) {
        await user.type(screen.getByLabelText("Stole text"), text);
      }
      if (image) {
        await user.click(await screen.findByRole("button", { name: "Upload test image" }));
      }
      if (trim) {
        await user.click(
          within(screen.getByRole("group", { name: "Choose trim" })).getByRole(
            "radio",
            { name: /Gold/ },
          ),
        );
      }

      await user.click(screen.getByRole("button", { name: "Add to cart" }));
      expect(await screen.findByText(/Added to your cart/)).toBeInTheDocument();

      const addCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/cart/items" && init?.method === "POST",
      );
      expect(addCall).toBeDefined();
      expect(JSON.parse(String(addCall?.[1]?.body))).toEqual({
        fabricId: "navy",
        ...expected,
        line2: "",
        listingId: "listing-1",
        quantity: 1,
      });
    },
  );
});
