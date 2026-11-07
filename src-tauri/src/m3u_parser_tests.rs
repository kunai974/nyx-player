use super::*;
use std::io::{BufReader, Cursor, Read};

/// Lit une liste entière et rend ses entrées et son résumé.
fn read_all(text: &str) -> (Vec<M3uEntry>, M3uSummary) {
    read_all_max(text, usize::MAX)
}

fn read_all_max(text: &str, max: usize) -> (Vec<M3uEntry>, M3uSummary) {
    let mut entries = Vec::new();
    let summary = read_m3u(Cursor::new(text.as_bytes()), max, |e| entries.push(e)).expect("read");
    (entries, summary)
}

// Adresses d'exemple : domaines réservés à la documentation, réseau local de documentation

/// Sortie M3U d'un serveur Dispatcharr : numéros de chaîne, identifiants du guide, adresse du guide
/// dans l'en-tête, adresses de flux sans extension.
const DISPATCHARR: &str = "#EXTM3U x-tvg-url=\"http://192.0.2.10:9191/output/epg\" url-tvg=\"http://192.0.2.10:9191/output/epg\"
#EXTINF:-1 tvg-id=\"tf1.fr\" tvg-name=\"TF1\" tvg-logo=\"http://192.0.2.10:9191/api/channels/logos/1/cache/\" tvg-chno=\"1\" group-title=\"France\",TF1
http://192.0.2.10:9191/proxy/ts/stream/8f2c5e6a-1b2d-4c3e-9f00-0a1b2c3d4e5f
#EXTINF:-1 tvg-id=\"france2.fr\" tvg-name=\"France 2\" tvg-chno=\"2.5\" group-title=\"France\",France 2
http://192.0.2.10:9191/proxy/ts/stream/0b9d7c1e-2f3a-4b5c-8d6e-7f8091a2b3c4
";

/// Liste faite par un panneau Xtream (`get.php?type=m3u_plus`) : chaînes, films et épisodes.
const XTREAM_M3U_PLUS: &str = "#EXTM3U
#EXTINF:-1 tvg-id=\"bbc1.uk\" tvg-name=\"UK: BBC One\" tvg-logo=\"http://logo.example/bbc1.png\" group-title=\"UK | General\",UK: BBC One
http://provider.example:8080/live/user/pass/12345.ts
#EXTINF:-1 tvg-id=\"\" tvg-name=\"Inception (2010)\" tvg-logo=\"\" group-title=\"VOD | Action\",Inception (2010)
http://provider.example:8080/movie/user/pass/67890.mkv
#EXTINF:-1 tvg-name=\"Dark S01 E03\" group-title=\"Series | Drama\",Dark S01 E03
http://provider.example:8080/series/user/pass/24680.mp4
#EXTINF:-1 tvg-id=\"cnn.us\" group-title=\"US\",CNN
http://provider.example:8080/user/pass/13579
";

#[test]
fn reads_a_dispatcharr_playlist() {
    let (entries, summary) = read_all(DISPATCHARR);
    assert!(summary.has_header);
    assert_eq!(summary.epg_urls, vec!["http://192.0.2.10:9191/output/epg".to_string()]);
    assert_eq!(entries.len(), 2);
    let tf1 = &entries[0];
    assert_eq!(tf1.kind, EntryKind::Live);
    assert_eq!(tf1.name, "TF1");
    assert_eq!(tf1.group, "France");
    assert_eq!(tf1.tvg_id.as_deref(), Some("tf1.fr"));
    assert_eq!(tf1.chno, Some(1.0));
    assert!(tf1.logo.is_some());
    assert!(tf1.id >= HASH_ID_MIN && tf1.id < HASH_ID_END);
    assert_eq!(entries[1].chno, Some(2.5));
    assert_ne!(entries[0].id, entries[1].id);
}

