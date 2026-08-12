export type HeroSlide = {
  id: string;
  desktopImageSrc: string;
  mobileImageSrc?: string;
  imageAlt: string;
  caption: string;
  objectPosition?: {
    desktop: string;
    mobile: string;
  };
};

export type HeroAction = {
  href: string;
  label: string;
};

export type HeroCarouselProps = {
  eyebrow: string;
  headline: string;
  supportingCopy: string;
  slides: readonly HeroSlide[];
  primaryAction?: HeroAction;
  secondaryAction?: HeroAction;
  autoplayIntervalMs?: number;
};

export type HomeHeroContent = HeroCarouselProps;

export type HeroAssetReview = {
  assetOwner: string;
  approvalStatus: "development-only-pending-owner-approval";
  representationStatus: "pending-product-and-cultural-review";
};

const slides = [
  {
    id: "woven-stole-detail",
    desktopImageSrc: "/images/hero/woven-stole-detail.webp",
    mobileImageSrc: "/images/hero/woven-stole-detail-mobile.webp",
    imageAlt:
      "A multicolored woven graduation stole arranged on a wooden worktable, showing textured red, teal, gold, green, and black panels.",
    caption: "Heritage in every thread",
    objectPosition: {
      desktop: "70% center",
      mobile: "65% center",
    },
  },
  {
    id: "graduate-milestone",
    desktopImageSrc: "/images/hero/graduate-wearing-woven-stole.webp",
    mobileImageSrc:
      "/images/hero/graduate-wearing-woven-stole-mobile.webp",
    imageAlt:
      "A graduate in a black cap and gown wearing a bright blue, magenta, gold, and green woven stole in a university courtyard.",
    caption: "Made for your milestone",
    objectPosition: {
      desktop: "72% center",
      mobile: "68% center",
    },
  },
  {
    id: "personalized-stole",
    desktopImageSrc: "/images/hero/personalized-woven-stole.webp",
    mobileImageSrc: "/images/hero/personalized-woven-stole-mobile.webp",
    imageAlt:
      "A purple woven graduation stole on a tailor's form with gold AM and 2026 embroidery beside coordinating threads.",
    caption: "Personalized with purpose",
    objectPosition: {
      desktop: "70% center",
      mobile: "65% center",
    },
  },
] as const satisfies readonly HeroSlide[];

function assertUniqueSlideIds(heroSlides: readonly HeroSlide[]): void {
  const slideIds = new Set<string>();

  for (const slide of heroSlides) {
    if (slideIds.has(slide.id)) {
      throw new Error(`Duplicate home hero slide id: ${slide.id}`);
    }

    slideIds.add(slide.id);
  }
}

if (process.env.NODE_ENV !== "production") {
  assertUniqueSlideIds(slides);
}

export const homeHeroContent = {
  eyebrow: "Kapchi graduation stoles",
  headline:
    "Celebrate your Indigenous culture with authentic Andean stoles.",
  supportingCopy:
    "Handcrafted graduation stoles designed to honor heritage, achievement, and the story you carry forward.",
  slides,
  primaryAction: {
    href: "/#graduation-stoles",
    label: "Shop graduation stoles",
  },
  secondaryAction: {
    href: "/about",
    label: "Our story",
  },
  autoplayIntervalMs: 7_000,
} as const satisfies HomeHeroContent;

export const homeHeroAssetReview = {
  "woven-stole-detail": {
    assetOwner: "Kapchi",
    approvalStatus: "development-only-pending-owner-approval",
    representationStatus: "pending-product-and-cultural-review",
  },
  "graduate-milestone": {
    assetOwner: "Kapchi",
    approvalStatus: "development-only-pending-owner-approval",
    representationStatus: "pending-product-and-cultural-review",
  },
  "personalized-stole": {
    assetOwner: "Kapchi",
    approvalStatus: "development-only-pending-owner-approval",
    representationStatus: "pending-product-and-cultural-review",
  },
} as const satisfies Record<(typeof slides)[number]["id"], HeroAssetReview>;
