/**
 * EpisodeCard — remise à zéro de la progression : pas de message de réussite (rafraîchissement du
 * parent) quand la base refuse, barre remise et message d'échec.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EpisodeCard, type EpisodeCardProps } from '../EpisodeCard';
import type { XtreamEpisode } from '../../../types/xtream';

const { clearProgress, showAppNotice } = vi.hoisted(() => ({ clearProgress: vi.fn(), showAppNotice: vi.fn() }));
vi.mock('../../../services/playbackProgressService', () => ({ clearProgress }));
vi.mock('../../../utils/appNotice', () => ({ showAppNotice }));
vi.mock('react-i18next', () => ({
    initReactI18next: { type: '3rdParty', init: () => {} },
    useTranslation: () => ({ t: (key: string) => key }),
}));

const episode = { id: '123', episode_num: 1, title: 'Pilote', container_extension: 'mkv', info: {}, duration: '45' } as unknown as XtreamEpisode;
const props: EpisodeCardProps = {
    episode, episodeNum: 1, imageUrl: 'x.jpg', posterFallback: 'y.jpg', progress: 40, dragStarted: false, onPlay: vi.fn(),
};

describe('EpisodeCard — remise à zéro', () => {
    beforeEach(() => { clearProgress.mockReset(); showAppNotice.mockReset(); });

    it('succès : le parent est prévenu une fois la base mise à jour', async () => {
        clearProgress.mockResolvedValue(undefined);
        const onProgressReset = vi.fn();
        render(<EpisodeCard {...props} onProgressReset={onProgressReset} />);
        fireEvent.click(screen.getByTestId('episode-card-reset'));
        await waitFor(() => expect(onProgressReset).toHaveBeenCalledTimes(1));
        expect(showAppNotice).not.toHaveBeenCalled();
    });

    it('échec : message d\'échec, parent non prévenu, barre de progression remise', async () => {
        clearProgress.mockRejectedValue(new Error('database is locked'));
        const onProgressReset = vi.fn();
        render(<EpisodeCard {...props} onProgressReset={onProgressReset} />);
        fireEvent.click(screen.getByTestId('episode-card-reset'));
        await waitFor(() => expect(showAppNotice).toHaveBeenCalledWith('progress_reset_failed'));
        expect(onProgressReset).not.toHaveBeenCalled();
        expect(screen.getByTestId('episode-card-reset')).toBeInTheDocument();
    });
});
