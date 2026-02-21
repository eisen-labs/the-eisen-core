import DemoBox from '@/components/demo-box';
import Logo from '@/components/logo';
import Wordmark from '@/components/wordmark';
import StatusBar from '@/components/status-bar';

const team = [
  { face: ':)', handle: '@georg' },
  { face: ';)', handle: '@harj' },
  { face: ':D', handle: '@max' },
  { face: ':P', handle: '@seb' },
];

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center px-6 font-sans">
      {/* Logo */}
      <header className="fade-up flex items-center gap-2 pt-14 pb-10 md:gap-3 md:pt-16 md:pb-12">
        <Wordmark className="marquee-logo h-10 md:h-14" />
        <Logo className="marquee-logo h-8 md:h-11" />
      </header>

      <div className="w-full max-w-[500px]">
        {/* Intro */}
        <section className="fade-up">
          <p className="text-muted mt-4 text-justify text-sm">
            Real-time observability for AI coding agents. We make the invisible visible. Every file,
            token and decision your agent makes, surfaced in your editor.
          </p>
        </section>

        {/* Demo */}
        <section className="fade-up mt-16">
          <DemoBox />
        </section>

        {/* Vision */}
        <section className="fade-up mt-16">
          <p className="text-sm font-medium">Vision</p>
          <p className="text-muted mt-4 text-justify text-sm">
            Agent knowledge shouldn&apos;t be a black box. Eisenlabs brings full observability and
            transparency to AI-assisted development. See every file your agent reads, every token it
            spends and every decision it makes. Works with Claude Code, Open Code, Codex and any
            custom API.
          </p>
        </section>

        {/* Team */}
        <section className="fade-up mt-16">
          <p className="text-sm font-medium">Team</p>
          <p className="text-muted mt-4 text-justify text-sm">
            Small team with a purely technical focus. We build developer tools because we use them
            ourselves. No managers, no meetings. Just engineering.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {team.map((member, i) => (
              <div
                key={i}
                className="bg-foreground/[0.03] flex aspect-square flex-col items-center justify-between rounded-2xl px-4 pt-4 pb-2"
              >
                <div />
                <span className="text-muted text-lg">{member.face}</span>
                <span className="text-muted text-sm">{member.handle}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="pb-32" />
      </div>

      <StatusBar />
    </div>
  );
}
