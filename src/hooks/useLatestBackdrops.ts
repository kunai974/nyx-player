import { useEffect, useState } from 'react';
import tmdb from '../services/tmdbApi';
import { createLogger } from '../utils/logger';

const log = createLogger('useLatestBackdrops');

/** Backdrops of the latest movies and TV shows, fetched once per session */
export interface LatestBackdrop {
  url: string;
  title: string;
  kind: 'movie' | 'tv';
  year?: number;
}

let cached: LatestBackdrop[] | null = null;
let pending: Promise<LatestBackdrop[]> | null = null;

function loadBackdrops(): Promise<LatestBackdrop[]> {
  if (cached) return Promise.resolve(cached);
  pending ??= Promise.all([tmdb.getNowPlaying(), tmdb.getOnTheAir()])
    .then(([movies, shows]) => {
      const a = movies.results.filter((r) => r.backdrop_path).map((r) => ({ path: r.backdrop_path as string, title: r.title, kind: 'movie' as const, year: Number(r.release_date?.slice(0, 4)) || undefined }));
      const b = shows.results.filter((r) => r.backdrop_path).map((r) => ({ path: r.backdrop_path as string, title: r.name, kind: 'tv' as const, year: Number(r.first_air_date?.slice(0, 4)) || undefined }));
      // Movies and shows alternate
      const mixed: Array<{ path: string; title: string; kind: 'movie' | 'tv'; year?: number }> = [];
      for (let i = 0; i < Math.max(a.length, b.length) && mixed.length < 16; i++) {
        if (a[i]) mixed.push(a[i]);
        if (b[i]) mixed.push(b[i]);
      }
      cached = mixed
        .slice(0, 16)
        .map((m) => ({ url: tmdb.imageUrl(m.path, 'w1280') ?? '', title: m.title, kind: m.kind, year: m.year }))
        .filter((m) => m.url);
      return cached;
    })
    .catch((e) => {
      log.warn('Latest backdrops unavailable:', e);
      pending = null;
      return [];
    });
  return pending;
}

/** Pictures and titles of the latest movies / TV shows (empty while loading or when TMDB is unreachable) */
export function useLatestBackdrops(enabled: boolean): LatestBackdrop[] {
  const [urls, setUrls] = useState<LatestBackdrop[]>(cached ?? []);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadBackdrops().then((list) => { if (!cancelled) setUrls(list); });
    return () => { cancelled = true; };
  }, [enabled]);
  return urls;
}