#[test]
fn reads_a_playlist_made_by_an_xtream_panel() {
    let (entries, summary) = read_all(XTREAM_M3U_PLUS);
    assert_eq!(summary.entries, 4);
    let kinds: Vec<_> = entries.iter().map(|e| (e.kind, e.id)).collect();
    // Numéros du fournisseur gardés : les mêmes qu'en mode Xtream
    assert_eq!(
        kinds,
        vec![
            (EntryKind::Live, 12345),
            (EntryKind::Movie, 67890),
            (EntryKind::Episode, 24680),
            (EntryKind::Live, 13579),
        ]
    );
    assert_eq!(entries[0].extension.as_deref(), Some("ts"));
    assert_eq!(entries[1].year, Some(2010));
    assert_eq!(entries[1].tvg_id, None, "an empty attribute is no value");
    assert_eq!(
        entries[2].episode,
        Some(EpisodeInfo { series_name: "Dark".into(), season: 1, episode: 3 })
    );
    assert_eq!(entries[0].group, "UK | General");
}

#[test]
fn a_simple_playlist_without_attributes_still_reads() {
    let text = "#EXTM3U\n#EXTINF:-1,Radio One\nhttps://radio.example/live.m3u8\n#EXTINF:0,Film\nhttps://cdn.example/films/film.mp4\nhttps://cdn.example/bare/stream\n";
    let (entries, summary) = read_all(text);
    assert_eq!(summary.entries, 3);
    assert_eq!(entries[0].name, "Radio One");
    assert_eq!(entries[0].kind, EntryKind::Live);
    assert_eq!(entries[0].group, "");
    assert_eq!(entries[1].kind, EntryKind::Movie);
    // Adresse seule : nom tiré de la fin de l'adresse
    assert_eq!(entries[2].name, "stream");
    assert_eq!(entries[2].kind, EntryKind::Live);
}

#[test]
fn tolerates_bom_windows_line_ends_and_unquoted_attributes() {
    let text = "\u{feff}#EXTM3U\r\n#EXTINF:-1 tvg-id=arte.fr group-title='Culture' tvg-logo=\"http://l.example/a,b.png\",Arte, la chaîne\r\n#EXTVLCOPT:http-user-agent=Test\r\nhttp://tv.example/arte.ts\r\n";
    let (entries, summary) = read_all(text);
    assert!(summary.has_header);
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert_eq!(e.tvg_id.as_deref(), Some("arte.fr"));
    assert_eq!(e.group, "Culture");
    // Virgule dans un attribut entre guillemets, puis virgule dans le nom
    assert_eq!(e.logo.as_deref(), Some("http://l.example/a,b.png"));
    assert_eq!(e.name, "Arte, la chaîne");
    assert_eq!(e.url, "http://tv.example/arte.ts");
}

#[test]
fn extgrp_gives_the_group_before_or_after_extinf() {
    let text = "#EXTM3U\n#EXTINF:-1,Un\n#EXTGRP:Sport\nhttp://tv.example/1.ts\n#EXTGRP:Info\n#EXTINF:-1,Deux\nhttp://tv.example/2.ts\n";
    let (entries, summary) = read_all(text);
    assert_eq!(summary.skipped_invalid, 0);
    assert_eq!(entries[0].group, "Sport");
    assert_eq!(entries[1].group, "Info");
}

#[test]
fn a_broken_playlist_skips_bad_entries_and_keeps_the_rest() {
    let text = "#EXTM3U\n#EXTINF:-1,Sans adresse\n#EXTINF:-1,Bonne\nhttp://tv.example/ok.ts\n#EXTINF:-1,Fichier local\nfile:///etc/passwd\n#EXTINF:-1,Rtmp\nrtmp://tv.example/live\n#EXTINF:-1,Texte\nce n'est pas une adresse\n#EXTINF:-1,Hôte vide\nhttp:///chemin\n#EXTINF:-1,Dernière sans adresse\n";
    let (entries, summary) = read_all(text);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "Bonne");
    assert_eq!(summary.skipped_scheme, 2);
    // Sans adresse (2), texte, hôte vide
    assert_eq!(summary.skipped_invalid, 4);
}

