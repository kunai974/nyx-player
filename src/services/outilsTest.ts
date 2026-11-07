/**
 * Prises des outils de test (dossier src/dev) : banc de tests automatiques, pont d'audit, version de
 * mesure, pastille de diagnostic du guide en développement.
 *
 * Le code de l'appli n'importe jamais src/dev (règle ESLint « no-restricted-imports »). Il lit ici des
 * prises vides, que les outils de test remplissent eux-mêmes au chargement (src/dev/prises.ts), importés
 * par la seule porte d'entrée, main.tsx, et seulement dans leur version. Dans une version normale,
 * chaque lecture d'une prise est derrière un indicateur évalué à la compilation (ci-dessous, ou
 * `import.meta.env.DEV`) : la branche et ce module disparaissent du bundle (vérifié par
 * audit/nyx/banc/verifier-bundle.mjs).
 */
import type { ComponentType } from 'react';

/** Version d'audit (VITE_AUDIT=1) : pont d'audit des émulateurs et du banc. */
export const VERSION_AUDIT = import.meta.env.VITE_AUDIT === '1';
/** Version du banc (VITE_BANC=1, posée avec VITE_AUDIT=1) : verrou « jamais de vrai flux », guide factice. */
export const VERSION_BANC = import.meta.env.VITE_BANC === '1';
/** Version de mesure (VITE_PERF=1) : capteurs et variantes de fluidité. */
export const VERSION_MESURE = import.meta.env.VITE_PERF === '1';

/** Écrans d'avant l'accueil, affichables par l'outil d'audit alors que la session est ouverte. */
export type EcranAudit = 'account' | 'provider';

/** Lecteur simulé du banc : remplace mpv, sans aucune requête vers le flux. */
export interface LecteurSimule {
  commande(name: string, args?: unknown[]): Promise<unknown>;
  ecrire(name: string, value: unknown): Promise<void>;
  lire(name: string): Promise<unknown>;
  observer(noms: ReadonlyArray<string>, rappel: (event: { name: string; data: unknown }) => void): Promise<() => void>;
  ecouterEvenements(rappel: (event: { event: string; [cle: string]: unknown }) => void): Promise<() => void>;
}

/** Verrou « jamais de vrai flux » du lecteur et lecteur simulé, pour les versions du banc. */
export interface PriseBancLecteur {
  /**
   * Arguments d'un `loadfile` : null si la lecture est permise, sinon l'erreur à rendre. Note la
   * tentative pour le pont d'audit, sans jamais écrire l'adresse.
   */
  verrouLecture(args: unknown[] | undefined): Error | null;
  /** Refus sans examen (loadlist, options de fichier, propriété qui ouvrirait une adresse), noté. */
  refuser(): Error;
  /** L'erreur vient-elle du verrou ? */
  estLectureRefusee(e: unknown): boolean;
  /** Absent dans la variante « vrai lecteur » (VITE_BANC_LECTEUR=reel), où mpv lit le faux fournisseur. */
  simule?: LecteurSimule;
}

/** Informations de la pastille de diagnostic d'une carte de chaîne (version de développement). */
export interface ChannelCardDebugInfo {
  name: string;
  m3uId: string | undefined;
  matchedEpgId: string | undefined | null;
  matchMethod: string | undefined | null;
  epgName: string | undefined;
}

export interface PrisesOutilsTest {
  /** Version du banc. Absente : le lecteur refuse tout (mpvApi). */
  bancLecteur?: PriseBancLecteur;
  /** Version du banc : adresse du guide du faux fournisseur, ou null pour la source publique. */
  guideBanc?: (source: { host: string; username: string; password: string } | null) => string | null;
  /**
   * Version du banc : adresse du faux relais TMDB du faux fournisseur qui sert de source, ou null (aucune
   * demande à TMDB : jamais le relais de production).
   */
  relaisTmdbBanc?: (source: { host: string; username: string; password: string } | null) => string | null;
  /** Version d'audit : crochet React de l'écran forcé par l'outil. */
  ecranAudit?: () => EcranAudit | null;
  /** Version de développement : pastille « i » des cartes de chaîne. */
  pastilleChaine?: ComponentType<{ debugInfo: ChannelCardDebugInfo }>;
}

/** Prises remplies par src/dev/prises.ts au chargement ; vides dans une version normale. */
export const prises: PrisesOutilsTest = {};

/**
 * Écran forcé par l'outil d'audit ; toujours null hors de la version d'audit. Crochet React : la prise
 * est branchée avant le premier rendu et ne change plus, l'appel du crochet branché est donc stable.
 */
export function useEcranAudit(): EcranAudit | null {
  return VERSION_AUDIT && prises.ecranAudit ? prises.ecranAudit() : null;
}

/** Appelé seulement par les outils de test (src/dev/prises.ts), avant le premier rendu. */
export function brancherOutilsTest(outils: PrisesOutilsTest): void {
  Object.assign(prises, outils);
}
