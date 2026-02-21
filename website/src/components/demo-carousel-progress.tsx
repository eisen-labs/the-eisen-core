'use client';

interface DemoCarouselProgressProps {
  panelCount: number;
  activePanel: number;
  progress: number;
}

export default function DemoCarouselProgress({
  panelCount,
  activePanel,
  progress,
}: DemoCarouselProgressProps) {
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: panelCount }).map((_, i) => (
        <div key={i} className="bg-foreground/10 h-0.5 flex-1 overflow-hidden rounded-full">
          <div
            className="bg-foreground/40 h-full rounded-full"
            style={{
              width: i < activePanel ? '100%' : i === activePanel ? `${progress * 100}%` : '0%',
              transition: i < activePanel ? 'width 0.3s ease' : 'none',
            }}
          />
        </div>
      ))}
    </div>
  );
}
