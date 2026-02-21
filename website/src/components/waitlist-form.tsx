'use client';

import { useState } from 'react';

export default function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) setDone(true);
    } catch {}
  }

  return (
    <div className="h-9">
      {done ? (
        <p className="animate-in fade-in flex h-9 items-center text-sm duration-300">
          You&apos;re on the list. We&apos;ll be in touch.
        </p>
      ) : (
        <form onSubmit={submit} noValidate className="flex h-9 items-center gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="placeholder-foreground/40 rounded-lg bg-white/5 px-4 py-1.5 text-sm outline-none"
          />
          <button
            type="submit"
            disabled={!valid}
            className="bg-foreground text-background rounded-lg px-4 py-1.5 text-sm font-medium transition-all duration-300 ease-out hover:bg-gray-300 disabled:opacity-50"
          >
            Join the waitlist
          </button>
        </form>
      )}
    </div>
  );
}
