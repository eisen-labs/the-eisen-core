import Link from 'next/link';
import Logo from '@/components/logo';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center px-6 font-sans">
      <div className="flex flex-1 flex-col items-center justify-center">
        <Link href="/" aria-label="Back to home">
          <Logo className="marquee-logo h-5 md:h-6" />
        </Link>
        <p className="text-muted mt-4 text-sm">Page not found</p>
      </div>
    </div>
  );
}
