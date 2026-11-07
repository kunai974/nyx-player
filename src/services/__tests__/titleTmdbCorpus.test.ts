/**
 * Lien titre → fiche TMDB sur des noms écrits comme chez les fournisseurs IPTV.
 *
 * Utilise la vraie logique de l'appli (cleanTitleForSearch + pickConfidentMatch, comme searchByTitle)
 * contre une mini-base façon TMDB (fixtures/tmdbTitleCorpus.ts). Trois issues par titre :
 *  - bonne fiche ; fausse fiche (grave : jamais acceptée) ; pas de fiche (acceptable si ambigu, sinon
 *    c'est un « raté » compté et plafonné).
 * Les ratés connus sont listés en dur : un raté de plus, ou un raté corrigé, fait échouer le test
 * pour obliger à mettre la liste à jour (et à relire le bilan).
 */

import { describe, it, expect } from 'vitest';
import { cleanTitleForSearch, normalizeTitle, pickConfidentMatch, yearOf, type TitleCandidate } from '../../utils/tmdbTitleMatch';
import { matchListTitle, prepareListTitles } from '../../utils/tmdbListTitleMatch';
import { PROVIDER_TITLES, TMDB_INDEX, type FixtureEntry, type ProviderTitle } from './fixtures/tmdbTitleCorpus';

/** Recherche façon TMDB : tous les mots demandés se retrouvent dans un titre (traduit ou original) */
function fakeSearch(kind: 'movie' | 'series', query: string): TitleCandidate[] {
    const words = normalizeTitle(query).split(' ').filter(Boolean);
    if (words.length === 0) return [];
    return TMDB_INDEX.filter((e) => e.kind === kind)
        .filter((e) => [e.title, e.original].some((t) => {
            const have = new Set(normalizeTitle(t).split(' '));
            return words.every((w) => have.has(w));
        }))
        .slice(0, 20)
        .map((e) => ({ id: e.id, titles: [e.title, e.original], year: yearOf(`${e.year}-01-01`) }));
}

/** Ce que fait findTitleTmdbId pour un film ou une série sans numéro (étape 4 : recherche par le titre) */
function link(p: ProviderTitle): number {
    const query = cleanTitleForSearch(p.name);
    if (!query) return 0;
    return pickConfidentMatch(query, fakeSearch(p.kind, query.query));
}

/**
 * Ratés connus : une fiche existe mais l'appli ne la relie pas (jamais une fausse fiche).
 * Causes : titre écrit autrement que TMDB (« Le Parrain 2 » pour « Le Parrain, 2ème partie »,
 * « Asterix et Obelix » sans accents ni ponctuation). Les saisons et les préfixes « XX| » sont nettoyés.
 */
const KNOWN_MISSES = [
    'FR| Le Parrain 2 (1974)',
    'Asterix et Obelix Mission Cleopatre 2002',
];

describe('lien par le titre sur des noms de fournisseurs', () => {
    const outcomes = PROVIDER_TITLES.map((p) => ({ p, got: link(p) }));
    const good = outcomes.filter(({ p, got }) => p.expect !== null && got === p.expect);
    const wrong = outcomes.filter(({ p, got }) => got !== 0 && got !== p.expect);
    const missed = outcomes.filter(({ p, got }) => p.expect !== null && got === 0);
    const silentOk = outcomes.filter(({ p, got }) => p.expect === null && got === 0);

    it('aucune fausse fiche', () => {
        expect(wrong.map(({ p, got }) => `${p.name} → ${got} (attendu ${p.expect})`)).toEqual([]);
    });

    it('ambigu ou absent de TMDB : l\'appli se tait', () => {
        expect(silentOk.length).toBe(PROVIDER_TITLES.filter((p) => p.expect === null).length - wrong.filter(({ p }) => p.expect === null).length);
    });

    it('ratés : exactement la liste connue', () => {
        expect(missed.map(({ p }) => p.name).sort()).toEqual([...KNOWN_MISSES].sort());
    });

    it('bilan : taux de bonnes fiches parmi les titres qui en ont une', () => {
        const withCard = PROVIDER_TITLES.filter((p) => p.expect !== null).length;
        const rate = good.length / withCard;
        // Affiché dans la sortie des tests : lisible sans ouvrir le code
        console.info(`TMDB par titre : ${good.length}/${withCard} bonnes fiches (${(rate * 100).toFixed(0)} %), ${wrong.length} fausses, ${missed.length} ratées, ${silentOk.length} silences justes`);
        expect(rate).toBeGreaterThanOrEqual(0.85);
    });
});

describe('versions du même titre réunies sur une fiche (sources groupées)', () => {
    const asEntry = (id: number): FixtureEntry => TMDB_INDEX.find((e) => e.id === id)!;
    const prepared = (id: number) => {
        const e = asEntry(id);
        return prepareListTitles([{ kind: e.kind, tmdbId: e.id, titles: [e.title, e.original], year: e.year }]);
    };

    it('« Dune (2021) » : les autres versions de 2021 rejoignent la fiche, pas 1984 ni la suite', () => {
        const dune2021 = prepared(438631);
        const verdict = (name: string) => matchListTitle('movie', name, dune2021);
        expect(verdict('FR| Dune (2021)')).toMatchObject({ tmdbId: 438631 });
        expect(verdict('Dune (2021) 4K')).toMatchObject({ tmdbId: 438631 });
        expect(verdict('Dune.2021.MULTI.1080p')).toMatchObject({ tmdbId: 438631 });
        expect(verdict('Dune (1984)')).toBeNull();
        expect(verdict('Dune: Deuxième partie (2024)')).toBeNull();
    });

    it('sans année : seulement à confirmer par une recherche, jamais acceptée d\'office', () => {
        expect(matchListTitle('movie', 'Dune', prepared(438631))).toMatchObject({ kind: 'confirm' });
    });
});