#[test]
fn a_list_without_header_is_read_and_says_so() {
    let (entries, summary) = read_all("#EXTINF:-1,Un\nhttp://tv.example/1.ts\n");
    assert!(!summary.has_header);
    assert_eq!(entries.len(), 1);
}

#[test]
fn ids_stay_the_same_when_access_tokens_change() {
    let first = "#EXTM3U\n#EXTINF:-1,Un\nhttp://tv.example/live/channel-one.m3u8?token=aaa111&exp=1\n";
    let second = "#EXTM3U\n#EXTINF:-1,Un\nhttp://TV.example/live/channel-one.m3u8?token=bbb222&exp=2#frag\n";
    let (a, _) = read_all(first);
    let (b, _) = read_all(second);
    assert_eq!(a[0].id, b[0].id);
    // L'adresse rendue, elle, est celle du jour, jetons compris
    assert!(b[0].url.contains("token=bbb222"));
}

#[test]
fn ids_are_fixed_values_across_versions() {
    // Une valeur écrite en dur : si l'empreinte changeait, toutes les reprises, Ma liste et les
    // favoris enregistrés avec une liste M3U seraient perdus
    let (entries, _) = read_all("#EXTINF:-1,Un\nhttp://tv.example/live/one.ts\n");
    assert_eq!(entries[0].id, hash_id(fnv1a(b"tv.example/live/one.ts")));
    assert_eq!(fnv1a(b""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(fnv1a(b"a"), 0xaf63_dc4c_8601_ec8c);
}

#[test]
fn credentials_before_at_do_not_change_the_id() {
    let (a, _) = read_all("#EXTINF:-1,Un\nhttp://user:pw1@tv.example/one.ts\n");
    let (b, _) = read_all("#EXTINF:-1,Un\nhttp://user:pw2@tv.example/one.ts\n");
    assert_eq!(a[0].id, b[0].id);
}

#[test]
fn a_repeated_address_is_kept_once() {
    let text = "#EXTINF:-1 group-title=\"A\",Un\nhttp://tv.example/one.ts\n#EXTINF:-1 group-title=\"B\",Un bis\nhttp://TV.example/one.ts#x\n";
    let (entries, summary) = read_all(text);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].group, "A");
    assert_eq!(summary.skipped_duplicate, 1);
}

#[test]
fn addresses_that_differ_only_by_a_volatile_parameter_are_both_kept() {
    // Un paramètre classé « changeant » qui désignait en fait la chaîne : deux chaînes gardées,
    // la seconde sur le numéro libre suivant
    let text = "#EXTINF:-1,Un\nhttp://tv.example/play?key=1\n#EXTINF:-1,Deux\nhttp://tv.example/play?key=2\n";
    let (entries, summary) = read_all(text);
    assert_eq!(entries.len(), 2);
    assert_eq!(summary.skipped_duplicate, 0);
    assert_eq!(summary.id_collisions, 1);
    assert_eq!(entries[1].id, entries[0].id + 1);
}

#[test]
fn common_signature_parameters_do_not_change_the_id() {
    let families = [
        ("http://tvh.example/stream/channelid/42?ticket=aaa", "http://tvh.example/stream/channelid/42?ticket=bbb"),
        (
            "https://cdn.example/a.m3u8?Policy=p1&Key-Pair-Id=k1&Signature=s1",
            "https://cdn.example/a.m3u8?Policy=p2&Key-Pair-Id=k2&Signature=s2",
        ),
        (
            "https://bucket.example/v.mp4?X-Amz-Signature=1&X-Amz-Date=1&X-Amz-Credential=1",
            "https://bucket.example/v.mp4?X-Amz-Signature=2&X-Amz-Date=2&X-Amz-Credential=2",
        ),
        ("http://tv.example/x.ts?play_token=1&hmac=1&hdntl=1", "http://tv.example/x.ts?play_token=2&hmac=2&hdntl=2"),
    ];
    for (first, second) in families {
        let (a, _) = read_all(&format!("#EXTINF:-1,X\n{first}\n"));
        let (b, _) = read_all(&format!("#EXTINF:-1,X\n{second}\n"));
        assert_eq!(a[0].id, b[0].id, "{first}");
    }
}

