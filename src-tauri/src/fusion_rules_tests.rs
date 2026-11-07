//! Banc d'essai des règles de regroupement : noms écrits comme les fournisseurs les écrivent
//! (inventés, aucun nom d'un vrai catalogue). Objectif : zéro faux regroupement, et le maximum de
//! doublons réunis.

use super::*;

/// Nom nettoyé et année d'un titre : ils ne réunissent jamais deux titres. Le découpage donne la
/// qualité et la langue de chaque version ; le nom nettoyé sert aussi aux catégories et aux chaînes.
fn key(name: &str) -> (String, Option<u16>) {
    let p = title_parts(name);
    (p.key, p.year)
}

#[test]
fn tags_become_quality_and_language_and_leave_the_name() {
    let p = title_parts("FR | Le Voyage (2019) [4K] MULTI");
    assert_eq!(p, TitleParts { key: "le voyage".into(), year: Some(2019), quality: Some("4K"), language: Some("MULTI"), country: Some("fr".into()) });
    let p = title_parts("|FR| Le Voyage - 2019 - VOSTFR");
    assert_eq!((p.key.as_str(), p.year, p.language), ("le voyage", Some(2019), Some("VOSTFR")));
    let p = title_parts("Le Voyage (2019) ᶠᴴᴰ");
    assert_eq!((p.key.as_str(), p.quality), ("le voyage", Some("FHD")));
    let p = title_parts("[VIP] Été Brûlant (2021) HEVC");
    assert_eq!((p.key.as_str(), p.year), ("ete brulant", Some(2021)));
    // Deux qualités écrites : la meilleure
    assert_eq!(title_parts("Film (2020) HD 4K").quality, Some("4K"));
}

#[test]
fn the_same_film_written_by_several_providers_reads_the_same() {
    let names = [
        "FR | Le Grand Départ (2018)",
        "|FR| LE GRAND DEPART (2018) 4K",
        "Le Grand Départ - 2018 - MULTI",
        "VOD - FR - Le grand départ (2018) [FHD]",
        "Le Grand Départ (2018) VOSTFR",
        "[FR] Le Grand Départ [2018]",
    ];
    for name in names {
        assert_eq!(key(name), ("le grand depart".to_string(), Some(2018)), "{name}");
    }
}

#[test]
fn never_grouped_when_in_doubt() {
    // Sans fiche TMDB : jamais regroupé, même titre et même année compris (les numéros et les noms
    // viennent du fournisseur, la fiche non)
    assert_eq!(title_group_key(None), None);
    // Même nom, années différentes : deux films (remake)
    assert_ne!(key("Le Retour (1998)"), key("Le Retour (2021)"));
    // Année collée au titre sans séparateur : elle fait partie du titre, pas une année
    let p = title_parts("Planète 2049");
    assert_eq!((p.key.as_str(), p.year), ("planete 2049", None));
    assert_ne!(key("Planète 2049 (2017)"), key("Planète (2017)"));
    // Un titre qui est une année
    let p = title_parts("1917 (2019)");
    assert_eq!((p.key.as_str(), p.year), ("1917", Some(2019)));
    // Une suite n'est pas le film d'origine
    assert_ne!(key("Le Voyage 2 (2021)"), key("Le Voyage (2021)"));
    // Partie de titre entre parenthèses qui n'est pas une étiquette : gardée
    assert_ne!(key("Le Voyage (Version longue) (2021)"), key("Le Voyage (2021)"));
}

#[test]
fn words_of_a_title_are_never_taken_for_tags() {
    // « French » au milieu d'un titre fait partie du titre
    assert_eq!(title_parts("The French Line (1971)").key, "the french line");
    assert_ne!(key("The French Line (1971)"), key("The Line (1971)"));
    // Un titre d'un seul mot qui ressemble à une étiquette reste lui-même
    assert_eq!(title_parts("HD").key, "hd");
    // Deux-points dans un titre : pas un préfixe de fournisseur
    assert_eq!(title_parts("Mission: Lointaine (2001)").key, "mission lointaine");
    assert_eq!(title_parts("FR: Mission Lointaine (2001)").key, "mission lointaine");
}

#[test]
fn only_a_tmdb_sheet_groups_films_and_series() {
    assert_eq!(title_group_key(Some(603)).as_deref(), Some("tmdb:603"));
    assert_eq!(title_group_key(Some(0)), None);
    assert_eq!(title_group_key(Some(-1)), None);
}

#[test]
fn channels_group_by_guide_id_name_and_country() {
    let a = channel_group_key("FR | Chaîne Une HD", Some("ChaineUne.fr"), None);
    let b = channel_group_key("Chaîne Une FHD", Some("chaineune.fr"), Some("fr"));
    assert_eq!(a, b);
    assert_eq!(a.as_deref(), Some("epg:chaineune.fr:fr:chaine une"));
    // Sans identifiant de guide : jamais réunie, même nom et même pays compris
    assert_eq!(channel_group_key("FR | Info 24", None, None), None);
    assert_eq!(channel_group_key("Info 24 HD", None, Some("FR")), None);
}

