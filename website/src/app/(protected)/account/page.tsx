'use client';

import Link from 'next/link';
import { useAuth } from '@/contexts/auth-context';

const TIER_LABEL: Record<string, string> = { free: 'Free', pro: 'Pro', premium: 'Premium' };
const TIER_DESC: Record<string, string> = {
  free: 'Limited access',
  pro: 'Full access',
  premium: 'Full access + priority',
};

export default function AccountPage() {
  const { user, loading } = useAuth();

  const tier = user?.subscription?.tier ?? 'free';
  const status = user?.subscription?.status ?? 'active';
  const isActive = status === 'active';

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <p className="text-foreground/40 text-xs">Signed in as</p>
        <h2 className="mt-0.5 text-lg font-medium">
          {loading ? <span className="text-foreground/30">Loading…</span> : (user?.email ?? '—')}
        </h2>
      </div>

      {/* Plan card */}
      <div className="bg-foreground/5 flex items-center justify-between rounded-xl p-4">
        <div className="flex items-center gap-3">
          <div
            className={`h-2 w-2 rounded-full ${isActive ? 'bg-green-500' : 'bg-foreground/20'}`}
          />
          <div>
            <p className="text-sm font-medium">
              {loading ? '—' : (TIER_LABEL[tier] ?? tier)} plan
            </p>
            <p className="text-foreground/40 text-xs">
              {loading ? '' : (TIER_DESC[tier] ?? status)}
            </p>
          </div>
        </div>
        <Link
          href="/account/billing"
          className="text-foreground/40 hover:text-foreground text-xs underline underline-offset-2"
        >
          {tier === 'free' ? 'Upgrade' : 'Manage'}
        </Link>
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-2 gap-3">
        <Link
          href="/account/api-keys"
          className="bg-foreground/5 hover:bg-foreground/[0.08] group rounded-xl p-4 transition-colors"
        >
          <p className="text-sm font-medium">API Keys</p>
          <p className="text-foreground/40 mt-0.5 text-xs">Create and manage keys</p>
        </Link>
        <Link
          href="/account/billing"
          className="bg-foreground/5 hover:bg-foreground/[0.08] group rounded-xl p-4 transition-colors"
        >
          <p className="text-sm font-medium">Billing</p>
          <p className="text-foreground/40 mt-0.5 text-xs">Plans and subscription</p>
        </Link>
        <Link
          href="/account/usage"
          className="bg-foreground/5 hover:bg-foreground/[0.08] group rounded-xl p-4 transition-colors"
        >
          <p className="text-sm font-medium">Usage</p>
          <p className="text-foreground/40 mt-0.5 text-xs">Activity and limits</p>
        </Link>
        <a
          href="https://docs.eisenlabs.com"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-foreground/5 hover:bg-foreground/[0.08] group rounded-xl p-4 transition-colors"
        >
          <p className="text-sm font-medium">Docs</p>
          <p className="text-foreground/40 mt-0.5 text-xs">Integration guides</p>
        </a>
      </div>

      {/* Account details */}
      <div className="border-foreground/10 space-y-3 border-t pt-6">
        <div className="space-y-1">
          <p className="text-foreground/40 text-xs">User ID</p>
          <p className="font-mono text-xs">
            {loading ? <span className="text-foreground/20">—</span> : (user?.userId ?? '—')}
          </p>
        </div>
        <button className="text-xs text-red-500/70 hover:text-red-500 transition-colors">
          Delete account
        </button>
      </div>
    </div>
  );
}
