/**
 * Accueil TV « Avec mon téléphone » : la TV vérifie le fournisseur reçu auprès de son serveur, puis
 * se connecte elle-même avec le compte ; le fournisseur attend l'écran du fournisseur, et seulement
 * si le compte est accepté. Un fournisseur refusé l'est sur le téléphone, avant toute connexion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { TvLinkPayload } from '../../services/tvLink/tvLinkPayload';
import type { TvLinkAck } from '../../services/tvLink/tvLinkSession';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'fr', changeLanguage: vi.fn() } }),
}));
const signIn = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/SupabaseAuthContext', () => ({ useSupabaseAuth: () => ({ signIn }) }));
const panel = vi.hoisted(() => ({ onPayload: null as ((p: TvLinkPayload) => Promise<TvLinkAck>) | null }));
vi.mock('../../components/TvLink/TvLinkPanel', () => ({
    default: (props: { mode: string; error?: string | null; onPayload: (p: TvLinkPayload) => Promise<TvLinkAck> }) => {
        panel.onPayload = props.onPayload;
        return <div data-testid="tvlink-panel" data-mode={props.mode}>{props.error}</div>;
    },
}));

const server = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock('../../services/xtreamApi', () => ({
    XtreamApiService: class { authenticate = (): Promise<unknown> => server.authenticate(); },
    isCredentialsRejectedError: (e: unknown) => e instanceof Error && e.message === 'Authentication failed',
    isProviderAccountInactiveError: (e: unknown) => e instanceof Error && e.message === 'provider_account_inactive',
}));

const notices = vi.hoisted(() => ({ list: [] as unknown[][] }));
vi.mock('../../utils/appNotice', () => ({ showAppNotice: (...args: unknown[]) => { notices.list.push(args); } }));

import TvLinkAccountPage from '../TvLinkAccountPage';
import { clearPendingTvLinkProvider, takePendingTvLinkProvider } from '../../services/tvLink/pendingProvider';

const provider = { type: 'm3u' as const, link: 'http://l.example/x.m3u' };

describe('TvLinkAccountPage', () => {
    beforeEach(() => { signIn.mockReset(); server.authenticate.mockReset(); clearPendingTvLinkProvider(); notices.list = []; });
    afterEach(() => cleanup());

    it('compte accepté : réponse « ok », le fournisseur attend l\'écran du fournisseur', async () => {
        signIn.mockResolvedValue({ error: null, errorKey: null });
        render(<TvLinkAccountPage onCancel={vi.fn()} />);
        expect(screen.getByTestId('tvlink-panel').getAttribute('data-mode')).toBe('account');
        let ack: TvLinkAck | undefined;
        await act(async () => { ack = await panel.onPayload!({ account: { email: 'a@b.c', password: 'pw' }, provider }); });
        expect(signIn).toHaveBeenCalledWith('a@b.c', 'pw');
        expect(ack).toEqual({ ok: true });
        expect(takePendingTvLinkProvider()).toEqual(provider);
        // Sans validation à la télécommande, la TV dit avec quoi elle s'est connectée (jamais un mot de passe)
        expect(notices.list).toEqual([['tvlink_connected_account_provider', { values: { email: 'a@b.c', host: 'l.example' }, ms: 10_000 }]]);
    });

    it('compte refusé : réponse d\'échec, erreur affichée, fournisseur oublié', async () => {
        signIn.mockResolvedValue({ error: 'x', errorKey: 'auth_error_invalid_credentials' });
        render(<TvLinkAccountPage onCancel={vi.fn()} />);
        let ack: TvLinkAck | undefined;
        await act(async () => { ack = await panel.onPayload!({ account: { email: 'a@b.c', password: 'faux' }, provider }); });
        expect(ack).toEqual({ ok: false, reason: 'account' });
        expect(notices.list).toEqual([]);
        expect(screen.getByTestId('tvlink-panel').textContent).toBe('auth_error_invalid_credentials');
        expect(takePendingTvLinkProvider()).toBeNull();
    });

    it.each([
        [new Error('Authentication failed'), 'provider'],
        [new Error('provider_account_inactive'), 'provider-inactive'],
        [new Error('provider_unreachable: délai dépassé'), 'provider-unreachable'],
    ])('fournisseur Xtream refusé par son serveur : refus précis au téléphone, pas de connexion au compte', async (error, reason) => {
        server.authenticate.mockRejectedValue(error);
        render(<TvLinkAccountPage onCancel={vi.fn()} />);
        let ack: TvLinkAck | undefined;
        await act(async () => {
            ack = await panel.onPayload!({ account: { email: 'a@b.c', password: 'pw' }, provider: { type: 'xtream', host: 'http://s.example', username: 'u', password: 'p' } });
        });
        expect(ack).toEqual({ ok: false, reason });
        expect(signIn).not.toHaveBeenCalled();
        expect(takePendingTvLinkProvider()).toBeNull();
    });

    it('compte seul : pas de vérification de fournisseur', async () => {
        signIn.mockResolvedValue({ error: null, errorKey: null });
        render(<TvLinkAccountPage onCancel={vi.fn()} />);
        await act(async () => { await panel.onPayload!({ account: { email: 'a@b.c', password: 'pw' } }); });
        expect(server.authenticate).not.toHaveBeenCalled();
        expect(signIn).toHaveBeenCalledTimes(1);
    });

    it('Retour pendant la vérification du fournisseur : la TV ne se connecte pas au compte', async () => {
        let answer: (v: unknown) => void = () => {};
        server.authenticate.mockReturnValue(new Promise((r) => { answer = r; }));
        const { unmount } = render(<TvLinkAccountPage onCancel={vi.fn()} />);
        const pending = panel.onPayload!({ account: { email: 'a@b.c', password: 'pw' }, provider: { type: 'xtream', host: 'http://s.example', username: 'u', password: 'p' } });
        await act(async () => { await Promise.resolve(); });
        unmount();
        answer({ user_info: { auth: 1 } });
        await expect(pending).resolves.toEqual({ ok: false, reason: 'closed' });
        expect(signIn).not.toHaveBeenCalled();
        expect(takePendingTvLinkProvider()).toBeNull();
    });
});
