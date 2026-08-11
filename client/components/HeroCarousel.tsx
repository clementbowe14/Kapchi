"use client";

import useEmblaCarousel from "embla-carousel-react";
import {
  ChevronLeft,
  ChevronRight,
  CirclePause,
  CirclePlay,
} from "lucide-react";
import Image, { getImageProps } from "next/image";
import Link from "next/link";
import {
  type CSSProperties,
  type FocusEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

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

export type HeroCarouselProps = {
  eyebrow: string;
  headline: string;
  supportingCopy: string;
  slides: readonly HeroSlide[];
  primaryAction?: {
    href: string;
    label: string;
  };
  secondaryAction?: {
    href: string;
    label: string;
  };
  autoplayIntervalMs?: number;
};

type HeroAction = NonNullable<HeroCarouselProps["primaryAction"]>;
type SlideChangeSource =
  | "autoplay"
  | "next"
  | "pagination"
  | "previous"
  | "swipe";

const DEFAULT_AUTOPLAY_INTERVAL_MS = 7_000;
const DESKTOP_BREAKPOINT = "768px";
const MOBILE_BREAKPOINT = "767px";

function isValidAction(action?: HeroAction): action is HeroAction {
  return Boolean(action?.href.trim() && action.label.trim());
}

function isValidSlide(slide: HeroSlide) {
  return Boolean(
    slide.id.trim() &&
      slide.desktopImageSrc.trim() &&
      slide.imageAlt.trim() &&
      slide.caption.trim(),
  );
}

function assertUniqueSlideIds(slides: readonly HeroSlide[]) {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  const ids = new Set<string>();

  for (const slide of slides) {
    if (ids.has(slide.id)) {
      throw new Error(`HeroCarousel received duplicate slide id "${slide.id}".`);
    }

    ids.add(slide.id);
  }
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);

    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);

    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  return prefersReducedMotion;
}

function HeroActions({
  primaryAction,
  secondaryAction,
}: Pick<HeroCarouselProps, "primaryAction" | "secondaryAction">) {
  const hasPrimaryAction = isValidAction(primaryAction);
  const hasSecondaryAction = isValidAction(secondaryAction);

  if (!hasPrimaryAction && !hasSecondaryAction) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
      {hasPrimaryAction ? (
        <Link
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-[#b49872] px-5 py-3 text-sm font-semibold text-[#171614] transition-colors hover:bg-[#c9ad86] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          href={primaryAction.href}
        >
          {primaryAction.label}
        </Link>
      ) : null}
      {hasSecondaryAction ? (
        <Link
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-white/70 bg-black/20 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-black/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          href={secondaryAction.href}
        >
          {secondaryAction.label}
        </Link>
      ) : null}
    </div>
  );
}

function HeroCopy({
  eyebrow,
  headline,
  primaryAction,
  secondaryAction,
  supportingCopy,
}: Omit<HeroCarouselProps, "autoplayIntervalMs" | "slides">) {
  return (
    <div className="w-full max-w-[42rem] md:max-w-[60%] lg:max-w-[42rem]">
      <p className="mb-2 text-xs font-semibold uppercase leading-4 text-[#dbc8aa] sm:mb-3 sm:text-sm">
        {eyebrow}
      </p>
      <h1 className="max-w-[18ch] text-[2rem] font-semibold leading-[1.08] text-white sm:text-[2.5rem] lg:text-6xl">
        {headline}
      </h1>
      <p className="mt-2 max-w-[38rem] text-sm leading-5 text-white/90 sm:mt-4 sm:text-lg sm:leading-7">
        {supportingCopy}
      </p>
      <div className="mt-3 sm:mt-6">
        <HeroActions
          primaryAction={primaryAction}
          secondaryAction={secondaryAction}
        />
      </div>
    </div>
  );
}

function HeroFallback(
  props: Omit<HeroCarouselProps, "autoplayIntervalMs" | "slides">,
) {
  return (
    <section
      aria-label="Featured Kapchi stoles"
      aria-roledescription="carousel"
      className="relative isolate flex min-h-[var(--hero-min-height)] overflow-hidden bg-[#171614] text-white [--hero-min-height:clamp(28rem,calc(100svh-9rem),48rem)]"
      role="region"
    >
      <div className="absolute inset-0 opacity-15" aria-hidden="true">
        <Image
          alt=""
          className="h-full w-full object-contain p-16"
          height={512}
          src="/kapchi_logo.png"
          width={512}
        />
      </div>
      <div className="relative z-10 mx-auto flex w-full max-w-7xl items-end px-4 pb-12 pt-20 sm:px-6 md:px-8 lg:px-10 lg:pb-16">
        <HeroCopy {...props} />
      </div>
    </section>
  );
}

