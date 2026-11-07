/**
 * Écran du QR code : le code n'apparaît qu'une fois le canal prêt, expire au bout de 10 minutes
 * (« Nouveau code » en tire un neuf), et le canal est fermé quand l'écran se ferme.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'fr', changeLanguage: vi.fn() } }),
}));
vi.mock('../TvLinkPanel.css', () => ({}));

type Opts = { onReady?: () => void; onError?: () => void; onExhausted?: () => void; onPayload: (p: unknown) => Promise<unknown>; ttlMs?: number };
const sessions = vi.hoisted(() => ({ list: [] as { opts: Opts; close: ReturnType<typeof vi.fn> }[] }));
vi.mock('../../../services/tvLink/tvLinkSession', () => ({
    startTvLinkSession: async (opts: Opts) => {
        const close = vi.fn();
        sessions.list.push({ opts, close });
        return { url: `https://nyxplayer.app/tv/#v=1&n=${sessions.list.length}`, expiresAt: Date.now() + (opts.ttlMs ?? 600_000), close };
    },
    TV_LINK_EMBEDDED_TTL_MS: 300_000,
}));

import TvLinkPanel from '../TvLinkPanel';
import { dispatchBack } from '../../../hooks/useBackHandler';

const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); }); };

describe('TvLinkPanel', () => {
    beforeEach(() => { sessions.list = []; });
    afterEach(() => { cleanup(); vi.useRealTimers(); });

    it('QR code montré seulement quand le canal écoute', async () => {
        render(<TvLinkPanel mode="account" onPayload={vi.fn()} onCancel={vi.fn()} />);
        await flush();
        expect(screen.queryByTestId('tvlink-qr')).toBeNull();
        expect(screen.getByTestId('tvlink-placeholder').textContent).toBe('tvlink_preparing');
        act(() => sessions.list[0].opts.onReady?.());
        expect(screen.getByTestId('tvlink-qr')).toBeTruthy();
    });

    it('expire au bout de 10 minutes ; « Nouveau code » ouvre un canal neuf', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        render(<TvLinkPanel mode="provider" onPayload={vi.fn()} onCancel={vi.fn()} />);
        await flush();
        act(() => sessions.list[0].opts.onReady?.());
        act(() => { vi.advanceTimersByTime(600_000); });
        expect(sessions.list[0].close).toHaveBeenCalled();
        expect(screen.queryByTestId('tvlink-qr')).toBeNull();
        expect(screen.getByTestId('tvlink-placeholder').textContent).toBe('tvlink_expired');
        fireEvent.click(screen.getByTestId('tvlink-renew'));
        await flush();
        expect(sessions.list).toHaveLength(2);
        act(() => sessions.list[1].opts.onReady?.());
        expect(screen.getByTestId('tvlink-qr')).toBeTruthy();
    });

    it('sans réseau : message et « Nouveau code »', async () => {
        render(<TvLinkPanel mode="provider" onPayload={vi.fn()} onCancel={vi.fn()} />);
        await flush();
        act(() => sessions.list[0].opts.onError?.());
        expect(screen.getByTestId('tvlink-placeholder').textContent).toBe('tvlink_network_error');
        expect(screen.getByTestId('tvlink-renew')).toBeTruthy();
    });

    it('paquet reçu : utilisé aussitôt, sans validation ; la TV montre ce qu\'elle utilise, sans identifiant', async () => {
        let finish: (v: unknown) => void = () => {};
        const onPayload = vi.fn(() => new Promise((r) => { finish = r; }));
        render(<TvLinkPanel mode="account" onPayload={onPayload as never} onCancel={vi.fn()} error="refusé" />);
        await flush();
        act(() => sessions.list[0].opts.onReady?.());
        let ack: Promise<unknown> = Promise.resolve();
        act(() => { ack = sessions.list[0].opts.onPayload({ account: { email: 'a@b.c', password: 'pw' }, provider: { type: 'm3u', link: 'http://serveur.example/get.php?username=u&password=secret' } }); });
        expect(onPayload).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('tvlink-working')).toBeTruthy();
        expect(screen.getByTestId('tvlink-received-account').textContent).toBe('tvlink_received_account');
        // Le fournisseur est montré par son serveur seul, jamais avec ses identifiants
        expect(screen.getByTestId('tvlink-working').textContent).not.toContain('secret');
        expect(screen.queryByTestId('tvlink-error')).toBeNull();
        await act(async () => { finish({ ok: false, reason: 'account' }); await ack; });
        await expect(ack).resolves.toEqual({ ok: false, reason: 'account' });
        expect(screen.queryByTestId('tvlink-working')).toBeNull();
        expect(screen.getByTestId('tvlink-error').textContent).toBe('refusé');
        expect(screen.getByTestId('tvlink-qr')).toBeTruthy();
    });

    it('envoi réussi : code fermé, « Nouveau code » pour renvoyer', async () => {
        const onPayload = vi.fn().mockResolvedValue({ ok: true });
        render(<TvLinkPanel mode="provider" onPayload={onPayload} embedded />);
        await flush();
        act(() => sessions.list[0].opts.onReady?.());
        await act(async () => { await sessions.list[0].opts.onPayload({ provider: { type: 'm3u', link: 'http://serveur.example/x.m3u' } }); });
        expect(screen.queryByTestId('tvlink-qr')).toBeNull();
        expect(screen.getByTestId('tvlink-placeholder').textContent).toBe('tvlink_used');
        fireEvent.click(screen.getByTestId('tvlink-renew'));
        await flush();
        expect(sessions.list).toHaveLength(2);
    });

    it('code expiré pendant la connexion, puis refus : « code expiré », jamais un QR mort', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        let finish: (v: unknown) => void = () => {};
        const onPayload = vi.fn(() => new Promise((r) => { finish = r; }));
        render(<TvLinkPanel mode="account" onPayload={onPayload as never} onCancel={vi.fn()} />);
        await flush();
        act(() => sessions.list[0].opts.onReady?.());
        let ack: Promise<unknown> = Promise.resolve();
        act(() => { ack = sessions.list[0].opts.onPayload({ account: { email: 'a@b.c', password: 'pw' } }); });
        act(() => { vi.advanceTimersByTime(600_000); });
        // Toujours en train de se connecter : pas d'« expiré » par-dessus, et le canal attend la réponse
        expect(screen.getByTestId('tvlink-working')).toBeTruthy();
        expect(sessions.list[0].close).not.toHaveBeenCalled();
        await act(async () => { finish({ ok: false, reason: 'account' }); await ack; });
        expect(sessions.list[0].close).toHaveBeenCalled();
        expect(screen.queryByTestId('tvlink-qr')).toBeNull();
        expect(screen.getByTestId('tvlink-placeholder').textContent).toBe('tvlink_expired');
    });

    it('à côté d\'un formulaire : ni bouton Retour, ni prise de la touche Retour', async () => {
        render(<TvLinkPanel mode="provider" onPayload={vi.fn()} embedded />);
        await flush();
        act(() => sessions.list[0].opts.onReady?.());
        expect(screen.queryByTestId('tvlink-cancel')).toBeNull();
        let handled = true;
        act(() => { handled = dispatchBack(); });
        expect(handled).toBe(false);
    });

    it('Retour sur le QR code quitte l\'écran', async () => {
        const onCancel = vi.fn();
        render(<TvLinkPanel mode="provider" onPayload={vi.fn()} onCancel={onCancel} />);
        await flush();
        act(() => { dispatchBack(); });
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('trop d\'échecs : code fermé, « Nouveau code »', async () => {
        render(<TvLinkPanel mode="account" onPayload={vi.fn()} onCancel={vi.fn()} />);
        await flush();
        act(() => sessions.list[0].opts.onReady?.());
        act(() => sessions.list[0].opts.onExhausted?.());
        expect(screen.getByTestId('tvlink-placeholder').textContent).toBe('tvlink_expired');
        expect(screen.getByTestId('tvlink-renew')).toBeTruthy();
    });

    it('écran fermé : canal fermé', async () => {
        const { unmount } = render(<TvLinkPanel mode="account" onPayload={vi.fn()} onCancel={vi.fn()} />);
        await flush();
        unmount();
        expect(sessions.list[0].close).toHaveBeenCalled();
    });

    it('à côté du formulaire du fournisseur : code de 5 minutes (affiché en permanence) ; écran du compte : 10 minutes', async () => {
        render(<TvLinkPanel mode="provider" onPayload={vi.fn()} embedded />);
        await flush();
        expect(sessions.list[0].opts.ttlMs).toBe(300_000);
        cleanup();
        render(<TvLinkPanel mode="account" onPayload={vi.fn()} onCancel={vi.fn()} />);
        await flush();
        expect(sessions.list[1].opts.ttlMs).toBeUndefined();
    });
});
