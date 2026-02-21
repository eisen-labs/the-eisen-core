'use client';

import { useEffect, useState } from 'react';

function formatTime(timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(new Date());
}

function useTime(timeZone: string) {
  const [time, setTime] = useState(() => formatTime(timeZone));

  useEffect(() => {
    const id = setInterval(() => setTime(formatTime(timeZone)), 1000);
    return () => clearInterval(id);
  }, [timeZone]);

  return time;
}

export default function StatusBar() {
  const stockholm = useTime('Europe/Stockholm');
  const sf = useTime('America/Los_Angeles');

  return (
    <div className="fixed right-0 bottom-0 left-0 z-40 flex items-center justify-center px-6 py-4 font-mono text-xs tracking-wider uppercase md:grid md:grid-cols-3">
      <span
        suppressHydrationWarning
        className="text-muted hidden text-left whitespace-nowrap md:block"
      >
        {stockholm && `Stockholm ${stockholm}`}
      </span>
      <a href="mailto:team@eisenlabs.com" className="text-muted hover:text-foreground text-center">
        Contact
      </a>
      <span
        suppressHydrationWarning
        className="text-muted hidden text-right whitespace-nowrap md:block"
      >
        {sf && `SF ${sf}`}
      </span>
    </div>
  );
}
