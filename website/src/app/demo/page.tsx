import type { Metadata } from 'next';
import DemoCarousel from '@/components/demo-carousel';

export const metadata: Metadata = {
  title: 'Eisen',
  description: 'See how Eisenlabs visualizes your codebase and AI agent activity in real time.',
};

export default function DemoPage() {
  return <DemoCarousel />;
}
