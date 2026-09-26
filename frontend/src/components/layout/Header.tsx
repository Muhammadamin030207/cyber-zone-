'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { LayoutDashboard, Crown, MessageSquare, UserRound } from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { useChatUnread } from '@/hooks/useChatUnread';
import LanguageSwitcher from './LanguageSwitcher';
import ThemeSwitcher from './ThemeSwitcher';
import Logo from '@/components/brand/Logo';
import { confirmDialog } from '@/lib/confirm';
import { cn } from '@/lib/utils';

export default function Header() {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const unread = useChatUnread();

  const handleLogout = async () => {
    const ok = await confirmDialog({
      title: 'Tizimdan chiqish',
      message: 'Hisobingizdan chiqishni tasdiqlaysizmi?',
      confirmLabel: 'Chiqish',
      cancelLabel: 'Bekor qilish',
      danger: true,
    });
    if (ok) logout();
  };

  const links = [
    { href: '/', label: t('home') },
    { href: '/rooms', label: t('rooms') },
  ];

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' || pathname === '' : pathname.startsWith(href);

  const navItems = (
    <>
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={isActive(l.href) ? 'page' : undefined}
          className={cn(
            'inline-flex items-center h-9 px-3.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap',
            isActive(l.href)
              ? 'text-neon-cyan bg-neon-cyan/10'
              : 'text-gray-300 hover:text-white hover:bg-white/5'
          )}
        >
          {l.label}
        </Link>
      ))}
    </>
  );

  const userInitial = (() => {
    const name = user?.fullName || 'U';
    return name.trim()[0]?.toUpperCase() || 'U';
  })();

  const iconBtn = 'w-9 h-9 rounded-lg border flex items-center justify-center transition-colors';

  const chatButton = (
    <Link
      href="/chat"
      data-tip={unread > 0 ? `Xabarlar (${unread})` : 'Xabarlar'}
      data-tip-top
      aria-label={unread > 0 ? `Xabarlar — ${unread} ta o'qilmagan` : 'Xabarlar'}
      className={cn(
        'relative shrink-0',
        iconBtn,
        isActive('/chat')
          ? 'text-neon-cyan bg-neon-cyan/15 border-neon-cyan/30'
          : 'text-gray-200 bg-cyber-800 border-white/10 hover:border-neon-cyan/40'
      )}
    >
      <MessageSquare size={16} />
      {unread > 0 && (
        <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-neon-magenta text-white text-[10px] font-extrabold grid place-items-center border border-white/20">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );

  const profileButton = (
    <Link
      href="/profile"
      data-tip={t('profile')}
      data-tip-top
      aria-label={t('profile')}
      aria-current={isActive('/profile') ? 'page' : undefined}
      className={cn(
        'shrink-0',
        iconBtn,
        isActive('/profile')
          ? 'text-neon-cyan bg-neon-cyan/15 border-neon-cyan/30'
          : 'text-gray-200 bg-cyber-800 border-white/10 hover:border-neon-cyan/40'
      )}
    >
      <UserRound size={16} />
    </Link>
  );

  return (
    <header className="sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-3 sm:px-5 pt-2 sm:pt-3 pb-2">
        <div className="relative flex items-center gap-2 rounded-2xl border border-white/10 glass px-2.5 sm:px-4 h-14 md:h-16 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.5)]">
          <Link href="/" className="flex items-center gap-2 group shrink-0" aria-label="Cyber-ZONE — bosh sahifa">
            <Logo size={30} />
            <span className="hidden sm:inline font-[--font-orbitron] font-bold tracking-widest text-base md:text-lg">
              CYBER<span className="text-neon-cyan">-ZONE</span>
            </span>
          </Link>

          <nav
            className="hidden lg:flex flex-1 min-w-0 items-center justify-center gap-0.5"
            aria-label="Asosiy navigatsiya"
          >
            {navItems}
          </nav>

          <div className="hidden lg:flex items-center gap-1.5 shrink-0">
            <ThemeSwitcher />
            <LanguageSwitcher />
            {user ? (
              <>
                {user.role === 'SUPER_ADMIN' && (
                  <Link
                    href="/super-admin"
                    className="inline-flex items-center h-9 px-3 text-sm font-medium rounded-lg text-yellow-300 hover:bg-yellow-400/10 gap-1.5"
                  >
                    <Crown size={16} />
                    {t('superAdmin')}
                  </Link>
                )}
                {user.role === 'ADMIN' && (
                  <Link
                    href="/admin"
                    className="inline-flex items-center h-9 px-3 text-sm font-medium rounded-lg text-neon-green hover:bg-neon-green/10 gap-1.5"
                  >
                    <LayoutDashboard size={16} />
                    {t('admin')}
                  </Link>
                )}
                {chatButton}
                {profileButton}
                {user.role === 'USER' && (
                  <Link
                    href="/dashboard"
                    data-tip={t('dashboard')}
                    data-tip-top
                    aria-label={t('dashboard')}
                    aria-current={isActive('/dashboard') ? 'page' : undefined}
                    className={cn(
                      'w-9 h-9 rounded-lg border flex items-center justify-center font-bold text-sm transition-colors',
                      isActive('/dashboard')
                        ? 'text-neon-cyan bg-neon-cyan/15 border-neon-cyan/30'
                        : 'text-gray-200 bg-cyber-800 border-white/10 hover:border-neon-cyan/40'
                    )}
                  >
                    {userInitial}
                  </Link>
                )}
                <button
                  onClick={handleLogout}
                  className="inline-flex items-center h-9 px-3 text-sm font-medium rounded-lg text-red-400 hover:bg-red-500/10"
                >
                  {t('logout')}
                </button>
              </>
            ) : (
              <Link
                href="/login"
                className="inline-flex items-center h-9 px-4 text-sm font-bold rounded-lg neon-btn"
              >
                {t('login')}
              </Link>
            )}
          </div>

          <div className="hidden md:flex lg:hidden items-center justify-end flex-1 min-w-0 gap-2">
            <ThemeSwitcher />
            <LanguageSwitcher />
            {user ? (
              <>
                {user.role === 'SUPER_ADMIN' && (
                  <Link
                    href="/super-admin"
                    aria-label={t('superAdmin')}
                    className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-xl text-yellow-300 bg-yellow-400/10 border border-yellow-400/30"
                  >
                    <Crown size={17} />
                  </Link>
                )}
                {user.role === 'ADMIN' && (
                  <Link
                    href="/admin"
                    aria-label={t('admin')}
                    className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-xl text-neon-green bg-neon-green/10 border border-neon-green/30"
                  >
                    <LayoutDashboard size={16} />
                  </Link>
                )}
                {user.role === 'USER' && (
                  <Link
                    href="/dashboard"
                    data-tip={t('dashboard')}
                    aria-label={t('dashboard')}
                    aria-current={isActive('/dashboard') ? 'page' : undefined}
                    className={cn(
                      'shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-xl border font-bold text-sm transition-colors',
                      isActive('/dashboard')
                        ? 'text-neon-cyan bg-neon-cyan/15 border-neon-cyan/30'
                        : 'text-gray-200 bg-white/[0.06] border-white/15 hover:border-neon-cyan/40'
                    )}
                  >
                    {userInitial}
                  </Link>
                )}
                {chatButton}
                {profileButton}
              </>
            ) : (
              <Link
                href="/login"
                className="inline-flex items-center h-9 px-4 text-sm font-bold rounded-xl neon-btn"
              >
                {t('login')}
              </Link>
            )}
          </div>

          <div className="md:hidden flex items-center gap-2 ml-auto">
            <ThemeSwitcher />
            <LanguageSwitcher />
          </div>
        </div>
      </div>
    </header>
  );
}
