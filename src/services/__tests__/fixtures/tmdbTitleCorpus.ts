/**
 * Jeu d'essai du lien « titre de fournisseur → fiche TMDB » (voir titleTmdbCorpus.test.ts).
 *
 * Deux parties :
 * - `TMDB_INDEX` : une mini-base façon TMDB (titre traduit, titre original, année), écrite à la main.
 *   Les numéros sont indicatifs : seul compte le fait qu'ils soient distincts. Elle contient exprès des
 *   refaites, des suites et des titres voisins (faux amis) pour tenter la règle « lien sûr ou rien ».
 * - `PROVIDER_TITLES` : des noms écrits comme chez les fournisseurs IPTV (préfixes de langue, 4K, années,
 *   MULTI, VOSTFR, saisons, accents, titres traduits…), avec la fiche attendue (`null` : aucune fiche
 *   n'est acceptable, l'appli doit se taire).
 *
 * Ce n'est PAS une mesure sur du vrai TMDB (le nuage n'y accède pas) : c'est un filet qui empêche de
 * dégrader la règle. La mesure réelle se fait avec scripts/test/sonde-titres-tmdb.mjs sur le PC.
 */

export interface FixtureEntry {
    id: number;
    kind: 'movie' | 'series';
    /** Titre traduit (français) */
    title: string;
    /** Titre original */
    original: string;
    year: number;
}

const m = (id: number, title: string, original: string, year: number): FixtureEntry => ({ id, kind: 'movie', title, original, year });
const s = (id: number, title: string, original: string, year: number): FixtureEntry => ({ id, kind: 'series', title, original, year });

export const TMDB_INDEX: FixtureEntry[] = [
    m(27205, 'Inception', 'Inception', 2010),
    m(438631, 'Dune', 'Dune', 2021),
    m(841, 'Dune', 'Dune', 1984),
    m(693134, 'Dune : Deuxième partie', 'Dune: Part Two', 2024),
    m(194, 'Le Fabuleux Destin d\'Amélie Poulain', 'Amélie', 2001),
    m(78, 'Blade Runner', 'Blade Runner', 1982),
    m(335984, 'Blade Runner 2049', 'Blade Runner 2049', 2017),
    m(8587, 'Le Roi lion', 'The Lion King', 1994),
    m(420818, 'Le Roi lion', 'The Lion King', 2019),
    m(762441, 'Mufasa : Le Roi lion', 'Mufasa: The Lion King', 2024),
    m(475557, 'Joker', 'Joker', 2019),
    m(889737, 'Joker : Folie à deux', 'Joker: Folie à Deux', 2024),
    m(5001, 'Joker', 'Joker', 1960),
    m(346364, 'Ça', 'It', 2017),
    m(474350, 'Ça : Chapitre 2', 'It Chapter Two', 2019),
    m(5002, 'It', 'It', 1990),
    m(597, 'Titanic', 'Titanic', 1997),
    m(634649, 'Spider-Man : No Way Home', 'Spider-Man: No Way Home', 2021),
    m(278, 'Les Évadés', 'The Shawshank Redemption', 1994),
    m(5003, 'Astérix & Obélix : Mission Cléopâtre', 'Astérix & Obélix : Mission Cléopâtre', 2002),
    m(19995, 'Avatar', 'Avatar', 2009),
    m(76600, 'Avatar : La Voie de l\'eau', 'Avatar: The Way of Water', 2022),
    m(872585, 'Oppenheimer', 'Oppenheimer', 2023),
    m(98, 'Gladiator', 'Gladiator', 2000),
    m(558449, 'Gladiator II', 'Gladiator II', 2024),
    m(346698, 'Barbie', 'Barbie', 2023),
    m(82695, 'Les Misérables', 'Les Misérables', 2012),
    m(5004, 'Les Misérables', 'Les Misérables', 2019),
    m(5005, 'Les Misérables', 'Les Misérables', 1998),
    m(809, 'Shrek 2', 'Shrek 2', 2004),
    m(808, 'Shrek', 'Shrek', 2001),
    m(238, 'Le Parrain', 'The Godfather', 1972),
    m(240, 'Le Parrain, 2ème partie', 'The Godfather Part II', 1974),
    m(1011985, 'Kung Fu Panda 4', 'Kung Fu Panda 4', 2024),
    m(575264, 'Mission : Impossible - Dead Reckoning, partie 1', 'Mission: Impossible - Dead Reckoning Part One', 2023),
    m(101, 'Léon', 'Léon', 1994),
    m(424139, 'Halloween', 'Halloween', 2018),
    m(948, 'Halloween', 'Halloween', 1978),
    m(5006, 'Halloween', 'Halloween', 2007),
    m(4232, 'Scream', 'Scream', 1996),
    m(646385, 'Scream', 'Scream', 2022),
    m(10719, 'Elfe', 'Elf', 2003),
    m(414906, 'The Batman', 'The Batman', 2022),
    m(268, 'Batman', 'Batman', 1989),
    m(530915, '1917', '1917', 2019),
    m(14160, 'Là-haut', 'Up', 2009),
    m(284053, 'Thor : Ragnarok', 'Thor: Ragnarok', 2017),
    m(4585, 'Le Dîner de cons', 'Le Dîner de cons', 1998),
    m(5007, 'Le Dîner', 'Le Dîner', 2017),
    m(496243, 'Parasite', '기생충', 2019),
    m(5008, 'Parasite', 'Parasite', 1982),
    m(5009, 'Taken', 'Taken', 2008),
    m(5010, 'Taken 2', 'Taken 2', 2012),
    m(5011, 'Alien', 'Alien', 1979),
    m(5012, 'Aliens', 'Aliens', 1986),
    m(5013, 'Matrix', 'The Matrix', 1999),
    m(5014, 'Matrix Reloaded', 'The Matrix Reloaded', 2003),
    m(5015, 'La Vie est belle', 'It\'s a Wonderful Life', 1946),
    m(5016, 'La vita è bella', 'La vita è bella', 1997),
    m(5017, 'Fast & Furious', 'Fast & Furious', 2009),
    m(5018, 'Fast & Furious 6', 'Furious 6', 2013),
    s(1396, 'Breaking Bad', 'Breaking Bad', 2008),
    s(5101, 'Breaking Bad: Original Minisodes', 'Breaking Bad: Original Minisodes', 2009),
    s(1399, 'Game of Thrones', 'Game of Thrones', 2011),
    s(71446, 'La Casa de Papel', 'La casa de papel', 2017),
    s(66732, 'Stranger Things', 'Stranger Things', 2016),
    s(1402, 'The Walking Dead', 'The Walking Dead', 2010),
    s(70523, 'Dark', 'Dark', 2017),
    s(5102, 'Dark', 'Dark', 2023),
    s(1668, 'Friends', 'Friends', 1994),
    s(2316, 'The Office', 'The Office', 2005),
    s(2996, 'The Office', 'The Office', 2001),
    s(96677, 'Lupin', 'Lupin', 2021),
    s(93405, 'Squid Game', '오징어 게임', 2021),
    s(60574, 'Peaky Blinders', 'Peaky Blinders', 2013),
    s(44217, 'Vikings', 'Vikings', 2013),
    s(5103, 'Vikings : Valhalla', 'Vikings: Valhalla', 2022),
    s(5104, 'Shogun', 'Shōgun', 2024),
    s(5105, 'Shogun', 'Shōgun', 1980),
    s(5106, 'Sherlock', 'Sherlock', 2010),
    s(5107, 'Le Bureau des légendes', 'Le Bureau des légendes', 2015),
    s(5108, 'Sydney', 'Sydney', 2023),
    s(5109, 'NCIS : Los Angeles', 'NCIS: Los Angeles', 2009),
    m(5110, 'Chapter Two', 'Chapter Two', 1979),
];

