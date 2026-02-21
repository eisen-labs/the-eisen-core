'use client';

import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

const NAV = [
  { label: 'Use cases', section: 'usecases' },
  { label: 'Pricing', section: 'pricing' },
  { label: 'Docs', href: '/docs' },
  { label: 'Login', href: '/login' },
] as const;

export default function Dock() {
  const [highlight, setHighlight] = useState({ left: 0, width: 0, opacity: 0 });
  const navRef = useRef<HTMLUListElement>(null);
  const router = useRouter();

  const updateHighlight = useCallback((label: string | null) => {
    if (!label || !navRef.current) {
      setHighlight((h) => ({ ...h, opacity: 0 }));
      return;
    }
    const btn = navRef.current.querySelector(`[data-item="${label}"]`) as HTMLElement;
    if (!btn) {
      setHighlight((h) => ({ ...h, opacity: 0 }));
      return;
    }
    const navRect = navRef.current.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    setHighlight({ left: btnRect.left - navRect.left, width: btnRect.width, opacity: 0.2 });
  }, []);

  const handleClick = (item: (typeof NAV)[number]) => {
    if ('section' in item) {
      const el = document.getElementById(item.section);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else router.push(`/#${item.section}`);
    } else {
      router.push(item.href);
    }
  };

  return (
    <nav className="relative w-auto rounded-full border border-white/20 bg-white/10 shadow-lg backdrop-blur-md">
      <ul
        ref={navRef}
        className="relative flex items-center p-2"
        onMouseLeave={() => updateHighlight(null)}
      >
        <li className="hidden items-center pl-4 sm:flex">
          <button
            onClick={() =>
              document
                .getElementById('index')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          >
            <Image
              src="/wordmark.svg"
              alt="Logo"
              width={20}
              height={20}
              className="h-5 w-10 translate-y-[0.5px]"
            />
          </button>
          <div className="bg-foreground/25 mr-1 ml-5 h-6 w-px" />
        </li>

        {NAV.map((item) => (
          <li key={item.label}>
            <button
              className="relative px-3 py-1 text-sm font-medium"
              data-item={item.label}
              onClick={() => handleClick(item)}
              onMouseEnter={() => updateHighlight(item.label)}
              onFocus={() => updateHighlight(item.label)}
            >
              {item.label}
            </button>
          </li>
        ))}

        <div
          className="pointer-events-none absolute hidden h-8 rounded-full bg-blue-300 transition-all duration-300 ease-out md:block"
          style={{ left: highlight.left, width: highlight.width, opacity: highlight.opacity }}
        />
      </ul>
    </nav>
  );
}
