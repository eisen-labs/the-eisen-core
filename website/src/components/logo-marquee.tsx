'use client';

import Image from 'next/image';

interface LogoMarqueeProps {
  items: { src: string; alt: string; width: number; height: number; offsetY?: number }[];
  pixelsPerSecond?: number;
}

const ITEM_PADDING = 48;

export default function LogoMarquee({ items, pixelsPerSecond = 40 }: LogoMarqueeProps) {
  const contentWidth = items.reduce((sum, item) => sum + item.width + ITEM_PADDING, 0);
  const duration = contentWidth / pixelsPerSecond;

  return (
    <div className="relative overflow-hidden select-none">
      <div
        className="marquee flex w-max items-center will-change-transform"
        style={{ animationDuration: `${duration}s` }}
      >
        {[0, 1].map((copy) =>
          items.map((item, i) => (
            <div
              key={`${copy}-${i}`}
              className="flex items-center px-6"
              style={item.offsetY ? { transform: `translateY(${item.offsetY}px)` } : undefined}
            >
              <Image
                src={item.src}
                alt={item.alt}
                width={item.width}
                height={item.height}
                className="opacity-80 grayscale transition-all duration-300 ease-out hover:opacity-100 hover:grayscale-0"
              />
            </div>
          )),
        )}
      </div>
      <div className="from-background pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r" />
      <div className="from-background pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l" />
      <style jsx>{`
        .marquee {
          animation: marquee linear infinite;
        }
        @keyframes marquee {
          to {
            transform: translateX(-50%);
          }
        }
      `}</style>
    </div>
  );
}
