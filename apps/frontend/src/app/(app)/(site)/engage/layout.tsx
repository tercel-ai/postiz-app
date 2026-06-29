'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';

export default function EngageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const tabs = [
    { label: 'Signal Feed', href: '/engage' },
    { label: 'Sent', href: '/engage/sent' },
    { label: 'Scan Automation', href: '/engage/automation' },
    { label: 'Settings', href: '/engage/settings' },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-6 px-6 py-4 border-b border-[#1e2536]">
        <h1 className="text-xl font-semibold text-white">Engage</h1>
        <nav className="flex gap-1">
          {tabs.map((tab) => {
            const active =
              tab.href === '/engage'
                ? pathname === '/engage'
                : pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={clsx(
                  'px-4 py-1.5 rounded-md text-sm font-medium transition-colors',
                  active
                    ? 'bg-[#2d3748] text-white'
                    : 'text-gray-400 hover:text-white hover:bg-[#1e2536]'
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}
