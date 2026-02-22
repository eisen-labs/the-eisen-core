'use client';

import { useEffect, useState } from 'react';
import { createApiKey, deleteApiKey, getApiKeys, type ApiKey } from '@/lib/auth';

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    try {
      const result = await createApiKey(newKeyName.trim());
      setCreatedKey(result.key);
      setNewKeyName('');
      setKeys((prev) => [
        ...prev,
        {
          id: result.id,
          name: result.name,
          prefix: result.key.slice(0, 14),
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key.');
    } finally {
      setCreating(false);
    }
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

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-medium">API Keys</h2>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* New key reveal — shown once after creation */}
      {createdKey && (
        <div className="border-foreground/10 space-y-2 rounded-lg border p-4">
          <p className="text-xs font-medium text-amber-500">
            Copy your key now — it won&apos;t be shown again.
          </p>
          <code className="bg-foreground/5 block break-all rounded px-3 py-2 font-mono text-xs">
            {createdKey}
          </code>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(createdKey);
            }}
            className="text-foreground/40 hover:text-foreground text-xs underline"
          >
            Copy to clipboard
          </button>
        </div>
      )}

      {/* Create form */}
      <form onSubmit={(e) => void handleCreate(e)} className="flex gap-2">
        <input
          type="text"
          value={newKeyName}
          onChange={(e) => setNewKeyName(e.target.value)}
          placeholder="Key name (e.g. VS Code)"
          maxLength={100}
          className="bg-foreground/5 focus:ring-foreground/20 flex-1 rounded-lg px-4 py-1.5 text-sm outline-none focus:ring-2"
        />
        <button
          type="submit"
          disabled={creating || !newKeyName.trim()}
          className="bg-foreground text-background hover:bg-foreground/80 rounded-lg px-4 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create'}
        </button>
      </form>

      {/* Key list */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="bg-foreground/5 h-14 animate-pulse rounded-lg" />
          ))}
        </div>
      ) : keys.length === 0 ? (
        <p className="text-foreground/40 text-sm">No API keys yet.</p>
      ) : (
        <ul className="space-y-2">
          {keys.map((key) => (
            <li
              key={key.id}
              className="bg-foreground/5 flex items-center justify-between rounded-lg px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{key.name}</p>
                <p className="text-foreground/40 font-mono text-xs">{key.prefix}…</p>
              </div>
              <button
                onClick={() => void handleDelete(key.id)}
                disabled={deletingId === key.id}
                className="text-foreground/40 hover:text-red-500 ml-4 flex-shrink-0 text-sm disabled:opacity-50"
              >
                {deletingId === key.id ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-foreground/30 text-xs">Maximum 10 active keys per account.</p>
    </div>
  );
}
