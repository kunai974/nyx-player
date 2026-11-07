/**
 * resumeTarget : ce que lance une carte « Reprendre » quand le fournisseur a pu réattribuer le
 * numéro enregistré.
 */
import { describe, it, expect } from 'vitest';
import { resolveResumeTarget } from '../resumeTarget';
import { markStaleTitleLink } from '../../utils/lightIndexHelpers';
import type { LightIndexes } from '../../types/lightIndex';

const entry = (id: number, tmdbId: number) => ({ id, tmdbId });

function indexes(movies: { id: number; tmdbId: number }[], series: { id: number; tmdbId: number }[] = []): LightIndexes {
  return {
    movies: new Map(movies.map((m) => [m.id, m])),
    series: new Map(series.map((s) => [s.id, s])),
    live: new Map(),
    categories: new Map(),
    moviesByTmdb: new Map(movies.filter((m) => m.tmdbId > 0).map((m) => [m.tmdbId, m])),
    seriesByTmdb: new Map(series.filter((s) => s.tmdbId > 0).map((s) => [s.tmdbId, s])),
    iconPrefixes: [''],
  } as unknown as LightIndexes;
}

const film = { id: 100, type: 'movie' as const, tmdbId: 1 };
const episode = { id: 5001, type: 'series' as const, tmdbId: 7, seriesId: 300 };

describe('resolveResumeTarget', () => {
  it('garde le numéro enregistré quand il mène au même titre', () => {
    expect(resolveResumeTarget(film, indexes([entry(100, 1)]))).toEqual({ kind: 'as-saved' });
  });

  it('garde le numéro enregistré sans rien à comparer (catalogue absent, reprise ou entrée sans TMDB)', () => {
    expect(resolveResumeTarget(film, undefined)).toEqual({ kind: 'as-saved' });
    expect(resolveResumeTarget({ ...film, tmdbId: null }, indexes([entry(100, 2)]))).toEqual({ kind: 'as-saved' });
    expect(resolveResumeTarget(film, indexes([entry(100, 0)]))).toEqual({ kind: 'as-saved' });
  });

  it('entrée sans numéro dont le lien par le titre a été perdu à un changement de nom : introuvable, jamais l\'ancien film', () => {
    // Le fournisseur a redonné ce numéro à un autre titre : la reprise de Dune ne doit pas lancer Barbie
    const barbie = entry(100, 0);
    markStaleTitleLink(barbie);
    expect(resolveResumeTarget(film, indexes([barbie]))).toEqual({ kind: 'unavailable' });
    // Sans marque (jamais relié), rien à comparer : lecture comme avant
    expect(resolveResumeTarget(film, indexes([entry(100, 0)]))).toEqual({ kind: 'as-saved' });
  });

  it('numéro repris par un autre film, titre absent : introuvable', () => {
    expect(resolveResumeTarget(film, indexes([entry(100, 2)]))).toEqual({ kind: 'unavailable' });
  });

  it('numéro repris par un autre film, titre ailleurs : re-lié à son numéro', () => {
    expect(resolveResumeTarget(film, indexes([entry(100, 2), entry(250, 1)]))).toEqual({ kind: 'relinked', id: 250 });
  });

  // Une reprise n'est plus effacée à la connexion, elle reste affichée « Introuvable »
  it('numéro disparu : re-lié si le titre est ailleurs, sinon introuvable', () => {
    expect(resolveResumeTarget(film, indexes([entry(250, 1)]))).toEqual({ kind: 'relinked', id: 250 });
    expect(resolveResumeTarget(film, indexes([entry(250, 3)]))).toEqual({ kind: 'unavailable' });
    expect(resolveResumeTarget({ ...film, tmdbId: null }, indexes([entry(250, 3)]))).toEqual({ kind: 'unavailable' });
  });

  it('catalogue de films vide (liste pas encore reçue) : rien ne permet de juger, inchangé', () => {
    expect(resolveResumeTarget(film, indexes([]))).toEqual({ kind: 'as-saved' });
    expect(resolveResumeTarget({ ...film, tmdbId: null }, indexes([]))).toEqual({ kind: 'as-saved' });
  });

  it('épisode : vérifie la série par son numéro TMDB', () => {
    expect(resolveResumeTarget(episode, indexes([], [entry(300, 7)]))).toEqual({ kind: 'as-saved' });
    expect(resolveResumeTarget(episode, indexes([], [entry(300, 8)]))).toEqual({ kind: 'unavailable' });
    expect(resolveResumeTarget(episode, indexes([], [entry(300, 8), entry(410, 7)]))).toEqual({ kind: 'relinked', id: 410 });
  });

  it('épisode sans numéro de série : inchangé', () => {
    expect(resolveResumeTarget({ ...episode, seriesId: undefined }, indexes([], [entry(300, 8)]))).toEqual({ kind: 'as-saved' });
  });
});
