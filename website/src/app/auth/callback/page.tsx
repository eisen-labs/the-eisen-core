'use client';

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { exchangeCode, setSession } from '@/lib/auth';
import Logo from '@/components/logo';

export default function AuthCallbackPage() {
  const router = useRouter();
  const params = useSearchParams();
  const didRun = useRef(false);

  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;

    const code = params.get('code');
    if (!code) {
      router.replace('/login');
      return;
    }

    exchangeCode(code)
      .then((session) => {
        setSession(session);
        router.replace('/account');
      })
      .catch(() => {
        router.replace('/login');
      });
  }, [params, router]);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 px-6 font-sans">
      <Logo className="marquee-logo h-8 animate-pulse md:h-11" />
      <p className="text-foreground/40 text-sm">Signing you in…</p>
    </div>
  );
}