function ResponsiveHeroImage({
  isInitialSlide,
  onError,
  onLoad,
  slide,
}: {
  isInitialSlide: boolean;
  onError: () => void;
  onLoad: () => void;
  slide: HeroSlide;
}) {
  const common = {
    alt: slide.imageAlt,
    quality: 75,
    sizes: "100vw",
  } as const;
  const {
    props: {
      alt: desktopImageAlt,
      srcSet: desktopSrcSet,
      ...desktopImageProps
    },
  } = getImageProps({
    ...common,
    height: 1_350,
    loading: isInitialSlide ? undefined : "lazy",
    preload: isInitialSlide,
    src: slide.desktopImageSrc,
    width: 2_400,
  });
  const mobileImage = slide.mobileImageSrc
    ? getImageProps({
        ...common,
        height: 1_600,
        loading: isInitialSlide ? undefined : "lazy",
        preload: isInitialSlide,
        src: slide.mobileImageSrc,
        width: 1_200,
      }).props
    : null;
  const imageStyle = {
    ...desktopImageProps.style,
    "--hero-desktop-position":
      slide.objectPosition?.desktop ?? "center center",
    "--hero-mobile-position": slide.objectPosition?.mobile ?? "center center",
  } as CSSProperties;

  return (
    <>
      {isInitialSlide && mobileImage ? (
        <>
          <link
            as="image"
            imageSizes="100vw"
            imageSrcSet={mobileImage.srcSet}
            media={`(max-width: ${MOBILE_BREAKPOINT})`}
            rel="preload"
          />
          <link
            as="image"
            imageSizes="100vw"
            imageSrcSet={desktopSrcSet}
            media={`(min-width: ${DESKTOP_BREAKPOINT})`}
            rel="preload"
          />
        </>
      ) : null}
      {isInitialSlide && !mobileImage ? (
        <link
          as="image"
          imageSizes="100vw"
          imageSrcSet={desktopSrcSet}
          rel="preload"
        />
      ) : null}
      <picture className="absolute inset-0 block h-full w-full">
        {mobileImage ? (
          <source
            media={`(max-width: ${MOBILE_BREAKPOINT})`}
            sizes="100vw"
            srcSet={mobileImage.srcSet}
          />
        ) : null}
        {/* getImageProps keeps this art-directed picture on Next's optimizer. */}
        <img
          {...desktopImageProps}
          alt={desktopImageAlt}
          className="absolute inset-0 h-full w-full object-cover [object-position:var(--hero-mobile-position)] md:[object-position:var(--hero-desktop-position)]"
          onError={onError}
          onLoad={onLoad}
          srcSet={desktopSrcSet}
          style={imageStyle}
        />
      </picture>
    </>
  );
}

