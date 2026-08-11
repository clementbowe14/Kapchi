import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HeroCarousel, type HeroCarouselProps } from "./HeroCarousel";

const emblaMock = vi.hoisted(() => {
  type Listener = (api: unknown, event: string) => void;

  let selectedIndex = 0;
  let viewport: HTMLElement | null = null;
  const listeners = new Map<string, Set<Listener>>();

  const slideCount = () =>
    viewport?.querySelectorAll('[aria-roledescription="slide"]').length ?? 0;
  const emit = (event: string) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(api, event);
    }
  };
  const select = (index: number) => {
    const count = slideCount();

    if (!count) {
      return;
    }

    selectedIndex = ((index % count) + count) % count;
    emit("select");
  };
  const api = {
    canScrollNext: () => slideCount() > 1,
    canScrollPrev: () => slideCount() > 1,
    containerNode: () => viewport?.firstElementChild as HTMLElement,
    destroy: vi.fn(),
    emit,
    internalEngine: vi.fn(),
    off(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return api;
    },
    on(event: string, listener: Listener) {
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return api;
    },
    plugins: () => ({}),
    previousScrollSnap: () => selectedIndex,
    reInit: vi.fn(),
    rootNode: () => viewport as HTMLElement,
    scrollNext: vi.fn(() => select(selectedIndex + 1)),
    scrollPrev: vi.fn(() => select(selectedIndex - 1)),
    scrollProgress: () => 0,
    scrollSnapList: () => Array.from({ length: slideCount() }, (_, index) => index),
    scrollTo: vi.fn((index: number) => select(index)),
    selectedScrollSnap: () => selectedIndex,
    slideNodes: () =>
      Array.from(
        viewport?.querySelectorAll<HTMLElement>(
          '[aria-roledescription="slide"]',
        ) ?? [],
      ),
    slidesInView: () => [selectedIndex],
    slidesNotInView: () =>
      Array.from({ length: slideCount() }, (_, index) => index).filter(
        (index) => index !== selectedIndex,
      ),
  };
  const viewportRef = (node: HTMLElement | null) => {
    viewport = node;
  };
  const useEmblaCarousel = vi.fn(() => [viewportRef, api]);

  return {
    api,
    emit,
    reset() {
      selectedIndex = 0;
      viewport = null;
      listeners.clear();
      useEmblaCarousel.mockClear();
      api.destroy.mockClear();
      api.internalEngine.mockClear();
      api.reInit.mockClear();
      api.scrollNext.mockClear();
      api.scrollPrev.mockClear();
      api.scrollTo.mockClear();
    },
    useEmblaCarousel,
  };
});

vi.mock("embla-carousel-react", () => ({
  default: emblaMock.useEmblaCarousel,
}));

const slides: HeroCarouselProps["slides"] = [
  {
    caption: "Heritage in every thread",
    desktopImageSrc: "/images/hero/woven-stole-detail.webp",
    id: "heritage",
    imageAlt: "Detailed red and gold weaving on an Andean graduation stole",
    mobileImageSrc: "/images/hero/woven-stole-detail-mobile.webp",
    objectPosition: {
      desktop: "70% center",
      mobile: "55% center",
    },
  },
  {
    caption: "Made for your milestone",
    desktopImageSrc: "/images/hero/graduate-stole.webp",
    id: "milestone",
    imageAlt: "Graduate wearing a full-length woven Kapchi stole",
  },
  {
    caption: "Personalized with purpose",
    desktopImageSrc: "/images/hero/personalized-stole.webp",
    id: "personalized",
    imageAlt: "Personalized graduation stole with embroidered details",
  },
];

const defaultProps: HeroCarouselProps = {
  autoplayIntervalMs: 7_000,
  eyebrow: "Kapchi graduation stoles",
  headline:
    "Celebrate your Indigenous culture with authentic Andean stoles.",
  primaryAction: {
    href: "/listings",
    label: "Shop graduation stoles",
  },
  secondaryAction: {
    href: "/about",
    label: "Our story",
  },
  slides,
  supportingCopy:
    "Handcrafted graduation stoles designed to honor heritage, achievement, and the story you carry forward.",
};

function installMatchMedia(initialMatches = false) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((media: string) => ({
      addEventListener: (_event: string, listener: () => void) =>
        listeners.add(listener),
      dispatchEvent: () => true,
      matches,
      media,
      onchange: null,
      removeEventListener: (_event: string, listener: () => void) =>
        listeners.delete(listener),
    })),
  });

  return {
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
}

function renderCarousel(overrides: Partial<HeroCarouselProps> = {}) {
  return render(<HeroCarousel {...defaultProps} {...overrides} />);
}

function activeSlide(position: number, count = slides.length) {
  const slide = document.querySelector(
    `[aria-roledescription="slide"][aria-label="${position} of ${count}"]`,
  );

  expect(slide).toHaveAttribute("aria-hidden", "false");
  return slide;
}

