export default function BillingPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-medium">Billing</h2>
      <div className="bg-foreground/5 flex items-center justify-between rounded-lg p-4">
        <div>
          <p className="text-sm font-medium">Free plan</p>
          <p className="text-foreground text-xs">Your current plan.</p>
        </div>
        <button className="bg-foreground text-background hover:bg-foreground/80 rounded-lg px-4 py-1.5 text-sm font-medium">
          Upgrade
        </button>
      </div>
    </div>
  );
}
