/**
 * Connexion de la TV par QR code — canal d'échange avec le téléphone.
 *
 * Le transport est la messagerie instantanée de Supabase (Realtime « broadcast ») : les messages
 * passent d'un appareil à l'autre sans être écrits dans la base. Le canal porte un nom tiré au hasard
 * (128 bits), connu seulement de la TV et du téléphone qui a lu le QR code ; son contenu est chiffré
 * de bout en bout (tvLinkCrypto.ts).
 *
 * - Un code sert une fois : après une réussite, le canal est fermé et la clé privée oubliée.
 * - Sans réussite, il expire après `TV_LINK_TTL_MS`, ou après `TV_LINK_MAX_FAILURES` échecs (un QR
 *   code photographié ne permet pas d'essayer des mots de passe en boucle depuis la TV).
 * - Un paquet valide est utilisé aussitôt, sans validation à la télécommande. Le téléphone en est
 *   prévenu par un message `status` (« la TV se connecte ») : il attend alors plus longtemps la réponse,
 *   le temps de la vérification du fournisseur et de la connexion au compte.
 * - Le téléphone joint à son paquet un numéro d'envoi (`rid`), recopié dans `status` et `ack` : il
 *   ignore les réponses destinées à un autre envoi sur le même canal.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../supabaseClient';
import { generateTvKeys, isTvLinkEnvelope, newChannelId, openEnvelope } from './tvLinkCrypto';
import { tvLinkUrl } from './tvLinkUrl';
import { parseTvLinkPayload, type TvLinkMode, type TvLinkPayload } from './tvLinkPayload';

export const TV_LINK_TTL_MS = 10 * 60 * 1000;
/** Code affiché en permanence à côté du formulaire du fournisseur : plus court, il traîne moins à l'écran */
export const TV_LINK_EMBEDDED_TTL_MS = 5 * 60 * 1000;
export const TV_LINK_MAX_FAILURES = 5;
const CLOSE_DELAY_MS = 2000;

/** Réponse renvoyée au téléphone, pour qu'il affiche « C'est fait » ou ce qui ne va pas. */
export type TvLinkAck =
  | { ok: true }
  | { ok: false; reason: TvLinkFailure };

/**
 * Raison d'un refus, affichée sur le téléphone : c'est là qu'on corrige et qu'on renvoie.
 * `provider` : identifiants refusés par le serveur ; `provider-format` : champs incomplets ou lien
 * illisible ; `provider-unreachable` : serveur injoignable ou en panne ; `provider-inactive` :
 * abonnement expiré ou suspendu.
 */
export type TvLinkFailure =
  | 'unreadable' | 'invalid' | 'account'
  | 'provider' | 'provider-format' | 'provider-unreachable' | 'provider-inactive'
  | 'busy' | 'closed';

export interface TvLinkSession {
  /** Lien à mettre dans le QR code. */
  url: string;
  expiresAt: number;
  close: () => void;
}

export interface TvLinkSessionOptions {
  mode: TvLinkMode;
  /**
   * Appelé une fois par paquet valide, un seul à la fois ; sa réponse est renvoyée au téléphone.
   * Une erreur levée vaut un refus.
   */
  onPayload: (payload: TvLinkPayload) => Promise<TvLinkAck>;
  /** Le canal écoute : le QR code peut s'afficher (un paquet envoyé avant serait perdu). */
  onReady?: () => void;
  /** Le canal n'a pas pu s'ouvrir (pas de réseau, service indisponible). */
  onError?: () => void;
  /** Trop d'échecs : le code est fermé, il faut en afficher un nouveau. */
  onExhausted?: () => void;
  /** Durée de validité du code (`TV_LINK_TTL_MS` par défaut) */
  ttlMs?: number;
  now?: () => number;
}

/** Numéro d'envoi du téléphone, recopié tel quel s'il a la bonne forme. */
function readRid(raw: unknown): string | undefined {
  const rid = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).rid : undefined;
  return typeof rid === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(rid) ? rid : undefined;
}

export function tvLinkTopic(channelId: string): string {
  return `tvlink:${channelId}`;
}

export async function startTvLinkSession(options: TvLinkSessionOptions): Promise<TvLinkSession> {
  const now = options.now ?? Date.now;
  const channelId = newChannelId();
  const letter = options.mode === 'account' ? 'a' : 'p';
  let keys: Awaited<ReturnType<typeof generateTvKeys>> | null = await generateTvKeys();
  const url = tvLinkUrl(channelId, keys.publicKey, options.mode);
  let busy = false;
  let closed = false;
  let failures = 0;

  const channel: RealtimeChannel = supabase.channel(tvLinkTopic(channelId), {
    config: { broadcast: { self: false, ack: false } },
  });

  // Fermeture : plus aucun paquet n'est ouvert et la clé privée est oubliée tout de suite ; le canal
  // lui-même part un peu après, le temps que la dernière réponse au téléphone soit envoyée (l'écran
  // se ferme souvent pendant la connexion, avant cette réponse)
  const close = (): void => {
    if (closed) return;
    closed = true;
    keys = null;
    setTimeout(() => void supabase.removeChannel(channel), CLOSE_DELAY_MS);
  };

  const send = (event: 'ack' | 'status', payload: Record<string, unknown>, rid: string | undefined): void => {
    void channel.send({ type: 'broadcast', event, payload: rid ? { ...payload, rid } : payload });
  };

  const reply = (ack: TvLinkAck, rid: string | undefined): void => {
    send('ack', ack, rid);
    if (ack.ok) {
      close();
      return;
    }
    if (ack.reason === 'busy') return;
    failures += 1;
    if (failures >= TV_LINK_MAX_FAILURES && !closed) {
      close();
      options.onExhausted?.();
    }
  };

  const handle = async (raw: unknown): Promise<void> => {
    const rid = readRid(raw);
    if (closed || !keys) {
      send('ack', { ok: false, reason: 'closed' }, rid);
      return;
    }
    if (busy) {
      reply({ ok: false, reason: 'busy' }, rid);
      return;
    }
    if (!isTvLinkEnvelope(raw)) {
      reply({ ok: false, reason: 'invalid' }, rid);
      return;
    }
    busy = true;
    try {
      let text: string;
      try {
        text = await openEnvelope(keys.privateKey, channelId, letter, raw);
      } catch {
        reply({ ok: false, reason: 'unreadable' }, rid);
        return;
      }
      const payload = parseTvLinkPayload(text, options.mode);
      if (!payload) {
        reply({ ok: false, reason: 'invalid' }, rid);
        return;
      }
      // Le téléphone patiente : la TV vérifie le fournisseur et se connecte
      send('status', { step: 'working' }, rid);
      let ack: TvLinkAck;
      try {
        ack = await options.onPayload(payload);
      } catch {
        ack = { ok: false, reason: options.mode === 'account' ? 'account' : 'provider' };
      }
      reply(ack, rid);
    } finally {
      busy = false;
    }
  };

  channel.on('broadcast', { event: 'seal' }, (message: { payload?: unknown }) => {
    void handle(message.payload);
  });

  channel.subscribe((status) => {
    if (closed) return;
    if (status === 'SUBSCRIBED') options.onReady?.();
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') options.onError?.();
  });

  return { url, expiresAt: now() + (options.ttlMs ?? TV_LINK_TTL_MS), close };
}
