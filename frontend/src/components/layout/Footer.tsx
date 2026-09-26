import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { MapPin, Phone, Mail } from 'lucide-react';
import Logo from '@/components/brand/Logo';

export default function Footer() {
  const t = useTranslations('footer');
  const tn = useTranslations('nav');

  return (
    <footer className="border-t border-neon-cyan/15 bg-cyber-950/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Brand */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Logo size={34} />
              <span className="font-[--font-orbitron] font-bold tracking-widest neon-text">CYBER-ZONE</span>
            </div>
            <p className="text-sm text-gray-400">{t('tagline')}</p>
            <div className="flex gap-2 mt-4">
              <span className="chip"><span className="w-2 h-2 rounded-full bg-neon-green animate-pulse" /> 24/7 ochiq</span>
              <span className="chip chip-success">3 til</span>
            </div>
          </div>

          {/* Links */}
          <div>
            <h4 className="text-sm font-bold text-gray-200 mb-3 uppercase tracking-wider">{t('quickLinks')}</h4>
            <ul className="space-y-2 text-sm">
              <li><Link href="/" className="text-gray-400 hover:text-neon-cyan transition-colors">{tn('home')}</Link></li>
              <li><Link href="/rooms" className="text-gray-400 hover:text-neon-cyan transition-colors">{tn('rooms')}</Link></li>
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h4 className="text-sm font-bold text-gray-200 mb-3 uppercase tracking-wider">{t('contact')}</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              <li className="flex items-center gap-2"><MapPin size={14} className="text-neon-cyan" /> Toshkent, O&apos;zbekiston</li>
              <li className="flex items-center gap-2"><Phone size={14} className="text-neon-cyan" /> +998 90 000 00 00</li>
              <li className="flex items-center gap-2"><Mail size={14} className="text-neon-cyan" /> info@cyber-zone.uz</li>
            </ul>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-neon-cyan/10 text-center text-xs text-gray-500">
          © {new Date().getFullYear()} <span className="neon-text font-semibold">Cyber-ZONE</span>. {t('rights')}
        </div>
      </div>
    </footer>
  );
}