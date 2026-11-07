/**
 * Relais TMDB, recherche groupée : lecture des titres demandés, réponse réduite, recherches limitées
 * à quelques-unes en même temps.
 */
import { describe, it, expect } from 'vitest';
import {
    BATCH_MAX_ITEMS, BATCH_RESULTS_PER_ITEM, mapWithLimit, parseBatchItems, slimSearchAnswer,
} from '../../../supabase/functions/_shared/tmdbBatch';

describe('titres d\'une recherche groupée', () => {
    it('lit sorte, année et titre ; le titre peut contenir « : »', () => {
        expect(parseBatchItems(['movie:2010:Inception', 'tv::Lost', 'movie::Mission: Impossible'])).toEqual([
            { kind: 'movie', year: '2010', query: 'Inception' },
            { kind: 'tv', year: '', query: 'Lost' },
            { kind: 'movie', year: '', query: 'Mission: Impossible' },
        ]);
    });

    it('un doublon exact n\'est cherché (et compté) qu\'une fois', () => {
        expect(parseBatchItems(['movie::Elf', 'movie::Elf', 'tv::Elf'])).toHaveLength(2);
    });

    it('refuse un appel mal formé en entier', () => {
        expect(parseBatchItems([])).toBeNull();
        expect(parseBatchItems(Array.from({ length: BATCH_MAX_ITEMS + 1 }, (_, i) => `movie::Titre ${i}`))).toBeNull();
        expect(parseBatchItems(['person::Someone'])).toBeNull();
        expect(parseBatchItems(['movie:20:Elf'])).toBeNull();
        expect(parseBatchItems(['movie:2010:'])).toBeNull();
        expect(parseBatchItems(['movie:Elf'])).toBeNull();
        expect(parseBatchItems([`movie::${'a'.repeat(201)}`])).toBeNull();
    });

    it('accepte le plafond exact', () => {
        expect(parseBatchItems(Array.from({ length: BATCH_MAX_ITEMS }, (_, i) => `tv::Série ${i}`))).toHaveLength(BATCH_MAX_ITEMS);
    });
});

describe('réponse réduite', () => {
    it('garde seulement numéro, titres, date et affiche, pour les premiers résultats', () => {
        const answer = {
            results: [
                { id: 1, title: 'Elf', original_title: 'Elf', release_date: '2003-10-09', poster_path: '/a.jpg', overview: 'long', popularity: 9 },
                { title: 'sans numéro' },
                ...Array.from({ length: 15 }, (_, i) => ({ id: 100 + i, title: `T${i}` })),
            ],
        };
        const slim = slimSearchAnswer('movie', answer);
        expect(slim[0]).toEqual({ id: 1, title: 'Elf', original_title: 'Elf', release_date: '2003-10-09', poster_path: '/a.jpg' });
        expect(slim.length).toBe(BATCH_RESULTS_PER_ITEM - 1);
        expect(slimSearchAnswer('tv', { results: [{ id: 2, name: 'Lost', original_name: 'Lost', first_air_date: '2004-09-22', title: 'x' }] }))
            .toEqual([{ id: 2, name: 'Lost', original_name: 'Lost', first_air_date: '2004-09-22' }]);
        expect(slimSearchAnswer('movie', null)).toEqual([]);
        expect(slimSearchAnswer('movie', { results: 'non' })).toEqual([]);
    });
});

describe('recherches en parallèle bornées', () => {
    it('jamais plus de `limit` à la fois, résultats dans l\'ordre', async () => {
        let running = 0;
        let peak = 0;
        const out = await mapWithLimit([5, 1, 4, 2, 3, 0], 2, async (n, index) => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((r) => setTimeout(r, n));
            running--;
            return `${index}:${n}`;
        });
        expect(peak).toBe(2);
        expect(out).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3', '5:0']);
    });
});
