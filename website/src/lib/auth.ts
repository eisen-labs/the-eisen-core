const AUTH_URL =
  process.env.NEXT_PUBLIC_AUTH_URL ?? 'https://eisen-auth-923944622611.europe-west1.run.app';
const SESSION_KEY = 'eisen_session';
const SESSION_COOKIE = 'session';

export interface SessionData {
  sessionToken: string;
  expiresAt: number;
  offlineDeadline: number;
}

export interface UserProfile {
  userId: string;
  email: string;
  subscription: {
    tier: 'free' | 'pro' | 'premium';
    status: 'active' | 'expired' | 'cancelled';
  };
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Plan {
  tier: 'free' | 'pro' | 'premium';
  priceId?: string;
  price: number | null;
  interval: string | null;
  features: string[];
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

export function getSession(): SessionData | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SessionData) : null;
  } catch {
    return null;
  }
}

export function setSession(data: SessionData): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  // Mirror token in a plain cookie so middleware can read it
  document.cookie = `${SESSION_COOKIE}=${data.sessionToken}; path=/; SameSite=Lax`;
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(SESSION_KEY);
  document.cookie = `${SESSION_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}

// ---------------------------------------------------------------------------
// Auth API calls
// ---------------------------------------------------------------------------

export async function exchangeCode(code: string): Promise<SessionData> {
  const res = await fetch(`${AUTH_URL}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? 'Failed to exchange code');
  }
  return res.json() as Promise<SessionData>;
}

export async function refreshSession(sessionToken: string): Promise<SessionData> {
  const res = await fetch(`${AUTH_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? 'Failed to refresh session');
  }
  return res.json() as Promise<SessionData>;
}

export async function logoutSession(sessionToken: string): Promise<void> {
  await fetch(`${AUTH_URL}/auth/logout`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    },
  });
}

// ---------------------------------------------------------------------------
// Authenticated fetch with auto-refresh
// ---------------------------------------------------------------------------

export async function fetchWithAuth(path: string, init?: RequestInit): Promise<Response> {
  const session = getSession();
  if (!session) throw new AuthError('Not authenticated');

  const doRequest = (token: string) =>
    fetch(`${AUTH_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
        Authorization: `Bearer ${token}`,
      },
    });

  let res = await doRequest(session.sessionToken);

  if (res.status === 401) {
    // Attempt token refresh if within offlineDeadline
    if (Date.now() < session.offlineDeadline) {
      try {
        const fresh = await refreshSession(session.sessionToken);
        setSession(fresh);
        res = await doRequest(fresh.sessionToken);
      } catch {
        clearSession();
        throw new AuthError('Session expired');
      }
    } else {
      clearSession();
      throw new AuthError('Session expired');
    }
  }

  return res;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

// ---------------------------------------------------------------------------
// Resource helpers
// ---------------------------------------------------------------------------

export async function getMe(): Promise<UserProfile> {
  const res = await fetchWithAuth('/auth/me');
  if (!res.ok) throw new Error('Failed to fetch user profile');
  return res.json() as Promise<UserProfile>;
}

export async function getApiKeys(): Promise<ApiKey[]> {
  const res = await fetchWithAuth('/apikeys');
  if (!res.ok) throw new Error('Failed to fetch API keys');
  const data = (await res.json()) as { keys: ApiKey[] };
  return data.keys;
}

export async function createApiKey(name: string): Promise<{ id: string; name: string; key: string }> {
  const res = await fetchWithAuth('/apikeys', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? 'Failed to create API key');
  }
  return res.json() as Promise<{ id: string; name: string; key: string }>;
}

export async function deleteApiKey(id: string): Promise<void> {
  const res = await fetchWithAuth(`/apikeys/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? 'Failed to delete API key');
  }
}

export async function getBillingPlans(): Promise<Plan[]> {
  const res = await fetch(`${AUTH_URL}/billing/plans`);
  if (!res.ok) throw new Error('Failed to fetch billing plans');
  const data = (await res.json()) as { plans: Plan[] };
  return data.plans;
}

export async function createCheckoutSession(tier: 'pro' | 'premium'): Promise<string> {
  const res = await fetchWithAuth('/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ tier }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? 'Failed to create checkout session');
  }
  const data = (await res.json()) as { url: string };
  return data.url;
}

export async function createPortalSession(): Promise<string> {
  const res = await fetchWithAuth('/billing/portal', { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? 'Failed to create portal session');
  }
  const data = (await res.json()) as { url: string };
  return data.url;
}
