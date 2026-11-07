/**
 * Vérification d'une adresse de liste M3U saisie (et de son guide facultatif), sans réseau : la
 * liste n'est téléchargée qu'une fois la source enregistrée, par le chargement natif (seules les
 * adresses http et https y sont acceptées). Sert au formulaire M3U et à l'onglet M3U de la connexion.
 */

import type { M3uSourceSecret } from '../../types/iptvSource';
import { serializeSourceSecret, MAX_DESKTOP_ENTRY_LENGTH } from './sourceSecret';
import { isAndroid } from '../../utils/platform';

export type M3uSourceInputError = 'missing_url' | 'invalid_url' | 'invalid_epg_url' | 'too_long';

/** Adresse http(s) avec un hôte, sans espace ni caractère de contrôle */
function isHttpAddress(value: string): boolean {
    // eslint-disable-next-line no-control-regex -- refuse justement les caractères de contrôle
    if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
    // Même forme que celle exigée par le chargement natif (« http:/hôte » passerait sinon ici)
    if (!/^https?:\/\//i.test(value)) return false;
    try {
        const parsed = new URL(value);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
    } catch {
        return false;
    }
}

/**
 * Vérifie la saisie et rend la partie secrète de la source, ou le code de l'erreur à afficher.
 * Les espaces autour des adresses (copier-coller) sont retirés.
 */
export function validateM3uSourceInput(input: { url: string; epgUrl?: string }):
    { secret: M3uSourceSecret } | { error: M3uSourceInputError } {
    const url = input.url.trim();
    const epgUrl = input.epgUrl?.trim() ?? '';
    if (url === '') return { error: 'missing_url' };
    if (!isHttpAddress(url)) return { error: 'invalid_url' };
    if (epgUrl !== '' && !isHttpAddress(epgUrl)) return { error: 'invalid_epg_url' };
    const secret: M3uSourceSecret = { kind: 'm3u', url, ...(epgUrl ? { epgUrl } : {}) };
    // Même plafond que le coffre de l'ordinateur (Android n'en a pas) : refusé ici avec un message
    // clair plutôt qu'à l'enregistrement
    if (!isAndroid() && serializeSourceSecret(secret).length > MAX_DESKTOP_ENTRY_LENGTH) return { error: 'too_long' };
    return { secret };
}
