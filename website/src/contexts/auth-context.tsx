'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  AuthError,
  clearSession,
  getMe,
  getSession,
  logoutSession,
  setSession,
  type SessionData,
  type UserProfile,
} from '@/lib/auth';
import { useRouter } from 'next/navigation';

interface AuthContextValue {
  user: UserProfile | null;
  session: SessionData | null;
  loading: boolean;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [session, setSessionState] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUser = useCallback(async () => {
    const stored = getSession();
    if (!stored) {
      setLoading(false);
      return;
    }

    // Re-hydrate the cookie in case it was cleared (e.g. after browser restart)
    setSession(stored);
    setSessionState(stored);

    try {
      const profile = await getMe();
      setUser(profile);
    } catch (err) {
      if (err instanceof AuthError) {
        clearSession();
        setSessionState(null);
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  const logout = useCallback(async () => {
    const stored = getSession();
    if (stored) {
      try {
        await logoutSession(stored.sessionToken);
      } catch {
        // Ignore errors — clear locally regardless
      }
    }
    clearSession();
    setSessionState(null);
    setUser(null);
    router.push('/login');
  }, [router]);

  const refreshUser = useCallback(async () => {
    try {
      const profile = await getMe();
      setUser(profile);
    } catch {
      // silently ignore refresh errors
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, session, loading, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
