use super::*;
use std::io::{Cursor, Write};

fn catalog() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::schema::CATALOG_TABLES).unwrap();
    crate::schema::run_auto_repair(&conn, crate::schema::CATALOG_AUTO_REPAIR);
    conn
}

fn write(conn: &mut Connection, text: &str) -> M3uWriteCounts {
    write_m3u_catalog(conn, Cursor::new(text.as_bytes().to_vec())).unwrap()
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
}

const PLAYLIST: &str = "#EXTM3U url-tvg=\"http://g.example/guide.xml\"
#EXTINF:-1 tvg-id=\"deux.example\" tvg-chno=\"2\" tvg-logo=\"http://l.example/2.png\" group-title=\"Info\",FR: Deux HD
http://tv.example/live/deux.m3u8?token=abc
#EXTINF:-1 tvg-id=\"un.example\" tvg-chno=\"1\" group-title=\"Info\",Un
http://tv.example/live/un.m3u8
#EXTINF:-1 group-title=\"Divers\",Sans numéro
http://tv.example/live/autre.ts
#EXTINF:-1 group-title=\"Films\",Le Film (2001)
http://cdn.example/films/le-film.mkv
#EXTINF:-1 tvg-logo=\"http://l.example/s.png\" group-title=\"Séries\",Ma Série S01E02
http://cdn.example/series/ma-serie-1-2.mp4
#EXTINF:-1 group-title=\"Séries\",Ma Série S01E01
http://cdn.example/series/ma-serie-1-1.mp4
#EXTVLCOPT:http-user-agent=Lecteur/1.0
#EXTINF:-1 group-title=\"Séries\",Ma Série S02E01
http://cdn.example/series/ma-serie-2-1.mp4
";

#[test]
fn writes_channels_movies_series_and_categories() {
    let mut conn = catalog();
    let counts = write(&mut conn, PLAYLIST);
    assert!(counts.replaced);
    assert_eq!((counts.live, counts.movies, counts.series, counts.episodes), (3, 1, 1, 3));
    assert_eq!(count(&conn, "live"), 3);
    assert_eq!(count(&conn, "movies"), 1);
    assert_eq!(count(&conn, "series"), 1);
    // Info, Divers (chaînes), Films, Séries
    assert_eq!(counts.categories, 4);
    assert_eq!(count(&conn, "categories"), 4);
}

#[test]
fn channels_follow_their_channel_numbers_then_the_list() {
    let mut conn = catalog();
    write(&mut conn, PLAYLIST);
    let names: Vec<String> = conn
        .prepare("SELECT name FROM live ORDER BY sort_order")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(names[0], "Un");
    assert!(names[1].contains("Deux"));
    assert_eq!(names[2], "Sans numéro");
}