#[test]
fn channels_are_never_grouped_across_countries_regions_or_unknowns() {
    // Pays différents
    assert_ne!(channel_group_key("FR | Info 24", Some("info24"), None), channel_group_key("BE | Info 24", Some("info24"), None));
    // Éditions régionales avec le même identifiant de guide chez un fournisseur
    assert_ne!(
        channel_group_key("Régionale Nord", Some("regionale.fr"), None),
        channel_group_key("Régionale Sud", Some("regionale.fr"), None)
    );
    // Pays inconnu, sans identifiant : jamais regroupée
    assert_eq!(channel_group_key("Info 24", None, None), None);
    assert_eq!(channel_group_key("", Some("x.fr"), None), None);
}

#[test]
fn categories_with_the_same_name_meet() {
    assert_eq!(category_key("FR | Action"), category_key("|FR| ACTION"));
    assert_eq!(category_key("Action [4K]"), category_key("action"));
    // Le pays écrit reste : « Sport » de deux pays ne se mélange pas
    assert_ne!(category_key("FR | Sport"), category_key("UK | Sport"));
    assert_ne!(category_key("FR - Sport"), category_key("UK - Sport"));
    assert_ne!(category_key("[FR] Sport"), category_key("[UK] Sport"));
    assert_eq!(category_key("FR - Sport"), category_key("FR | SPORT"));
    assert_ne!(category_key("FR | Action"), category_key("Action"));
    assert_eq!(category_key("Comédies"), category_key("COMEDIES"));
    assert_ne!(category_key("Action"), category_key("Aventure"));
    assert_eq!(category_key("  "), None);
}

#[test]
fn ordinary_words_at_the_end_of_a_title_stay_in_it() {
    assert_ne!(key("The English (2022)"), key("The VIP (2022)"));
    assert_ne!(key("Johnny English (2003)"), key("Johnny (2003)"));
    assert_ne!(key("Room 1080 (2020)"), key("Room (2020)"));
    assert_ne!(key("Le Retour - English (2003)"), key("Le Retour (2003)"));
    // Entre crochets, ce sont bien des étiquettes
    assert_eq!(key("Le Retour (2003) [EN]"), key("Le Retour (2003)"));
}

#[test]
fn a_short_word_before_a_separator_is_a_country_only_when_written_as_one() {
    assert_eq!(title_parts("It: Chapitre Deux (2019)").key, "it chapitre deux");
    assert_eq!(title_parts("Us - Eux (2019)").key, "us eux");
    assert_ne!(key("It: Chapitre Deux (2019)"), key("Chapitre Deux (2019)"));
    assert_eq!(key("IT: Chapitre Deux (2019)"), key("Chapitre Deux (2019)"));
    assert_eq!(key("fr | Chapitre Deux (2019)"), key("Chapitre Deux (2019)"));
    // Une étiquette avant « | » garde son sens : langue ou qualité, jamais un pays
    assert_ne!(channel_group_key("VF | France 24", Some("france24.fr"), None), channel_group_key("VO | France 24", Some("france24.fr"), None));
    assert_ne!(channel_group_key("EN | France 24", Some("france24.fr"), None), channel_group_key("FR | France 24", Some("france24.fr"), None));
    assert_ne!(key("OK | Corral (1957)"), key("Corral (1957)"));
    assert_eq!(title_parts("VO | Le Voyage (2019)").language, Some("VO"));
    assert_eq!(title_parts("HD | Le Voyage (2019)").quality, Some("HD"));
    assert_eq!(category_key("HD | Sport"), category_key("Sport"));
    assert_eq!(category_key("[VO] Sport"), category_key("Sport"));
    // Avant « | », un autre code de deux lettres en majuscules est un pays
    assert_eq!(channel_group_key("SE | Kanal Ett", Some("kanalett.se"), None), channel_group_key("Kanal Ett", Some("kanalett.se"), None));
    // Sans pays écrit, celui de l'identifiant du guide
    assert_eq!(channel_group_key("FR| Chaîne Une HD", Some("chaineune.fr"), None), channel_group_key("Chaîne Une HD", Some("chaineune.fr"), None));
    assert_ne!(channel_group_key("EN | France 24", Some("france24.fr"), None), channel_group_key("France 24", Some("france24.fr"), None));
    // Un mot de deux lettres hors de la liste des pays n'est pas retiré
    assert_eq!(title_parts("OK: Corral (1957)").key, "ok corral");
}

#[test]
fn the_same_channel_in_two_languages_stays_two_channels() {
    assert_ne!(channel_group_key("FR | France 24 EN", Some("france24"), None), channel_group_key("FR | France 24 FR", Some("france24"), None));
    assert_ne!(
        channel_group_key("Info Monde EN", Some("infomonde.fr"), None),
        channel_group_key("Info Monde FR", Some("infomonde.fr"), None)
    );
    // Sans langue écrite, la règle ne change pas
    assert_eq!(channel_group_key("FR | Info 24 HD", Some("info24.fr"), None), channel_group_key("FR | Info 24", Some("info24.fr"), None));
}
