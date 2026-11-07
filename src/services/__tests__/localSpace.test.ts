/**
 * Espace local : un compte garde exactement les noms de base et de coffre d'avant, un invité a un
 * espace stable, jamais noté pour la synchro, et une valeur abîmée ne finit jamais dans un nom de fichier.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../nyxDatabase', () => ({ default: { load: vi.fn() } }));
const setKeyringUser = vi.fn();
const resetKeyringUser = vi.fn();
vi.mock('../storage', () => ({
    setKeyringUser: (uid: string) => setKeyringUser(uid),
    resetKeyringUser: () => resetKeyringUser(),
}));
const setCurrentSyncUserId = vi.fn();
vi.mock('../syncService', () => ({ setCurrentSyncUserId: (uid: string | null) => setCurrentSyncUserId(uid) }));

import { getDatabaseFileName, resetDatabaseName } from '../dbCore';
import {
    accountSpace, guestSpace, newSpaceId, readGuestSpaceId, forgetGuestSpaceId, isValidSpaceId, readGuestMode, writeGuestMode,
    openLocalSpace, closeLocalSpace, getOpenLocalSpace, GUEST_SPACE_STORAGE_KEY,
} from '../localSpace';

const UID = '550e8400-e29b-41d4-a716-446655440000';

describe('espace local', () => {
    beforeEach(() => {
        localStorage.clear();
        resetDatabaseName();
        closeLocalSpace();
        vi.clearAllMocks();
    });

    it('un compte garde les noms de base et de coffre d\'avant, au caractère près, et est noté pour la synchro', () => {
        openLocalSpace(accountSpace(UID));
        expect(getDatabaseFileName()).toBe(`nyxplayer_${UID}.db`);
        expect(setKeyringUser).toHaveBeenCalledWith(UID);
        expect(setCurrentSyncUserId).toHaveBeenLastCalledWith(UID);
        expect(getOpenLocalSpace()).toEqual({ kind: 'account', id: UID });
    });

    it('un invité a sa base et sa place du coffre, mais n\'est jamais noté pour la synchro', () => {
        const space = guestSpace();
        openLocalSpace(space);
        expect(getDatabaseFileName()).toBe(`nyxplayer_${space.id}.db`);
        expect(setKeyringUser).toHaveBeenCalledWith(space.id);
        expect(setCurrentSyncUserId).toHaveBeenLastCalledWith(null);
        expect(setCurrentSyncUserId).not.toHaveBeenCalledWith(space.id);
    });

    it('l\'identifiant d\'un invité a la forme acceptée par la partie native et reste le même d\'un lancement à l\'autre', () => {
        const first = guestSpace();
        expect(first.kind).toBe('guest');
        expect(isValidSpaceId(first.id)).toBe(true);
        expect(guestSpace()).toEqual(first);
        expect(readGuestSpaceId()).toBe(first.id);
    });

    it('une valeur abîmée ou modifiée à la main n\'est jamais prise comme identifiant', () => {
        for (const bad of ['../evil', `${UID}.db`, UID.toUpperCase(), '', 'guest']) {
            localStorage.setItem(GUEST_SPACE_STORAGE_KEY, bad);
            expect(readGuestSpaceId()).toBeNull();
            const space = guestSpace();
            expect(space.id).not.toBe(bad);
            expect(isValidSpaceId(space.id)).toBe(true);
        }
    });

    it('refuse d\'ouvrir un espace invité au nom invalide, sans rien préparer', () => {
        expect(() => openLocalSpace({ kind: 'guest', id: '../evil' })).toThrow();
        expect(getDatabaseFileName()).toBeNull();
        expect(setKeyringUser).not.toHaveBeenCalled();
        expect(getOpenLocalSpace()).toBeNull();
    });

    it('oublier l\'espace invité en crée un autre au prochain usage', () => {
        const first = guestSpace();
        forgetGuestSpaceId();
        expect(readGuestSpaceId()).toBeNull();
        expect(guestSpace().id).not.toBe(first.id);
    });

    it('sans stockage disponible, l\'espace invité vaut pour ce lancement, sans erreur', () => {
        const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
        try {
            const space = guestSpace();
            expect(isValidSpaceId(space.id)).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });

    it('sans crypto.randomUUID (WebView ancienne), l\'identifiant créé a toujours la bonne forme', () => {
        const original = crypto.randomUUID;
        Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
        try {
            const ids = new Set(Array.from({ length: 50 }, () => newSpaceId()));
            expect(ids.size).toBe(50);
            for (const id of ids) expect(isValidSpaceId(id)).toBe(true);
        } finally {
            Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
        }
    });

    it('fermer l\'espace remet base, coffre et synchro à l\'état sans personne', () => {
        openLocalSpace(accountSpace(UID));
        closeLocalSpace();
        expect(getDatabaseFileName()).toBeNull();
        expect(resetKeyringUser).toHaveBeenCalled();
        expect(setCurrentSyncUserId).toHaveBeenLastCalledWith(null);
        expect(getOpenLocalSpace()).toBeNull();
    });
});

describe('espace local et partie native', () => {
    it('la forme d\'identifiant est celle que la partie native accepte pour la base et le coffre', async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
        const dbRule = readFileSync(resolve(process.cwd(), 'src-tauri/src/storage.rs'), 'utf8');
        const vaultRule = readFileSync(resolve(process.cwd(), 'src-tauri/src/secret_vault.rs'), 'utf8');
        expect(dbRule).toContain(`^nyxplayer_${uuid}\\.db$`);
        // Le motif du coffre est écrit avec une constante UUID (entrées des sources, sources/sourceVault.ts)
        expect(vaultRule).toContain(`const UUID: &str = "${uuid}";`);
        expect(vaultRule).toContain('r"^(?:iptv_credentials(?:_{UUID})?|iptv_source_{UUID}_{UUID})$"');
        const space = guestSpace();
        expect(new RegExp(`^nyxplayer_${uuid}\\.db$`).test(`nyxplayer_${space.id}.db`)).toBe(true);
        expect(new RegExp(`^iptv_credentials(?:_${uuid})?$`).test(`iptv_credentials_${space.id}`)).toBe(true);
    });
});

describe('choix « sans compte » de l\'appareil', () => {
    beforeEach(() => { localStorage.clear(); });

    it('absent par défaut, retenu puis oublié', () => {
        expect(readGuestMode()).toBe(false);
        writeGuestMode(true);
        expect(readGuestMode()).toBe(true);
        writeGuestMode(false);
        expect(readGuestMode()).toBe(false);
    });

    it('oublier l\'espace invité oublie aussi le choix (sinon l\'app rouvrirait un espace vide)', () => {
        guestSpace();
        writeGuestMode(true);
        forgetGuestSpaceId();
        expect(readGuestSpaceId()).toBeNull();
        expect(readGuestMode()).toBe(false);
    });
});
