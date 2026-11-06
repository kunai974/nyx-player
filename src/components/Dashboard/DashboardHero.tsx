import React from 'react';
import HeroBanner from './HeroBanner';
import { useHeroRotation } from '../../hooks/useHeroRotation';
import type { HeroMovie } from '../../types/dashboard';
import type { LightIndexes } from '../../types/lightIndex';
import type { DirectPlayableItem } from '../../types/player';
import { getAllVersionsByTmdb } from '../../utils/lightIndexHelpers';
import { selectBestSourceIndex } from '../../utils/sourceLanguageSelector';
import { getAppLanguage } from '../../utils/tmdbLanguage';
import { getMovieDetail } from '../../services/detailFetcher';
import { findCatalogTitle } from '../../utils/catalogTitleMatch';
import type { LatestBackdrop } from '../../hooks/useLatestBackdrops';

interface DashboardHeroProps {
  heroMovies: HeroMovie[];
  loading: boolean;
  lightIndexes?: LightIndexes;
  play: (item: DirectPlayableItem) => void | Promise<void>;
  navigateById: (type: 'movie' | 'series', id: number | string, tmdbId?: number) => void;
  handleWatchlistToggle: (streamId: number, tmdbId: number, type: 'movie' | 'series') => unknown;
  /** Accueil caché (fiche ou lecture par-dessus) : rotation arrêtée. */
  paused?: boolean;
  /** Réglages du DevPanel (forçages de la bannière). */
  forceFading?: boolean;
  forceEmpty?: boolean;
  forceNoLogo?: boolean;
}

/**
 * Bannière de l'accueil avec sa rotation. La rotation (un film toutes les 18 s, deux changements
 * d'état par film) vit ici et non dans DashboardPage : sinon chaque changement redessinait tout
 * l'accueil, rangées et cartes comprises, ce qui fait saccader le Chromecast.
 */
const DashboardHero: React.FC<DashboardHeroProps> = ({
  heroMovies,
  loading,
  lightIndexes,
  play,
  navigateById,
  handleWatchlistToggle,
  paused = false,
  forceFading = false,
  forceEmpty = false,
  forceNoLogo = false,
}) => {
  const { heroIndex, isFading: rawIsFading, handleDotClick, setHeld } = useHeroRotation(heroMovies, paused);
  const isFading = forceFading || rawIsFading;

  const rawHeroMovie = forceEmpty ? null : (heroMovies.length > 0 ? heroMovies[heroIndex] : null);
  const heroMovie = rawHeroMovie && forceNoLogo
    ? { ...rawHeroMovie, logoUrl: undefined }
    : rawHeroMovie;

  const playHeroMovie = async () => {
    if (!heroMovie) return;
    // 1. Multi-sources : chercher la meilleure par langue
    let bestStreamId = Number(heroMovie.id);
    if (lightIndexes && heroMovie.tmdbId && heroMovie.tmdbId > 0) {
      const versions = getAllVersionsByTmdb(lightIndexes, heroMovie.tmdbId, 'movie');
      if (versions.length > 1) {
        const bestIndex = selectBestSourceIndex(
          versions.map(v => v.name),
          getAppLanguage(),
        );
        bestStreamId = versions[bestIndex]?.id ?? bestStreamId;
      }
    }

    // 2. Charger le film complet (pour container_extension)
    const movie = await getMovieDetail(bestStreamId);
    if (movie) {
      void play(movie as DirectPlayableItem);
    } else {
      // Fallback : ouvrir la page détail
      navigateById('movie', heroMovie.id, heroMovie.tmdbId);
    }
  };

  // Welcome slideshow: a slide can be played when its title is in the user's catalogue
  const welcomeMatch = (slide: LatestBackdrop) =>
    lightIndexes ? findCatalogTitle(lightIndexes, slide.title, slide.kind, slide.year) : null;
  const playWelcomeTitle = async (slide: LatestBackdrop) => {
    const match = welcomeMatch(slide);
    if (!match) return;
    if (match.type === 'series') {
      // A series needs an episode: its page lists them
      navigateById('series', match.id, match.tmdbId);
      return;
    }
    const movie = await getMovieDetail(match.id);
    if (movie) void play(movie as DirectPlayableItem);
    else navigateById('movie', match.id, match.tmdbId);
  };

  return (
    <HeroBanner
      welcomeIsAvailable={(slide) => welcomeMatch(slide) !== null}
      onWelcomePlay={(slide) => { void playWelcomeTitle(slide); }}
      movie={heroMovie}
      loading={loading}
      isFading={isFading}
      totalSlides={heroMovies.length}
      currentIndex={heroIndex}
      onDotClick={handleDotClick}
      onHoldChange={setHeld}
      onPlay={() => { void playHeroMovie(); }}
      onInfo={() => {
        if (heroMovie) {
          navigateById('movie', heroMovie.id, heroMovie.tmdbId);
        }
      }}
      onToggleWatchlist={() => {
        if (heroMovie) {
          const tmdbId = heroMovie.tmdbId || 0;
          const streamId = Number(heroMovie.id);
          handleWatchlistToggle(streamId, tmdbId, 'movie');
        }
      }}
    />
  );
};

export default DashboardHero;
