/**
 * Saisie d'une source « liste M3U » : adresse obligatoire en http(s), guide facultatif, longueur
 * bornée par le coffre de l'ordinateur ; la partie secrète rendue est prête pour le registre.
 * Adresses d'exemple uniquement, aucun appel réseau.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { M3uSourceSecret } from '../../../types/iptvSource';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'fr' } }),
    initReactI18next: { type: '3rdParty', init: () => {} },
}));
const platform = vi.hoisted(() => ({ android: false }));
vi.mock('../../../utils/platform', () => ({ isAndroid: () => platform.android }));

import M3uSourceForm, { validateM3uSourceInput } from '../M3uSourceForm';

describe('validateM3uSourceInput', () => {
    it('adresse de liste seule : partie secrète M3U, espaces du copier-coller retirés', () => {
        expect(validateM3uSourceInput({ url: '  https://tv.example/liste.m3u8?token=abc \n' }))
            .toEqual({ secret: { kind: 'm3u', url: 'https://tv.example/liste.m3u8?token=abc' } });
    });

    it('avec un guide : gardé dans la partie secrète', () => {
        expect(validateM3uSourceInput({ url: 'http://192.0.2.10:9191/output/m3u', epgUrl: 'http://192.0.2.10:9191/output/epg' }))
            .toEqual({ secret: { kind: 'm3u', url: 'http://192.0.2.10:9191/output/m3u', epgUrl: 'http://192.0.2.10:9191/output/epg' } });
    });

    it('adresse absente, autre protocole ou mal formée : refusée', () => {
        expect(validateM3uSourceInput({ url: '   ' })).toEqual({ error: 'missing_url' });
        for (const url of ['file:///home/liste.m3u', 'rtsp://tv.example/flux', 'tv.example/liste.m3u', 'http://', 'http://tv.example/a b.m3u', 'http:/tv.example/l.m3u', 'https:tv.example/l.m3u']) {
            expect(validateM3uSourceInput({ url })).toEqual({ error: 'invalid_url' });
        }
    });

    it('majuscules, IPv6 et lien get.php d\'un fournisseur Xtream : acceptés', () => {
        expect(validateM3uSourceInput({ url: 'HTTPS://tv.example/l.m3u' })).toEqual({ secret: { kind: 'm3u', url: 'HTTPS://tv.example/l.m3u' } });
        expect(validateM3uSourceInput({ url: 'http://[2001:db8::1]:8080/l.m3u' })).toEqual({ secret: { kind: 'm3u', url: 'http://[2001:db8::1]:8080/l.m3u' } });
        const getPhp = 'http://tv.example:8080/get.php?username=u&password=p&type=m3u_plus';
        expect(validateM3uSourceInput({ url: getPhp })).toEqual({ secret: { kind: 'm3u', url: getPhp } });
    });

    it('guide mal formé : refusé', () => {
        expect(validateM3uSourceInput({ url: 'https://tv.example/l.m3u', epgUrl: 'guide.xml' })).toEqual({ error: 'invalid_epg_url' });
    });

    it('trop long pour le coffre de l\'ordinateur : refusé avant l\'enregistrement', () => {
        expect(validateM3uSourceInput({ url: `https://tv.example/${'a'.repeat(1300)}` })).toEqual({ error: 'too_long' });
    });

    it('Android (pas de plafond dans son coffre) : une longue adresse est acceptée', () => {
        platform.android = true;
        try {
            expect(validateM3uSourceInput({ url: `https://tv.example/${'a'.repeat(1300)}` })).toHaveProperty('secret');
        } finally {
            platform.android = false;
        }
    });
});

describe('M3uSourceForm', () => {
    let onSubmit: Mock<(secret: M3uSourceSecret) => void>;
    let onCancel: Mock<() => void>;
    beforeEach(() => {
        onSubmit = vi.fn();
        onCancel = vi.fn();
    });

    it('enregistrer : la partie secrète validée est rendue à l\'écran parent', () => {
        render(<M3uSourceForm onSubmit={onSubmit} onCancel={onCancel} />);
        fireEvent.change(screen.getByTestId('settings-m3u-source-url'), { target: { value: 'https://tv.example/l.m3u' } });
        fireEvent.change(screen.getByTestId('settings-m3u-source-epg'), { target: { value: 'https://tv.example/guide.xml' } });
        fireEvent.click(screen.getByTestId('settings-m3u-source-save'));
        expect(onSubmit).toHaveBeenCalledWith({ kind: 'm3u', url: 'https://tv.example/l.m3u', epgUrl: 'https://tv.example/guide.xml' });
        expect(screen.queryByTestId('settings-m3u-source-error')).toBeNull();
    });

    it('saisie invalide : message affiché, rien n\'est rendu', () => {
        render(<M3uSourceForm onSubmit={onSubmit} onCancel={onCancel} />);
        fireEvent.click(screen.getByTestId('settings-m3u-source-save'));
        expect(screen.getByTestId('settings-m3u-source-error').textContent).toBe('m3u_source_error_missing_url');
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('erreur d\'enregistrement du parent affichée ; boutons coupés pendant l\'enregistrement', () => {
        render(<M3uSourceForm onSubmit={onSubmit} onCancel={onCancel} isSaving saveError="Coffre indisponible" />);
        expect(screen.getByTestId('settings-m3u-source-error').textContent).toBe('Coffre indisponible');
        expect((screen.getByTestId('settings-m3u-source-save') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId('settings-m3u-source-cancel') as HTMLButtonElement).disabled).toBe(true);
    });

    it('annuler', () => {
        render(<M3uSourceForm onSubmit={onSubmit} onCancel={onCancel} />);
        fireEvent.click(screen.getByTestId('settings-m3u-source-cancel'));
        expect(onCancel).toHaveBeenCalled();
    });
});
