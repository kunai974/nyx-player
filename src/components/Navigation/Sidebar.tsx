import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TabType } from '../../contexts/NavigationContext';
import { DASHBOARD_RESET_EVENT } from '../../services/eventConstants';
import { useTvArrivalFocus } from '../../hooks/useTvArrivalFocus';
import nyxLogo from '../../assets/icons/nyx-logo.svg';

interface SidebarProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  onLogout: () => void;
  isHidden?: boolean; // Focus mode: hide on TV tab
  iptvStatus?: 'ok' | 'warning' | 'error'; // IPTV data status indicator
}

const Sidebar: React.FC<SidebarProps> = ({ activeTab, onTabChange, onLogout, isHidden = false, iptvStatus = 'ok' }) => {
  const { t } = useTranslation('navigation');
  // Télécommande : à l'arrivée sur une page, la sélection est sur son icône
  useTvArrivalFocus(activeTab);
  // Helper: Nyx branding SVG icons (fill-based)
  const getNyxIcon = (type: TabType | 'logout'): React.ReactNode => {
    switch (type) {
      case 'search': // Loupe vide
        return (
          <svg className="nav-icon" viewBox="0 0 190.69 190.55" fill="currentColor">
            <path d="M71.96,0C32.28,0,0,32.28,0,71.96s32.28,71.96,71.96,71.96,71.96-32.28,71.96-71.96S111.64,0,71.96,0ZM71.96,123.92c-28.65,0-51.96-23.31-51.96-51.96s23.31-51.96,51.96-51.96,51.96,23.31,51.96,51.96-23.31,51.96-51.96,51.96Z"/>
            <rect x="147.27" y="119.88" width="20" height="74.52" transform="translate(-65.05 157.23) rotate(-45)"/>
          </svg>
        );
      case 'dashboard': // Home
        return (
          <svg className="nav-icon" viewBox="0 0 192.45 181.5" fill="currentColor">
            <polygon points="172.5 181.5 19.95 181.5 19.95 63.65 40.95 63.65 40.95 160.5 151.5 160.5 151.5 63.65 172.5 63.65 172.5 181.5"/>
            <polygon points="12.79 91.81 0 75.15 97.91 0 192.45 72.57 179.67 89.23 97.91 26.47 12.79 91.81"/>
          </svg>
        );
      case 'movies': // Pellicule
        return (
          <svg className="nav-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M4 3h16a1 1 0 011 1v16a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1zm1 2v2h2V5H5zm0 4v2h2V9H5zm0 4v2h2v-2H5zm0 4v2h2v-2H5zm12-12v2h2V5h-2zm0 4v2h2V9h-2zm0 4v2h2v-2h-2zm0 4v2h2v-2h-2zM9 5v14h6V5H9z"/>
          </svg>
        );
      case 'series': // Écran avec lecture et pied
        return (
          <svg className="nav-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 4h18a1 1 0 011 1v11a1 1 0 01-1 1h-6l1.5 3H17v2H7v-2h.5L9 17H3a1 1 0 01-1-1V5a1 1 0 011-1zm1 2v9h16V6H4zm5 1.5l6 3.5-6 3.5v-7z"/>
          </svg>
        );
      case 'live': // Écran
        return (
          <svg className="nav-icon" viewBox="0 0 178.78 160.5" fill="currentColor">
            <path d="M178.78,123.43V0H0v123.43h75.62v17.08H30.14v20h110.97v-20h-45.49v-17.08h83.16ZM20,20s28.47,79.4,138.78,83.43H20V20Z"/>
          </svg>
        );
      case 'watchlist': // Étoile pleine
        return (
          <svg className="nav-icon" viewBox="0 0 188.49 179.27" fill="currentColor">
            <path d="M152.49,179.27l-58.25-32.96-58.25,32.96,13.34-65.58L0,68.47l66.49-7.58L94.25,0l27.75,60.9,66.49,7.58-49.34,45.21,13.34,65.58Z"/>
          </svg>
        );
      case 'settings': // Paramètre
        return (
          <svg className="nav-icon" viewBox="0 0 172.7 172.29" fill="currentColor">
            <path d="M151.96,78.7l20.74-12.14-11.08-26.55-23.38,5.28c-1.54-1.95-3.19-3.84-4.98-5.65-1.98-2-4.06-3.82-6.22-5.51l5.87-23.47L106.19.01l-12.64,20.49c-5.23-.57-10.51-.52-15.73.16L65.14,0l-26.3,11.64,5.79,23.31c-1.64,1.34-3.23,2.76-4.76,4.28-2.03,2.01-3.88,4.12-5.59,6.31l-23.48-5.72L.3,66.61l20.39,12.41c-.51,4.73-.5,9.5,0,14.24L0,105.4l11.11,26.54,23.11-5.25c1.61,2.06,3.33,4.05,5.22,5.95,1.95,1.97,4.01,3.77,6.13,5.45l-5.78,23.13,26.72,10.64,12.39-20.09c4.92.55,9.89.55,14.81,0l12.02,20.52,26.55-11.08-5.21-23.06c2-1.57,3.94-3.25,5.79-5.09,1.69-1.68,3.27-3.43,4.75-5.24l23,6.28,11.22-26.49-19.98-12.92c.69-5.3.73-10.67.13-15.98ZM86.35,126.61c-22.35,0-40.46-18.12-40.46-40.46s18.12-40.46,40.46-40.46,40.46,18.12,40.46,40.46-18.12,40.46-40.46,40.46Z"/>
          </svg>
        );
      case 'logout': // Reste stroke-based
        return (
          <svg className="nav-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5} style={{ color: '#ef4444' }}>
            <path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
        );
      default:
        return null;
    }
  };

  const renderButton = (type: TabType, label: string) => (
    <button
      className={`nav-item ${activeTab === type ? 'active' : ''}`}
      data-testid="nav-tab"
      data-tab={type}
      onClick={() => {
        if (type === 'dashboard' && activeTab === 'dashboard') {
          window.dispatchEvent(new CustomEvent(DASHBOARD_RESET_EVENT));
        }
        onTabChange(type);
      }}
      aria-label={label}
      data-label={label}
    >
      <div className="nav-icon-container">
        {getNyxIcon(type)}
        {activeTab === type && <div className="active-glow" />}

        {/* IPTV Error Badge - only on Settings icon */}
        {type === 'settings' && iptvStatus !== 'ok' && (
          <span
            className={`sidebar-badge sidebar-badge--${iptvStatus}`}
            title={iptvStatus === 'error' ? t('iptv_no_content') : t('iptv_vod_unavailable')}
          />
        )}
      </div>
    </button>
  );

  return (
    <div className={`sidebar ${isHidden ? 'sidebar--hidden' : ''}`} data-nav-zone="sidebar" data-testid="nav-sidebar">
      <div className="sidebar-logo">
        <img src={nyxLogo} alt="Nyx Player" className="logo-image" />
      </div>

      <nav className="sidebar-nav">
        {renderButton('search', t('search'))}
        {renderButton('dashboard', t('home'))}
        {renderButton('movies', t('movies'))}
        {renderButton('series', t('series'))}
        {renderButton('live', t('live'))}
        {renderButton('watchlist', t('watchlist'))}
      </nav>

      <div className="sidebar-footer">
        {renderButton('settings', t('settings'))}
        <button className="nav-item logout-button" onClick={onLogout} aria-label={t('logout')} data-label={t('logout')} data-testid="nav-logout">
          <div className="nav-icon-container">
            {getNyxIcon('logout')}
          </div>
        </button>
      </div>
    </div>
  );
};

export default Sidebar;
