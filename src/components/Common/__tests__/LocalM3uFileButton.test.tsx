/**
 * « Ouvrir un fichier M3U de l'appareil » : proposé sur l'ordinateur et le téléphone, absent sur la
 * TV ; le fichier choisi devient la source, et un échec de copie s'affiche au lieu de se perdre.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const platform = vi.hoisted(() => ({ tv: false, android: false }));
const copy = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../utils/platform', () => ({ isTv: () => platform.tv, isAndroid: () => platform.android }));
vi.mock('../../../services/sources/m3uLocalFile', async (original) => ({
    ...(await original<typeof import('../../../services/sources/m3uLocalFile')>()),
    importLocalM3uFile: copy.run,
}));

import LocalM3uFileButton from '../LocalM3uFileButton';
import { LocalM3uFileError } from '../../../services/sources/m3uLocalFile';

const creds = { host: 'm3u:file/liste.m3u', username: '', password: '', m3u: { url: 'nyx-file://x/liste.m3u' } };

beforeEach(() => {
    platform.tv = false;
    platform.android = false;
    copy.run.mockReset();
});

function choose(input: HTMLElement) {
    fireEvent.change(input, { target: { files: [new File(['#EXTM3U\n'], 'liste.m3u')] } });
}

describe('LocalM3uFileButton', () => {
    it('absent sur la TV', () => {
        platform.tv = true;
        const { queryByTestId } = render(<LocalM3uFileButton testId="f" onImported={vi.fn()} onError={vi.fn()} />);
        expect(queryByTestId('f')).toBeNull();
        expect(queryByTestId('f-input')).toBeNull();
    });

    it('le fichier choisi devient la source', async () => {
        copy.run.mockResolvedValue(creds);
        const onImported = vi.fn();
        const onError = vi.fn();
        const { getByTestId } = render(<LocalM3uFileButton testId="f" onImported={onImported} onError={onError} />);
        expect(getByTestId('f-input').getAttribute('accept')).toContain('.m3u');
        choose(getByTestId('f-input'));
        await waitFor(() => expect(onImported).toHaveBeenCalledWith(creds));
        expect(onError).toHaveBeenLastCalledWith(null);
    });

    it('échec de la copie : le message est affiché', async () => {
        copy.run.mockRejectedValue(new LocalM3uFileError('too_large'));
        const onImported = vi.fn();
        const onError = vi.fn();
        const { getByTestId } = render(<LocalM3uFileButton testId="f" onImported={onImported} onError={onError} />);
        choose(getByTestId('f-input'));
        await waitFor(() => expect(onError).toHaveBeenLastCalledWith('error_m3u_file_too_large'));
        expect(onImported).not.toHaveBeenCalled();
    });

    it('Android : tous les fichiers proposés (le type d\'un .m3u n\'y est pas toujours reconnu)', () => {
        platform.android = true;
        const { getByTestId } = render(<LocalM3uFileButton testId="f" onImported={vi.fn()} onError={vi.fn()} />);
        expect(getByTestId('f-input').hasAttribute('accept')).toBe(false);
    });
});
