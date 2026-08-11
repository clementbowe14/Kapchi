# Kapchi Homepage Hero Carousel Specification

## Status

- Stage: implemented for review
- Surface: `client/app/page.tsx`
- Scope: homepage hero and its carousel only
- Implementation: complete; storefront imagery still requires owner approval

## Goal

Replace the current placeholder homepage card with an image-led hero that makes
Kapchi's product and cultural purpose immediately visible. The hero should pair
a stable brand message with a carousel of real Kapchi stole imagery and provide
clear, accessible controls on mobile and desktop.

The first viewport must show the Kapchi navbar, most of the hero, and a visible
hint of the content that follows the hero.

## Approved Headline

> Celebrate your Indigenous culture with authentic Andean stoles.

This copy corrects `andian` to `Andean` and capitalizes `Indigenous`. Before
launch, the product owner must confirm that `authentic` accurately describes the
products, sourcing, and maker relationships shown in the carousel.

Recommended supporting copy:

> Handcrafted graduation stoles designed to honor heritage, achievement, and
> the story you carry forward.

The headline and supporting copy remain in a stable content layer while the
carousel imagery and short slide captions change underneath them. This avoids
layout shifts and keeps the core message readable at all times.

## User Experience

### First Viewport

- Render the hero directly below the existing 80px sticky navbar.
- Use a full-width, edge-to-edge photograph rather than a card or framed image.
- Keep the content aligned to the same `max-w-7xl` page grid as the navbar.
- Place the headline over deliberate negative space in the image, with a
  uniform dark scrim when required for contrast.
- Do not use decorative gradient backgrounds, floating shapes, nested cards, or
  text embedded in the source image.
- Reserve enough height below the hero to reveal at least 32px of the next
  homepage section on common mobile and desktop viewports.

### Content Layout

- Eyebrow: `Kapchi graduation stoles`
- H1: the approved headline above
- Supporting paragraph: the recommended supporting copy above
- Slide caption: one short line tied to the active image
- Primary action: `Shop graduation stoles`
- Secondary action: `Our story`

The primary action should link to `/listings` only after a listing index route
exists. The current frontend does not contain that route. Until then, omit the
primary action instead of shipping a broken or disabled link. The secondary
action links to the existing `/about` route.

### Proposed Slides

Use three slides for the initial release. Each slide must show the real product
clearly and have approval for storefront use.

1. `Heritage in every thread`
   - A close, well-lit view of an Andean stole showing weaving, color, and
     material detail.
2. `Made for your milestone`
   - A graduate wearing a Kapchi stole, with the complete stole visible and
     enough negative space for the hero copy.
3. `Personalized with purpose`
   - A customized stole that clearly shows the available personalization rather
     than a purely atmospheric scene.

The component supports three to five slides. More than five is out of scope
because it weakens discoverability and increases image cost.

## Carousel Behavior

- Start on slide 1 during server rendering and hydration.
- Automatically advance every 7 seconds after the first image has loaded.
- Loop from the final slide back to the first slide.
- Use a restrained crossfade or horizontal slide transition lasting 300-450ms.
- Provide previous, next, pause/play, and direct slide-selection controls.
- Use Lucide icons for previous, next, pause, and play buttons.
- Use fixed-size controls so icon, focus, and active states do not shift layout.
- Pause automatic movement when the user hovers over the hero, focuses an
  interactive element, changes slides manually, or switches the tab away.
- Resume only when the user explicitly presses play after a manual pause.
- Support touch and pointer swiping without intercepting normal vertical page
  scrolling.
- Keep keyboard focus on the control the user activated; never move focus when
  a slide changes.
- Hide carousel controls and disable rotation when there is only one slide.
- If there are no valid slides, render a static branded fallback rather than a
  blank hero.

Use `embla-carousel-react` for the carousel mechanics. Do not implement custom
dragging, snapping, or loop behavior from scratch.

## Responsive Requirements

### Mobile: 320-767px

- Use a portrait-aware crop with the product and subject still visible.
- Place content near the lower-left safe area, above the controls.
- Keep the H1 between 2rem and 2.5rem using breakpoint classes, not viewport
  width-based font scaling.
