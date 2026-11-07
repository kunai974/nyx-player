/**
 * Lien titre → TMDB : nettoyage des noms de liste et règle « lien sûr ou rien ».
 */

import { describe, it, expect } from 'vitest';
import { cleanTitleForSearch, normalizeTitle, pickConfidentMatch, yearOf, type TitleCandidate } from '../tmdbTitleMatch';

describe('cleanTitleForSearch', () => {
    it.each([
        ['FR: Le Fabuleux Destin d\'Amélie Poulain (2001)', { query: 'Le Fabuleux Destin d\'Amélie Poulain', year: 2001 }],
        ['|FR| Inception (2010) [4K] MULTI', { query: 'Inception', year: 2010 }],
        ['VF - Le Dîner de cons 1998 1080p', { query: 'Le Dîner de cons', year: 1998, withYear: 'Le Dîner de cons 1998' }],
        ['Le.Grand.Bleu.1988.MULTI.1080p', { query: 'Le Grand Bleu', year: 1988, withYear: 'Le Grand Bleu 1988' }],
        ['The French Dispatch', { query: 'The French Dispatch' }],
        ['1917', { query: '1917' }],
        ['1917 (2019)', { query: '1917', year: 2019 }],
        ['Blade Runner 2049 MULTI', { query: 'Blade Runner', year: 2049, withYear: 'Blade Runner 2049' }],
        ['2001 : l\'Odyssée de l\'espace (1968)', { query: '2001 : l\'Odyssée de l\'espace', year: 1968 }],
        // Un premier mot suivi de « : » ou « - » n'est pas pris pour une langue
        ['Thor: Ragnarok', { query: 'Thor: Ragnarok' }],
        ['Tron: Legacy (2010)', { query: 'Tron: Legacy', year: 2010 }],
        ['Dune: Part Two', { query: 'Dune: Part Two' }],
        ['Jaws: The Revenge', { query: 'Jaws: The Revenge' }],
        ['Up: Là-haut', { query: 'Up: Là-haut' }],
        ['Big: Movie', { query: 'Big: Movie' }],
        ['Elf - FR', { query: 'Elf' }],
        ['EN - Elf (2003)', { query: 'Elf', year: 2003 }],
        ['FR | Titre', { query: 'Titre' }],
        ['[VOSTFR] Titre', { query: 'Titre' }],
        ['FR-Inception', { query: 'Inception' }],
        // Listes tout en majuscules : un code final sans séparateur fait partie du titre
        ['ALL OF US', { query: 'ALL OF US' }],
        ['AMONG US', { query: 'AMONG US' }],
        ['LET IT BE', { query: 'LET IT BE' }],
        ['ELF | FR', { query: 'ELF' }],
        ['Le Film - FR - MULTI', { query: 'Le Film' }],
        ['Elf - FR - 4K', { query: 'Elf' }],
        ['Titre - EN - FR', { query: 'Titre' }],
        ['Inception (2010) FR', { query: 'Inception', year: 2010 }],
        ['Inception FR', { query: 'Inception' }],
        ['Le Film: FR', { query: 'Le Film' }],
        ['Among Us', { query: 'Among Us' }],
        ['Stephen King\'s IT', { query: 'Stephen King\'s IT' }],
        ['Made in USA', { query: 'Made in USA' }],
        ['Free Guy | FR | 4K', { query: 'Free Guy' }],
        // « IT » et « US » sont aussi des mots de titre : gardés devant un titre en majuscules
        ['IT: CHAPTER TWO', { query: 'IT: CHAPTER TWO' }],
        ['US - 2019', { query: 'US', year: 2019, withYear: 'US - 2019' }],
        ['IT: La vita è bella', { query: 'La vita è bella' }],
        // Saisons et épisodes en fin de nom
        ['FR| Breaking Bad S01', { query: 'Breaking Bad' }],
        ['Breaking Bad - S05', { query: 'Breaking Bad' }],
        ['The Walking Dead (2010) S11', { query: 'The Walking Dead', year: 2010 }],
        ['Friends S01E03', { query: 'Friends' }],
        ['Stranger Things - Saison 1', { query: 'Stranger Things' }],
        ['Dark - Season 3 (2020)', { query: 'Dark', year: 2020 }],
        ['Saison 8', { query: 'Saison 8' }],
        ['Open Season 2', { query: 'Open Season 2' }],
        ['Hunting Season 2 (2010)', { query: 'Hunting Season 2', year: 2010 }],
        ['Alien S1', { query: 'Alien S1' }],
        ['IT | CHAPTER TWO', { query: 'IT | CHAPTER TWO' }],
        ['US | 2019', { query: 'US', year: 2019, withYear: 'US | 2019' }],
        ['SCREAM | 2022', { query: 'SCREAM', year: 2022, withYear: 'SCREAM | 2022' }],
        ['Shrek 2', { query: 'Shrek 2' }],
        ['Se7en', { query: 'Se7en' }],
        // Préfixes « XX| » hors liste : retirés ; un simple code ou un titre en minuscules reste
        ['EX-YU| Titanic', { query: 'Titanic' }],
        ['TOP 10 | Barbie (2023)', { query: 'Barbie', year: 2023 }],
        ['VOD| Les Misérables (2012)', { query: 'Les Misérables', year: 2012 }],
        ['NETFLIX|Stranger Things', { query: 'Stranger Things' }],
        ['ELF | FR', { query: 'ELF' }],
        ['Mission | Impossible', { query: 'Mission | Impossible' }],
        // Étiquettes de pays ou de service suivies de « - » : liste fermée (pays ISO, services connus)
        ['AL - Titre Exemple (2020)', { query: 'Titre Exemple', year: 2020 }],
        ['SE - Vier Gäste (2022)', { query: 'Vier Gäste', year: 2022 }],
        ['AR-SUBS - Le Film (2021)', { query: 'Le Film', year: 2021 }],
        ['ANM-D - Naruto', { query: 'Naruto' }],
        ['AMZ - The Boys', { query: 'The Boys' }],
        ['DK - Bamse', { query: 'Bamse' }],
        ['KH - Film (2022)', { query: 'Film', year: 2022 }],
        ['NO - Fjols til fjells', { query: 'Fjols til fjells' }],
        ['IN - Pushpa 2 (2024)', { query: 'Pushpa 2', year: 2024 }],
        ['AL - TITRE EN MAJUSCULES', { query: 'TITRE EN MAJUSCULES' }],
        ['NF - AL - Le Film', { query: 'Le Film' }],
        ['4K-SC - Le Film (2020)', { query: 'Le Film', year: 2020 }],
        ['4K-IN - Pushpa 2 (2024)', { query: 'Pushpa 2', year: 2024 }],
        ['AR-IN-S - Titre Exemple', { query: 'Titre Exemple' }],
        ['4K-DE-DV - Der Film', { query: 'Der Film' }],
        ['D+ - Titre Exemple', { query: 'Titre Exemple' }],
        ['KU-S - Titre Exemple', { query: 'Titre Exemple' }],
        ['NICK - Bob', { query: 'Bob' }],
        ['TOP - Titre Exemple', { query: 'Titre Exemple' }],
        ['KU-S - Lost Bullet 2 (2022) فیشەکی ونبوو 2', { query: 'Lost Bullet 2', year: 2022 }],
        ['Title Example عنوان (2020)', { query: 'Title Example', year: 2020 }],
        ['عنوان Title Example', { query: 'Title Example' }],
        ['فيلم X', { query: 'فيلم X' }],
        ['فيلم Up', { query: 'فيلم Up' }],
        ['مسلسل It', { query: 'مسلسل It' }],
        ['Dune دون ،', { query: 'Dune' }],
        ['X-MEN - Apocalypse', { query: 'X-MEN - Apocalypse' }],
        ['ES - Norbert(a) (2024)', { query: 'Norbert(a)', year: 2024 }],
        ['Le Film (FR) [4K]', { query: 'Le Film' }],
        ['Titre (VF)(HD) (2020)', { query: 'Titre', year: 2020 }],
        ['Film(FR)', { query: 'Film' }],
        ['Titre[4K]', { query: 'Titre' }],
        ['C++ - Le Film', { query: 'C++ - Le Film' }],
        ['A+ - Le Film', { query: 'A+ - Le Film' }],
        // Sigles de trois lettres ou plus, vrais débuts de titre : jamais retirés
        ['NCIS - Sydney', { query: 'NCIS - Sydney' }],
        ['CSI - Miami', { query: 'CSI - Miami' }],
        ['WWE - Raw', { query: 'WWE - Raw' }],
        ['BBC - Planet Earth', { query: 'BBC - Planet Earth' }],
        // Codes qui sont aussi des mots : gardés devant un titre tout en majuscules ou un nombre
        ['IS - THE END', { query: 'IS - THE END' }],
        ['NO - 2019', { query: 'NO', year: 2019, withYear: 'NO - 2019' }],
        ['SE - 1917', { query: 'SE', year: 1917, withYear: 'SE - 1917' }],
        ['ER - Emergency Room', { query: 'ER - Emergency Room' }],
        ['TV - Total Wipeout', { query: 'TV - Total Wipeout' }],
        ['PS - I Love You', { query: 'PS - I Love You' }],
        ['SE - ', { query: 'SE' }],
        ['M - Eine Stadt sucht einen Mörder', { query: 'M - Eine Stadt sucht einen Mörder' }],
    ])('%s', (name, expected) => {
        expect(cleanTitleForSearch(name)).toEqual(expected);
    });

    it('année fournie par la liste : gardée, une autre année du nom n\'est pas prise', () => {
        expect(cleanTitleForSearch('Le Film', 2003)).toEqual({ query: 'Le Film', year: 2003 });
        expect(cleanTitleForSearch('Blade Runner 2049', 2017)).toEqual({ query: 'Blade Runner 2049', year: 2017 });
    });

    it('rien d\'utilisable : null', () => {
        expect(cleanTitleForSearch('')).toBeNull();
        expect(cleanTitleForSearch('FR: (2001)')).toBeNull();
        expect(cleanTitleForSearch('[MULTI]')).toBeNull();
        expect(cleanTitleForSearch('MULTI')).toBeNull();
    });
});

