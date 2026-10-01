import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AboutNavigation } from "./AboutNavigation";

afterEach(() => vi.unstubAllGlobals());

it("tracks the reading section and activates a short final section at the page bottom", () => {
  const callbacks: (() => void)[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const sections = [
    { id: "creator", navLabel: "Meet the Creator", number: "01" },
    { id: "mission", navLabel: "What We Do", number: "02" },
    { id: "future", navLabel: "What's Next?", number: "03" },
  ];
  render(
    <>
      <AboutNavigation sections={sections} />
      {sections.map((s) => (
        <section key={s.id} id={s.id} />
      ))}
      <footer id="about-page-end" />
    </>,
  );
  const rect = (id: string, top: number, bottom: number) => {
    vi.spyOn(
      document.getElementById(id)!,
      "getBoundingClientRect",
    ).mockReturnValue({
      top,
      bottom,
      left: 0,
      right: 400,
      width: 400,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
  };
  rect("creator", -700, 0);
  rect("mission", 0, 400);
  rect("future", 400, 1400);
  rect("about-page-end", 1400, 1500);
  act(() => callbacks[0]());
  expect(screen.getByRole("link", { name: "What We Do" })).toHaveAttribute(
    "aria-current",
    "location",
  );

  // Future begins below the reading line, but the footer is entirely visible.
  rect("future", 180, window.innerHeight - 80);
  rect("about-page-end", window.innerHeight - 80, window.innerHeight);
  act(() => callbacks[1]());
  expect(screen.getByRole("link", { name: "What's Next?" })).toHaveAttribute(
    "aria-current",
    "location",
  );

  // Scrolling upward leaves the end sentinel and returns to the current section.
  rect("about-page-end", 1400, 1500);
  act(() => callbacks[1]());
  expect(screen.getByRole("link", { name: "What We Do" })).toHaveAttribute(
    "aria-current",
    "location",
  );
  expect(
    screen.getAllByRole("link").filter((a) => a.hasAttribute("aria-current")),
  ).toHaveLength(1);
});
