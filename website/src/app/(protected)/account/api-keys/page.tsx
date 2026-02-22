'use client';

import { useEffect, useRef, useState } from 'react';
import { createApiKey, deleteApiKey, getApiKeys, type ApiKey } from '@/lib/auth';

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getApiKeys()
      .then(setKeys)
      .catch(() => setError('Failed to load API keys.'))
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    setCreating(true);
    setError(null);
    setCreatedKey(null);
    setCopied(false);
    try {
      const result = await createApiKey(newKeyName.trim());
      setCreatedKey(result.key);
      setNewKeyName('');
      setKeys((prev) => [
        {
          id: result.id,
          name: result.name,
          prefix: result.key.slice(0, 14),
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        },
        ...prev,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key.');
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    setError(null);
    try {
      await deleteApiKey(id);
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke key.');
    } finally {
      setDeletingId(null);
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-medium">API Keys</h2>
        <span className="text-foreground/30 text-xs">{keys.length} / 10</span>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* New key reveal */}
      {createdKey && (
        <div className="border-foreground/10 space-y-3 rounded-xl border p-4">
          <p className="text-xs font-medium text-amber-500">
            Copy your key now — it won&apos;t be shown again.
          </p>
          <div className="bg-foreground/5 flex items-center gap-2 rounded-lg px-3 py-2">
            <code className="flex-1 break-all font-mono text-xs">{createdKey}</code>
            <button
              onClick={() => void handleCopy()}
              className="text-foreground/40 hover:text-foreground flex-shrink-0 text-xs transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {/* Create form */}
      <form onSubmit={(e) => void handleCreate(e)} className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={newKeyName}
          onChange={(e) => setNewKeyName(e.target.value)}
          placeholder="Key name, e.g. VS Code"
          maxLength={100}
          className="bg-foreground/5 focus:ring-foreground/20 flex-1 rounded-lg px-4 py-2 text-sm outline-none focus:ring-2"
        />
        <button
          type="submit"
          disabled={creating || !newKeyName.trim() || keys.length >= 10}
          className="bg-foreground text-background hover:bg-foreground/80 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40 transition-colors"
        >
          {creating ? 'Creating…' : 'Create'}
        </button>
      </form>

      {/* Key list */}
      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="bg-foreground/5 h-[58px] animate-pulse rounded-xl" />
          ))}
        </div>
      ) : keys.length === 0 ? (
        <p className="text-foreground/40 py-2 text-sm">No API keys yet.</p>
      ) : (
        <ul className="space-y-2">
          {keys.map((key) => (
            <li
              key={key.id}
              className="bg-foreground/5 flex items-center justify-between rounded-xl px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{key.name}</p>
                <div className="mt-0.5 flex items-center gap-2">
                  <code className="text-foreground/40 font-mono text-xs">{key.prefix}…</code>
                  <span className="text-foreground/20 text-xs">·</span>
                  <span className="text-foreground/30 text-xs">{formatDate(key.createdAt)}</span>
                </div>
              </div>
              <button
                onClick={() => void handleDelete(key.id)}
                disabled={deletingId === key.id}
                className="text-foreground/30 hover:text-red-500 ml-4 flex-shrink-0 text-xs transition-colors disabled:opacity-50"
              >
                {deletingId === key.id ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
