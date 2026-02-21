import LogoMarquee from '@/components/logo-marquee';

export default function Home() {
  return (
    <>
      <div className="grid min-h-screen grid-cols-1 gap-6 p-6 md:grid-cols-2">
        <div className="bg-foreground/5 order-2 hidden rounded-2xl md:order-1 md:block" />

        <div className="order-1 flex flex-col justify-center px-2 md:order-2 md:px-6 md:pt-0">
          <h1 className="mb-6 font-serif text-4xl sm:text-5xl md:text-6xl">
            See your AI agents work.
          </h1>
          <p className="text-base md:text-lg">Your agent&apos;s context and permissions</p>
          <p className="text-base text-white md:text-lg">
            are invisible &mdash; and you can&apos;t change them.
          </p>

          <div className="bg-foreground/5 border-foreground/10 my-8 aspect-video rounded-2xl border md:hidden" />

          <p className="mt-0 text-base md:mt-4 md:text-lg">
            We provide the observability layer your AI workflow is missing.
          </p>
          <p className="mb-8 text-base md:text-lg">
            Works with the agents you already use, in your editor.
          </p>
          <div className="mb-10">
            <LogoMarquee
              items={[
                { src: '/brands/anthropic.svg', alt: 'Anthropic', height: 30 },
                { src: '/brands/openai.svg', alt: 'OpenAI', height: 40, offsetY: 4 },
                { src: '/brands/cursor.svg', alt: 'Cursor', height: 30 },
                { src: '/brands/opencode.svg', alt: 'OpenCode', height: 40 },
              ]}
            />
          </div>
          <a
            href="#"
            className="inline-flex w-fit rounded-lg bg-white px-4 py-1.5 text-sm font-medium text-black transition-colors hover:bg-gray-300"
          >
            Join the waitlist
          </a>
          <p className="text-foreground/50 mt-12 text-sm md:hidden">
            &copy; {new Date().getFullYear()} Eisen. All rights reserved.
          </p>
        </div>
      </div>
      <div className="text-foreground/50 fixed right-6 bottom-6 hidden text-sm md:block">
        &copy; {new Date().getFullYear()} Eisen. All rights reserved.
      </div>
    </>
  );
}