#[test]
fn a_colliding_hash_takes_the_next_free_number() {
    let mut taken = HashSet::new();
    let id = hash_id(42);
    taken.insert(id);
    assert_eq!(next_free_id(id, &taken), Some(id + 1));
    // Fin de plage : on repart au début, sans sortir de la plage
    let last = HASH_ID_END - 1;
    let taken: HashSet<i64> = [last].into_iter().collect();
    assert_eq!(next_free_id(last, &taken), Some(HASH_ID_MIN));
    // Plage encombrée autour du numéro : rien, l'entrée sera sautée
    let crowded: HashSet<i64> = (0..=MAX_ID_PROBES as i64).map(|k| id + k).collect();
    assert_eq!(next_free_id(id, &crowded), None);
}

#[test]
fn entries_named_by_their_query_string_are_all_kept() {
    let text = "#EXTINF:-1,Un\nhttp://tv.example/play.php?id=1&token=aaa\n#EXTINF:-1,Deux\nhttp://tv.example/play.php?id=2&token=aaa\n#EXTINF:-1,Trois\nhttp://tv.example/stream?channel=5\n";
    let (entries, summary) = read_all(text);
    assert_eq!(entries.len(), 3);
    assert_eq!(summary.skipped_duplicate, 0);
    assert_ne!(entries[0].id, entries[1].id);
    // Jeton changé, paramètres dans un autre ordre : même numéro
    let again = "#EXTINF:-1,Un\nhttp://tv.example/play.php?token=bbb&id=1\n";
    let (b, _) = read_all(again);
    assert_eq!(b[0].id, entries[0].id);
}

#[test]
fn an_xtream_number_taken_by_another_server_falls_back_to_its_address_hash() {
    let a = "#EXTINF:-1,A\nhttp://one.example/u/p/5\n";
    let b = "#EXTINF:-1,B\nhttp://two.example/u/p/5\n";
    let (ab, _) = read_all(&format!("{a}{b}"));
    let (ba, _) = read_all(&format!("{b}{a}"));
    let id_of = |list: &[M3uEntry], name: &str| list.iter().find(|e| e.name == name).unwrap().id;
    // Le premier lu garde le numéro du fournisseur ; l'autre prend l'empreinte de son adresse, qui
    // ne dépend pas de l'ordre. Le choix de celui qui garde le numéro, lui, en dépend (limite
    // écrite en tête du module)
    assert_eq!(id_of(&ab, "A"), 5);
    assert_eq!(id_of(&ba, "B"), 5);
    assert_eq!(id_of(&ab, "B"), hash_id(fnv1a(b"two.example/u/p/5")));
    assert_eq!(id_of(&ba, "A"), hash_id(fnv1a(b"one.example/u/p/5")));
}

#[test]
fn quotes_protect_commas_but_an_apostrophe_in_a_name_is_a_letter() {
    let text = "#EXTINF:-1 group-title='Rock, Pop' tvg-name=\"L'Équipe, direct\",L'Équipe\nhttp://tv.example/e.ts\n";
    let (entries, _) = read_all(text);
    assert_eq!(entries[0].group, "Rock, Pop");
    assert_eq!(entries[0].tvg_name.as_deref(), Some("L'Équipe, direct"));
    assert_eq!(entries[0].name, "L'Équipe");
    // Sans guillemets, une apostrophe au milieu d'une valeur n'ouvre rien
    let (entries, _) = read_all("#EXTINF:-1 tvg-name=L'Equipe group-title=\"X\",Nom\nhttp://tv.example/e.ts\n");
    assert_eq!(entries[0].name, "Nom");
    assert_eq!(entries[0].group, "X");
}

