import FloatingLogo from '@/components/floating-logo';
import Dock from '@/components/dock';

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
            <h1 className="mb-4 font-serif text-7xl">
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
            <p className="text-xl text-gray-600 dark:text-gray-300">
              Dedicated LLMs with fixed costs, better latency <br />
              and complete data security.
            </p>
          </div>
        </section>

        <section id="usecases" className="flex h-[800px] items-center justify-center">
          <div className="mx-auto flex h-[800px] w-full max-w-3xl items-center justify-center border px-4">
            <h2 className="text-2xl">Use Cases</h2>
          </div>
        </section>

        <section id="pricing" className="flex h-[800px] items-center justify-center">
          <div className="mx-auto flex h-[800px] w-full max-w-3xl items-center justify-center border px-4">
            <h2 className="text-2xl">Pricing</h2>
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
