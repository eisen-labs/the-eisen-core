'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import {
  createCheckoutSession,
  createPortalSession,
  getBillingPlans,
  type Plan,
} from '@/lib/auth';

const TIER_LABEL: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  premium: 'Premium',
};

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

  const currentTier = user?.subscription?.tier ?? 'free';
  const currentStatus = user?.subscription?.status ?? 'active';
  const isPaid = currentTier !== 'free';
  const isActive = currentStatus === 'active';

  async function handleUpgrade(tier: 'pro' | 'premium') {
    setActionLoading(tier);
    setError(null);
    try {
      const url = await createCheckoutSession(tier);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setActionLoading(null);
    }
  }

  async function handlePortal() {
    setActionLoading('portal');
    setError(null);
    try {
      const url = await createPortalSession();
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setActionLoading(null);
    }
  }

  async function handleRefreshStatus() {
    await refreshUser();
  }

  if (authLoading || loadingPlans) {
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-medium">Billing</h2>
        <div className="bg-foreground/5 h-16 animate-pulse rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-medium">Billing</h2>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* Current plan */}
      <div className="bg-foreground/5 flex items-center justify-between rounded-lg p-4">
        <div>
          <p className="text-sm font-medium">{TIER_LABEL[currentTier] ?? currentTier} plan</p>
          <p className="text-foreground/40 text-xs capitalize">
            {isActive ? 'Active' : currentStatus}
          </p>
        </div>
        {isPaid && isActive ? (
          <button
            onClick={() => void handlePortal()}
            disabled={actionLoading === 'portal'}
            className="bg-foreground text-background hover:bg-foreground/80 rounded-lg px-4 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {actionLoading === 'portal' ? 'Loading…' : 'Manage'}
          </button>
        ) : (
          <button
            onClick={() => void handleRefreshStatus()}
            className="text-foreground/40 hover:text-foreground rounded-lg px-4 py-1.5 text-sm"
          >
            Refresh
          </button>
        )}
      </div>

      {/* Upgrade options for free users */}
      {!isPaid && (
        <div className="space-y-3">
          {plans
            .filter((p) => p.tier !== 'free')
            .map((plan) => (
              <div
                key={plan.tier}
                className="border-foreground/10 flex items-center justify-between rounded-lg border p-4"
              >
                <div>
                  <p className="text-sm font-medium">{TIER_LABEL[plan.tier] ?? plan.tier}</p>
                  {plan.features.length > 0 && (
                    <p className="text-foreground/40 mt-0.5 text-xs">{plan.features[0]}</p>
                  )}
                </div>
                <button
                  onClick={() => void handleUpgrade(plan.tier as 'pro' | 'premium')}
                  disabled={actionLoading === plan.tier}
                  className="bg-foreground text-background hover:bg-foreground/80 rounded-lg px-4 py-1.5 text-sm font-medium disabled:opacity-50"
                >
                  {actionLoading === plan.tier ? 'Loading…' : 'Upgrade'}
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