#[test]
fn each_entry_keeps_its_playback_address_in_data() {
    let mut conn = catalog();
    write(&mut conn, PLAYLIST);
    let (data, epg): (String, String) = conn
        .query_row("SELECT data, epg_channel_id FROM live WHERE name = 'Un'", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    let data: serde_json::Value = serde_json::from_str(&data).unwrap();
    assert_eq!(data["source"], "m3u");
    assert_eq!(data["url"], "http://tv.example/live/un.m3u8");
    assert_eq!(epg, "un.example");
    let (data, ext): (String, String) = conn
        .query_row("SELECT data, container_extension FROM movies", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    let data: serde_json::Value = serde_json::from_str(&data).unwrap();
    assert_eq!(data["url"], "http://cdn.example/films/le-film.mkv");
    assert_eq!(data["year"], 2001);
    assert_eq!(ext, "mkv");
}

#[test]
fn series_hold_their_episodes_sorted_by_season_and_number() {
    let mut conn = catalog();
    write(&mut conn, PLAYLIST);
    let (id, name, icon, data): (i64, String, String, String) = conn
        .query_row("SELECT id, name, icon, data FROM series", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap();
    assert_eq!(name, "Ma Série");
    assert_eq!(icon, "http://l.example/s.png");
    assert_eq!(id, series_id("Ma Série", "Séries"));
    let data: serde_json::Value = serde_json::from_str(&data).unwrap();
    let episodes = data["episodes"].as_array().unwrap();
    let order: Vec<(i64, i64)> = episodes
        .iter()
        .map(|e| (e["season"].as_i64().unwrap(), e["episode_num"].as_i64().unwrap()))
        .collect();
    assert_eq!(order, vec![(1, 1), (1, 2), (2, 1)]);
    assert_eq!(episodes[0]["data"]["url"], "http://cdn.example/series/ma-serie-1-1.mp4");
    assert_eq!(episodes[2]["data"]["user_agent"], "Lecteur/1.0");
    assert!(episodes[0]["id"].as_i64().unwrap() > 0);
}

#[test]
fn numbers_are_the_same_after_a_second_reading() {
    let mut conn = catalog();
    write(&mut conn, PLAYLIST);
    let ids = |conn: &Connection| -> Vec<i64> {
        conn.prepare("SELECT id FROM live UNION ALL SELECT id FROM movies UNION ALL SELECT id FROM series ORDER BY 1")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let before = ids(&conn);
    // Jeton renouvelé : mêmes numéros
    write(&mut conn, &PLAYLIST.replace("token=abc", "token=xyz"));
    assert_eq!(ids(&conn), before);
}

#[test]
fn a_new_reading_replaces_the_previous_catalogue() {
    let mut conn = catalog();
    write(&mut conn, PLAYLIST);
    let counts = write(&mut conn, "#EXTM3U\n#EXTINF:-1,Seule\nhttp://tv.example/seule.ts\n");
    assert!(counts.replaced);
    assert_eq!(count(&conn, "live"), 1);
    assert_eq!(count(&conn, "movies"), 0);
    assert_eq!(count(&conn, "series"), 0);
    assert_eq!(count(&conn, "categories"), 1);
}

#[test]
fn an_empty_or_unreadable_list_keeps_the_catalogue() {
    let mut conn = catalog();
    write(&mut conn, PLAYLIST);
    for text in ["", "#EXTM3U\n", "<html><body>Maintenance</body></html>\n", "#EXTM3U\n#EXTINF:-1,X\nrtmp://tv.example/x\n"] {
        let counts = write(&mut conn, text);
        assert!(!counts.replaced, "{text:?}");
        assert_eq!(count(&conn, "live"), 3, "{text:?}");
        assert_eq!(count(&conn, "series"), 1, "{text:?}");
        assert_eq!(count(&conn, "categories"), 4, "{text:?}");
    }
}

#[test]
fn an_xtream_style_list_keeps_the_provider_numbers() {
    let mut conn = catalog();
    write(
        &mut conn,
        "#EXTM3U\n#EXTINF:-1,Chaîne\nhttp://p.example/live/u/p/101.ts\n#EXTINF:-1,Film\nhttp://p.example/movie/u/p/202.mp4\n",
    );
    let live: i64 = conn.query_row("SELECT id FROM live", [], |r| r.get(0)).unwrap();
    let movie: i64 = conn.query_row("SELECT id FROM movies", [], |r| r.get(0)).unwrap();
    assert_eq!((live, movie), (101, 202));
}

#[test]
fn category_numbers_are_digits_and_differ_by_kind() {
    let a = category_id("live", "Sport");
    let b = category_id("movie", "Sport");
    assert_ne!(a, b);
    assert!(a.bytes().all(|c| c.is_ascii_digit()));
    assert_eq!(category_id("live", "Sport"), category_id("live", "SPORT"));
}

#[test]
fn a_compressed_list_is_read() {
    let dir = std::env::temp_dir().join(format!("nyx-m3u-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("liste.m3u.gz");
    let mut gz = flate2::write::GzEncoder::new(std::fs::File::create(&path).unwrap(), flate2::Compression::fast());
    gz.write_all(PLAYLIST.as_bytes()).unwrap();
    gz.finish().unwrap();
    let mut conn = catalog();
    let counts = write_m3u_catalog(&mut conn, open_playlist(&path).unwrap()).unwrap();
    assert_eq!(counts.live, 3);
    let plain = dir.join("liste.m3u");
    std::fs::write(&plain, PLAYLIST).unwrap();
    let mut conn = catalog();
    assert_eq!(write_m3u_catalog(&mut conn, open_playlist(&plain).unwrap()).unwrap().live, 3);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_temporary_download_is_removed() {
    let path = std::env::temp_dir().join(format!("nyx-m3u-temp-{}.part", std::process::id()));
    std::fs::write(&path, "x").unwrap();
    drop(TempFile(path.clone()));
    assert!(!path.exists());
}

#[test]
fn a_stop_during_the_write_keeps_the_catalogue() {
    let mut conn = catalog();
    write(&mut conn, PLAYLIST);
    let mut text = String::from("#EXTM3U\n");
    for i in 0..5000 {
        text.push_str(&format!("#EXTINF:-1,C{i}\nhttp://tv.example/c/{i}.ts\n"));
    }
    let calls = std::cell::Cell::new(0);
    let stop = || {
        calls.set(calls.get() + 1);
        true
    };
    let result = write_m3u_catalog_until(&mut conn, Cursor::new(text.into_bytes()), &stop);
    assert_eq!(result.unwrap_err(), WRITE_CANCELLED);
    // Arrêt vu à la première vérification, pas à la fin de la liste
    assert_eq!(calls.get(), 1);
    assert_eq!(count(&conn, "live"), 3);
    assert_eq!(count(&conn, "series"), 1);
    // La connexion reste utilisable : une lecture suivante passe
    assert!(write(&mut conn, PLAYLIST).replaced);
}

#[test]
fn a_stop_before_the_commit_keeps_the_catalogue() {
    let mut conn = catalog();
    write(&mut conn, PLAYLIST);
    let result = write_m3u_catalog_until(&mut conn, Cursor::new(b"#EXTINF:-1,X\nhttp://tv.example/x.ts\n".to_vec()), &|| true);
    assert_eq!(result.unwrap_err(), WRITE_CANCELLED);
    assert_eq!(count(&conn, "live"), 3);
}

#[test]
fn many_series_are_grouped_quickly() {
    const SERIES: usize = 5000;
    let mut text = String::from("#EXTM3U\n");
    for s in 0..SERIES {
        for e in 1..=4 {
            text.push_str(&format!("#EXTINF:-1 group-title=\"S\",Serie {s} S01E0{e}\nhttp://cdn.example/s/{s}/{e}.mkv\n"));
        }
    }
    let mut conn = catalog();
    let start = std::time::Instant::now();
    let counts = write(&mut conn, &text);
    let elapsed = start.elapsed();
    assert_eq!(counts.series, SERIES);
    assert_eq!(counts.episodes, SERIES * 4);
    // Sans l'index de la table de travail, cette écriture prend plusieurs dizaines de secondes
    assert!(elapsed < std::time::Duration::from_secs(8), "{elapsed:?}");
}

#[test]
fn groups_that_differ_only_by_case_are_one_category() {
    let mut conn = catalog();
    let counts = write(
        &mut conn,
        "#EXTINF:-1 group-title=\"Sport\",A\nhttp://tv.example/a.ts\n#EXTINF:-1 group-title=\"SPORT\",B\nhttp://tv.example/b.ts\n",
    );
    assert_eq!(counts.categories, 1);
    let name: String = conn.query_row("SELECT name FROM categories", [], |r| r.get(0)).unwrap();
    assert_eq!(name, "Sport");
    let distinct: i64 = conn.query_row("SELECT COUNT(DISTINCT category_id) FROM live", [], |r| r.get(0)).unwrap();
    assert_eq!(distinct, 1);
}

#[test]
fn a_list_too_large_once_decompressed_is_refused_not_cut() {
    let dir = std::env::temp_dir().join(format!("nyx-m3u-limit-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("liste.m3u");
    std::fs::write(&path, PLAYLIST).unwrap();
    let mut conn = catalog();
    write(&mut conn, PLAYLIST);
    let reader = open_playlist_limited(&path, 100).unwrap();
    assert!(write_m3u_catalog(&mut conn, reader).is_err());
    // Le catalogue d'avant est intact
    assert_eq!(count(&conn, "live"), 3);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn leftover_downloads_of_another_run_are_removed() {
    let dir = std::env::temp_dir().join(format!("nyx-m3u-left-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let old = dir.join(format!("{DOWNLOAD_PREFIX}{}-1_0.part", std::process::id()));
    let mine = dir.join(format!("{DOWNLOAD_PREFIX}{}_7.part", launch_marker()));
    let other = dir.join("nyxplayer_x.db");
    for f in [&old, &mine, &other] {
        std::fs::write(f, "x").unwrap();
    }
    remove_leftover_downloads(&dir);
    // Même numéro de processus, autre lancement : supprimé
    assert!(!old.exists());
    assert!(mine.exists());
    assert!(other.exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_episode_work_table_never_stays_in_the_base() {
    let mut conn = catalog();
    write(&mut conn, PLAYLIST);
    let _ = write_m3u_catalog_until(&mut conn, Cursor::new(PLAYLIST.as_bytes().to_vec()), &|| true);
    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'm3u_episodes_work%'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn the_journal_is_emptied_after_a_stopped_or_finished_write() {
    let dir = std::env::temp_dir().join(format!("nyx-m3u-wal-{}-{}", std::process::id(), launch_marker()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("catalogue.db");
    let wal = dir.join("catalogue.db-wal");
    let mut conn = crate::catalog_parser::open_connection(&db).unwrap();
    let mut text = String::from("#EXTM3U\n");
    for i in 0..3000 {
        text.push_str(&format!("#EXTINF:-1 group-title=\"S\",Série {i} S01E01\nhttp://cdn.example/s/{i}.mp4\n"));
    }
    let stopped = write_then_shrink_journal(&mut conn, Cursor::new(text.clone().into_bytes()), &|| true);
    assert_eq!(stopped.unwrap_err(), WRITE_CANCELLED);
    assert_eq!(std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0), 0);
    assert!(write_then_shrink_journal(&mut conn, Cursor::new(text.into_bytes()), &|| false).unwrap().replaced);
    assert_eq!(std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0), 0);
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn title_links_stay_out_of_the_catalogue_and_survive_a_new_reading() {
    // Un lien trouvé par le titre n'est jamais écrit dans `tmdb_id` : l'app le pose en mémoire tant
    // que le réglage est allumé, et le retire dès qu'on le coupe
    let mut conn = catalog();
    write(&mut conn, PLAYLIST);
    let (movie_id, movie_name): (i64, String) =
        conn.query_row("SELECT id, name FROM movies", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    conn.execute(
        "INSERT INTO m3u_tmdb_links (kind, id, name, tmdb_id, checked_at) VALUES ('movie', ?1, ?2, 603, 1)",
        params![movie_id, movie_name],
    )
    .unwrap();

    write(&mut conn, PLAYLIST);
    let tmdb: Option<i64> = conn.query_row("SELECT tmdb_id FROM movies", [], |r| r.get(0)).unwrap();
    assert_eq!(tmdb, None);
    assert_eq!(count(&conn, "m3u_tmdb_links"), 1);
}

#[test]
fn every_way_of_writing_an_episode_makes_a_series_and_a_reused_address_counts_once() {
    let mut conn = catalog();
    let v = "http://192.0.2.1/v/";
    let counts = write(
        &mut conn,
        &format!(
            "#EXTM3U\n\
             #EXTINF:-1 group-title=\"Films\",Big Buck Bunny (2008)\n{v}f1.mp4\n\
             #EXTINF:-1 group-title=\"Séries\",Série A - S01E01\n{v}a1.mp4\n\
             #EXTINF:-1 group-title=\"Séries\",Série A - S02E01\n{v}a2.mp4\n\
             #EXTINF:-1 group-title=\"Séries\",Série B Saison 1 Épisode 1\n{v}b1.mp4\n\
             #EXTINF:-1 group-title=\"Séries\",Série C 1x01\n{v}c1.mp4\n\
             #EXTINF:-1 group-title=\"Séries\",Série D S01.E01\n{v}d1.mp4\n\
             #EXTINF:-1 group-title=\"Séries\",Série D S01EP02\n{v}d2.mp4\n\
             #EXTINF:-1 group-title=\"Séries\",Série E S01E1071\n{v}e1.mp4\n\
             #EXTINF:-1 group-title=\"Pièges\",Off Road 4x4 (2019)\n{v}p1.mp4\n\
             #EXTINF:-1 group-title=\"Séries\",Série F S01E01\n{v}f1.mp4\n"
        ),
    );
    assert_eq!((counts.movies, counts.series, counts.episodes), (2, 5, 7));
    // Même adresse que « Big Buck Bunny » : la même vidéo, gardée une fois (la première)
    assert_eq!(counts.summary.skipped_duplicate, 1);
}
