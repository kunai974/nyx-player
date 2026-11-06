import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import CategoryDetailCard, { type CategoryItem, CARD_ASPECT_RATIO } from '../components/Lists/CategoryDetailCard';
import type { IptvStream, IptvSeries } from '../types/iptv';
import type { NavigateToContent } from '../types/navigation';
import { isCompactLayout } from '../utils/layout';
import { fitGridColumns, categoryGridColumnBounds, categoryGridPaddingLeft, categoryGridPaddingRight } from '../utils/gridColumns';
import { isTv } from '../utils/platform';
import { measureCssLength } from '../utils/cssHelpers';
import './CategoryDetailPage.css';

interface CategoryDetailPageProps {
  categoryName: string;
  items: CategoryItem[];
  type: 'movies' | 'series';
  onNavigateToContent: NavigateToContent;
  onBack: () => void;
  /** Extra controls in the header (filters) */
  headerExtra?: React.ReactNode;
}

// Grid layout constants
const CARD_GAP = 24; // 1.5rem
const OVERSCAN = 3; // rows to render beyond viewport

/**
 * CategoryDetailPage - Virtualized grid view for "Voir tout"
 */
const CategoryDetailPage: React.FC<CategoryDetailPageProps> = ({
  categoryName,
  items,
  type,
  onNavigateToContent,
  onBack,
  headerExtra,
}) => {
  const { t } = useTranslation('details');
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Calculate grid layout based on container width
  // --sidebar-safe-zone = 5.5rem + 3rem = 8.5rem = 136px @ 16px base
  // Téléphone (styles/mobile.css) : pas de sidebar à gauche, cartes plus petites
  const compact = isCompactLayout();
  // TV : la zone de la barre latérale se mesure (rem de 18 px, marge de sécurité), voir categoryGridPaddingLeft
  const [safeZone, setSafeZone] = useState(0);
  const [safeX, setSafeX] = useState(0);
  const paddingLeft = categoryGridPaddingLeft({ compact, tv: isTv(), measuredSafeZone: safeZone });
  const paddingRight = categoryGridPaddingRight({ compact, tv: isTv(), measuredSafeX: safeX });
  const cardGap = compact ? 10 : CARD_GAP;
  const availableWidth = containerWidth - paddingLeft - paddingRight;

  // Calculate columns and card width (pas d'espace après la dernière colonne : + cardGap).
  // Téléphone : affiches encadrées entre ≈ 92 et 150 points. Sans plafond de colonnes,
  // le minimum suffit à rester sous 150 dès qu'il y a 2 colonnes ; le maximum documente la règle.
  // TV : 5 colonnes (voir categoryGridColumnBounds).
  const columnsCount = fitGridColumns(availableWidth + cardGap, cardGap, categoryGridColumnBounds({ compact, tv: isTv() }));
  const cardWidth = Math.floor((availableWidth - (columnsCount - 1) * cardGap) / columnsCount);
  const cardHeight = cardWidth * CARD_ASPECT_RATIO;
  const rowHeight = cardHeight + cardGap;

  // Calculate row count
  const rowCount = Math.ceil(items.length / columnsCount);

  // Virtualizer for rows
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => containerRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
  });

  // Measure container width on mount and resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => {
      setContainerWidth(container.clientWidth);
      if (isTv()) {
        setSafeZone(measureCssLength('var(--sidebar-safe-zone)', container));
        setSafeX(measureCssLength('var(--tv-safe-x)', container));
      }
    };

    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  // Navigate helper
  const navigate = useCallback((item: CategoryItem) => {
    const contentType = type === 'movies' ? 'movie' : 'series';
    if (contentType === 'movie') {
      const stream = item as IptvStream;
      onNavigateToContent('movie', {
        tmdbId: stream.tmdb,
        streamId: Number(stream.stream_id),
      });
    } else {
      const series = item as IptvSeries;
      onNavigateToContent('series', {
        tmdbId: series.tmdb,
        seriesId: Number(series.series_id),
      });
    }
  }, [type, onNavigateToContent]);

  // Get item key
  const getItemKey = (item: CategoryItem) => {
    return ('stream_id' in item ? item.stream_id : undefined) ||
      ('series_id' in item ? item.series_id : item.name);
  };

  return (
    <div ref={containerRef} className="category-detail-page scrollbar-thin" data-testid="category-page" data-nav-cadence data-media-type={type === 'movies' ? 'movie' : 'series'}>
      {/* Header */}
      <div className="category-detail-header">
        <button className="back-button" data-testid="category-page-back" onClick={onBack} title={t('back')}>
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M16 20l-8-8 8-8" />
          </svg>
        </button>
        <h1 className="category-detail-title">{categoryName}</h1>
        {headerExtra && <div className="category-detail-filters">{headerExtra}</div>}
        <span className="category-detail-count">{t('titles_count', { count: items.length })}</span>
      </div>

      {/* Virtualized Grid */}
      {items.length > 0 && containerWidth > 0 ? (
        <div
          className="category-detail-grid"
          style={{
            height: virtualizer.getTotalSize() + cardGap,
            position: 'relative',
            display: 'block', // Override grid display
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const startIndex = virtualRow.index * columnsCount;
            const rowItems = items.slice(startIndex, startIndex + columnsCount);

            return (
              <div
                key={virtualRow.key}
                style={{
                  position: 'absolute',
                  top: virtualRow.start,
                  left: paddingLeft,
                  right: paddingRight,
                  height: rowHeight,
                  display: 'flex',
                  gap: cardGap,
                }}
              >
                {rowItems.map((item) => (
                  <CategoryDetailCard
                    key={getItemKey(item)}
                    item={item}
                    type={type}
                    onSelect={navigate}
                    cardWidth={cardWidth}
                  />
                ))}
              </div>
            );
          })}
        </div>
      ) : items.length === 0 ? (
        <div className="category-detail-empty">
          <h2>{t('empty_title')}</h2>
          <p>{t('empty_desc')}</p>
        </div>
      ) : null}
    </div>
  );
};

export default CategoryDetailPage;

