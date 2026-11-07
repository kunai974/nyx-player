/**
 * Tests pour EpisodeCard.tsx
 *
 * Teste le rendu conditionnel, les fallbacks, et les interactions utilisateur.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EpisodeCard, type EpisodeCardProps } from '../EpisodeCard';
import type { XtreamEpisode } from '../../../types/xtream';

// Mock i18n pour retourner les traductions FR
vi.mock('react-i18next', () => ({
    // Chargé par i18n/config (via preferencesService → carouselConstants → tmdbLanguage)
    initReactI18next: { type: '3rdParty', init: () => {} },
    useTranslation: () => ({
        t: (key: string, options?: { count?: number }) => {
            const translations: Record<string, string> = {
                'episode_label_badge': `Épisode ${options?.count ?? ''}`,
                'no_synopsis': 'Aucun synopsis disponible',
                'play_button': 'Lecture',
                'restart_episode': 'Recommencer l\'épisode',
                'duration_min': 'min',
            };
            return translations[key] || key;
        },
    }),
}));

// Mock épisode minimal
const mockEpisode: XtreamEpisode = {
    id: '123',
    episode_num: 1,
    title: '',
    container_extension: 'mkv',
    info: {
        duration: '45',
        video: { width: 1920, height: 1080 },
        container_extension: 'mkv',
    },
    duration: '45',
};

const defaultProps: EpisodeCardProps = {
    episode: mockEpisode,
    episodeNum: 1,
    imageUrl: 'https://example.com/image.jpg',
    posterFallback: 'https://example.com/fallback.jpg',
    progress: 0,
    dragStarted: false,
    onPlay: vi.fn(),
};

describe('EpisodeCard', () => {
    describe('Rendu de base', () => {
        it('affiche le numéro d\'épisode quand pas de titre', () => {
            render(<EpisodeCard {...defaultProps} />);

            // Sans titre, devrait afficher le badge "Épisode 1"
            expect(screen.getByText('Épisode 1')).toBeInTheDocument();
        });

        it('affiche le bouton Play', () => {
            render(<EpisodeCard {...defaultProps} />);

            expect(screen.getByRole('button', { name: /lecture/i })).toBeInTheDocument();
        });

        it('affiche l\'image avec le bon alt', () => {
            render(<EpisodeCard {...defaultProps} />);

            const img = screen.getByRole('img');
            expect(img).toHaveAttribute('src', 'https://example.com/image.jpg');
            expect(img).toHaveAttribute('alt', 'Épisode 1');
        });
    });

    describe('Avec données TMDB', () => {
        it('affiche le titre TMDB', () => {
            const propsWithTmdb: EpisodeCardProps = {
                ...defaultProps,
                tmdbEpisode: {
                    name: 'Episode Title From TMDB',
                    overview: 'Synopsis détaillé de l\'épisode.',
                    runtime: 52,
                },
            };

            render(<EpisodeCard {...propsWithTmdb} />);

            expect(screen.getByText('Episode Title From TMDB')).toBeInTheDocument();
            expect(screen.getByText('Synopsis détaillé de l\'épisode.')).toBeInTheDocument();
        });

        it('affiche la durée TMDB si fournie', () => {
            const propsWithTmdb: EpisodeCardProps = {
                ...defaultProps,
                tmdbEpisode: {
                    runtime: 52,
                },
            };

            render(<EpisodeCard {...propsWithTmdb} />);

            expect(screen.getByText('52 min')).toBeInTheDocument();
        });
    });



    describe('Progression de lecture', () => {
        it('n\'affiche pas la barre de progression si 0%', () => {
            const { container } = render(<EpisodeCard {...defaultProps} progress={0} />);

            // La barre de progression ne devrait pas exister
            expect(container.querySelector('.episode-progress-bar')).toBeNull();
        });

        it('affiche la barre de progression si > 0%', () => {
            const { container } = render(<EpisodeCard {...defaultProps} progress={50} />);

            const progressBar = container.querySelector('.episode-progress-bar');
            expect(progressBar).not.toBeNull();

            const fill = container.querySelector('.progress-fill') as HTMLElement;
            expect(fill.style.width).toBe('50%');
        });
    });

    describe('Interactions', () => {
        it('appelle onPlay au clic sur le bouton', () => {
            const onPlayMock = vi.fn();
            render(<EpisodeCard {...defaultProps} onPlay={onPlayMock} />);

            fireEvent.click(screen.getByRole('button', { name: /lecture/i }));

            expect(onPlayMock).toHaveBeenCalledWith(mockEpisode);
        });

        it('n\'appelle pas onPlay si dragStarted est true', () => {
            const onPlayMock = vi.fn();
            render(<EpisodeCard {...defaultProps} onPlay={onPlayMock} dragStarted={true} />);

            fireEvent.click(screen.getByRole('button', { name: /lecture/i }));

            expect(onPlayMock).not.toHaveBeenCalled();
        });
    });

    describe('Image fallback', () => {
        it('utilise le posterFallback si l\'image échoue', () => {
            render(<EpisodeCard {...defaultProps} />);

            const img = screen.getByRole('img');

            // Simuler erreur de chargement
            fireEvent.error(img);

            expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.com/fallback.jpg');
        });

        it('sans aucune image qui charge, jamais d\'image cassée : la vignette reste un fond uni', () => {
            render(<EpisodeCard {...defaultProps} />);

            fireEvent.error(screen.getByRole('img'));
            fireEvent.error(screen.getByRole('img'));

            expect(screen.queryByRole('img')).toBeNull();
            expect(screen.getByText('Épisode 1')).toBeInTheDocument();
        });

        it('liste sans image ni affiche (M3U) : aucune balise image vide', () => {
            render(<EpisodeCard {...defaultProps} imageUrl="" posterFallback="" />);

            expect(screen.queryByRole('img')).toBeNull();
            expect(screen.getByText('Épisode 1')).toBeInTheDocument();
        });
    });
});
