'use client';

import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { MousePointerClick } from 'lucide-react';

export default function DemoBox() {
  const router = useRouter();
  const ref = useRef<HTMLButtonElement>(null);
  const [expanding, setExpanding] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const handleClick = useCallback(() => {
    if (expanding || !ref.current) return;
    setRect(ref.current.getBoundingClientRect());
    setExpanding(true);
  }, [expanding]);

  return (
    <>
      <button
        ref={ref}
        onClick={handleClick}
        className="group bg-foreground/[0.03] hover:bg-foreground/[0.06] flex w-full cursor-pointer items-center justify-center rounded-2xl transition-colors"
        style={{ aspectRatio: '16/9' }}
      >
        <span
          className={`text-muted flex items-center gap-2 text-sm transition-opacity ${expanding ? 'opacity-0' : 'opacity-100 group-hover:opacity-80'}`}
        >
          <MousePointerClick className="h-3.5 w-3.5" />
          Interactive demo
        </span>
      </button>

      {expanding &&
        rect &&
        createPortal(
          <>
            <motion.div
              className="bg-background fixed inset-0 z-40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
            />
            <motion.div
              className="bg-foreground/[0.03] fixed z-50"
              initial={{
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height,
                borderRadius: 16,
              }}
              animate={{
                top: 0,
                left: 0,
                width: '100vw',
                height: '100vh',
                borderRadius: 0,
              }}
              transition={{
                duration: 0.45,
                ease: [0.4, 0, 0.2, 1],
              }}
              onAnimationComplete={() => router.push('/demo')}
            >
              <motion.div
                className="bg-background h-full w-full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3, delay: 0.15 }}
              />
            </motion.div>
          </>,
          document.body,
        )}
    </>
  );
}