export function HeroCarousel({
  autoplayIntervalMs = DEFAULT_AUTOPLAY_INTERVAL_MS,
  eyebrow,
  headline,
  primaryAction,
  secondaryAction,
  slides,
  supportingCopy,
}: HeroCarouselProps) {
  assertUniqueSlideIds(slides);

  const validSlides = useMemo(() => slides.filter(isValidSlide), [slides]);
  const [failedSlideIds, setFailedSlideIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [loadedSlideIds, setLoadedSlideIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const availableSlides = useMemo(
    () => validSlides.filter((slide) => !failedSlideIds.has(slide.id)),
    [failedSlideIds, validSlides],
  );
  const [activeSlideId, setActiveSlideId] = useState<string | null>(
    () => validSlides[0]?.id ?? null,
  );
  const [announcement, setAnnouncement] = useState("");
  const [isManuallyPaused, setIsManuallyPaused] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [hasFocusWithin, setHasFocusWithin] = useState(false);
  const [focusPauseOverridden, setFocusPauseOverridden] = useState(false);
  const [isDocumentHidden, setIsDocumentHidden] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();
  const viewportId = useId();
  const pendingChangeSource = useRef<SlideChangeSource | null>(null);
  const [emblaRef, emblaApi] = useEmblaCarousel({
    duration: prefersReducedMotion ? 0 : 30,
    loop: availableSlides.length > 1,
    skipSnaps: false,
    watchDrag: availableSlides.length > 1,
  });
  const activeSlideIndex = Math.max(
    0,
    availableSlides.findIndex((slide) => slide.id === activeSlideId),
  );
  const activeSlide = availableSlides[activeSlideIndex];
  const firstAvailableSlideLoaded = Boolean(
    availableSlides[0] && loadedSlideIds.has(availableSlides[0].id),
  );
  const intervalMs =
    Number.isFinite(autoplayIntervalMs) && autoplayIntervalMs > 0
      ? autoplayIntervalMs
      : DEFAULT_AUTOPLAY_INTERVAL_MS;
  const canAutoplay =
    availableSlides.length > 1 &&
    firstAvailableSlideLoaded &&
    !prefersReducedMotion &&
    !isManuallyPaused &&
    !isHovered &&
    (!hasFocusWithin || focusPauseOverridden) &&
    !isDocumentHidden;

  const announceSlide = useCallback(
    (index: number) => {
      const slide = availableSlides[index];

      if (slide) {
        setAnnouncement(
          `Slide ${index + 1} of ${availableSlides.length}: ${slide.caption}`,
        );
      }
    },
    [availableSlides],
  );

  const handleSelect = useCallback(
    (api: NonNullable<typeof emblaApi>) => {
      const index = api.selectedScrollSnap();
      const slide = availableSlides[index];
      const source = pendingChangeSource.current;

      if (!slide) {
        return;
      }

      setActiveSlideId(slide.id);

      if (source && source !== "autoplay") {
        announceSlide(index);
      }

      pendingChangeSource.current = null;
    },
    [announceSlide, availableSlides],
  );

  useEffect(() => {
    if (!emblaApi) {
      return;
    }

    const handlePointerDown = () => {
      pendingChangeSource.current = "swipe";
      setIsManuallyPaused(true);
    };

    emblaApi.on("select", handleSelect);
    emblaApi.on("pointerDown", handlePointerDown);

    return () => {
      emblaApi.off("select", handleSelect);
      emblaApi.off("pointerDown", handlePointerDown);
    };
  }, [emblaApi, handleSelect]);

  useEffect(() => {
    const handleVisibilityChange = () => setIsDocumentHidden(document.hidden);

    handleVisibilityChange();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (!emblaApi || !activeSlide) {
      return;
    }

    if (emblaApi.selectedScrollSnap() !== activeSlideIndex) {
      pendingChangeSource.current = null;
      emblaApi.scrollTo(activeSlideIndex, true);
    }
  }, [activeSlide, activeSlideIndex, availableSlides, emblaApi]);

  useEffect(() => {
    if (!canAutoplay || !emblaApi) {
      return;
    }

    const timer = window.setTimeout(() => {
      pendingChangeSource.current = "autoplay";
      emblaApi.scrollNext();
    }, intervalMs);

    return () => window.clearTimeout(timer);
  }, [activeSlideId, canAutoplay, emblaApi, intervalMs]);

  const handleImageLoad = useCallback((slideId: string) => {
    setLoadedSlideIds((current) => {
      if (current.has(slideId)) {
        return current;
      }

      return new Set(current).add(slideId);
    });
  }, []);

  const handleImageError = useCallback(
    (slideId: string) => {
      const failedIndex = availableSlides.findIndex(
        (slide) => slide.id === slideId,
      );
      const remainingSlides = availableSlides.filter(
        (slide) => slide.id !== slideId,
      );

      setFailedSlideIds((current) => new Set(current).add(slideId));
      setLoadedSlideIds((current) => {
        const next = new Set(current);
        next.delete(slideId);
        return next;
      });

      if (slideId === activeSlide?.id) {
        const nextIndex = remainingSlides.length
          ? Math.max(0, failedIndex) % remainingSlides.length
          : 0;
        setActiveSlideId(remainingSlides[nextIndex]?.id ?? null);
        pendingChangeSource.current = null;
      }
    },
    [activeSlide?.id, availableSlides],
  );

  const requestPreviousSlide = () => {
    if (!emblaApi) {
      return;
    }

    pendingChangeSource.current = "previous";
    setIsManuallyPaused(true);
    emblaApi.scrollPrev();
  };

  const requestNextSlide = () => {
    if (!emblaApi) {
      return;
    }

    pendingChangeSource.current = "next";
    setIsManuallyPaused(true);
    emblaApi.scrollNext();
  };

  const requestSlide = (index: number) => {
    if (!emblaApi || index === activeSlideIndex) {
      return;
    }

    pendingChangeSource.current = "pagination";
    setIsManuallyPaused(true);
    emblaApi.scrollTo(index);
  };

  const toggleAutoplay = () => {
    if (isManuallyPaused) {
      setIsManuallyPaused(false);
      setFocusPauseOverridden(true);
      return;
    }

    setIsManuallyPaused(true);
    setFocusPauseOverridden(false);
  };

  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setHasFocusWithin(false);
      setFocusPauseOverridden(false);
    }
  };

  const sharedCopyProps = {
    eyebrow,
    headline,
    primaryAction,
    secondaryAction,
    supportingCopy,
  };

  if (!activeSlide) {
    return <HeroFallback {...sharedCopyProps} />;
  }

  return (
    <section
      aria-label="Featured Kapchi stoles"
      aria-roledescription="carousel"
      className="relative isolate min-h-[var(--hero-min-height)] overflow-hidden bg-[#171614] text-white [--hero-min-height:clamp(28rem,calc(100svh-9rem),48rem)]"
      onBlurCapture={handleBlur}
      onFocusCapture={() => {
        setHasFocusWithin(true);
        setFocusPauseOverridden(false);
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="region"
    >
      <div
        className="absolute inset-0 overflow-hidden"
        id={viewportId}
        ref={emblaRef}
      >
        <div className="flex h-full touch-pan-y">
          {availableSlides.map((slide, index) => {
            const isActive = index === activeSlideIndex;

            return (
              <div
                aria-hidden={!isActive}
                aria-label={`${index + 1} of ${availableSlides.length}`}
                aria-roledescription="slide"
                className="relative min-w-0 flex-[0_0_100%]"
                key={slide.id}
                role="group"
              >
                <ResponsiveHeroImage
                  isInitialSlide={slide.id === validSlides[0]?.id}
                  onError={() => handleImageError(slide.id)}
                  onLoad={() => handleImageLoad(slide.id)}
                  slide={slide}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-0 z-10 bg-black/50" />

      <div className="relative z-20 mx-auto flex min-h-[var(--hero-min-height)] w-full max-w-7xl items-end px-4 pb-24 pt-3 sm:px-6 sm:pb-28 sm:pt-20 md:px-8 lg:px-10 lg:pb-32">
        <div className="pointer-events-auto">
          <HeroCopy {...sharedCopyProps} />
        </div>
      </div>

      {availableSlides.length > 1 ? (
        <div
          aria-label="Carousel controls"
          className="pointer-events-none absolute inset-0 z-30"
          role="group"
        >
          <button
            aria-label="Show previous slide"
            className="pointer-events-auto absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 inline-flex size-11 items-center justify-center rounded-md border border-white/60 bg-black/40 text-white hover:bg-black/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white md:bottom-auto md:top-6 lg:left-6 lg:top-8"
            onClick={requestPreviousSlide}
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={20} strokeWidth={2} />
          </button>

          <button
            aria-label="Show next slide"
            className="pointer-events-auto absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-16 inline-flex size-11 items-center justify-center rounded-md border border-white/60 bg-black/40 text-white hover:bg-black/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white md:bottom-auto md:left-auto md:right-4 md:top-6 lg:right-6 lg:top-8"
            onClick={requestNextSlide}
            type="button"
          >
            <ChevronRight aria-hidden="true" size={20} strokeWidth={2} />
          </button>

          <div className="pointer-events-auto absolute inset-x-0 bottom-0 mx-auto flex w-full max-w-7xl flex-col items-end gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-end sm:justify-between sm:gap-3 sm:px-6 md:px-8 lg:px-10">
            <p className="self-start text-sm font-medium text-white">
              {activeSlide.caption}
            </p>

            <div className="flex shrink-0 items-center gap-1">
              <div
                aria-label="Slides"
                className="flex items-center"
                role="group"
              >
                {availableSlides.map((slide, index) => (
                  <button
                    aria-controls={viewportId}
                    aria-current={
                      index === activeSlideIndex ? "true" : undefined
                    }
                    aria-label={`Go to slide ${index + 1}: ${slide.caption}`}
                    className="inline-flex size-11 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                    key={slide.id}
                    onClick={() => requestSlide(index)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className={`block h-1.5 rounded-full transition-[width,background-color] motion-reduce:transition-none ${
                        index === activeSlideIndex
                          ? "w-6 bg-[#dbc8aa]"
                          : "w-2 bg-white/65"
                      }`}
                    />
                  </button>
                ))}
              </div>

              <button
                aria-label={
                  prefersReducedMotion
                    ? "Automatic rotation disabled by reduced motion preference"
                    : isManuallyPaused
                      ? "Play automatic slide rotation"
                      : "Pause automatic slide rotation"
                }
                className="inline-flex size-11 items-center justify-center rounded-md border border-white/60 bg-black/40 text-white hover:bg-black/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-60"
                disabled={prefersReducedMotion}
                onClick={toggleAutoplay}
                type="button"
              >
                {isManuallyPaused || prefersReducedMotion ? (
                  <CirclePlay aria-hidden="true" size={20} strokeWidth={2} />
                ) : (
                  <CirclePause aria-hidden="true" size={20} strokeWidth={2} />
                )}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="absolute inset-x-0 bottom-0 z-30 mx-auto w-full max-w-7xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 md:px-8 lg:px-10">
          <p className="text-sm font-medium text-white">
            {activeSlide.caption}
          </p>
        </div>
      )}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
