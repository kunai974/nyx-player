/**
 * Source IPTV : un abonnement Xtream ou une playlist M3U. Plusieurs sources par espace (compte
 * Supabase ou invité), 5 au plus par appareil. Modèle commun aux chantiers multi-sources, M3U et
 * mode invité (accord du 02/11/2026) :
 * - la partie SECRÈTE (identifiants Xtream, adresse M3U complète, adresse de guide) va au coffre du
 *   système, une entrée par source (services/sources/sourceVault.ts) ;
 * - la partie AFFICHABLE (nom, type, hôte seul, empreinte, ordre) va dans la base perso de l'espace,
 *   table `iptv_sources` (services/sources/sourceRegistry.ts). Jamais de secret dans la base.
 */

export type SourceKind = 'xtream' | 'm3u';

/** Partie secrète d'une source Xtream (mêmes champs que XtreamCredentials, plus le guide externe) */
export interface XtreamSourceSecret {
  kind: 'xtream';
  host: string;
  username: string;
  password: string;
  /** Guide externe (XMLTV) à la place de celui du fournisseur ; peut contenir un jeton */
  epgUrl?: string;
}

/** Partie secrète d'une playlist M3U : l'adresse complète contient souvent un jeton */
export interface M3uSourceSecret {
  kind: 'm3u';
  url: string;
  epgUrl?: string;
}

export type SourceSecret = XtreamSourceSecret | M3uSourceSecret;

/** Source telle que l'affichent les écrans : aucun secret */
export interface SourceSummary {
  /** Identifiant tiré au hasard à la création (uuid), stable, jamais dérivé du compte */
  id: string;
  name: string;
  kind: SourceKind;
  /** Nom d'hôte seul (ni schéma, ni port, ni chemin, ni identifiant) */
  hostLabel: string;
  /** Empreinte commune à tous les appareils (sources/sourceFingerprint.ts) ; rangement du cloud */
  providerHash: string;
  sortOrder: number;
  /** Faux : la source ne sert que de secours, ses titres ne s'affichent pas d'eux-mêmes */
  showInCatalog: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Source complète, en mémoire seulement le temps de s'en servir */
export type IptvSource = SourceSummary & { secret: SourceSecret };
