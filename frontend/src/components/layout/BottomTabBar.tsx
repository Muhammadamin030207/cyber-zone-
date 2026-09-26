'use client';

import { Home, Monitor, MessageSquare, LayoutDashboard, LogIn, Crown, UserRound, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { useAuthStore } from '@/store/auth';
import { useChatUnread } from '@/hooks/useChatUnread';
import { cn } from '@/lib/utils';

interface TabDef {
  href: string;
  icon: LucideIcon;
  label: string;
  aria: string;
  badge?: number;
}

export default function BottomTabBar() {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const unread = useChatUnread();

  const tabs: TabDef[] = [
    { href: '/', icon: Home, label: t('home'), aria: t('home') },
    { href: '/rooms', icon: Monitor, label: t('rooms'), aria: t('rooms') },
  ];

  if (user) {
    tabs.push({ href: '/chat', icon: MessageSquare, label: t('chat'), aria: t('chat'), badge: unread });
    if (user.role === 'ADMIN') {
      tabs.push({ href: '/admin', icon: LayoutDashboard, label: t('admin'), aria: t('admin') });
    } else if (user.role === 'SUPER_ADMIN') {
      tabs.push({ href: '/super-admin', icon: Crown, label: t('superAdmin'), aria: t('superAdmin') });
    } else {
      tabs.push({ href: '/dashboard', icon: LayoutDashboard, label: t('dashboard'), aria: t('dashboard') });
    }
    tabs.push({ href: '/profile', icon: UserRound, label: t('profile'), aria: t('profile') });
  } else {
    tabs.push({ href: '/login', icon: LogIn, label: t('login'), aria: t('login') });
  }

  const isTab = (href: string) =>
    href === '/' ? pathname === '/' || pathname === '' : pathname.startsWith(href);

  return (
    <nav
      aria-label="Asosiy navigatsiya"
      className="fixed bottom-2 inset-x-0 z-50 lg:hidden pointer-events-none px-3 pb-[env(safe-area-inset-bottom,0px)]"
    >
      <div className="pointer-events-auto mx-auto flex items-center gap-0.5 w-full max-w-md rounded-2xl border border-white/10 bg-[color-mix(in_srgb,var(--bg-1)_92%,transparent)] backdrop-blur-xl shadow-[0_10px_30px_rgba(0,0,0,0.45)] px-1.5 py-1.5">
        {tabs.map((tab) => {
          const active = isTab(tab.href);
          const badge = tab.badge ?? 0;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-label={badge > 0 ? `${tab.aria} — ${badge > 99 ? '99+' : badge}` : tab.aria}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 py-1 text-[10px] font-medium rounded-xl transition-colors',
                active ? 'text-neon-cyan' : 'text-gray-400 active:text-gray-200'
              )}
            >
              <span
                className={cn(
                  'relative flex items-center justify-center w-9 h-6 rounded-full transition-all',
                  active && 'bg-neon-cyan/15 shadow-[0_0_14px_-4px_var(--acc-a)]'
                )}
              >
                <tab.icon size={18} strokeWidth={active ? 2.4 : 1.9} />
                {badge > 0 && (
                  <span className="absolute -top-1 -right-2 min-w-[16px] h-[16px] px-1 rounded-full bg-neon-magenta text-white text-[9px] font-extrabold grid place-items-center border border-white/20">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </span>
              <span className="max-w-full truncate px-1 leading-none">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
