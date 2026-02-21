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
        <img src="/wordmark.svg" alt="Eisenlabs" className="marquee-logo h-10 md:h-14" />
        <img src="/logo.svg" alt="" className="marquee-logo h-8 md:h-11" />
      </header>

      <div className="w-full max-w-[500px]">
        {/* Intro */}
        <section className="fade-up" style={{ animationDelay: '50ms' }}>
          <p className="mt-4 text-justify text-sm text-muted">
            Real-time observability for AI coding agents. We make the invisible visible. Every
            file, token and decision your agent makes, surfaced in your editor.
          </p>
        </section>

        {/* Demo */}
        <section className="fade-up mt-16" style={{ animationDelay: '100ms' }}>
          <p className="text-sm font-medium">Demo</p>
          <div className="mt-4 aspect-video rounded-2xl bg-foreground/[0.03]" />
        </section>

        {/* Vision */}
        <section className="fade-up mt-16" style={{ animationDelay: '150ms' }}>
          <p className="text-sm font-medium">Vision</p>
          <p className="mt-4 text-justify text-sm text-muted">
            Agent knowledge shouldn&apos;t be a black box. Eisenlabs brings full observability and
            transparency to AI-assisted development. See every file your agent reads, every token it
            spends and every decision it makes. Works with Claude Code, Open Code, Codex and any
            custom API.
          </p>
        </section>

        {/* Team */}
        <section className="fade-up mt-16" style={{ animationDelay: '200ms' }}>
          <p className="text-sm font-medium">Team</p>
          <p className="mt-4 text-justify text-sm text-muted">
            Small team with a purely technical focus. We build developer tools because we use them
            ourselves. No managers, no meetings. Just engineering.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {team.map((member, i) => (
              <div
                key={i}
                className="flex aspect-square flex-col items-center justify-between rounded-2xl bg-foreground/[0.03] px-4 pt-4 pb-2"
              >
                <div />
                <span className="text-lg text-muted">{member.face}</span>
                <span className="text-sm text-muted">{member.handle}</span>
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
