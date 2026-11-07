/**
 * Liste M3U ouverte depuis un fichier de l'appareil (ordinateur ou téléphone ; pas la TV, sans
 * explorateur de fichiers à la télécommande).
 *
 * Le fichier choisi est recopié par morceaux dans le dossier de l'app (`m3u_local_file.rs`), puis
 * la source garde l'adresse `nyx-file://<numéro>/<nom du fichier>` : la lecture M3U ouvre cette
 * copie au lieu de télécharger, et « Actualiser » la relit telle quelle.
 *
 * Le numéro et l'empreinte du fournisseur viennent du nom du fichier : le même fichier choisi de
 * nouveau remplace sa copie, et le même fichier ouvert sur l'ordinateur et sur le téléphone est le
 * même fournisseur pour la synchronisation (deux listes de même nom aussi : c'est le prix à payer).
 */

import { invoke } from '@tauri-apps/api/core';
import type { XtreamCredentials } from '../../types/iptv';
import { m3uListCredentials } from './m3uListCredentials';
import { LOCAL_M3U_SCHEME } from './m3uLocalAddress';

export { LOCAL_M3U_SCHEME, isLocalM3uUrl, localM3uId, localM3uFileName } from './m3uLocalAddress';

/** Même plafond que le téléchargement d'une liste M3U */
export const MAX_LOCAL_M3U_BYTES = 512 * 1024 * 1024;
/** Morceau envoyé à chaque appel (le texte base64 fait un tiers de plus) */
const CHUNK_BYTES = 2 * 1024 * 1024;
/** Nom de fichier gardé au plus (affichage et empreinte) */
const MAX_NAME_LENGTH = 60;

export type LocalM3uError = 'too_large' | 'empty' | 'copy_failed';

export class LocalM3uFileError extends Error {
    constructor(readonly code: LocalM3uError) {
        super(`local M3U file: ${code}`);
        this.name = 'LocalM3uFileError';
    }
}

/** Nom gardé : sans chemin, ni caractère de contrôle ou invisible (un nom ne se fait pas passer pour un autre), raccourci */
function cleanName(name: string): string {
    const base = (name.split(/[\\/]/).pop() ?? '')
        // eslint-disable-next-line no-control-regex -- retire justement les caractères de contrôle
        .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
        .trim();
    // Coupé par caractères, jamais au milieu d'un emoji (l'adresse ne se formerait pas)
    return Array.from(base || 'liste.m3u').slice(0, MAX_NAME_LENGTH).join('');
}

/**
 * Numéro de la copie, tiré du nom : le même fichier choisi de nouveau remplace sa copie au lieu
 * d'en ajouter une. Même règle que l'empreinte (nom en minuscules).
 */
async function idForName(name: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`m3u-file:${name.toLowerCase()}`));
    return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    // Par paquets : un seul appel avec 2 Mo d'arguments dépasse la pile de certains moteurs
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** Morceau du fichier, lu à part (le fichier n'est jamais entier en mémoire) */
async function readSlice(file: Blob, start: number, end: number): Promise<Uint8Array> {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/**
 * Recopie le fichier choisi dans le dossier de l'app et rend la source de session qui le lit.
 * `onProgress` reçoit la part recopiée (0 à 1).
 */
export async function importLocalM3uFile(
    file: File,
    onProgress?: (done: number) => void,
): Promise<XtreamCredentials> {
    if (file.size === 0) throw new LocalM3uFileError('empty');
    if (file.size > MAX_LOCAL_M3U_BYTES) throw new LocalM3uFileError('too_large');
    const name = cleanName(file.name);
    const id = await idForName(name);
    try {
        for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
            const chunk = await readSlice(file, offset, Math.min(offset + CHUNK_BYTES, file.size));
            await invoke<number>('m3u_file_write', { id, offset, data: toBase64(chunk) });
            onProgress?.(Math.min(1, (offset + chunk.length) / file.size));
        }
        await invoke('m3u_file_finish', { id });
    } catch {
        // La copie terminée du même fichier, s'il y en a une, reste
        // Attendu : un nouveau choix du même fichier juste après ne doit pas voir sa copie effacée
        await invoke('m3u_file_abort', { id }).catch(() => undefined);
        throw new LocalM3uFileError('copy_failed');
    }
    const url = `${LOCAL_M3U_SCHEME}${id}/${encodeURIComponent(name)}`;
    const creds = m3uListCredentials({ kind: 'm3u', url });
    if (!creds) throw new LocalM3uFileError('copy_failed');
    return creds;
}

/** Erreur de lecture d'une liste dont la copie n'est plus là (données de l'app effacées) : la choisir de nouveau */
export function isLocalM3uMissingError(error: unknown): boolean {
    return String(error).includes('local list missing');
}
