'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import DemoCarouselProgress from './demo-carousel-progress';
import Logo from '@/components/logo';

const PANEL_DURATION = 5000;

const PANELS = [
  {
    title: 'Codebase as Nodes',
    description:
      'Your codebase visualized as an interactive node graph. Each file surfaces its tokens, methods, and classes at a glance.',
  },
  {
    title: 'Agent Activity',
    description:
      'Highlighted nodes show which files were read or edited by agents, color-coded by action type in real time.',
  },
  {
    title: 'Any Agent, Zero Setup',
    description:
      'Works with Claude Code, Codex, OpenCode, or any custom API. Drop in and go — no configuration needed.',
  },
  {
    title: 'Multi-Agent Navigation',
    description:
      'Navigate between multiple agents by clicking on them or switch to the orchestrator view for a unified picture.',
  },
];

export default function DemoCarousel() {
  const router = useRouter();
  const [activePanel, setActivePanel] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isOpen, setIsOpen] = useState(true);
  const timerRef = useRef(0);
  const startTimeRef = useRef(0);

  const goNext = useCallback(() => {
    setActivePanel((prev) => (prev + 1) % PANELS.length);
    setProgress(0);
    startTimeRef.current = performance.now();
  }, []);

  const goPrev = useCallback(() => {
    setActivePanel((prev) => (prev - 1 + PANELS.length) % PANELS.length);
    setProgress(0);
    startTimeRef.current = performance.now();
  }, []);

  // Auto-advance — always runs while open, never pauses
  useEffect(() => {
    if (!isOpen) return;

    startTimeRef.current = performance.now();

    const tick = () => {
      const elapsed = performance.now() - startTimeRef.current;
      const p = Math.min(elapsed / PANEL_DURATION, 1);
      setProgress(p);

      if (p >= 1) {
        setActivePanel((prev) => (prev + 1) % PANELS.length);
        setProgress(0);
        startTimeRef.current = performance.now();
      }

      timerRef.current = requestAnimationFrame(tick);
    };

    timerRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(timerRef.current);
  }, [isOpen, activePanel]);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (isOpen) setIsOpen(false);
        else router.push('/');
      }
      if (!isOpen) return;
      if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goNext, goPrev, router, isOpen]);

  const panel = PANELS[activePanel];

  return (
    <div className="bg-background fixed inset-0 font-sans">
      {/* Logo / back */}
      <motion.a
        href="/"
        onClick={(e) => {
          e.preventDefault();
          router.push('/');
        }}
        className="fixed top-6 left-0 z-20 flex w-full justify-center md:top-8"
        aria-label="Back to home"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.1 }}
      >
        <Logo className="marquee-logo h-5 md:h-6" />
      </motion.a>

      {/* Window */}
      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-30 bg-black/50"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            />

            <motion.div
              className="fixed inset-0 z-40 flex items-center justify-center p-4 md:p-10"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              onClick={() => setIsOpen(false)}
            >
              <div
                className="w-full max-w-[640px] cursor-default"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="bg-background flex flex-col overflow-hidden rounded-xl">
                  {/* Visual area */}
                  <div className="bg-foreground/[0.03] mx-4 mt-4 aspect-video rounded-lg" />

                  {/* Text */}
                  <div className="px-4 pt-5 pb-1">
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={activePanel}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                      >
                        <h2 className="text-sm font-medium">{panel.title}</h2>
                        <p className="text-muted mt-1.5 text-sm leading-relaxed">
                          {panel.description}
                        </p>
                      </motion.div>
                    </AnimatePresence>
                  </div>

                  {/* Navigation + progress */}
                  <div className="px-4 pt-4 pb-4">
                    <div className="mb-3 flex items-center justify-between">
                      <button
                        onClick={goPrev}
                        className="text-muted hover:text-foreground cursor-pointer transition-colors"
                        aria-label="Previous panel"
                      >
                        <ArrowLeft className="h-3.5 w-3.5" />
                      </button>

                      <span className="text-muted text-xs tabular-nums">
                        {activePanel + 1} / {PANELS.length}
                      </span>

                      <button
                        onClick={goNext}
                        className="text-muted hover:text-foreground cursor-pointer transition-colors"
                        aria-label="Next panel"
                      >
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <DemoCarouselProgress
                      panelCount={PANELS.length}
                      activePanel={activePanel}
                      progress={progress}
                    />
                  </div>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
