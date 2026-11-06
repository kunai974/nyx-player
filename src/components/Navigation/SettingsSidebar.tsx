/**
 * SettingsSidebar - Navigation sidebar pour les paramètres
 *
 * Clone de TvCategoriesSidebar adapté aux Settings.
 * Même style Glass Panel pour cohérence UX.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import './SettingsSidebar.css';

export type SettingsSection =
    | 'sources'
    | 'general'
    | 'dashboard'
    | 'data'
    | 'account'
    | 'about';

interface SettingsSidebarProps {
    activeSection: SettingsSection;
    onSelectSection: (section: SettingsSection) => void;
    iptvStatus?: 'ok' | 'warning' | 'error';
    /** Téléphone : la déconnexion quitte la barre de navigation et ferme la liste des rubriques */
    onLogout?: () => void;
}

export const SettingsSidebar: React.FC<SettingsSidebarProps> = ({
    activeSection,
    onSelectSection,
    iptvStatus = 'ok',
    onLogout,
}) => {
    const { t } = useTranslation('settings');

    const menuItems: { id: SettingsSection; icon: React.ReactNode; label: string }[] = [
        { id: 'sources', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1.25rem', height: '1.25rem' }}><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" /><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4" /><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4" /><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1" /><circle cx="12" cy="12" r="2" /></svg>, label: t('sidebar_sources') },
        { id: 'general', icon: <svg viewBox="0 0 172.7 172.29" fill="currentColor" style={{ width: '1.25rem', height: '1.25rem' }}><path d="M151.96,78.7l20.74-12.14-11.08-26.55-23.38,5.28c-1.54-1.95-3.19-3.84-4.98-5.65-1.98-2-4.06-3.82-6.22-5.51l5.87-23.47L106.19.01l-12.64,20.49c-5.23-.57-10.51-.52-15.73.16L65.14,0l-26.3,11.64,5.79,23.31c-1.64,1.34-3.23,2.76-4.76,4.28-2.03,2.01-3.88,4.12-5.59,6.31l-23.48-5.72L.3,66.61l20.39,12.41c-.51,4.73-.5,9.5,0,14.24L0,105.4l11.11,26.54,23.11-5.25c1.61,2.06,3.33,4.05,5.22,5.95,1.95,1.97,4.01,3.77,6.13,5.45l-5.78,23.13,26.72,10.64,12.39-20.09c4.92.55,9.89.55,14.81,0l12.02,20.52,26.55-11.08-5.21-23.06c2-1.57,3.94-3.25,5.79-5.09,1.69-1.68,3.27-3.43,4.75-5.24l23,6.28,11.22-26.49-19.98-12.92c.69-5.3.73-10.67.13-15.98ZM86.35,126.61c-22.35,0-40.46-18.12-40.46-40.46s18.12-40.46,40.46-40.46,40.46,18.12,40.46,40.46-18.12,40.46-40.46,40.46Z"/></svg>, label: t('sidebar_general') },
        { id: 'dashboard', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1.25rem', height: '1.25rem' }}><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>, label: t('sidebar_dashboard') },
        { id: 'data', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1.25rem', height: '1.25rem' }}><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4.03 3-9 3S3 13.66 3 12" /><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" /></svg>, label: t('sidebar_data') },
        { id: 'account', icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
            </svg>
        ), label: t('sidebar_account') },
        { id: 'about', icon: <svg viewBox="0 0 178.53 178.53" fill="currentColor" style={{ width: '1.25rem', height: '1.25rem' }}><path d="M89.27,0C40.04,0,0,40.04,0,89.27s40.04,89.27,89.27,89.27,89.27-40.04,89.27-89.27S138.49,0,89.27,0ZM89.27,158.53c-38.19,0-69.27-31.07-69.27-69.27S51.07,20,89.27,20s69.27,31.07,69.27,69.27-31.07,69.27-69.27,69.27Z"/><rect x="79.27" y="75.81" width="20" height="61.38"/><rect x="79.27" y="47.17" width="20" height="17.13"/></svg>, label: t('sidebar_about') },
    ];

    return (
        <aside className="settings-sidebar" data-nav-zone="aside">
            {/* Header */}
            <div className="settings-sidebar__header">
                <h2 className="settings-sidebar__title">{t('sidebar_header')}</h2>
            </div>

            {/* Menu Items */}
            <nav className="settings-sidebar__nav scrollbar-thin">
                {menuItems.map((item) => (
                    <button
                        key={item.id}
                        className={`settings-nav-item ${activeSection === item.id ? 'active' : ''}`}
                        data-testid="settings-nav-item"
                        data-section={item.id}
                        onClick={() => onSelectSection(item.id)}
                    >
                        <span className="settings-nav-item__icon">{item.icon}</span>
                        <span className="settings-nav-item__label">{item.label}</span>

                        {/* Badge on Sources item when IPTV has issues */}
                        {item.id === 'sources' && iptvStatus !== 'ok' && (
                            <span className={`settings-nav-item__badge settings-nav-item__badge--${iptvStatus}`} />
                        )}
                    </button>
                ))}

                {onLogout && (
                    <button type="button" className="settings-nav-item settings-nav-item--logout" data-testid="settings-logout" onClick={onLogout}>
                        <span className="settings-nav-item__icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1.25rem', height: '1.25rem' }} aria-hidden="true">
                                <path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                            </svg>
                        </span>
                        <span className="settings-nav-item__label">{t('logout')}</span>
                    </button>
                )}
            </nav>

            <p className="settings-sidebar__credit" data-testid="settings-sidebar-credit">{t('macos_credit')}</p>
        </aside>
    );
};


