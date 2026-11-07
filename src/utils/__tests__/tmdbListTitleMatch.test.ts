/**
 * Rapprochement des listes TMDB de l'accueil avec les noms du catalogue : lien sûr ou rien.
 */

import { describe, it, expect } from 'vitest';
import { matchListTitle, prepareListTitles, type ListTitle } from '../tmdbListTitleMatch';

const movie = (tmdbId: number, title: string, year?: number, original?: string): ListTitle => ({
    kind: 'movie', tmdbId, titles: original ? [title, original] : [title], ...(year ? { year } : {}),
});

describe('matchListTitle', () => {
    const prepared = prepareListTitles([
        movie(693134, 'Dune : Deuxième partie', 2024, 'Dune: Part Two'),
        movie(426063, 'Nosferatu', 2024),
        movie(194, 'Le Fabuleux Destin d\'Amélie Poulain', 2001),
        movie(335984, 'Blade Runner 2049', 2017),
        { kind: 'series', tmdbId: 1396, titles: ['Breaking Bad'], year: 2008 },
    ]);

    it('links a name with a prefix, tags and the same year', () => {
        expect(matchListTitle('movie', 'FR | Dune: Part Two (2024) MULTI 1080p', prepared)).toEqual({ kind: 'sure', tmdbId: 693134 });
        expect(matchListTitle('movie', 'Dune : Deuxième partie (2024)', prepared)).toEqual({ kind: 'sure', tmdbId: 693134 });
    });

    it('accepts a one-year gap but not more', () => {
        expect(matchListTitle('movie', 'Nosferatu (2025)', prepared)).toEqual({ kind: 'sure', tmdbId: 426063 });
        // Le film de 1922 du même nom n'est pas celui de la liste
        expect(matchListTitle('movie', 'Nosferatu (1922)', prepared)).toBeNull();
    });

    it('asks for a confirmation when the name has no year (remakes)', () => {
        expect(matchListTitle('movie', 'Nosferatu', prepared)).toEqual({
            kind: 'confirm', tmdbId: 426063, query: { query: 'Nosferatu' },
        });
    });

    it('ignores accents, case and the apostrophe style', () => {
        expect(matchListTitle('movie', "le fabuleux destin d’amelie poulain 2001", prepared)).toEqual({ kind: 'sure', tmdbId: 194 });
    });

    it('confirms a title that ends with a number', () => {
        expect(matchListTitle('movie', 'Blade Runner 2049', prepared)).toEqual({
            kind: 'confirm', tmdbId: 335984, query: { query: 'Blade Runner 2049' },
        });
    });

    it('never mixes movies and series', () => {
        expect(matchListTitle('movie', 'Breaking Bad (2008)', prepared)).toBeNull();
        expect(matchListTitle('series', 'Breaking Bad (2008)', prepared)).toEqual({ kind: 'sure', tmdbId: 1396 });
    });

    it('does not link a different title', () => {
        expect(matchListTitle('movie', 'Dune (1984)', prepared)).toBeNull();
        expect(matchListTitle('movie', 'Dune Part Three (2026)', prepared)).toBeNull();
        expect(matchListTitle('movie', '', prepared)).toBeNull();
    });

    it('gives nothing when two list titles share the name and year', () => {
        const twins = prepareListTitles([movie(1, 'Twin', 2020), movie(2, 'Twin', 2020)]);
        expect(matchListTitle('movie', 'Twin (2020)', twins)).toBeNull();
        expect(matchListTitle('movie', 'Twin', twins)).toBeNull();
    });

    it('picks the exact year among close titles', () => {
        const close = prepareListTitles([movie(1, 'Echo', 2020), movie(2, 'Echo', 2021)]);
        expect(matchListTitle('movie', 'Echo (2021)', close)).toEqual({ kind: 'sure', tmdbId: 2 });
    });
});
