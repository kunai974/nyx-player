/**
 * WatchlistButton — Bouton réutilisable d'ajout/retrait watchlist.
 *
 * Deux tailles :
 * - "sm" (2.25rem) — pour cards (CategoryDetailCard, CarouselCard, WatchlistPage)
 * - "md" (3.5rem) — pour pages détail (MovieDetailPage, SeriesDetailPage)
 *
 * SVG custom Nyx Player branding (plus.svg + check.svg).
 * Animation de transition +/✓ via CSS (opacity, scale, rotate).
 */

import React from 'react';
import './WatchlistButton.css';

interface WatchlistButtonProps {
  /** Est-ce que l'item est dans la watchlist ? */
  isAdded: boolean;
  /** Callback au clic (toggle) */
  onClick: (e: React.MouseEvent) => void;
  /** Taille du bouton */
  size?: 'sm' | 'md';
  /** Titre/tooltip */
  title?: string;
  /** Classes CSS additionnelles */
  className?: string;
  /**
   * `false` retire le bouton du parcours de focus (Android TV) : à la télécommande, on navigue
   * de carte en carte, les actions secondaires passent par la page détail.
   */
  focusable?: boolean;
  /** Repère du banc de test (défaut : « watchlist-button ») */
  testId?: string;
}

/** SVG inline "+" — Nyx Player branding (viewBox 161.12) */
const PlusIcon: React.FC = () => (
  <svg className="watchlist-btn__icon watchlist-btn__icon--plus" viewBox="0 0 161.12 161.12" fill="currentColor">
    <polygon points="161.12 70.56 90.56 70.56 90.56 0 70.56 0 70.56 70.56 0 70.56 0 90.56 70.56 90.56 70.56 161.12 90.56 161.12 90.56 90.56 161.12 90.56 161.12 70.56" />
  </svg>
);

/** SVG inline "✓" — Nyx Player branding (viewBox 174.74x159.46) */
const CheckIcon: React.FC = () => (
  <svg className="watchlist-btn__icon watchlist-btn__icon--check" viewBox="0 0 174.74 159.46" fill="currentColor">
    <polygon points="62.56 159.46 0 67.99 16.51 56.7 63.43 125.31 158.83 0 174.74 12.12 62.56 159.46" />
  </svg>
);

const WatchlistButton: React.FC<WatchlistButtonProps> = ({
  isAdded,
  onClick,
  size = 'sm',
  title,
  className = '',
  focusable,
  testId = 'watchlist-button',
}) => {
  const classes = [
    'watchlist-btn',
    `watchlist-btn--${size}`,
    isAdded ? 'watchlist-btn--added' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      className={classes}
      onClick={onClick}
      aria-label={title}
      data-tip={size === 'md' ? title : undefined}
      title={size === 'md' ? undefined : title}
      type="button"
      tabIndex={focusable === false ? -1 : undefined}
      data-testid={testId}
    >
      <PlusIcon />
      <CheckIcon />
    </button>
  );
};

export default WatchlistButton;
