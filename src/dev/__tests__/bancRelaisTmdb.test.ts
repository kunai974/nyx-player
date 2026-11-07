/**
 * Adresse du faux relais TMDB des versions du banc : celui du faux fournisseur de la source, ou rien.
 */
import { describe, it, expect } from 'vitest';
import { adresseRelaisTmdbBanc } from '../bancAdresses';

describe('adresseRelaisTmdbBanc', () => {
    it.each([
        ['http://127.0.0.1:8765', 'http://127.0.0.1:8765/__tmdb'],
        ['http://127.0.0.1:8785/', 'http://127.0.0.1:8785/__tmdb'],
        ['https://127.0.0.1:8768', 'https://127.0.0.1:8768/__tmdb'],
        ['http://10.0.2.2:8775', 'http://10.0.2.2:8775/__tmdb'],
    ])('faux fournisseur %s', (host, attendu) => {
        expect(adresseRelaisTmdbBanc({ host })).toBe(attendu);
    });

    it.each([
        ['relais du vrai fournisseur (port 8790)', 'http://127.0.0.1:8790'],
        ['vrai fournisseur', 'http://fournisseur.example:8080'],
        ['localhost', 'http://localhost:8765'],
        ['identifiants dans l\'adresse', 'http://127.0.0.1:8765@evil.example'],
    ])('%s : aucun relais', (_nom, host) => {
        expect(adresseRelaisTmdbBanc({ host })).toBeNull();
    });

    it('aucune source : aucun relais', () => {
        expect(adresseRelaisTmdbBanc(null)).toBeNull();
    });
});
