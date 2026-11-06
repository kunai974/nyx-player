/**
 * AppRoutes.tsx — Routing conditionnel de l'application
 *
 * Extrait depuis App.tsx (Phase 3B).
 * Composant pur qui rend la page active en fonction de l'onglet sélectionné.
 * Reçoit toutes ses données via props — aucun useContext direct.
 */

import React from 'react';
import ErrorBoundary from './Common/ErrorBoundary';
import DashboardPage from '../pages/DashboardPage';
import LiveTvPage from '../pages/LiveTvPage';
import BrowseAllPage from '../pages/BrowseAllPage';
// Pages secondaires chargées à la demande : App rend AppRoutes sous un <Suspense>
import { SettingsPage, WatchlistPage, GlobalSearchPage, CategoryDetailPage } from './lazyPages';
import type { IptvStream, IptvSeries } from '../types/iptv';
import type { LightIndexes } from '../types/lightIndex';
import { liveTvLists } from '../services/liveTvLists';
import type { NavigateToContent } from '../types/navigation';
import type { TabType, LiveTvViewMode } from '../types/navigation';

interface CategoryDetailState {
    categoryId: string;
    categoryName: string;
    items: IptvStream[] | IptvSeries[];
    type: 'movies' | 'series';
}

interface AppRoutesProps {
    activeTab: string;
    categoryDetail: CategoryDetailState | null;
    searchQuery: string;
    onSearchChange: (query: string) => void;
    lightIndexes: LightIndexes | null;
    iptvStatus: 'ok' | 'warning' | 'error';
    navigateToContent: NavigateToContent;
    navigateToCategory: (detail: CategoryDetailState) => void;
    goBack: () => void;
    // Live TV props
    liveTvSelectedCategory: string;
    liveTvViewMode: LiveTvViewMode;
    // Watchlist CTA
    onNavigateToTab?: (tab: TabType) => void;
    // Profile props (Account section)
    profileName?: string;
    profileId?: string;
    onProfileRenamed?: () => void;
    /** Déconnexion (téléphone : en bas de la liste des rubriques des paramètres) */
    onLogout?: () => void;
    /** Accueil caché par une fiche ou par la lecture : la bannière arrête sa rotation. */
    homeCovered?: boolean;
}

const AppRoutes: React.FC<AppRoutesProps> = ({
    activeTab,
    categoryDetail,
    searchQuery,
    onSearchChange,
    lightIndexes,
    iptvStatus,
    navigateToContent,
    navigateToCategory,
    goBack,
    liveTvSelectedCategory,
    liveTvViewMode,
    onNavigateToTab,
    profileName,
    profileId,
    onProfileRenamed,
    onLogout,
    homeCovered = false,
}) => {

    if (categoryDetail) {
        return (
            <div className="content-wrapper">
                <ErrorBoundary context="CategoryDetail">
                <CategoryDetailPage
                    categoryName={categoryDetail.categoryName}
                    items={categoryDetail.items}
                    type={categoryDetail.type}
                    onNavigateToContent={navigateToContent}
                    onBack={goBack}
                />
                </ErrorBoundary>
            </div>
        );
    }

    if (activeTab === 'search') {
        return (
            <div className="content-wrapper">
                <ErrorBoundary context="Search">
                <GlobalSearchPage
                    onNavigateToContent={navigateToContent}
                    searchQuery={searchQuery}
                    onSearchChange={onSearchChange}
                    lightIndexes={lightIndexes ?? undefined}
                />
                </ErrorBoundary>
            </div>
        );
    }

    if (activeTab === 'dashboard') {
        // Don't render DashboardPage until lightIndexes is ready — prevents
        // a brief flash of empty Hero + empty carousels while data loads.
        if (!lightIndexes) {
            return <div className="content-wrapper dashboard-wrapper" />;
        }
        return (
            <div className="content-wrapper dashboard-wrapper">
                <ErrorBoundary context="Dashboard">
                <DashboardPage
                    iptvStatus={iptvStatus}
                    onNavigateToContent={navigateToContent}
                    lightIndexes={lightIndexes}
                    heroPaused={homeCovered}
                    onOpenCategoryDetail={(categoryId, categoryName, items, type) => {
                        navigateToCategory({
                            categoryId,
                            categoryName,
                            items: items as IptvStream[],
                            type,
                        });
                    }}
                />
                </ErrorBoundary>
            </div>
        );
    }

    if (activeTab === 'settings') {
        return (
            <ErrorBoundary context="Settings">
            <SettingsPage
                profileName={profileName}
                profileId={profileId}
                onProfileRenamed={onProfileRenamed}
                onLogout={onLogout}
            />
            </ErrorBoundary>
        );
    }

    if (activeTab === 'watchlist' && lightIndexes) {
        return (
            <ErrorBoundary context="Watchlist">
            <WatchlistPage
                key="watchlist"
                onNavigateToContent={navigateToContent}
                onNavigateToTab={onNavigateToTab}
                lightIndexes={lightIndexes}
            />
            </ErrorBoundary>
        );
    }

    if ((activeTab === 'movies' || activeTab === 'series') && lightIndexes) {
        return (
            <div className="content-wrapper">
                <ErrorBoundary context="Browse">
                <BrowseAllPage
                    key={activeTab}
                    type={activeTab}
                    lightIndexes={lightIndexes}
                    onNavigateToContent={navigateToContent}
                    onBack={() => onNavigateToTab?.('dashboard')}
                />
                </ErrorBoundary>
            </div>
        );
    }

    if (activeTab === 'live' && lightIndexes) {
        const live = liveTvLists(lightIndexes);
        return (
            <ErrorBoundary context="LiveTV">
            <LiveTvPage
                categories={live.categories}
                streams={live.streams}
                selectedCategory={liveTvSelectedCategory}
                viewMode={liveTvViewMode}
            />
            </ErrorBoundary>
        );
    }

    return null;
};

export default AppRoutes;
