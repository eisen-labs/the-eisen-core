import LogoMarquee from '@/components/logo-marquee';
import WaitlistForm from '@/components/waitlist-form';

export default function Home() {
  return (
    <>
      <div className="flex min-h-screen flex-col justify-center px-8 py-6 md:px-24 lg:px-32">
        <h1 className="mb-6 font-serif text-4xl sm:text-5xl md:text-6xl">
          See your AI agents work.
        </h1>
        <p className="max-w-2xl text-base md:text-lg">
          AI agents are rewriting your codebase, but their context, permissions, and decision-making
          are completely invisible.{' '}
          <span>As context windows grow, so do your costs. You have no way to see why.</span>
        </p>
        <p className="mt-4 max-w-2xl text-base md:text-lg">
          Agent knowledge shouldn&apos;t be a black box.
        </p>
        <p className="mt-4 mb-8 max-w-2xl text-base md:text-lg">
          <span>
            EisenLabs brings full observability and transparency to AI-assisted development.
          </span>{' '}
          See every file your agent reads, every token it spends, and every decision it makes
          &mdash; all in real time, right in your editor. Works with the agents you already use.
        </p>
        <div className="mb-10 max-w-xl">
          <LogoMarquee
            items={[
              { src: '/brands/anthropic.svg', alt: 'Anthropic', height: 30 },
              { src: '/brands/openai.svg', alt: 'OpenAI', height: 40, offsetY: 4 },
              { src: '/brands/cursor.svg', alt: 'Cursor', height: 30 },
              { src: '/brands/opencode.svg', alt: 'OpenCode', height: 40 },
            ]}
          />
        </div>
        <WaitlistForm />
      </div>
      <div className="text-foreground/50 fixed right-6 bottom-6 text-sm">
        &copy; {new Date().getFullYear()} EisenLabs. All rights reserved.
      </div>
    </>
  );
}
