'use client';

import { useEffect, useState } from 'react';

function useTime(timeZone: string) {
  const [time, setTime] = useState('');

  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

    const tick = () => setTime(fmt.format(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timeZone]);

  return time;
}

export default function StatusBar() {
  const stockholm = useTime('Europe/Stockholm');
  const sf = useTime('America/Los_Angeles');

  return (
    <div className="fade-up fixed right-0 bottom-0 left-0 z-40 flex items-center justify-center px-6 py-4 font-mono text-xs uppercase tracking-wider md:grid md:grid-cols-3">
      <span className="hidden whitespace-nowrap text-left text-muted md:block">
        {stockholm && `Stockholm ${stockholm}`}
      </span>
      <a
        href="mailto:team@eisenlabs.com"
        className="text-center text-muted hover:text-foreground"
      >
        Contact
      </a>
      <span className="hidden whitespace-nowrap text-right text-muted md:block">
        {sf && `SF ${sf}`}
      </span>
    </div>
  );
}
