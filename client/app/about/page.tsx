import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { AboutNavigation } from "@/components/about/AboutNavigation";
import { aboutSections } from "@/content/about";
import "./about.css";

export const metadata: Metadata = {
  title: "Our Story | Kapchi",
  description:
    "Meet Bianca Poma, the creator of Kapchi, and discover the story behind our customized Indigenous graduation stoles.",
};

export default function AboutPage() {
  const [founder, mission, future] = aboutSections;
  return (
    <main className="kapchi-about">
      <header className="about-intro">
        <div className="about-intro-inner">
          <p className="about-eyebrow">
            <span aria-hidden="true" /> THE STORY BEHIND THE STOLE
          </p>
          <h1>
            Rooted in heritage.
            <br />
            <em>Made for your story.</em>
          </h1>
          <p>
            A little piece of where you come from,
            <br className="about-desktop-break" /> for the moment you step into
            what’s next.
          </p>
          <div className="about-intro-bottom">
            <span>WITH LOVE, KAPCHI</span>
            <a href="#meet-the-creator">
              Get to know us <span aria-hidden="true">↓</span>
            </a>
          </div>
        </div>
        <div className="about-thread" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      </header>

      <div className="about-story-layout">
        <AboutNavigation sections={aboutSections} />
        <div className="about-chapters">
          <section
            id={founder.id}
            className="about-chapter about-founder"
            aria-labelledby="founder-heading"
            tabIndex={-1}
          >
            <div className="about-chapter-label">
              <span>{founder.number}</span>
              <p className="about-eyebrow">{founder.eyebrow}</p>
            </div>
            <h2 id="founder-heading">{founder.title}</h2>
            <div className="about-founder-grid">
              <figure className="about-founder-image">
                <div className="about-image-frame">
                  <Image
                    src="/images/about/peruvian-andes.jpg"
                    alt="Terraced fields and a village beneath the mountains of the Peruvian Andes."
                    fill
                    sizes="(max-width: 760px) 90vw, (max-width: 1100px) 36vw, 390px"
                    className="about-photo"
                    priority
                  />
                </div>
                <figcaption>
                  <span>The Peruvian Andes, where Kapchi’s story is rooted.</span>
                  <span aria-hidden="true">↗</span>
                </figcaption>
              </figure>
              <div className="about-founder-copy">
                <p className="about-founder-name">Hi, I’m {founder.name}.</p>
                {founder.paragraphs.map((p) => (
                  <p key={p}>{p}</p>
                ))}
                <div className="about-signature">
                  <span>Much love,</span>
                  <span>Bianca</span>
                  <small>FOUNDER OF KAPCHI</small>
                </div>
              </div>
            </div>
          </section>

          <section
            id={mission.id}
            className="about-chapter about-mission"
            aria-labelledby="mission-heading"
            tabIndex={-1}
          >
            <div className="about-chapter-label">
              <span>{mission.number}</span>
              <p className="about-eyebrow">{mission.eyebrow}</p>
            </div>
            <h2 id="mission-heading">{mission.title}</h2>
            <div className="about-mission-grid">
              <div className="about-mission-copy">
                <p className="about-section-lead">{mission.lead}</p>
                {mission.paragraphs.map((p) => (
                  <p key={p}>{p}</p>
                ))}
                <Link href="/listings" className="about-shop-link">
                  Find your graduation stole <span aria-hidden="true">↗</span>
                </Link>
              </div>
              <figure className="about-mission-image">
                <Image
                  src="/images/hero/personalized-woven-stole.webp"
                  alt="A purple woven stole with gold personalization on a tailor’s form beside spools of thread."
                  fill
                  sizes="(max-width: 760px) 90vw, (max-width: 1100px) 35vw, 360px"
                  className="about-photo"
                />
              </figure>
            </div>
            <div className="about-values" aria-label="What matters to us">
              <span>Honor your roots.</span>
              <span>Make it yours.</span>
              <span>Carry it forward.</span>
            </div>
          </section>

          <section
            id={future.id}
            className="about-chapter about-future"
            aria-labelledby="future-heading"
            tabIndex={-1}
          >
            <div className="about-chapter-label">
              <span>{future.number}</span>
              <p className="about-eyebrow">{future.eyebrow}</p>
            </div>
            <h2 id="future-heading">{future.title}</h2>
            <p className="about-section-lead">{future.lead}</p>
            <div className="about-future-copy">
              {future.paragraphs.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
            <div className="about-future-directions">
              <div>
                <span aria-hidden="true">01 /</span>
                <h3>Opening doors</h3>
                <p>A vision for future scholarships.</p>
              </div>
              <div>
                <span aria-hidden="true">02 /</span>
                <h3>Growing together</h3>
                <p>A vision for community programs.</p>
              </div>
            </div>
            <div className="about-closing">
              <span aria-hidden="true">♡</span>
              <p>Thank you for being part of our story.</p>
              <span className="about-wordmark">Kapchi</span>
            </div>
          </section>
        </div>
      </div>
      <div id="about-page-end" aria-hidden="true" className="h-px" />
    </main>
  );
}
