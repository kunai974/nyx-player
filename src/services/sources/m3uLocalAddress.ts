/**
 * Adresse d'une liste M3U recopiée depuis un fichier de l'appareil : `nyx-file://<numéro>/<nom>`
 * (m3uLocalFile.ts). Sans dépendance, comme sourceAddress.ts qui s'en sert pour l'empreinte.
 */

/** Début de l'adresse d'une liste recopiée (même texte que dans `m3u_local_file.rs`) */
export const LOCAL_M3U_SCHEME = 'nyx-file://';

/** Adresse d'une liste recopiée depuis un fichier de l'appareil */
export function isLocalM3uUrl(url: string): boolean {
    return url.slice(0, LOCAL_M3U_SCHEME.length).toLowerCase() === LOCAL_M3U_SCHEME;
}

/** Numéro de la copie (32 chiffres hexadécimaux), ou null si l'adresse n'en porte pas un valide */
export function localM3uId(url: string): string | null {
    if (!isLocalM3uUrl(url)) return null;
    const id = url.slice(LOCAL_M3U_SCHEME.length).split('/')[0];
    return /^[0-9a-f]{32}$/.test(id) ? id : null;
}

/** Nom du fichier d'origine, tel qu'affiché (vide s'il manque ou est illisible) */
export function localM3uFileName(url: string): string {
    if (localM3uId(url) === null) return '';
    const encoded = url.slice(LOCAL_M3U_SCHEME.length).split('/').slice(1).join('/');
    try {
        return decodeURIComponent(encoded);
    } catch {
        return '';
    }
}

/** Texte de l'empreinte d'une liste recopiée : « m3u:file/ » + nom en minuscules (un hôte n'a jamais de « / ») */
export function localM3uFingerprintInput(url: string): string | null {
    if (localM3uId(url) === null) return null;
    return `m3u:file/${localM3uFileName(url).trim().toLowerCase()}`;
}
