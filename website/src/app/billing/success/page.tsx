'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import Logo from '@/components/logo';
import { useAuth } from '@/contexts/auth-context';

export default function BillingSuccessPage() {
  const { refreshUser } = useAuth();
  const didRefresh = useRef(false);

  useEffect(() => {
    if (didRefresh.current) return;
    didRefresh.current = true;
    void refreshUser();
  }, [refreshUser]);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 font-sans">
      <Link href="/">
        <Logo className="marquee-logo h-8 md:h-11" />
      </Link>
      <div className="text-center">
        <h1 className="text-lg font-medium">Subscription activated</h1>
        <p className="text-foreground/40 mt-1 text-sm">
          Your plan has been updated. Welcome aboard.
        </p>
      </div>
      <Link
        href="/account/billing"
        className="bg-foreground text-background hover:bg-foreground/80 rounded-xl px-5 py-2 text-sm font-medium transition-colors"
      >
        Go to billing
      </Link>
    </div>
  );
}