export interface ProviderTitle {
    name: string;
    kind: 'movie' | 'series';
    /** Numéro de la fiche attendue, ou `null` : aucune fiche acceptable (ambigu ou absent de TMDB) */
    expect: number | null;
}

const pm = (name: string, expect: number | null): ProviderTitle => ({ name, kind: 'movie', expect });
const ps = (name: string, expect: number | null): ProviderTitle => ({ name, kind: 'series', expect });

export const PROVIDER_TITLES: ProviderTitle[] = [
    // Préfixes de langue, qualité et pays
    pm('FR| Inception (2010)', 27205),
    pm('|FR| Inception (2010) [4K] MULTI', 27205),
    pm('4K| Dune: Deuxième partie (2024)', 693134),
    pm('FR| Dune Part Two (2024) VOSTFR', 693134),
    pm('|FR| (4K) Dune (2021)', 438631),
    pm('Dune (1984) MULTI', 841),
    pm('FR - Le Roi Lion (1994) MULTI', 8587),
    pm('FR - Le Roi Lion (2019) MULTI', 420818),
    pm('|FR| Joker (2019) 4K', 475557),
    // Le film de 2024 s'appelle « Joker : Folie à deux » : un nom raccourci par le fournisseur ne se relie pas
    pm('Joker (2024) VOSTFR', null),
    pm('AR| Titanic (1997)', 597),
    pm('Spider-Man: No Way Home (2021) VOSTFR', 634649),
    pm('Les Évadés (1994) HD', 278),
    pm('FR| 4K | Gladiator (2000)', 98),
    pm('4K-Gladiator II (2024)', 558449),
    pm('Barbie 2023 FR', 346698),
    pm('Kung Fu Panda 4 (2024) HDR', 1011985),
    pm('Shrek 2 (2004)', 809),
    pm('FR| Le Parrain 2 (1974)', 240),
    // Accents, titres traduits, ponctuation
    pm('LE FABULEUX DESTIN D\'AMELIE POULAIN (2001)', 194),
    pm('Amélie (2001)', 194),
    pm('Astérix & Obélix : Mission Cléopâtre (2002)', 5003),
    pm('Asterix et Obelix Mission Cleopatre 2002', 5003),
    pm('Avatar : La Voie de l\'eau 2022 MULTI 4K', 76600),
    pm('Avatar: The Way of Water (2022)', 76600),
    pm('Léon (1994) [FHD]', 101),
    pm('Leon (1994)', 101),
    pm('Là-haut (2009)', 14160),
    pm('Up (2009)', 14160),
    pm('Thor: Ragnarok', 284053),
    pm('Mission: Impossible - Dead Reckoning Partie 1 (2023)', 575264),
    pm('Ça (2017)', 346364),
    pm('IT (2017)', 346364),
    pm('IT: CHAPTER TWO (2019)', 474350),
    // Noms de fichier
    pm('Oppenheimer.2023.1080p.WEB-DL.x264', 872585),
    pm('Le.Dîner.de.cons.1998.MULTI.1080p', 4585),
    // Années collées au titre
    pm('Blade Runner 2049 MULTI', 335984),
    pm('Blade Runner (1982)', 78),
    pm('1917 (2019)', 530915),
    pm('1917', 530915),
    // Faux amis : titres voisins ou refaites, l'année décide
    pm('Halloween (2018)', 424139),
    pm('Halloween (1978)', 948),
    pm('Halloween (2007)', 5006),
    pm('Scream (2022) 4K', 646385),
    pm('Scream (1996)', 4232),
    pm('Les Misérables (2012)', 82695),
    pm('Les Misérables (2019)', 5004),
    pm('Parasite (2019) VOSTFR', 496243),
    pm('Parasite (1982)', 5008),
    pm('Taken (2008)', 5009),
    pm('Taken 2 (2012)', 5010),
    pm('Alien (1979)', 5011),
    pm('Aliens (1986)', 5012),
    pm('The Batman (2022)', 414906),
    pm('Batman (1989)', 268),
    pm('Fast & Furious (2009)', 5017),
    // Ambigus sans année : le silence est la bonne réponse
    pm('Dune', null),
    pm('Joker', null),
    pm('Halloween', null),
    pm('Les Misérables', null),
    pm('Scream FR', null),
    // Absents de TMDB ou sans rapport : aucune fiche
    pm('FR| SOIREE FOOT - Finale Coupe du monde', null),
    pm('24/7 MOVIES - CINE EN CONTINU', null),
    pm('Film Inconnu Totalement Imaginaire (2031)', null),
    // Séries
    ps('FR| Breaking Bad', 1396),
    ps('Breaking Bad (2008) MULTI', 1396),
    ps('FR| Game of Thrones (US) (2011)', 1399),
    ps('LA CASA DE PAPEL', 71446),
    ps('La Casa de Papel (FR)', 71446),
    ps('NF| Stranger Things', 66732),
    ps('The Walking Dead (2010)', 1402),
    ps('Dark (2017)', 70523),
    ps('Dark (2023)', 5102),
    ps('Dark', null),
    ps('Friends', 1668),
    ps('The Office (2005)', 2316),
    ps('The Office (UK) (2001)', 2996),
    ps('The Office', null),
    ps('Lupin (2021)', 96677),
    ps('Squid Game (2021)', 93405),
    ps('Peaky Blinders', 60574),
    ps('Vikings', 44217),
    ps('Vikings: Valhalla (2022)', 5103),
    ps('Shogun (2024)', 5104),
    ps('Shogun (1980)', 5105),
    ps('Sherlock (2010)', 5106),
    ps('Le Bureau des légendes', 5107),
    // Saisons dans le nom (surtout listes M3U) : non gérées aujourd'hui, voir MISSES_KNOWN
    ps('FR| Breaking Bad S01', 1396),
    ps('The Walking Dead (2010) S11', 1402),
    ps('Stranger Things - Saison 1', 66732),
    ps('Friends S01', 1668),
    // Étiquettes de pays et de service (liste fermée) retirées ; sigles de vrais titres gardés
    pm('AR-SUBS - Inception (2010)', 27205),
    pm('AL - Parasite (2019)', 496243),
    ps('SE - Dark (2017)', 70523),
    ps('AMZ - The Boys', null),
    ps('NCIS - Sydney', null),
    ps('NCIS - Los Angeles', 5109),
    pm('IT - CHAPTER TWO', 474350),
    // Préfixes inconnus de la liste fermée
    pm('EX-YU| Titanic (1997)', 597),
    pm('TOP 10 | Barbie (2023)', 346698),
    pm('VOD| Les Misérables (2012)', 82695),
];
