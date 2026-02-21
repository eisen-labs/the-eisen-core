import Link from 'next/link';
import Logo from '@/components/logo';
import AccountNav from './nav';

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center px-6 pt-14 pb-16 font-sans">
      <Link href="/" className="mb-8">
        <Logo className="marquee-logo h-8 md:h-11" />
      </Link>
      <div className="w-full max-w-[500px]">
        <AccountNav />
        <main className="pt-8">{children}</main>
      </div>
    </div>
  );
}
