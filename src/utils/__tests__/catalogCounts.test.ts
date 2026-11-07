import { describe, it, expect } from 'vitest';
import { uniqueTitleCount } from '../lightIndexHelpers';

describe('uniqueTitleCount', () => {
    it('fournisseur avec numéros TMDB : fiches différentes, plus les titres sans fiche', () => {
        expect(uniqueTitleCount(700, 880, 900)).toBe(720);
    });

    it('la moitié des titres reliée : ceux sans fiche ne disparaissent pas du compte', () => {
        // Liste de 4 films, 2 reliés par le titre : l'écran affichait « 2 Films »
        expect(uniqueTitleCount(2, 2, 4)).toBe(4);
    });

    it('fournisseur sans numéro TMDB : 0, le total est affiché', () => {
        // 101 titres reliés par le nom sur 186 358 films
        expect(uniqueTitleCount(101, 101, 186358)).toBe(0);
    });

    it('plusieurs versions par film, tous avec numéro : fiches différentes gardées', () => {
        expect(uniqueTitleCount(300, 900, 900)).toBe(300);
    });

    it('catalogue vide : 0', () => {
        expect(uniqueTitleCount(0, 0, 0)).toBe(0);
    });
});
