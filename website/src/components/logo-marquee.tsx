'use client';

import Image from 'next/image';

interface LogoMarqueeProps {
  items: { src: string; alt: string; height?: number; offsetY?: number }[];
  speed?: number;
}

export default function LogoMarquee({ items, speed = 30 }: LogoMarqueeProps) {
  return (
    <div className="relative overflow-hidden select-none">
      <div
        className="marquee flex w-max items-center will-change-transform"
        style={{ animationDuration: `${speed}s` }}
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
                width={0}
                height={item.height ?? 24}
                sizes="200px"
                className="opacity-80 grayscale transition-all duration-300 ease-out hover:opacity-100 hover:grayscale-0"
                style={{ width: 'auto', height: item.height ?? 24 }}
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
