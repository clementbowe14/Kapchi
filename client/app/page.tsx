import { HeroCarousel } from "@/components/HeroCarousel";
import { homeHeroContent } from "@/content/home-hero";

export default function Home() {
  return (
    <main className="bg-white">
      <HeroCarousel {...homeHeroContent} />

      <section
        aria-labelledby="craftsmanship-heading"
        className="min-h-40 border-t border-black/10 bg-white pb-10 pt-3 sm:pb-14 sm:pt-4"
      >
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <p className="text-xs font-semibold uppercase text-[#8f734f]">
            Made to carry meaning
          </p>
          <h2
            className="mt-2 max-w-2xl text-2xl font-semibold leading-tight text-[#171614] sm:text-3xl"
            id="craftsmanship-heading"
          >
            Stoles that honor where you come from and where you are going.
          </h2>
        </div>
      </section>
    </main>
  );
}