describe('normalizeTitle et yearOf', () => {
    it('accents, casse, apostrophes et ponctuation ignorés', () => {
        expect(normalizeTitle('Le Fabuleux Destin d’Amélie Poulain')).toBe(normalizeTitle('le fabuleux destin d\'amelie poulain'));
        expect(normalizeTitle('Fast & Furious')).toBe('fast and furious');
        expect(normalizeTitle('Mission: Impossible')).toBe('mission impossible');
    });

    it('année d\'une date TMDB', () => {
        expect(yearOf('2001-04-25')).toBe(2001);
        expect(yearOf('')).toBeUndefined();
        expect(yearOf(null)).toBeUndefined();
    });
});

describe('pickConfidentMatch', () => {
    const c = (id: number, title: string, year?: number, original = title): TitleCandidate => ({ id, titles: [title, original], year });

    it('sans année et sans lettre latine : jamais de lien (titres homonymes trop fréquents)', () => {
        expect(pickConfidentMatch({ query: 'ثمن الخيانة' }, [c(285188, 'ثمن الخيانة')])).toBe(0);
        expect(pickConfidentMatch({ query: 'ثمن الخيانة', year: 2020 }, [c(285188, 'ثمن الخيانة', 2020)])).toBe(285188);
    });

    it('lettres turques sans décomposition ignorées', () => {
        expect(pickConfidentMatch({ query: 'Kiralik Ask', year: 2015 }, [c(1, 'Kiralık Aşk', 2015)])).toBe(1);
        expect(normalizeTitle('İstanbul Kırmızısı')).toBe(normalizeTitle('Istanbul Kirmizisi'));
    });

    it('titre en deux écritures : début lu dans un titre de la fiche, fin dans l\'autre', () => {
        const fiche: TitleCandidate = { id: 7, titles: ['Suzhal - Le Vortex', 'சுழல் - The Vortex'], year: 2022 };
        expect(pickConfidentMatch({ query: 'Suzhal - The Vortex', year: 2022 }, [fiche])).toBe(7);
        // Le début seul ou la fin seule ne suffisent pas
        expect(pickConfidentMatch({ query: 'Suzhal - Autre chose', year: 2022 }, [fiche])).toBe(0);
        expect(pickConfidentMatch({ query: 'Autre - The Vortex', year: 2022 }, [fiche])).toBe(0);
        // La fin doit venir d'un titre qui a lui-même un séparateur, pas d'un titre entier et court
        expect(pickConfidentMatch({ query: 'Naruto - The Movie' }, [{ id: 9, titles: ['Naruto - Ninja Clash', 'The Movie'], year: 2020 }])).toBe(0);
        expect(pickConfidentMatch({ query: 'Rocky - 2', year: 2020 }, [{ id: 9, titles: ['Rocky - Balboa', '2'], year: 2020 }])).toBe(0);
        // Titre avec « / » : chaque morceau compte
        expect(pickConfidentMatch({ query: 'The Vortex', year: 2022 }, [{ id: 8, titles: ['Suzhal / The Vortex'], year: 2022 }])).toBe(8);
    });

    it('même titre et même année : lien', () => {
        expect(pickConfidentMatch({ query: 'Inception', year: 2010 }, [c(27205, 'Inception', 2010), c(1, 'Inception: The Cobol Job', 2010)])).toBe(27205);
    });

    it('titre traduit ou original, accents ignorés, un an d\'écart toléré', () => {
        expect(pickConfidentMatch({ query: 'Amelie', year: 2002 }, [c(194, 'Le Fabuleux Destin d\'Amélie Poulain', 2001, 'Amélie')])).toBe(194);
    });

    it('année trop éloignée : aucun lien', () => {
        expect(pickConfidentMatch({ query: 'Dune', year: 2021 }, [c(841, 'Dune', 1984)])).toBe(0);
    });

    it('remake de la même année à un an près : celui de la même année, s\'il est seul', () => {
        const remakes = [c(1, 'Le Film', 2000), c(2, 'Le Film', 2001)];
        expect(pickConfidentMatch({ query: 'Le Film', year: 2001 }, remakes)).toBe(2);
        expect(pickConfidentMatch({ query: 'Le Film', year: 2001 }, [c(1, 'Le Film', 2001), c(3, 'Le Film', 2001)])).toBe(0);
    });

    it('sans année : seulement si un seul résultat porte ce titre', () => {
        expect(pickConfidentMatch({ query: 'Breaking Bad' }, [c(1396, 'Breaking Bad', 2008), c(2, 'Breaking Bad: Original Minisodes', 2009)])).toBe(1396);
        expect(pickConfidentMatch({ query: 'Dune' }, [c(841, 'Dune', 1984), c(438631, 'Dune', 2021)])).toBe(0);
    });

    it('titre proche mais pas le même : aucun lien (pas de fausse fiche)', () => {
        expect(pickConfidentMatch({ query: 'Le Dîner', year: 2017 }, [c(1, 'Le Dîner de cons', 1998), c(2, 'The Dinner', 2017)])).toBe(0);
        expect(pickConfidentMatch({ query: 'Inception', year: 2010 }, [])).toBe(0);
    });

    it('nombre final qui faisait partie du titre : le titre complet, s\'il est seul', () => {
        const results = [c(78, 'Blade Runner', 1982), c(335984, 'Blade Runner 2049', 2017)];
        expect(pickConfidentMatch({ query: 'Blade Runner', year: 2049, withYear: 'Blade Runner 2049' }, results)).toBe(335984);
    });
});
