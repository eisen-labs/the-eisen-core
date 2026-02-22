'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';

const navItems = [
  { label: 'Account', href: '/account' },
  { label: 'API Keys', href: '/account/api-keys' },
  { label: 'Usage', href: '/account/usage' },
  { label: 'Billing', href: '/account/billing' },
];

export default function AccountNav() {
  const pathname = usePathname();
  const { logout } = useAuth();

  return (
    <nav className="border-foreground/10 flex items-center gap-4 border-b">
      {navItems.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`-mb-px border-b-2 pb-2 text-sm ${
            pathname === item.href
              ? 'border-foreground text-foreground'
              : 'text-foreground/40 hover:text-foreground border-transparent'
          }`}
        >
          {item.label}
        </Link>
      ))}
      <button
        onClick={() => void logout()}
        className="text-foreground/40 hover:text-foreground -mb-px ml-auto border-b-2 border-transparent pb-2 text-sm"
      >
        Sign out
      </button>
    </nav>
  );
}
