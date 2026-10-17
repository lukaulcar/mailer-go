import { ArrowRight } from "lucide-react";
import { GithubMark } from "./Header";
import { Reveal } from "./Reveal";

export default function Hero({ onAuth }: { onAuth: (mode: "signup" | "login") => void }) {
  return (
    <section className="relative overflow-hidden bg-white" aria-labelledby="hero-heading">
      
      <div className="bg-grid mask-fade-y pointer-events-none absolute inset-0" aria-hidden="true" />

      
      <div className="relative mx-auto flex min-h-svh w-full max-w-6xl flex-col items-center justify-center px-5 pb-10 pt-32 md:px-8 md:pt-36">
        <div className="mx-auto max-w-4xl text-center">
          <Reveal>
            <a
              href="https://github.com/lukaulcar/mailer-go"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white/80 py-1 pl-1 pr-3 text-[12.5px] font-medium text-neutral-600 shadow-[0_1px_2px_rgb(0_0_0/0.04)] backdrop-blur transition-colors hover:border-neutral-400 hover:text-neutral-950"
            >
              <span className="rounded-full bg-neutral-950 px-2 py-0.5 font-mono text-[10.5px] font-medium uppercase tracking-wider text-white">
                MIT
              </span>
              Open source · Go + React
              <span aria-hidden="true">→</span>
            </a>
          </Reveal>

          <Reveal delay={80}>
            <h1
              id="hero-heading"
              className="mt-7 text-balance text-[40px] font-semibold leading-[1.0] tracking-[-0.04em] text-neutral-950 min-[480px]:text-[48px] sm:text-[76px] md:text-[96px] lg:text-[108px]"
            >
              Email infrastructure
              <br className="hidden sm:block" />
              <span className="font-accent">you actually own.</span>
            </h1>
          </Reveal>

          <Reveal delay={160}>
            <p className="mx-auto mt-6 max-w-[600px] text-pretty text-[16px] leading-relaxed text-neutral-500 md:text-[18px]">
              Domains with live DNS verification, mailboxes with webmail, templates,
              scoped API keys and webhooks. One <span className="font-mono text-[0.92em] text-neutral-800">POST /v1/send</span> to send.
            </p>
          </Reveal>

          <Reveal delay={220}>
            <div className="mt-9 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
              <button
                onClick={() => onAuth("signup")}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-neutral-950 px-8 text-[14.5px] font-medium text-white shadow-[0_8px_24px_-8px_rgb(0_0_0/0.35)] transition-all hover:bg-neutral-800 hover:shadow-[0_8px_28px_-8px_rgb(0_0_0/0.45)] active:scale-[0.99] sm:w-auto"
              >
                Get started free
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
              <a
                href="https://github.com/lukaulcar/mailer-go"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border border-neutral-200 bg-white px-8 text-[14.5px] font-medium text-neutral-900 transition-colors hover:border-neutral-950 sm:w-auto"
              >
                <GithubMark className="h-4 w-4" />
                Star on GitHub
              </a>
            </div>
            <p className="mt-5 font-mono text-[11.5px] tracking-tight text-neutral-400">
              Self-host · No limits in code · Export anytime
            </p>
          </Reveal>
        </div>

        <Reveal delay={300} className="pb-8 pt-14">
          <a
            href="#preview"
            className="group flex flex-col items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.22em] text-neutral-400 transition-colors hover:text-neutral-900"
            aria-label="Scroll to product"
          >
            Scroll
            <span className="block h-8 w-px overflow-hidden bg-neutral-200" aria-hidden="true">
              <span className="scroll-cue block h-3 w-px bg-neutral-900" />
            </span>
          </a>
        </Reveal>
      </div>
    </section>
  );
}
