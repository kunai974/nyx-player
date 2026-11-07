/**
 * « Voir tout » (CategoryDetailPage) : la grille se redessine à chaque rangée montée au défilement. Les cartes déjà
 * montées ne doivent pas se redessiner avec elle (sur TV, 30 à 45 cartes à chaque rangée).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import type { IptvStream } from '../../types/iptv';

const cardRenders = vi.fn();
vi.mock('../../components/Lists/CategoryDetailCard', () => ({
  CARD_ASPECT_RATIO: 1.5,
  default: React.memo(function CardProbe(props: { item: { name: string } }) {
    cardRenders(props.item.name);
    return <div data-testid="category-card">{props.item.name}</div>;
  }),
}));

import CategoryDetailPage from '../CategoryDetailPage';

const films = Array.from({ length: 12 }, (_, i) => ({ stream_id: i + 1, name: `Film ${i + 1}`, tmdb: 0 }) as unknown as IptvStream);

beforeEach(() => {
  // jsdom ne mesure rien : une page de 1200 × 720
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720);
  // @tanstack/virtual-core ≥ 3.19 mesure la hauteur du conteneur avec clientHeight (et non plus offsetHeight)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(720);
  cardRenders.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CategoryDetailPage', () => {
  it('une grille redessinée ne redessine pas ses cartes déjà montées', () => {
    const onNavigateToContent = vi.fn();
    const onBack = vi.fn();
    const props = { categoryName: 'Action', items: films, type: 'movies' as const, onNavigateToContent, onBack };
    const { rerender } = render(<CategoryDetailPage {...props} />);
    expect(cardRenders).toHaveBeenCalled();
    cardRenders.mockClear();
    rerender(<CategoryDetailPage {...props} />);
    expect(cardRenders).not.toHaveBeenCalled();
  });
});
