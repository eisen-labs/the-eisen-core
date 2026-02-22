import Link from 'next/link';
import Logo from '@/components/logo';

export default function BillingCancelPage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 font-sans">
      <Link href="/">
        <Logo className="marquee-logo h-8 md:h-11" />
      </Link>
      <div className="text-center">
        <h1 className="text-lg font-medium">Checkout cancelled</h1>
        <p className="text-foreground/40 mt-1 text-sm">No changes were made to your subscription.</p>
      </div>
      <Link
        href="/account/billing"
        className="bg-foreground/[0.06] hover:bg-foreground/10 rounded-xl px-5 py-2 text-sm font-medium transition-colors"
      >
        Back to billing
      </Link>
    </div>
  );
}
