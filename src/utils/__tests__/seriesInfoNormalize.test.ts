/**
 * Réponses get_series_info écrites autrement par certains fournisseurs : numéros en nombre,
 * épisodes en tableau de saisons, saison ou liste de saisons en objet.
 */

import { describe, it, expect } from 'vitest';
import { normalizeSeriesInfo } from '../seriesInfoNormalize';
import type { XtreamSeriesInfo } from '../../types/xtream';

const raw = (value: unknown) => value as XtreamSeriesInfo;

describe('normalizeSeriesInfo', () => {
  it('numéros d\'épisode en nombre : rendus en texte, numéro dans la saison en nombre', () => {
    const info = normalizeSeriesInfo(raw({ episodes: { 1: [{ id: 101, episode_num: '2', title: 'A' }] } }));
    expect(info.episodes).toEqual({ 1: [{ id: '101', episode_num: 2, title: 'A' }] });
  });

  it('réponse déjà conforme : même contenu', () => {
    const conforme = raw({
      info: { name: 'Série' },
      seasons: [{ season_number: 1, name: 'Saison 1' }],
      episodes: { 1: [{ id: '101', episode_num: 1, title: 'A', container_extension: 'mkv' }] },
    });
    expect(normalizeSeriesInfo(conforme)).toEqual(conforme);
  });

  it('saison en objet à clés numériques, liste des saisons en objet', () => {
    const info = normalizeSeriesInfo(raw({
      seasons: { 0: { season_number: 1, name: 'S1' } },
      episodes: { 2: { 0: { id: 201, episode_num: 1 }, 1: { id: 202, episode_num: 2 } } },
    }));
    expect(info.seasons).toEqual([{ season_number: 1, name: 'S1' }]);
    expect(info.episodes?.['2']?.map((ep) => ep.id)).toEqual(['201', '202']);
  });

  it('épisodes en tableau de saisons : saison écrite dans l\'épisode, sinon sa place', () => {
    const info = normalizeSeriesInfo(raw({
      episodes: [
        [{ id: 1, episode_num: 1, season: 3 }],
        [{ id: 2, episode_num: 1 }],
      ],
    }));
    expect(Object.keys(info.episodes ?? {})).toEqual(['2', '3']);
    expect(info.episodes?.['3']?.[0].id).toBe('1');
    expect(info.episodes?.['2']?.[0].id).toBe('2');
  });

  it('épisodes en tableau avec une saison 0 (spéciaux) : gardée à part, pas mêlée à la saison 1', () => {
    const info = normalizeSeriesInfo(raw({
      episodes: [
        [{ id: 900, episode_num: 1, season: 0 }],
        [{ id: 101, episode_num: 1, season: 1 }],
      ],
    }));
    expect(info.episodes?.['0']?.map((ep) => ep.id)).toEqual(['900']);
    expect(info.episodes?.['1']?.map((ep) => ep.id)).toEqual(['101']);
  });

  it('épisode sans numéro ou illisible : écarté', () => {
    const info = normalizeSeriesInfo(raw({ episodes: { 1: [null, { episode_num: 1 }, { id: '', episode_num: 2 }, { id: 5, episode_num: 3 }] } }));
    expect(info.episodes?.['1']?.map((ep) => ep.id)).toEqual(['5']);
  });
});
