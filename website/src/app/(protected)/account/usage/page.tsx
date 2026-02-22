'use client';

import Link from 'next/link';
import { useAuth } from '@/contexts/auth-context';

const PLAN_LIMITS: Record<string, { label: string; value: string }[]> = {
  free: [
    { label: 'API requests / day', value: '100' },
    { label: 'Workspaces', value: '1' },
    { label: 'Encrypted storage', value: 'No' },
  ],
  pro: [
    { label: 'API requests / day', value: 'Unlimited' },
    { label: 'Workspaces', value: 'Unlimited' },
    { label: 'Encrypted storage', value: 'Yes' },
  ],
  premium: [
    { label: 'API requests / day', value: 'Unlimited' },
    { label: 'Workspaces', value: 'Unlimited' },
    { label: 'Encrypted storage', value: 'Yes' },
  ],
};

const TIER_LABEL: Record<string, string> = { free: 'Free', pro: 'Pro', premium: 'Premium' };

export default function UsagePage() {
  const { user, loading } = useAuth();

  const tier = user?.subscription?.tier ?? 'free';
  const limits = PLAN_LIMITS[tier] ?? PLAN_LIMITS.free;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-medium">Usage</h2>

      {/* Current plan note */}
      <div className="bg-foreground/5 flex items-center justify-between rounded-xl px-4 py-3">
        <p className="text-sm">
          {loading ? '—' : (TIER_LABEL[tier] ?? tier)} plan
        </p>
        {tier === 'free' && (
          <Link
            href="/account/billing"
            className="text-foreground/40 hover:text-foreground text-xs underline underline-offset-2"
          >
            Upgrade
          </Link>
        )}
      </div>

      {/* Plan limits */}
      <div>
        <p className="text-foreground/40 mb-3 text-xs">Plan limits</p>
        <ul className="divide-foreground/10 divide-y">
          {limits.map(({ label, value }) => (
            <li key={label} className="flex items-center justify-between py-2.5">
              <span className="text-foreground/60 text-sm">{label}</span>
              <span className="text-sm font-medium">{value}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-foreground/30 text-xs">
        Detailed usage analytics are coming soon.
      </p>
    </div>
  );
}