- Stack available actions vertically or wrap them without truncation.
- Keep every touch control at least 44px by 44px.
- Place pagination and pause/play controls on one stable bottom row.
- Maintain at least 16px horizontal safe space and account for device insets.

### Tablet: 768-1023px

- Keep copy within approximately 60% of the hero width.
- Position previous and next controls at the horizontal edges of the hero.
- Keep the slide caption visually connected to the pagination controls.

### Desktop: 1024px and wider

- Limit the copy block to approximately 42rem.
- Place the copy in the left third to half of the image according to its safe
  area.
- Place pagination, pause/play, and the slide caption along the lower edge.
- Cap the hero at approximately 48rem high on tall displays so following content
  remains visible.

### Short Viewports

- Reduce vertical spacing before reducing type size.
- The content and controls must never overlap.
- The hero may grow with its content when accessibility font scaling makes the
  designed height insufficient.

## Visual Direction

- Let the textiles provide the broad color range; avoid making the interface a
  field of beige or gold.
- Use near-white text over a neutral ink scrim with the existing Kapchi gold
  (`#b49872`) as an accent, not as the entire palette.
- Use square or lightly rounded controls with a maximum 8px radius.
- Use a visible 2px focus treatment that meets contrast requirements.
- Do not put the headline, supporting copy, or actions inside a card.
- Avoid heavy blur over the product. The weave and actual stole must remain
  inspectable.

## Accessibility

- Mark the outer region with `aria-roledescription="carousel"` and an accessible
  name such as `Featured Kapchi stoles`.
- Give each slide `role="group"`, `aria-roledescription="slide"`, and a position
  label such as `2 of 3`.
- Expose only the active slide to assistive technology and keyboard navigation.
- Every control must have a concise accessible name and a visible focus state.
- Announce user-requested slide changes with a polite live region. Do not
  announce automatic rotation.
- Provide specific image alt text describing the stole and relevant visible
  context. Do not repeat the headline as alt text.
- Meet WCAG AA contrast: 4.5:1 for normal text and 3:1 for large text and
  meaningful controls.
- Respect `prefers-reduced-motion`: disable autoplay and use no transition, or a
  near-instant opacity change.
- Rotation must be pausable to satisfy WCAG timing guidance.
- The complete experience must work with Tab, Shift+Tab, Enter, Space, and the
  visible previous/next buttons. Arrow-key shortcuts may be added only when
  focus is within the carousel.

## Asset Requirements

The repository currently contains only the Kapchi logo and no suitable hero
photographs. Approved image assets are an implementation prerequisite.

For each slide provide:

- a source image at least 2400px wide for desktop
- a portrait crop at least 1200px wide for mobile when one source cannot crop
  cleanly across both layouts
- an asset owner and approval status
- descriptive alt text
- desktop and mobile focal positions
- confirmation that the represented product and cultural claims are accurate

Store optimized source files under `client/public/images/hero/`. Use meaningful
names such as `woven-stole-detail.webp`; do not use `slide-1.webp`.

Use `next/image` with explicit responsive `sizes`. Load slide 1 with high
priority and lazy-load later slides. Do not preload every carousel image.

## Component Contract

```ts
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
```

Keep slide content in a typed data module rather than embedding repeated markup
inside the component. Reject duplicate slide IDs during development.

## Proposed File Changes

- `client/components/HeroCarousel.tsx`
  - Client component that owns Embla state, controls, pause behavior, and live
    announcements.
- `client/components/HeroCarousel.test.tsx`
  - Interaction, accessibility, reduced-motion, and fallback tests.
- `client/content/home-hero.ts`
  - Typed copy, slide metadata, image paths, and focal positions.
- `client/app/page.tsx`
  - Server-rendered homepage composition and hero integration.
- `client/app/globals.css`
  - Only shared tokens or reduced-motion rules that cannot remain component
    classes.
- `client/public/images/hero/*`
  - Approved raster assets.
- `client/package.json` and `client/package-lock.json`
  - Add `embla-carousel-react` and `lucide-react`.

Update the root metadata description so it describes Kapchi rather than the
current Clerk authentication placeholder.

## Loading and Failure States

- First render: show slide 1 immediately with reserved dimensions; do not show a
  spinner over an empty region.
