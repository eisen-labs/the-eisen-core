'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

const NAV = ['Use cases', 'Pricing', 'Docs', 'Login'] as const;

export default function Dock() {
  const [focused, setFocused] = useState<string | null>(null);
  const [highlight, setHighlight] = useState({ left: 0, width: 0, opacity: 0 });
  const navRef = useRef<HTMLUListElement>(null);
  const router = useRouter();
  const isHome = typeof window !== 'undefined' && window.location.pathname === '/';

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    if (!focused || !navRef.current) return setHighlight((h) => ({ ...h, opacity: 0 }));

    const btn = navRef.current.querySelector(`[data-item="${focused}"]`) as HTMLElement;
    if (!btn) return setHighlight((h) => ({ ...h, opacity: 0 }));

    const navRect = navRef.current.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();

    setHighlight({
      left: btnRect.left - navRect.left,
      width: btnRect.width,
      opacity: 0.2,
    });
  }, [focused]);

  const handleKey = (e: React.KeyboardEvent) => {
    const i = focused ? NAV.indexOf(focused as (typeof NAV)[number]) : 0;
    if (e.code === 'ArrowRight') setFocused(NAV[(i + 1) % NAV.length]);
    if (e.code === 'ArrowLeft') setFocused(NAV[(i - 1 + NAV.length) % NAV.length]);
  };

  return (
    <nav className="relative w-82 rounded-full border border-white/20 bg-white/10 shadow-lg backdrop-blur-md sm:w-96">
      <ul
        ref={navRef}
        className="relative flex w-full items-center p-2"
        onMouseLeave={() => setFocused(null)}
      >
        <li className="hidden items-center pl-4 sm:flex">
          <button
            onClick={() => {
              if (isHome) {
                scrollToSection('index');
              }
            }}
          >
            <Image src="/logo.svg" alt="Logo" width={20} height={20} className="h-5 w-5" />
          </button>
          <div className="bg-foreground/25 mr-1 ml-5 h-6 w-px" />
        </li>

        {NAV.map((item) => (
          <li key={item}>
            <button
              className="text-md relative px-3 py-1 font-medium text-gray-300"
              data-item={item}
              onClick={() => {
                if (item === 'Use cases') {
                  isHome ? scrollToSection('usecases') : router.push('/#usecases');
                }
                if (item === 'Pricing') {
                  isHome ? scrollToSection('pricing') : router.push('/#pricing');
                }
                if (item === 'Docs') {
                  router.push('/docs');
                }
              }}
              onMouseEnter={() => setFocused(item)}
              onFocus={() => setFocused(item)}
              onKeyDown={handleKey}
            >
              {item}
            </button>
          </li>
        ))}

        <div
          className="pointer-events-none absolute hidden h-8 rounded-full bg-blue-300 transition-all duration-300 ease-out md:block"
          style={{
            left: highlight.left,
            width: highlight.width,
            opacity: highlight.opacity,
          }}
        />
      </ul>
    </nav>
  );
}