#[test]
fn a_second_header_further_down_adds_its_guides() {
    let text = "#EXTM3U url-tvg=\"http://g.example/a.xml\"\n#EXTINF:-1,Un\nhttp://tv.example/1.ts\n#EXTM3U url-tvg=\"http://g.example/b.xml\"\n#EXTINF:-1,Deux\nhttp://tv.example/2.ts\n";
    let (entries, summary) = read_all(text);
    assert!(summary.has_header);
    assert_eq!(entries.len(), 2);
    assert_eq!(summary.epg_urls.len(), 2);
}

#[test]
fn guide_addresses_are_capped() {
    let urls: Vec<String> = (0..10).map(|i| format!("http://g.example/{i}.xml")).collect();
    let text = format!("#EXTM3U url-tvg=\"{}\"\n", urls.join(","));
    let (_, summary) = read_all(&text);
    assert_eq!(summary.epg_urls.len(), MAX_EPG_URLS);
}

#[test]
fn spaces_are_encoded_and_control_characters_refused() {
    let text = "#EXTINF:-1,Espace\nhttp://tv.example/films/Mon Film.mkv\n#EXTINF:-1,Contrôle\nhttp://tv.example/a\u{1}b.ts\n#EXTINF:-1,Tabulation\nhttp://tv.example/a\tb.ts\n#EXTINF:-1,Bonne\nHTTP://tv.example/ok.ts\n";
    let (entries, summary) = read_all(text);
    assert_eq!(entries.len(), 2);
    assert_eq!(summary.skipped_invalid, 2);
    assert_eq!(entries[0].url, "http://tv.example/films/Mon%20Film.mkv");
    // Espace dans l'hôte : pas une adresse
    let (none, summary) = read_all("#EXTINF:-1,X\nhttp://tv.example a/b.ts\n");
    assert!(none.is_empty());
    assert_eq!(summary.skipped_invalid, 1);
    // Sans nom : celui du fichier, décodé
    let (bare, _) = read_all("http://tv.example/films/Mon Film.mkv\n");
    assert_eq!(bare[0].name, "Mon Film");
    assert_eq!(entries[0].kind, EntryKind::Movie);
    // Schéma remis en minuscules
    assert_eq!(entries[1].url, "http://tv.example/ok.ts");
}

#[test]
fn a_logo_must_be_a_web_address() {
    let text = "#EXTINF:-1 tvg-logo=\"file:///etc/passwd\",Un\nhttp://tv.example/1.ts\n#EXTINF:-1 tvg-logo=\"javascript:alert(1)\",Deux\nhttp://tv.example/2.ts\n";
    let (entries, _) = read_all(text);
    assert!(entries.iter().all(|e| e.logo.is_none()));
}

#[test]
fn http_headers_from_the_playlist_are_kept_apart_from_the_address() {
    let text = "#EXTINF:-1,Pipe\nhttp://tv.example/a.m3u8|User-Agent=Mozilla%2F5.0&Referer=http://site.example/\n#EXTVLCOPT:http-user-agent=VLC/3.0\n#EXTINF:-1,Avant\n#EXTVLCOPT:http-referrer=http://ref.example/\nhttp://tv.example/b.ts\n#EXTINF:-1,Injection\n#EXTVLCOPT:http-user-agent=a\u{0}b\nhttp://tv.example/c.ts\n";
    let (entries, _) = read_all(text);
    assert_eq!(entries[0].url, "http://tv.example/a.m3u8");
    assert_eq!(entries[0].user_agent.as_deref(), Some("Mozilla/5.0"));
    assert_eq!(entries[0].referrer.as_deref(), Some("http://site.example/"));
    // #EXTVLCOPT avant ou après le #EXTINF
    assert_eq!(entries[1].user_agent.as_deref(), Some("VLC/3.0"));
    assert_eq!(entries[1].referrer.as_deref(), Some("http://ref.example/"));
    assert_eq!(entries[2].user_agent, None);
    // Même adresse avec ou sans en-têtes : même numéro
    let (plain, _) = read_all("#EXTINF:-1,Pipe\nhttp://tv.example/a.m3u8\n");
    assert_eq!(plain[0].id, entries[0].id);
}