- Later image loading: retain the active image until the requested image is
  ready, then transition.
- Image failure: skip the failed slide. If all images fail, render a static ink
  background with the Kapchi logo, headline, and working secondary action.
- JavaScript unavailable: slide 1, the core copy, and actions remain usable.
- Hydration: server and client must agree on slide 1 to avoid mismatch or visual
  movement.

## Analytics Contract

Do not add a new analytics vendor as part of this component. If an application
analytics adapter exists when implementation begins, emit:

- `hero_slide_view`: slide ID, slide index, and change source
- `hero_carousel_control`: control type and slide ID
- `hero_cta_click`: action label, destination, and active slide ID

The change source is one of `autoplay`, `previous`, `next`, `pagination`, or
`swipe`. Do not include user, order, cart, or free-form content in these events.

## Test Plan

### Automated Component Tests

- Renders the approved headline and supporting copy.
- Renders slide 1 during the initial pass.
- Previous, next, and pagination controls select the expected slide.
- Previous and next controls wrap at the carousel boundaries.
- Pause stops rotation and play restarts it.
- Manual interaction leaves rotation paused until play is pressed.
- Reduced-motion preference disables rotation.
- Focus remains on the activated control after a slide change.
- User-requested changes update the live region; autoplay changes do not.
- A one-slide configuration hides unnecessary controls.
- Empty and failed-slide configurations render the static fallback.
- Optional primary and secondary actions never render with empty destinations.

### Page and Visual Verification

- Run `npm run lint`, `npm test`, and `npm run build` in `client`.
- Verify at 320x568, 390x844, 768x1024, 1280x800, and 1440x900.
- Confirm there is no copy/control overlap at 200% browser zoom.
- Confirm keyboard-only navigation and reduced-motion behavior.
- Confirm slide 1 is the Largest Contentful Paint candidate and no hero element
  shifts after hydration.
- Confirm only slide 1 is eagerly downloaded on first load.
- Confirm all images preserve product visibility at each breakpoint.
- Confirm no broken image, console error, hydration warning, or broken link.

## Acceptance Criteria

- [ ] The placeholder homepage card is replaced by the hero carousel.
- [ ] The H1 reads `Celebrate your Indigenous culture with authentic Andean
      stoles.`
- [ ] The hero uses approved Kapchi product imagery and shows the actual stoles
      clearly.
- [ ] Three slides render with meaningful captions and alt text.
- [ ] Previous, next, pagination, and pause/play controls work with mouse,
      keyboard, and touch.
- [ ] Autoplay uses a 7-second interval and respects hover, focus, visibility,
      user pause, and reduced-motion states.
- [ ] The hero is responsive from 320px through wide desktop without overlap,
      truncation, or layout shift.
- [ ] The navbar remains usable and a hint of the following section is visible
      in common first viewports.
- [ ] All text and controls meet WCAG AA contrast and focus requirements.
- [ ] No action links to an unimplemented route.
- [ ] Component tests cover navigation, timing, accessibility, and fallback
      behavior.
- [ ] Client lint, tests, and production build pass.

## Reviewable Implementation Breakdown

### 1. Content, Assets, and Static Hero Frame

- Approve the headline, supporting copy, cultural claims, and three image sets.
- Add typed slide data and optimized assets.
- Replace the placeholder homepage with the server-rendered first slide and
  responsive content frame.
- Verify layout, image crops, contrast, and metadata before adding movement.

### 2. Carousel Interaction and Accessibility

- Add Embla and Lucide dependencies.
- Implement controls, looping, autoplay, pause/resume, swipe, live
  announcements, reduced motion, and fallback behavior.
- Add focused component tests for every interaction and accessibility state.

### 3. Integration, Performance, and Visual QA

- Connect working actions and omit unavailable destinations.
- Tune responsive focal positions and loading priority.
- Run lint, tests, build, keyboard checks, viewport screenshots, and loading
  verification.
- Resolve all overlap, contrast, hydration, and layout-shift findings before
  review.

## Out of Scope

- Building the `/listings` index route
- Product detail pages
- Admin-managed hero content or a CMS
- Backend schema or API changes
- New analytics infrastructure
- A broader homepage redesign below the hero
