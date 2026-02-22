'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import {
  createCheckoutSession,
  createPortalSession,
  getBillingPlans,
  type Plan,
} from '@/lib/auth';

const TIER_LABEL: Record<string, string> = { free: 'Free', pro: 'Pro', premium: 'Premium' };

export default function BillingPage() {
  const { user, loading: authLoading, refreshUser } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBillingPlans()
      .then(setPlans)
      .catch(() => setError('Failed to load plans.'))
      .finally(() => setLoadingPlans(false));
  }, []);

  const tier = user?.subscription?.tier ?? 'free';
  const status = user?.subscription?.status ?? 'active';
  const isPaid = tier !== 'free';
  const isActive = status === 'active';

  async function handleUpgrade(t: 'pro' | 'premium') {
    setActionLoading(t);
    setError(null);
    try {
      window.location.href = await createCheckoutSession(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setActionLoading(null);
    }
  }

  async function handlePortal() {
    setActionLoading('portal');
    setError(null);
    try {
      window.location.href = await createPortalSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setActionLoading(null);
    }
  }

  if (authLoading || loadingPlans) {
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-medium">Billing</h2>
        <div className="bg-foreground/5 h-16 animate-pulse rounded-xl" />
        <div className="bg-foreground/5 h-16 animate-pulse rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-medium">Billing</h2>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* Current plan */}
      <div className="bg-foreground/5 rounded-xl p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className={`h-2 w-2 rounded-full ${isActive ? 'bg-green-500' : 'bg-foreground/20'}`} />
            <p className="text-sm font-medium">{TIER_LABEL[tier] ?? tier} plan</p>
          </div>
          <span className="text-foreground/40 text-xs capitalize">{status}</span>
        </div>

        {isPaid && isActive && (
          <button
            onClick={() => void handlePortal()}
            disabled={actionLoading === 'portal'}
            className="mt-3 text-xs text-foreground/40 hover:text-foreground underline underline-offset-2 disabled:opacity-50 transition-colors"
          >
            {actionLoading === 'portal' ? 'Loading…' : 'Manage subscription →'}
          </button>
        )}

        {!isActive && isPaid && (
          <button
            onClick={() => void refreshUser()}
            className="mt-3 text-xs text-foreground/40 hover:text-foreground underline underline-offset-2 transition-colors"
          >
            Refresh status
          </button>
        )}
      </div>

      {/* Upgrade options */}
      {!isPaid && plans.filter((p) => p.tier !== 'free').length > 0 && (
        <div className="space-y-3">
          <p className="text-foreground/40 text-xs">Upgrade your plan</p>
          {plans
            .filter((p) => p.tier !== 'free')
            .map((plan) => (
              <div
                key={plan.tier}
                className="border-foreground/10 rounded-xl border p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{TIER_LABEL[plan.tier] ?? plan.tier}</p>
                    {plan.features.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {plan.features.map((f) => (
                          <li key={f} className="text-foreground/50 flex items-center gap-1.5 text-xs">
                            <span className="text-foreground/30">·</span>
                            {f}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <button
                    onClick={() => void handleUpgrade(plan.tier as 'pro' | 'premium')}
                    disabled={actionLoading === plan.tier}
                    className="bg-foreground text-background hover:bg-foreground/80 flex-shrink-0 rounded-lg px-4 py-1.5 text-sm font-medium disabled:opacity-50 transition-colors"
                  >
                    {actionLoading === plan.tier ? 'Loading…' : 'Upgrade'}
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