#[test]
fn long_fields_are_cut_and_long_addresses_skipped() {
    let long_name = "é".repeat(MAX_NAME_CHARS + 10);
    let long_group = "g".repeat(MAX_GROUP_CHARS + 10);
    let long_path = "a".repeat(MAX_URL_BYTES);
    let text = format!(
        "#EXTINF:-1 group-title=\"{long_group}\",{long_name}\nhttp://tv.example/1.ts\n#EXTINF:-1,Longue\nhttp://tv.example/{long_path}.ts\n"
    );
    let (entries, summary) = read_all(&text);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name.chars().count(), MAX_NAME_CHARS);
    assert_eq!(entries[0].group.chars().count(), MAX_GROUP_CHARS);
    assert_eq!(summary.skipped_invalid, 1);
}

#[test]
fn xtream_numbers_need_the_xtream_path_shape() {
    let cases = [
        ("http://p.example/live/u/p/12.ts", Some(12)),
        ("http://p.example/movie/u/p/34.mp4", Some(34)),
        ("http://p.example/u/p/56", Some(56)),
        ("http://p.example/u/p/56.ts", Some(56)),
        ("http://p.example/u/p/56.m3u8", Some(56)),
        // Trois morceaux avec une extension de fichier : pas une chaîne Xtream
        ("http://p.example/u/p/56.mp4", None),
        // Pas de forme Xtream : empreinte
        ("http://p.example/channels/78.ts", None),
        ("http://p.example/a/b/c/90.ts", None),
        ("http://p.example/live/u/p/abc.ts", None),
        ("http://p.example/live/u/p/0.ts", None),
        ("http://p.example/live/u/p/99999999999999.ts", None),
    ];
    for (url, expected) in cases {
        let parts = UrlParts::parse(url).unwrap();
        assert_eq!(parts.xtream_number(), expected, "{url}");
    }
}

#[test]
fn classifies_by_path_then_extension_then_name() {
    let text = "#EXTINF:-1,Journal\nhttp://tv.example/news.m3u8\n#EXTINF:-1,Le Film (1999)\nhttp://cdn.example/f/film.MKV\n#EXTINF:-1,The Office s2e10\nhttp://cdn.example/e/office.avi\n#EXTINF:-1,Match S01E01 en direct\nhttp://tv.example/match.ts\n#EXTINF:-1,Nom\nhttp://p.example/series/u/p/77.mkv\n";
    let (entries, _) = read_all(text);
    let kinds: Vec<_> = entries.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![EntryKind::Live, EntryKind::Movie, EntryKind::Episode, EntryKind::Live, EntryKind::Episode]
    );
    assert_eq!(entries[1].extension.as_deref(), Some("mkv"));
    assert_eq!(entries[1].year, Some(1999));
    // Une chaîne n'a ni épisode ni année, même si son nom en porte la marque
    assert_eq!(entries[3].episode, None);
    // Épisode de forme Xtream sans marque dans le nom : pas de série connue
    assert_eq!(entries[4].episode, None);
}

#[test]
fn hls_films_and_episodes_are_not_channels() {
    let text = "#EXTM3U\n\
#EXTINF:-1 group-title=\"Films\",Tears of Steel (2012)\nhttps://cdn.example/vod/tos/stream.m3u8\n\
#EXTINF:-1 group-title=\"Séries\",Série E S01E1071\nhttps://cdn.example/vod/serie-e/1071.m3u8\n\
#EXTINF:-1 group-title=\"Films\",Le Film [1999]\nhttps://cdn.example/vod/film\n\
#EXTINF:-1 group-title=\"Films\",Ciné Classics\nhttps://tv.example/cine-classics.m3u8\n\
#EXTINF:-1,Journal (2024)\nhttps://tv.example/journal.ts\n";
    let (entries, _) = read_all(text);
    let kinds: Vec<_> = entries.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![EntryKind::Movie, EntryKind::Episode, EntryKind::Movie, EntryKind::Live, EntryKind::Live]
    );
    assert_eq!(entries[0].year, Some(2012));
    assert_eq!(entries[1].episode.as_ref().map(|e| (e.season, e.episode)), Some((1, 1071)));
    // Une chaîne de cinéma rangée dans « Films » reste une chaîne, comme un flux .ts daté
    assert_eq!(entries[3].year, None);
}

