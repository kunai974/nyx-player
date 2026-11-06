/**
 * Une série dont TMDB ne connaît pas le numéro (ou sans numéro TMDB chez le fournisseur) doit
 * afficher les épisodes du fournisseur, avec leur bouton de lecture. Avant la correction, la fiche
 * passait en repli et le carrousel des épisodes restait en squelettes pour toujours : l'épisode ne
 * pouvait pas être lancé.
 *
 * useTmdbSeries est le vrai hook ; TMDB et son cache sont simulés (aucun appel réseau). Les épisodes
 * viennent du fournisseur (useSeriesDetail simulé).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AppSeriesInfo, XtreamEpisode } from '../../types/xtream';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../SeriesDetailPage.css', () => ({}));
vi.mock('../../utils/tmdbLanguage', () => ({ getTmdbLanguage: () => 'fr-FR' }));

const play = vi.fn();
vi.mock('../../contexts/PlayerContext', () => ({
  usePlayer: () => ({ play, setCurrentSeries: vi.fn() }),
}));
vi.mock('../../contexts/DevOverrideContext', () => ({
  useDevOverrides: () => ({ overrides: { seriesDetailPage: {} }, setActivePage: () => {} }),
}));

vi.mock('../../services/tmdbApi', () => ({
  default: {
    getTvDetails: vi.fn(),
    getSeasonDetailsWithFallback: vi.fn(),
    searchTv: vi.fn(async () => ({ results: [] })),
    imageUrl: () => null,
  },
}));
vi.mock('../../services/tmdbCacheSqlite', () => ({
  getCachedDetails: vi.fn(async () => null),
  cacheSeriesDetails: vi.fn(async () => {}),
}));
vi.mock('../../services/watchlistHydration', () => ({
  isInWatchlist: vi.fn(async () => false),
  toggleWatchlist: vi.fn(async () => {}),
}));
vi.mock('../../services/playbackProgressService', () => ({
  clearMultipleProgress: vi.fn(),
  clearProgress: vi.fn(),
}));

const mockVersions = vi.hoisted(() => ({ list: [] as Array<{ series_id: number; name: string }> }));
const episode = { id: '9001', episode_num: 1, title: 'Épisode du fournisseur', container_extension: 'mkv' } as unknown as XtreamEpisode;
vi.mock('../../hooks/useSeriesSourceSelection', () => ({
  useSeriesSourceSelection: ({ initialSeries }: { initialSeries: AppSeriesInfo }) => ({
    series: initialSeries,
    groupedVersions: mockVersions.list,
    handleSourceChange: () => {},
  }),
}));
vi.mock('../../hooks/useSeriesDetail', () => ({
  useSeriesDetail: () => ({
    localEpisodes: { 1: [episode] },
    isEpisodesLoading: false,
    selectedSeason: 1,
    setSelectedSeason: () => {},
    episodeProgress: new Map(),
    resetKey: 0,
    setResetKey: () => {},
  }),
}));
vi.mock('../../hooks/useBackdropUrl', () => ({ useBackdropUrl: () => '' }));
vi.mock('../../hooks/useTvPageFocus', () => ({ useTvPageFocus: () => {} }));

import tmdb from '../../services/tmdbApi';
import SeriesDetailPage from '../SeriesDetailPage';
import { setTvMode } from '../../utils/platform';

const series = (tmdb_id: string) =>
  ({ series_id: 5, name: 'Série du banc', cover: '', tmdb_id }) as unknown as AppSeriesInfo;

/** Erreur du relais TMDB pour un numéro inconnu (tmdbApi.tmdbFetch) */
const notFound = () => Object.assign(new Error('TMDB Proxy error: 404 Not Found'), { status: 404 });

describe('SeriesDetailPage : épisodes sans fiche TMDB', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('numéro TMDB inconnu de TMDB : les épisodes du fournisseur se lancent', async () => {
    vi.mocked(tmdb.getTvDetails).mockRejectedValue(notFound());
    vi.mocked(tmdb.getSeasonDetailsWithFallback).mockRejectedValue(notFound());

    render(<SeriesDetailPage series={series('999999999')} onBack={() => {}} />);

    const playButton = await screen.findByTestId('episode-card-play', {}, { timeout: 4000 });
    expect(screen.getByText('Épisode du fournisseur')).toBeTruthy();
    fireEvent.click(playButton);
    expect(play).toHaveBeenCalledWith(episode, expect.anything(), undefined, expect.anything());
  });

  it('saison rendue sans liste d\'épisodes : les épisodes du fournisseur s\'affichent, sans squelette', async () => {
    vi.mocked(tmdb.getTvDetails).mockResolvedValue({ id: 77, name: 'La Série' } as never);
    vi.mocked(tmdb.getSeasonDetailsWithFallback).mockResolvedValue({ success: false, status_code: 34 } as never);

    const { container } = render(<SeriesDetailPage series={series('77')} onBack={() => {}} />);

    await screen.findByTestId('episode-card-play', {}, { timeout: 4000 });
    await waitFor(() => expect(container.querySelector('.episode-card-netflix .skeleton-item')).toBeNull());
    expect(screen.getByText('Épisode du fournisseur')).toBeTruthy();
  });

  it('sans numéro TMDB chez le fournisseur : les épisodes se lancent, sans appel TMDB', async () => {
    render(<SeriesDetailPage series={series('0')} onBack={() => {}} />);

    const playButton = await screen.findByTestId('episode-card-play', {}, { timeout: 4000 });
    fireEvent.click(playButton);
    expect(play).toHaveBeenCalled();
    expect(tmdb.getTvDetails).not.toHaveBeenCalled();
  });
});

describe('SeriesDetailPage : étages de la télécommande', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockVersions.list = [];
    setTvMode(true);
  });

  afterEach(() => setTvMode(false));

  it('la source a son propre étage, sous les saisons (Haut/Bas, pas Gauche/Droite)', async () => {
    mockVersions.list = [{ series_id: 5, name: 'FR' }, { series_id: 6, name: 'VOSTFR' }];
    const { container } = render(<SeriesDetailPage series={series('0')} onBack={() => {}} />);
    await screen.findByTestId('episode-card-play', {}, { timeout: 4000 });

    const seasonRow = container.querySelector('[data-nav-row="series-season"]');
    const sourceRow = container.querySelector('[data-nav-row="series-source"]');
    expect(seasonRow).not.toBeNull();
    expect(sourceRow).not.toBeNull();
    expect(sourceRow?.querySelector('#source-selector')).not.toBeNull();
    expect(seasonRow?.querySelector('#source-selector')).toBeNull();
  });

  it('hors TV : la source reste dans la ligne des saisons, sans zone de synopsis', async () => {
    setTvMode(false);
    mockVersions.list = [{ series_id: 5, name: 'FR' }, { series_id: 6, name: 'VOSTFR' }];
    const { container } = render(<SeriesDetailPage series={series('0')} onBack={() => {}} />);
    await screen.findByTestId('episode-card-play', {}, { timeout: 4000 });
    expect(container.querySelector('[data-nav-row="series-source"]')).toBeNull();
    expect(container.querySelector('[data-nav-row="series-season"] #source-selector')).not.toBeNull();
    expect(container.querySelector('.synopsis-container')).toBeNull();
  });

  it('une seule source : pas d\'étage de source', async () => {
    const { container } = render(<SeriesDetailPage series={series('0')} onBack={() => {}} />);
    await screen.findByTestId('episode-card-play', {}, { timeout: 4000 });
    expect(container.querySelector('[data-nav-row="series-source"]')).toBeNull();
  });
});
