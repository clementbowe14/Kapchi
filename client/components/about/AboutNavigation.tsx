"use client";

import { useEffect, useRef, useState } from "react";

type SectionLink = { id: string; navLabel: string; number: string };

/** Observe a reading line below both sticky headers; no continuous scroll handler. */
export function AboutNavigation({
  sections,
}: {
  sections: readonly SectionLink[];
}) {
  const [activeId, setActiveId] = useState(sections[0].id);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const elements = sections
      .map(({ id }) => document.getElementById(id))
      .filter((element): element is HTMLElement => !!element);
    let observer: IntersectionObserver | undefined;
    let endObserver: IntersectionObserver | undefined;
    const pageEnd = document.getElementById("about-page-end");
    let frame = 0;
    const updateObserver = () => {
      observer?.disconnect();
      endObserver?.disconnect();
      const mobile = window.matchMedia("(max-width: 760px)").matches;
      const readingLine = Math.min(
        window.innerHeight - 1,
        80 + (mobile ? (navRef.current?.offsetHeight ?? 64) : 0) + 32,
      );
      // A short final section may never reach the reading line on a tall screen.
      const updateActive = () => {
        const end = pageEnd?.getBoundingClientRect();
        if (end && end.top >= 0 && end.bottom <= window.innerHeight + 1) {
          setActiveId(sections[sections.length - 1].id);
          return;
        }
        const current = elements
          .filter(
            (element) => element.getBoundingClientRect().top <= readingLine,
          )
          .at(-1);
        setActiveId(current?.id ?? sections[0].id);
      };
      updateActive();
      observer = new IntersectionObserver(updateActive, {
        rootMargin:
          "-" +
          readingLine +
          "px 0px -" +
          Math.max(0, window.innerHeight - readingLine - 1) +
          "px 0px",
        threshold: 0,
      });
      endObserver = new IntersectionObserver(updateActive, { threshold: 1 });
      if (pageEnd) endObserver.observe(pageEnd);
      elements.forEach((element) => observer?.observe(element));
    };
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateObserver);
    };
    updateObserver();
    window.addEventListener("resize", scheduleUpdate);
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    if (navRef.current) resizeObserver.observe(navRef.current);
    return () => {
      observer?.disconnect();
      endObserver?.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      cancelAnimationFrame(frame);
    };
  }, [sections]);

  return (
    <nav ref={navRef} className="about-nav" aria-label="Our story sections">
      <p className="about-nav-caption">OUR STORY</p>
      <div className="about-nav-links">
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={activeId === section.id ? "location" : undefined}
          >
            <span aria-hidden="true">{section.number}</span>
            {section.navLabel}
          </a>
        ))}
      </div>
      <p className="about-nav-note">
        Rooted in heritage.
        <br />
        Carried with love.
      </p>
    </nav>
  );
}
