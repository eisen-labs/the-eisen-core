'use client';

import { useAuth } from '@/contexts/auth-context';

export default function AccountPage() {
  const { user, loading } = useAuth();

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-medium">Account</h2>
      <div className="space-y-1.5">
        <p className="text-foreground text-xs">Email</p>
        <div className="bg-foreground/5 rounded-lg px-4 py-1.5 text-sm">
          {loading ? <span className="text-foreground/40">Loading…</span> : (user?.email ?? '—')}
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-foreground text-xs">User ID</p>
        <div className="bg-foreground/5 rounded-lg px-4 py-1.5 font-mono text-sm">
          {loading ? <span className="text-foreground/40">Loading…</span> : (user?.userId ?? '—')}
        </div>
      </div>
      <div className="border-foreground/10 border-t pt-6">
        <button className="text-sm text-red-500 hover:text-red-400">Delete account</button>
      </div>
    </div>
  );
}