#[test]
fn episode_markers() {
    let ok = [
        ("Breaking Bad S05E14", "Breaking Bad", 5, 14),
        ("Breaking Bad - S05E14 - Ozymandias", "Breaking Bad", 5, 14),
        ("Lupin s1e2", "Lupin", 1, 2),
        ("FR: Lupin (2021) S01 E05", "FR: Lupin (2021)", 1, 5),
        ("Lupin S01.E05", "Lupin", 1, 5),
        ("Lupin S01EP05", "Lupin", 1, 5),
        ("Lupin Saison 1 Épisode 5", "Lupin", 1, 5),
        ("LUPIN - SAISON 2 - ÉPISODE 3", "LUPIN", 2, 3),
        ("Lupin saison 1 episode 5", "Lupin", 1, 5),
        ("Dark Season 3 Episode 8", "Dark", 3, 8),
        ("Lupin Saison 1 Ep 5", "Lupin", 1, 5),
        ("The Office 2x05", "The Office", 2, 5),
        ("Friends - 10x17 - Le dernier", "Friends", 10, 17),
        ("One Piece S01E1071", "One Piece", 1, 1071),
        ("Game S01 Episode 02", "Game", 1, 2),
        ("Game S01xE02", "Game", 1, 2),
        // É écrit en deux caractères (E + accent), comme certains fichiers venus d'un Mac
        ("Lupin Saison 1 E\u{301}pisode 5", "Lupin", 1, 5),
        // Chiffres d'une autre écriture ignorés : la vraie marque plus loin est lue
        ("Game ١x٠٢ S01E02", "Game ١x٠٢", 1, 2),
    ];
    for (name, series, season, episode) in ok {
        let info = parse_episode(name);
        assert_eq!(info, Some(EpisodeInfo { series_name: series.into(), season, episode }), "{name}");
    }
    // Sans nom de série, marque incomplète, collée à un mot, ou numéro d'épisode à quatre chiffres
    // « 4x4 » et « 2x3 » : un seul chiffre après le x, un titre et non un épisode ; « Saison 2 » seule
    // n'a pas d'épisode ; numéro d'épisode à cinq chiffres
    for name in [
        "S01E01", "Classes S1", "BOSS01E02", "Saison 1 Episode 2", "S123E1 Nom", "Off Road 4x4", "Film 2x3",
        "Lupin Saison 2", "Lupin S01E10712", "Mix1x02 Nom", "Les 4x100 (2023)", "Paw Patrol 4x100 Relay",
        "Top Gun 2X10", "Film 1920x1080", "Le Film 2x10 (1999)",
    ] {
        assert_eq!(parse_episode(name), None, "{name}");
    }
}

#[test]
fn years() {
    assert_eq!(parse_year("Film (2019)"), Some(2019));
    assert_eq!(parse_year("Film [1985] (2020)"), Some(2020));
    assert_eq!(parse_year("Film 2019"), None);
    assert_eq!(parse_year("Film (1800)"), None);
    assert_eq!(parse_year("(12345)"), None);
}

#[test]
fn header_lists_several_guides_without_duplicates() {
    let text = "#EXTM3U url-tvg=\"http://g.example/a.xml.gz,http://g.example/b.xml\" x-tvg-url=\"http://g.example/a.xml.gz\" tvg-url=\"ftp://bad.example/c\"\n";
    let (_, summary) = read_all(text);
    assert_eq!(
        summary.epg_urls,
        vec!["http://g.example/a.xml.gz".to_string(), "http://g.example/b.xml".to_string()]
    );
}

#[test]
fn stops_at_the_entry_ceiling() {
    let mut text = String::from("#EXTM3U\n");
    for i in 0..10 {
        text.push_str(&format!("#EXTINF:-1,C{i}\nhttp://tv.example/{i}.ts\n"));
    }
    let (entries, summary) = read_all_max(&text, 4);
    assert_eq!(entries.len(), 4);
    assert!(summary.truncated);
    let (_, summary) = read_all_max(&text, 10);
    assert!(!summary.truncated);
}

