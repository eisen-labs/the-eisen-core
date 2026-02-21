export default function UsagePage() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-medium">Usage</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        {(['API calls', 'Tokens used', 'Sessions'] as const).map((label) => (
          <div key={label} className="bg-foreground/5 rounded-lg p-4">
            <p className="text-foreground text-xs">{label}</p>
            <p className="mt-1 text-2xl font-medium">0</p>
          </div>
        ))}
      </div>
    </div>
  );
}
