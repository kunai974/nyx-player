/**
 * Ajout du fournisseur sur TV, par QR code : le QR code est à côté du formulaire, sans clic de plus ;
 * un fournisseur reçu est vérifié auprès de son serveur (refus renvoyé au téléphone), puis connecte
 * la TV. Un fournisseur envoyé avec le compte depuis l'accueil remplit le formulaire et connecte.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { TvLinkPayload } from '../../services/tvLink/tvLinkPayload';
import type { TvLinkAck } from '../../services/tvLink/tvLinkSession';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'fr', changeLanguage: vi.fn() } }),
}));
vi.mock('../../contexts/SupabaseAuthContext', () => ({ useSupabaseAuth: () => ({ signOut: vi.fn() }) }));
vi.mock('../../contexts/DevOverrideContext', () => ({
    useDevOverrides: () => ({
        overrides: { xtreamPage: { forceLoading: false, forceProgress: null, forceError: null, forceMode: null } },
    }),
}));
const platform = vi.hoisted(() => ({ tv: true }));
vi.mock('../../utils/platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/platform')>()),
    isTv: () => platform.tv,
}));
const panel = vi.hoisted(() => ({ onPayload: null as ((p: TvLinkPayload) => Promise<TvLinkAck>) | null }));
vi.mock('../TvLink/TvLinkPanel', () => ({
    default: (props: { mode: string; embedded?: boolean; onPayload: (p: TvLinkPayload) => Promise<TvLinkAck> }) => {
        panel.onPayload = props.onPayload;
        return <div data-testid="tvlink-panel" data-mode={props.mode} data-embedded={String(!!props.embedded)} />;
    },
}));
// Serveur du fournisseur : réponse choisie par chaque test
const server = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock('../../services/xtreamApi', () => ({
    XtreamApiService: class { authenticate = (): Promise<unknown> => server.authenticate(); },
    isCredentialsRejectedError: (e: unknown) => e instanceof Error && e.message === 'Authentication failed',
    isProviderAccountInactiveError: () => false,
}));

const notices = vi.hoisted(() => ({ list: [] as unknown[][] }));
vi.mock('../../utils/appNotice', () => ({ showAppNotice: (...args: unknown[]) => { notices.list.push(args); } }));

import Login from '../Login';
import { clearPendingTvLinkProvider, setPendingTvLinkProvider } from '../../services/tvLink/pendingProvider';

describe('Login (TV) — fournisseur saisi sur le téléphone', () => {
    beforeEach(() => {
        platform.tv = true;
        panel.onPayload = null;
        server.authenticate.mockReset();
        notices.list = [];
        clearPendingTvLinkProvider();
    });
    afterEach(() => cleanup());

    it('TV : QR code à côté du formulaire, sans clic de plus ; hors TV, pas de QR code', () => {
        render(<Login onLogin={vi.fn()} isLoading={false} progress={0} />);
        expect(screen.getByTestId('provider-form')).toBeTruthy();
        expect(screen.getByTestId('tvlink-panel').getAttribute('data-mode')).toBe('provider');
        expect(screen.getByTestId('tvlink-panel').getAttribute('data-embedded')).toBe('true');
        cleanup();
        platform.tv = false;
        render(<Login onLogin={vi.fn()} isLoading={false} progress={0} />);
        expect(screen.queryByTestId('tvlink-panel')).toBeNull();
    });

    it('fournisseur reçu et accepté par son serveur : la TV se connecte avec les mêmes identifiants que le formulaire', async () => {
        server.authenticate.mockResolvedValue({ user_info: { auth: 1 } });
        const onLogin = vi.fn();
        render(<Login onLogin={onLogin} isLoading={false} progress={0} />);
        let ack: TvLinkAck | undefined;
        await act(async () => {
            ack = await panel.onPayload!({ provider: { type: 'xtream', host: 'HTTP://Serveur.example:8080/', username: 'u', password: 'p' } });
        });
        expect(ack).toEqual({ ok: true });
        expect(onLogin).toHaveBeenCalledWith({ host: 'http://serveur.example:8080', username: 'u', password: 'p' });
        expect(notices.list).toEqual([['tvlink_connected_provider', { values: { host: 'serveur.example' }, ms: 10_000 }]]);
        // Formulaire rempli : si le chargement échoue ensuite, on corrige sans tout retaper
        expect((screen.getByTestId('provider-url') as HTMLInputElement).value).toBe('HTTP://Serveur.example:8080/');
        expect((screen.getByTestId('provider-username') as HTMLInputElement).value).toBe('u');
    });

    it('identifiants refusés par le serveur : refus renvoyé au téléphone, pas de connexion', async () => {
        server.authenticate.mockRejectedValue(new Error('Authentication failed'));
        const onLogin = vi.fn();
        render(<Login onLogin={onLogin} isLoading={false} progress={0} />);
        let ack: TvLinkAck | undefined;
        await act(async () => {
            ack = await panel.onPayload!({ provider: { type: 'xtream', host: 'http://serveur.example', username: 'u', password: 'faux' } });
        });
        expect(ack).toEqual({ ok: false, reason: 'provider' });
        expect(onLogin).not.toHaveBeenCalled();
    });

    it('fournisseur incomplet : refus « provider-format », le serveur n\'est pas appelé', async () => {
        const onLogin = vi.fn();
        render(<Login onLogin={onLogin} isLoading={false} progress={0} />);
        let ack: TvLinkAck | undefined;
        await act(async () => {
            ack = await panel.onPayload!({ provider: { type: 'xtream', host: 'http://serveur.example', username: 'u', password: '' } });
        });
        expect(ack).toEqual({ ok: false, reason: 'provider-format' });
        expect(server.authenticate).not.toHaveBeenCalled();
        expect(onLogin).not.toHaveBeenCalled();
    });

    it('pendant un chargement : envoi du téléphone refusé « occupé », la connexion en cours continue', async () => {
        const onLogin = vi.fn();
        render(<Login onLogin={onLogin} isLoading={true} progress={10} />);
        let ack: TvLinkAck | undefined;
        await act(async () => {
            ack = await panel.onPayload!({ provider: { type: 'xtream', host: 'http://serveur.example', username: 'u', password: 'p' } });
        });
        expect(ack).toEqual({ ok: false, reason: 'busy' });
        expect(onLogin).not.toHaveBeenCalled();
    });

    it('fournisseur envoyé avec le compte : formulaire rempli même en mode strict de React (initialisation appelée deux fois)', () => {
        setPendingTvLinkProvider({ type: 'm3u', link: 'http://serveur.example/get.php?username=u&password=p&type=m3u_plus' });
        const onLogin = vi.fn();
        render(<React.StrictMode><Login onLogin={onLogin} isLoading={false} progress={0} /></React.StrictMode>);
        expect((screen.getByTestId('provider-m3u-link') as HTMLTextAreaElement).value).toContain('get.php');
        expect(onLogin).toHaveBeenCalledTimes(1);
    });

    it('fournisseur envoyé avec le compte depuis l\'accueil : connexion dès l\'arrivée, une seule fois', () => {
        setPendingTvLinkProvider({ type: 'xtream', host: 'http://serveur.example', username: 'u', password: 'p' });
        const onLogin = vi.fn();
        render(<Login onLogin={onLogin} isLoading={false} progress={0} />);
        expect(onLogin).toHaveBeenCalledTimes(1);
        expect((screen.getByTestId('provider-url') as HTMLInputElement).value).toBe('http://serveur.example');
        cleanup();
        render(<Login onLogin={onLogin} isLoading={false} progress={0} />);
        expect(onLogin).toHaveBeenCalledTimes(1);
    });

    it('fournisseur incomplet envoyé avec le compte : formulaire rempli avec l\'erreur, pas de connexion', () => {
        setPendingTvLinkProvider({ type: 'm3u', link: 'pas un lien' });
        const onLogin = vi.fn();
        render(<Login onLogin={onLogin} isLoading={false} progress={0} />);
        expect(onLogin).not.toHaveBeenCalled();
        expect(screen.getByTestId('provider-error').textContent).toBe('error_m3u_invalid');
        expect((screen.getByTestId('provider-m3u-link') as HTMLTextAreaElement).value).toBe('pas un lien');
    });

    it('écran quitté pendant la vérification du fournisseur : pas de connexion, réponse « fermé »', async () => {
        let answer: (v: unknown) => void = () => {};
        server.authenticate.mockReturnValue(new Promise((r) => { answer = r; }));
        const onLogin = vi.fn();
        const { unmount } = render(<Login onLogin={onLogin} isLoading={false} progress={0} />);
        const pending = panel.onPayload!({ provider: { type: 'xtream', host: 'http://serveur.example', username: 'u', password: 'p' } });
        await act(async () => { await Promise.resolve(); });
        unmount();
        answer({ user_info: { auth: 1 } });
        await expect(pending).resolves.toEqual({ ok: false, reason: 'closed' });
        expect(onLogin).not.toHaveBeenCalled();
    });

    it('chargement lancé pendant la vérification : refus « occupé », pas de seconde connexion', async () => {
        let answer: (v: unknown) => void = () => {};
        server.authenticate.mockReturnValue(new Promise((r) => { answer = r; }));
        const onLogin = vi.fn();
        const { rerender } = render(<Login onLogin={onLogin} isLoading={false} progress={0} />);
        const pending = panel.onPayload!({ provider: { type: 'xtream', host: 'http://serveur.example', username: 'u', password: 'p' } });
        rerender(<Login onLogin={onLogin} isLoading={true} progress={5} />);
        await act(async () => { answer({ user_info: { auth: 1 } }); await pending; });
        await expect(pending).resolves.toEqual({ ok: false, reason: 'busy' });
        expect(onLogin).not.toHaveBeenCalled();
    });
});
