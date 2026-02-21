export default function AccountPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-medium">Account</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" />
        <Field label="Last name" />
      </div>
      <Field label="Email" />
      <div className="border-foreground/10 border-t pt-6">
        <button className="text-sm text-red-500 hover:text-red-400">Delete account</button>
      </div>
    </div>
  );
}

function Field({ label }: { label: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-foreground text-xs">{label}</p>
      <div className="bg-foreground/5 rounded-lg px-4 py-1.5 text-sm">—</div>
    </div>
  );
}