function liveRegion() {
  return document.querySelector('[aria-live="polite"]');
}

beforeEach(() => {
  emblaMock.reset();
  installMatchMedia(false);
  setDocumentHidden(false);
});

afterEach(() => {
  vi.useRealTimers();
  setDocumentHidden(false);
});

describe("HeroCarousel rendering", () => {
  it("renders the approved copy, actions, and first slide on the initial pass", () => {
    renderCarousel();

    expect(
      screen.getByRole("heading", {
        name: defaultProps.headline,
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(defaultProps.supportingCopy)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Shop graduation stoles" }),
    ).toHaveAttribute("href", "/listings");
    expect(screen.getByRole("link", { name: "Our story" })).toHaveAttribute(
      "href",
      "/about",
    );
    expect(
      screen.getByRole("region", { name: "Featured Kapchi stoles" }),
    ).toHaveAttribute("aria-roledescription", "carousel");
    expect(
      screen.getByAltText(slides[0].imageAlt, { exact: true }),
    ).toBeInTheDocument();
    activeSlide(1);
  });

  it("uses an optimized picture for art direction and preloads only slide one", () => {
    renderCarousel();

    const initialImage = screen.getByAltText(slides[0].imageAlt);
    const laterImage = screen.getByAltText(slides[1].imageAlt);
    const picture = initialImage.closest("picture");
    const source = picture?.querySelector("source");
    const preloadLinks = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="image"]'),
    );

    expect(source).toHaveAttribute("media", "(max-width: 767px)");
    expect(source).toHaveAttribute("sizes", "100vw");
    expect(initialImage).not.toHaveAttribute("loading", "lazy");
    expect(laterImage).toHaveAttribute("loading", "lazy");
    expect(initialImage.style.getPropertyValue("--hero-mobile-position")).toBe(
      "55% center",
    );
    expect(
      initialImage.style.getPropertyValue("--hero-desktop-position"),
    ).toBe("70% center");
    expect(preloadLinks).toHaveLength(2);
    expect(preloadLinks.map((link) => link.media)).toEqual([
      "(max-width: 767px)",
      "(min-width: 768px)",
    ]);
    expect(
      preloadLinks.every((link) =>
        (link.getAttribute("imagesrcset") ?? "").includes(
          "woven-stole-detail",
        ),
      ),
    ).toBe(true);
    expect(
      preloadLinks.some((link) =>
        (link.getAttribute("imagesrcset") ?? "").includes("graduate-stole"),
      ),
    ).toBe(false);
  });

  it("does not render actions with empty destinations", () => {
    renderCarousel({
      primaryAction: { href: " ", label: "Shop graduation stoles" },
      secondaryAction: { href: "", label: "Our story" },
    });

    expect(
      screen.queryByRole("link", { name: "Shop graduation stoles" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Our story" }),
    ).not.toBeInTheDocument();
  });

  it("hides all carousel controls when there is one slide", () => {
    renderCarousel({ slides: [slides[0]] });

    expect(
      screen.queryByRole("group", { name: "Carousel controls" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(slides[0].caption)).toBeInTheDocument();
  });

  it("rejects duplicate slide IDs outside production", () => {
    const duplicateSlides = [slides[0], { ...slides[1], id: slides[0].id }];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => renderCarousel({ slides: duplicateSlides })).toThrow(
      'HeroCarousel received duplicate slide id "heritage".',
    );

    consoleError.mockRestore();
  });
});

describe("HeroCarousel navigation", () => {
  it("selects next, previous, and pagination destinations", () => {
    renderCarousel();

    fireEvent.click(screen.getByRole("button", { name: "Show next slide" }));
    activeSlide(2);

    fireEvent.click(
      screen.getByRole("button", { name: "Show previous slide" }),
    );
    activeSlide(1);

    fireEvent.click(
      screen.getByRole("button", {
        name: `Go to slide 3: ${slides[2].caption}`,
      }),
    );
    activeSlide(3);
  });

  it("wraps previous and next navigation at both boundaries", () => {
    renderCarousel();

    fireEvent.click(
      screen.getByRole("button", { name: "Show previous slide" }),
    );
    activeSlide(3);

    fireEvent.click(screen.getByRole("button", { name: "Show next slide" }));
    activeSlide(1);
  });

  it("keeps focus on the control that requested a slide", () => {
    renderCarousel();

    const nextButton = screen.getByRole("button", { name: "Show next slide" });
    nextButton.focus();
    fireEvent.click(nextButton);

    expect(nextButton).toHaveFocus();
    activeSlide(2);
  });

  it("announces controls and swipes, but not autoplay changes", () => {
    renderCarousel();

    fireEvent.click(screen.getByRole("button", { name: "Show next slide" }));
    expect(liveRegion()).toHaveTextContent(
      `Slide 2 of 3: ${slides[1].caption}`,
    );

    act(() => emblaMock.emit("pointerDown"));
    act(() => emblaMock.api.scrollNext());
    expect(liveRegion()).toHaveTextContent(
      `Slide 3 of 3: ${slides[2].caption}`,
    );
  });

  it("skips a failed active image and keeps the next slide available", () => {
    renderCarousel();

    fireEvent.error(screen.getByAltText(slides[0].imageAlt));

    expect(screen.queryByAltText(slides[0].imageAlt)).not.toBeInTheDocument();
    activeSlide(1, 2);
    expect(screen.getByAltText(slides[1].imageAlt)).toBeInTheDocument();
  });
});

describe("HeroCarousel autoplay", () => {
  beforeEach(() => vi.useFakeTimers());

  it("waits for the first image load and advances on the configured interval", () => {
    renderCarousel({ autoplayIntervalMs: 1_000 });

    act(() => vi.advanceTimersByTime(1_000));
    activeSlide(1);

    fireEvent.load(screen.getByAltText(slides[0].imageAlt));
    act(() => vi.advanceTimersByTime(1_000));

    activeSlide(2);
    expect(liveRegion()).toHaveTextContent("");
  });

  it("stops on pause and restarts only after play", () => {
    renderCarousel({ autoplayIntervalMs: 1_000 });
    fireEvent.load(screen.getByAltText(slides[0].imageAlt));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Pause automatic slide rotation",
      }),
    );
    act(() => vi.advanceTimersByTime(2_000));
    activeSlide(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Play automatic slide rotation" }),
    );
    act(() => vi.advanceTimersByTime(1_000));
    activeSlide(2);
  });

  it("keeps rotation paused after manual navigation until play is pressed", () => {
    renderCarousel({ autoplayIntervalMs: 1_000 });
    fireEvent.load(screen.getByAltText(slides[0].imageAlt));

    fireEvent.click(screen.getByRole("button", { name: "Show next slide" }));
    activeSlide(2);
    act(() => vi.advanceTimersByTime(3_000));
    activeSlide(2);

    fireEvent.click(
      screen.getByRole("button", { name: "Play automatic slide rotation" }),
    );
    act(() => vi.advanceTimersByTime(1_000));
    activeSlide(3);
  });

  it("temporarily pauses on hover, focus, and a hidden tab", () => {
    renderCarousel({ autoplayIntervalMs: 1_000 });
    fireEvent.load(screen.getByAltText(slides[0].imageAlt));
    const carousel = screen.getByRole("region", {
      name: "Featured Kapchi stoles",
    });

    fireEvent.mouseEnter(carousel);
    act(() => vi.advanceTimersByTime(1_000));
    activeSlide(1);
    fireEvent.mouseLeave(carousel);
    act(() => vi.advanceTimersByTime(1_000));
    activeSlide(2);

    const aboutLink = screen.getByRole("link", { name: "Our story" });
    fireEvent.focus(aboutLink);
    act(() => vi.advanceTimersByTime(1_000));
    activeSlide(2);
    fireEvent.blur(aboutLink, { relatedTarget: null });
    act(() => vi.advanceTimersByTime(1_000));
    activeSlide(3);

    setDocumentHidden(true);
    fireEvent(document, new Event("visibilitychange"));
    act(() => vi.advanceTimersByTime(1_000));
    activeSlide(3);
    setDocumentHidden(false);
    fireEvent(document, new Event("visibilitychange"));
    act(() => vi.advanceTimersByTime(1_000));
    activeSlide(1);
  });

  it("disables rotation when reduced motion is preferred", () => {
    installMatchMedia(true);
    renderCarousel({ autoplayIntervalMs: 1_000 });
    fireEvent.load(screen.getByAltText(slides[0].imageAlt));

    expect(
      screen.getByRole("button", {
        name: "Automatic rotation disabled by reduced motion preference",
      }),
    ).toBeDisabled();
    act(() => vi.advanceTimersByTime(3_000));
    activeSlide(1);
  });
});

describe("HeroCarousel fallback", () => {
  it("renders a branded static hero when no slides are valid", () => {
    renderCarousel({ slides: [] });

    expect(
      screen.getByRole("heading", { name: defaultProps.headline }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Carousel controls" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Our story" })).toHaveAttribute(
      "href",
      "/about",
    );
  });

  it("renders the static fallback after every image fails", () => {
    renderCarousel();

    fireEvent.error(screen.getByAltText(slides[0].imageAlt));
    fireEvent.error(screen.getByAltText(slides[1].imageAlt));
    fireEvent.error(screen.getByAltText(slides[2].imageAlt));

    expect(
      screen.getByRole("heading", { name: defaultProps.headline }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Carousel controls" }),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector('[aria-roledescription="slide"]'),
    ).not.toBeInTheDocument();
  });
});
