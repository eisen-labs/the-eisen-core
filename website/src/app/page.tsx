'use client';

import FloatingLogo from '@/components/floating-logo';
import Dock from '@/components/dock';
import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <nav className="fixed top-4 left-1/2 z-20 -translate-x-1/2 transform">
        <Dock />
      </nav>
      <main className="flex flex-1 flex-col">
        <section
          id="index"
          className="relative flex h-[900px] items-start justify-center p-4 pt-60"
        >
          <FloatingLogo showControls={true} />
          <div className="pointer-events-none relative z-10 mx-auto px-4 text-center select-none">
            <h1 className="mb-4 font-serif text-5xl md:text-6xl lg:text-7xl xl:text-7xl">
              Your{' '}
              <em
                className="text-white"
                style={{
                  textShadow:
                    '0 0 20px rgba(255,255,255,0.3), 0 0 40px rgba(255,255,255,0.2), 0 0 60px rgba(255,255,255,0.1)',
                }}
              >
                private
              </em>
              <br />
              AI Infrastructure
            </h1>
            <p className="mx-auto max-w-xs text-sm text-gray-600 sm:max-w-sm md:text-lg lg:text-xl dark:text-gray-300">
              Dedicated LLMs with fixed costs, better latency and complete data security.
            </p>
          </div>
        </section>

        <section id="usecases" className="mx-auto w-full max-w-3xl px-6 pt-16 pb-8">
          <div className="mb-6 flex flex-col items-start justify-between gap-2 md:flex-row md:items-baseline">
            <h2 className="text-2xl">Why Constellation?</h2>
            <p className="text-foreground/60">
              Built for teams that need simplicity, privacy, and compliance.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            <div className="border-foreground/10 rounded-xl border p-6">
              <div className="bg-foreground/10 mb-3 flex h-12 w-12 items-center justify-center rounded-lg text-2xl">
                💰
              </div>
              <h3 className="mb-2 text-lg font-semibold">Simple Cost Structure</h3>
              <p className="text-foreground/70 text-sm">
                Flat monthly fees. No variable usage-per-token costs.
              </p>
            </div>

            <div className="border-foreground/10 rounded-xl border p-6">
              <div className="bg-foreground/10 mb-3 flex h-12 w-12 items-center justify-center rounded-lg text-2xl">
                🔒
              </div>
              <h3 className="mb-2 text-lg font-semibold">Complete Privacy</h3>
              <p className="text-foreground/70 text-sm">
                Your data never leaves your infrastructure. Complete data sovereignty with dedicated
                Servers.
              </p>
            </div>

            <div className="border-foreground/10 rounded-xl border p-6">
              <div className="bg-foreground/10 mb-3 flex h-12 w-12 items-center justify-center rounded-lg text-2xl">
                🇪🇺
              </div>
              <h3 className="mb-2 text-lg font-semibold">EU-Grade Compliance</h3>
              <p className="text-foreground/70 text-sm">
                GDPR compliant. SOC 2 ready. Enterprise-grade security and compliance.
              </p>
            </div>
          </div>
        </section>

        <section id="pricing" className="flex min-h-[600px] items-center justify-center py-8">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-center px-6">
            <div className="w-full">
              <div className="mb-6 flex flex-col items-start justify-between gap-2 md:flex-row md:items-baseline">
                <h2 className="text-2xl">Simple, predictable pricing</h2>
                <p className="text-foreground/60">
                  Choose your LLM. Pay a flat monthly fee. No token costs.
                </p>
              </div>

              <div className="border-foreground/10 mt-8 rounded-2xl border p-6">
                <div className="grid gap-6 sm:grid-cols-5">
                  <div className="sm:col-span-3">
                    <label className="text-foreground/60 mb-2 block text-sm">Model</label>
                    <div className="group border-foreground/10 flex items-center justify-between rounded-xl border p-3">
                      <div>
                        <div className="font-medium">Llama 3.1</div>
                        <div className="text-foreground/60 text-xs">100k token context window</div>
                      </div>
                      <span className="text-foreground/40">▼</span>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <span className="bg-foreground/10 rounded-full px-2 py-0.5 text-xs">
                        Anthropic
                      </span>
                      <span className="bg-foreground/10 rounded-full px-2 py-0.5 text-xs">
                        OpenAI
                      </span>
                      <span className="bg-foreground/10 rounded-full px-2 py-0.5 text-xs">
                        Meta
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col items-start justify-between sm:col-span-2">
                    <div>
                      <div className="text-foreground/60 text-sm">Flat monthly</div>
                      <div className="text-4xl font-semibold tracking-tight">$20</div>
                    </div>
                    <button className="mt-2 inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-black">
                      Get started
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-8">
                <div className="text-foreground/60 mb-6 text-center text-sm">
                  Recent open‑source models
                </div>
                <div className="relative overflow-hidden">
                  <div className="marquee flex w-max items-stretch gap-8">
                    {['Llama 3.1 8B', 'Mistral 7B', 'Mixtral 8x7B', 'Qwen2.5 7B'].map((name) => (
                      <div key={`a-${name}`} className="flex w-32 flex-col items-center">
                        <div className="bg-foreground/10 flex h-12 w-12 items-center justify-center rounded-full text-sm">
                          {name.split(' ')[0].slice(0, 1)}
                        </div>
                        <div className="text-foreground/70 mt-2 text-center text-xs">{name}</div>
                      </div>
                    ))}
                    {['Llama 3.1 8B', 'Mistral 7B', 'Mixtral 8x7B', 'Qwen2.5 7B'].map((name) => (
                      <div key={`b-${name}`} className="flex w-32 flex-col items-center">
                        <div className="bg-foreground/10 flex h-12 w-12 items-center justify-center rounded-full text-sm">
                          {name.split(' ')[0].slice(0, 1)}
                        </div>
                        <div className="text-foreground/70 mt-2 text-center text-xs">{name}</div>
                      </div>
                    ))}
                  </div>
                  <div className="from-background pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r"></div>
                  <div className="from-background pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l"></div>
                </div>
              </div>
              <style jsx>{`
                .marquee {
                  animation: marquee 25s linear infinite;
                }
                @keyframes marquee {
                  0% {
                    transform: translateX(0);
                  }
                  100% {
                    transform: translateX(-50%);
                  }
                }
              `}</style>
            </div>
          </div>
        </section>

        <section id="announcements" className="flex items-center justify-center py-8">
          <div className="mx-auto flex w-full max-w-3xl items-start justify-center px-6">
            <div className="w-full">
              <div className="mb-6 flex items-baseline justify-between">
                <h2 className="text-2xl">Recent Announcements</h2>
                <Link className="text-foreground/70" href="/announcements">
                  View all →
                </Link>
              </div>
              <ul className="flex flex-col gap-4">
                <li className="border-foreground/10 rounded-2xl border p-5">
                  <div className="text-lg font-medium">Is LLM caching implicit or explicit?</div>
                  <p className="text-foreground/60 mt-1">
                    Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
                    incididunt ut labore et dolore magna aliqua.
                  </p>
                  <div className="text-foreground/50 mt-3 flex items-center gap-2 text-xs">
                    <span>23/10/2025</span>
                    <span className="bg-foreground/10 rounded-full px-2 py-0.5">New</span>
                  </div>
                </li>
                <li className="border-foreground/10 rounded-2xl border p-5">
                  <div className="text-lg font-medium">Inference Latency</div>
                  <p className="text-foreground/60 mt-1">
                    Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
                    incididunt ut labore et dolore magna aliqua.
                  </p>
                  <div className="text-foreground/50 mt-3 flex items-center gap-2 text-xs">
                    <span>21/10/2025</span>
                    <span className="bg-foreground/10 rounded-full px-2 py-0.5">New</span>
                  </div>
                </li>
                <li className="border-foreground/10 rounded-2xl border p-5">
                  <div className="text-lg font-medium">About Constellation</div>
                  <p className="text-foreground/60 mt-1">
                    Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
                    incididunt ut labore et dolore magna aliqua.
                  </p>
                  <div className="text-foreground/50 mt-3 flex items-center gap-2 text-xs">
                    <span>01/10/2025</span>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer>
        <div className="text-foreground/50 p-8 text-center text-sm">
          &copy; {new Date().getFullYear()} Constellation. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
