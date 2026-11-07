/**
 * Tests pour useBackdropUrl.ts
 *
 * Vérifie la chaîne de fallback :
 * 1. TMDB images.backdrops (sans langue)
 * 2. Xtream fallbackBackdrops[]
 * 3. TMDB backdrop_path simple
 * 4. fallbackCover
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBackdropUrl } from '../useBackdropUrl';

// Mock tmdbApi — imageUrl retourne l'URL concaténée
vi.mock('../../services/tmdbApi', () => ({
  default: {
    imageUrl: (path: string | null, size: string) =>
      path ? `https://image.tmdb.org/t/p/${size}${path}` : null,
  },
}));

describe('useBackdropUrl', () => {
  const COVER = 'https://fallback-cover.jpg';

  it('utilise les TMDB backdrops sans langue (priorité 1)', () => {
    const details = {
      images: {
        backdrops: [
          { file_path: '/bd1.jpg', iso_639_1: null },
          { file_path: '/bd2.jpg', iso_639_1: null },
          { file_path: '/bd3.jpg', iso_639_1: null },
        ],
      },
    };

    const { result } = renderHook(() =>
      useBackdropUrl(details, undefined, COVER, 0),
    );

    expect(result.current).toBe('https://image.tmdb.org/t/p/original/bd1.jpg');
  });

  it('respecte le backdropIndex en cyclant', () => {
    const details = {
      images: {
        backdrops: [
          { file_path: '/bd1.jpg', iso_639_1: null },
          { file_path: '/bd2.jpg', iso_639_1: null },
        ],
      },
    };

    const { result } = renderHook(() =>
      useBackdropUrl(details, undefined, COVER, 3),
    );

    // index 3 % 2 = 1 → bd2.jpg
    expect(result.current).toBe('https://image.tmdb.org/t/p/original/bd2.jpg');
  });

  it('filtre les backdrops avec une langue (garde uniquement null)', () => {
    const details = {
      images: {
        backdrops: [
          { file_path: '/bd_fr.jpg', iso_639_1: 'fr' },
          { file_path: '/bd_en.jpg', iso_639_1: 'en' },
          { file_path: '/bd_null.jpg', iso_639_1: null },
        ],
      },
    };

    const { result } = renderHook(() =>
      useBackdropUrl(details, undefined, COVER, 0),
    );

    expect(result.current).toBe('https://image.tmdb.org/t/p/original/bd_null.jpg');
  });

  it('fallback vers xtream backdrop_path[] (priorité 2)', () => {
    const details = { images: { backdrops: [] } };
    const fallbacks = ['https://xtream/bg1.jpg', 'https://xtream/bg2.jpg'];

    const { result } = renderHook(() =>
      useBackdropUrl(details, fallbacks, COVER, 1),
    );

    expect(result.current).toBe('https://xtream/bg2.jpg');
  });

  it('backdrop_path du fournisseur fait de chaînes vides : affiche à la place', () => {
    const details = { images: { backdrops: [] } };
    const { result } = renderHook(() => useBackdropUrl(details, ['', ' '], COVER, 0));
    expect(result.current).toBe(COVER);
    const mixed = renderHook(() => useBackdropUrl(details, ['', 'https://xtream/bg1.jpg'], COVER, 0));
    expect(mixed.result.current).toBe('https://xtream/bg1.jpg');
  });

  it('fallback vers TMDB backdrop_path simple (priorité 3)', () => {
    const details = {
      images: { backdrops: [] },
      backdrop_path: '/simple.jpg',
    };

    const { result } = renderHook(() =>
      useBackdropUrl(details, undefined, COVER, 0),
    );

    expect(result.current).toBe('https://image.tmdb.org/t/p/original/simple.jpg');
  });

  it('fallback final vers cover (priorité 4)', () => {
    const details = { images: { backdrops: [] } };

    const { result } = renderHook(() =>
      useBackdropUrl(details, undefined, COVER, 0),
    );

    expect(result.current).toBe(COVER);
  });

  it('retourne cover si details est null', () => {
    const { result } = renderHook(() =>
      useBackdropUrl(null, undefined, COVER, 0),
    );

    expect(result.current).toBe(COVER);
  });
});