#[test]
fn an_overlong_line_is_skipped_without_being_kept() {
    let mut text = String::from("#EXTM3U\n#EXTINF:-1,Avant\nhttp://tv.example/a.ts\n#EXTINF:-1,");
    text.push_str(&"x".repeat(MAX_LINE_BYTES * 3));
    text.push_str("\nhttp://tv.example/b.ts\n#EXTINF:-1,Après\nhttp://tv.example/c.ts\n");
    let (entries, summary) = read_all(&text);
    assert_eq!(summary.skipped_long_lines, 1);
    // L'adresse qui suivait la ligne trop longue reste lue, sans nom : tiré de l'adresse
    let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["Avant", "b", "Après"]);
}

#[test]
fn a_line_split_across_small_reads_is_rebuilt() {
    let reader = BufReader::with_capacity(7, Cursor::new(XTREAM_M3U_PLUS.as_bytes().to_vec()));
    let mut entries = Vec::new();
    read_m3u(reader, usize::MAX, |e| entries.push(e)).unwrap();
    let (expected, _) = read_all(XTREAM_M3U_PLUS);
    assert_eq!(entries, expected);
}

#[test]
fn invalid_utf8_does_not_stop_the_reading() {
    let mut bytes = b"#EXTM3U\n#EXTINF:-1,Cha\xEEne\nhttp://tv.example/a.ts\n".to_vec();
    bytes.extend_from_slice(b"#EXTINF:-1,Deux\nhttp://tv.example/b.ts\n");
    let mut entries = Vec::new();
    read_m3u(Cursor::new(bytes), usize::MAX, |e| entries.push(e)).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries[0].name.starts_with("Cha"));
}

#[test]
fn a_stream_error_is_an_error() {
    struct Failing;
    impl Read for Failing {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "cut"))
        }
    }
    let result = read_m3u(BufReader::new(Failing), usize::MAX, |_| {});
    assert!(result.is_err());
}

/// Liste générée à la volée, jamais entière en mémoire : `count` chaînes.
struct GeneratedPlaylist {
    next: usize,
    count: usize,
    current: Vec<u8>,
    pos: usize,
}

impl Read for GeneratedPlaylist {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.current.len() {
            if self.next > self.count {
                return Ok(0);
            }
            self.current = if self.next == 0 {
                b"#EXTM3U url-tvg=\"http://g.example/guide.xml.gz\"\n".to_vec()
            } else {
                let i = self.next;
                format!(
                    "#EXTINF:-1 tvg-id=\"c{i}.example\" tvg-name=\"Chaine {i}\" tvg-logo=\"http://logo.example/{i}.png\" group-title=\"Groupe {}\",Chaine {i}\nhttp://tv.example/stream/{i}.m3u8?token=abcdef0123456789\n",
                    i % 50
                )
                .into_bytes()
            };
            self.pos = 0;
            self.next += 1;
        }
        let n = out.len().min(self.current.len() - self.pos);
        out[..n].copy_from_slice(&self.current[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

#[test]
fn a_very_large_playlist_is_read_without_holding_it_in_memory() {
    const COUNT: usize = 200_000;
    let reader = BufReader::new(GeneratedPlaylist { next: 0, count: COUNT, current: Vec::new(), pos: 0 });
    let mut seen = 0usize;
    let (summary, peak) = crate::test_alloc::peak_during(|| {
        read_m3u(reader, usize::MAX, |_| seen += 1).unwrap()
    });
    assert_eq!(summary.entries, COUNT);
    assert_eq!(seen, COUNT);
    assert_eq!(summary.id_collisions, 0);
    // La liste fait environ 40 Mo ; seule la table des numéros pris grandit avec elle
    // (de l'ordre de 16 octets par entrée, plus la marge de la table)
    assert!(peak < 24 * 1024 * 1024, "peak {} bytes", peak);
}
