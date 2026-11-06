import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLatestBackdrops, type LatestBackdrop } from '../../hooks/useLatestBackdrops';

const SLIDE_MS = 3000;
/** More dots than this would crowd the banner: the dots then show a window around the current slide */
const MAX_DOTS = 8;

interface WelcomeSlideshowProps {
  /** Is this title in the user's catalogue? Only then is the Play button shown. */
  isAvailable?: (slide: LatestBackdrop) => boolean;
  /** Plays the title (a TV show opens its page) */
  onPlayTitle?: (slide: LatestBackdrop) => void;
}

/** Latest movies and TV shows, crossfading behind the welcome text: title, Play, dots to jump, play/pause */
const WelcomeSlideshow: React.FC<WelcomeSlideshowProps> = ({ isAvailable, onPlayTitle }) => {
  const { t } = useTranslation('dashboard');
  const slides = useLatestBackdrops(true);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);

  // `index` in the deps restarts the 3 s countdown after a click on a dot
  useEffect(() => {
    if (!playing || slides.length < 2) return;
    const timer = setTimeout(() => setIndex((i) => (i + 1) % slides.length), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [playing, slides.length, index]);

  if (slides.length === 0) return null;
  const current = index % slides.length;
  const next = (current + 1) % slides.length;

  // Dots: all of them, or a window of MAX_DOTS around the current slide
  const start = slides.length <= MAX_DOTS ? 0 : Math.min(Math.max(current - Math.floor(MAX_DOTS / 2), 0), slides.length - MAX_DOTS);
  const dots = slides.slice(start, start + Math.min(MAX_DOTS, slides.length)).map((slide, k) => ({ slide, i: start + k }));

  return (
    <div className="welcome-slideshow" data-testid="welcome-slideshow">
      {slides.map((slide, i) => (
        <div
          key={slide.url}
          aria-hidden="true"
          className={`welcome-slide ${i === current ? 'welcome-slide--active' : ''}`}
          // Only the current and the next picture are requested
          style={i === current || i === next ? { backgroundImage: `url(${slide.url})` } : undefined}
        />
      ))}
      <div className="welcome-slide-info">
      <p key={current} className="welcome-slide-title" data-testid="welcome-slide-title">{slides[current].title}</p>

      {onPlayTitle && isAvailable?.(slides[current]) && (
        <button
          type="button"
          key={`play-${current}`}
          className="welcome-slide-play"
          data-testid="welcome-slide-play"
          onClick={() => onPlayTitle(slides[current])}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          {t('slideshow_watch')}
        </button>
      )}

      <div className="welcome-slide-controls">
        <button
          type="button"
          className="welcome-slide-toggle"
          data-testid="welcome-slide-toggle"
          aria-label={playing ? t('slideshow_pause') : t('slideshow_play')}
          data-tip={playing ? t('slideshow_pause') : t('slideshow_play')}
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? (
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>
        <div className="welcome-slide-dots" role="tablist" aria-label={t('slideshow_label')}>
          {dots.map(({ slide, i }) => (
            <button
              key={slide.url}
              type="button"
              role="tab"
              aria-selected={i === current}
              aria-label={slide.title}
              className={`welcome-slide-dot ${i === current ? 'welcome-slide-dot--active' : ''}`}
              data-testid="welcome-slide-dot"
              onClick={() => setIndex(i)}
            >
              {/* Fills over 3 s on the current dot: how far along the slide is (paused: stays full) */}
              {i === current && <span key={`${current}-${playing}`} className={`welcome-slide-dot__fill ${playing ? 'welcome-slide-dot__fill--running' : ''}`} />}
            </button>
          ))}
        </div>
      </div>
      </div>
    </div>
  );
};

export default WelcomeSlideshow;
