import AccountNav from './nav';

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-svh max-w-3xl px-8 pt-16 pb-16 font-sans">
      <AccountNav />
      <main className="pt-8">{children}</main>
    </div>
  );
}
