/**
 * TvLinkPanel — Connexion de la TV par QR code (Android TV).
 *
 * La TV affiche un QR code ; le téléphone qui le scanne ouvre nyxplayer.app/tv, où l'on saisit le
 * compte Nyx (écran du compte) et/ou le fournisseur IPTV. Le téléphone chiffre pour cette TV seule et
 * envoie le paquet par la messagerie instantanée de Supabase, sans rien écrire dans la base
 * (services/tvLink). Un code sert une fois et expire au bout de 10 minutes.
 *
 * Ce qui arrive est utilisé aussitôt, sans validation à la télécommande : la TV affiche ce qu'elle
 * utilise (compte, nom du serveur) pendant la connexion. Les refus (mot de passe faux, serveur
 * injoignable) sont renvoyés au téléphone, où on corrige et renvoie.
 *
 * `embedded` : panneau posé à côté du formulaire du fournisseur (pas de titre ni de bouton Retour,
 * le focus et la touche Retour restent à l'écran qui l'accueille).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import NyxButton from '../Common/NyxButton';
import TvLinkQr from './TvLinkQr';
import { startTvLinkSession, TV_LINK_EMBEDDED_TTL_MS, type TvLinkAck, type TvLinkSession } from '../../services/tvLink/tvLinkSession';
import type { TvLinkMode, TvLinkPayload } from '../../services/tvLink/tvLinkPayload';
import { providerDisplayHost } from '../../services/tvLink/tvLinkSummary';
import { useTvPageFocus } from '../../hooks/useTvPageFocus';
import { useBackHandler } from '../../hooks/useBackHandler';
import './TvLinkPanel.css';

interface TvLinkPanelProps {
  mode: TvLinkMode;
  /** Utilise le paquet reçu : connexion au compte, ou ajout du fournisseur. */
  onPayload: (payload: TvLinkPayload) => Promise<TvLinkAck>;
  /** Retour à l'écran précédent (accueil). Sans lui (panneau `embedded`), pas de bouton Retour. */
  onCancel?: () => void;
  /** Panneau à côté d'un formulaire : compact, sans titre, sans prise du focus ni de la touche Retour. */
  embedded?: boolean;
  /** Message d'erreur à afficher (compte refusé, par exemple), traduit par l'appelant. */
  error?: string | null;
}

/** `used` : envoi réussi, code fermé (un code sert une fois) ; un nouveau code permet de renvoyer. */
type PanelState = 'preparing' | 'ready' | 'working' | 'used' | 'expired' | 'network-error';

const TvLinkPanel: React.FC<TvLinkPanelProps> = ({ mode, onPayload, onCancel, error, embedded = false }) => {
  const { t } = useTranslation(['auth', 'common']);
  const [state, setState] = useState<PanelState>('preparing');
  const [url, setUrl] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [received, setReceived] = useState<TvLinkPayload | null>(null);
  const onPayloadRef = useRef(onPayload);
  useEffect(() => {
    onPayloadRef.current = onPayload;
  }, [onPayload]);

  useEffect(() => {
    let cancelled = false;
    /** Code fermé (expiré ou trop d'échecs) : plus rien ne doit réafficher le QR code */
    let ended = false;
    let session: TvLinkSession | null = null;
    let expiry: ReturnType<typeof setTimeout> | null = null;
    /** Un paquet est en cours d'utilisation : à l'expiration, le canal attend sa réponse */
    let working = false;
    void startTvLinkSession({
      mode,
      ...(embedded ? { ttlMs: TV_LINK_EMBEDDED_TTL_MS } : {}),
      onReady: () => { if (!cancelled) setState((s) => (s === 'preparing' ? 'ready' : s)); },
      onError: () => { if (!cancelled) setState('network-error'); },
      onExhausted: () => {
        ended = true;
        if (!cancelled) setState('expired');
      },
      onPayload: async (payload) => {
        if (cancelled || ended) return { ok: false, reason: 'closed' };
        setReceived(payload);
        working = true;
        setState('working');
        let ack: TvLinkAck;
        try {
          ack = await onPayloadRef.current(payload);
        } catch {
          ack = { ok: false, reason: mode === 'account' ? 'account' : 'provider' };
        } finally {
          working = false;
        }
        // Code expiré pendant la connexion : fermé seulement maintenant, la réponse au téléphone part encore
        if (ended) session?.close();
        if (cancelled) return ack;
        setReceived(null);
        // Réussi : le code est fermé. Refusé : le même code resservira, sauf s'il a expiré entre-temps
        setState(ack.ok ? 'used' : ended ? 'expired' : 'ready');
        return ack;
      },
    }).then((s) => {
      if (cancelled) {
        s.close();
        return;
      }
      session = s;
      setUrl(s.url);
      expiry = setTimeout(() => {
        ended = true;
        if (working) return;
        s.close();
        if (!cancelled) setState('expired');
      }, Math.max(0, s.expiresAt - Date.now()));
    }).catch(() => {
      if (!cancelled) setState('network-error');
    });
    return () => {
      cancelled = true;
      if (expiry) clearTimeout(expiry);
      session?.close();
    };
  }, [mode, generation, embedded]);

  const renew = useCallback(() => {
    setState('preparing');
    setUrl(null);
    setReceived(null);
    setGeneration((g) => g + 1);
  }, []);
  // Retour : quitte l'écran du QR code (panneau à côté d'un formulaire : l'écran qui l'accueille décide)
  useBackHandler(!embedded && !!onCancel, () => {
    onCancel?.();
  });

  const rootRef = useRef<HTMLDivElement>(null);
  useTvPageFocus(
    rootRef,
    ['.tvlink__renew', '.tvlink__cancel'],
    !embedded && state !== 'preparing' && state !== 'working',
    `tvlink-${state}`,
  );

  const showQr = url && (state === 'ready' || state === 'working');
  const canRenew = state === 'expired' || state === 'network-error' || state === 'used';

  const steps = (
    <ol className="tvlink__list">
      <li>{t('tvlink_step_scan')}</li>
      <li>{mode === 'account' ? t('tvlink_step_fill_account') : t('tvlink_step_fill_provider')}</li>
      <li>{t('tvlink_step_done')}</li>
    </ol>
  );

  return (
    <div className={embedded ? 'tvlink tvlink--embedded' : 'tvlink'} ref={rootRef} data-testid="tvlink-panel" data-state={state}>
      {embedded ? (
        <p className="tvlink__heading">{t('tvlink_embedded_title')}</p>
      ) : (
        <h1 className="tvlink__title">{mode === 'account' ? t('tvlink_title_account') : t('tvlink_title_provider')}</h1>
      )}

      <div className="tvlink__body">
        <div className="tvlink__code">
          {showQr ? (
            <TvLinkQr value={url} label={t('tvlink_qr_alt')} />
          ) : (
            <div className="tvlink__placeholder" data-testid="tvlink-placeholder">
              <p className="tvlink__status">
                {state === 'used' ? t('tvlink_used')
                  : state === 'expired' ? t('tvlink_expired')
                  : state === 'network-error' ? t('tvlink_network_error')
                    : t('tvlink_preparing')}
              </p>
            </div>
          )}
        </div>

        <div className="tvlink__steps">
          {!embedded && steps}
          {state === 'working' ? (
            <div className="tvlink__working" data-testid="tvlink-working" role="status">
              <p className="tvlink__status">{t('tvlink_working')}</p>
              {received?.account && (
                <p className="tvlink__received" data-testid="tvlink-received-account">
                  {t('tvlink_received_account', { email: received.account.email })}
                </p>
              )}
              {received?.provider && (
                <p className="tvlink__received" data-testid="tvlink-received-provider">
                  {t('tvlink_received_provider', { host: providerDisplayHost(received.provider) })}
                </p>
              )}
            </div>
          ) : (
            <p className="tvlink__privacy">{t('tvlink_privacy')}</p>
          )}
          {error && state !== 'working' && <p className="tvlink__error" role="alert" data-testid="tvlink-error">{error}</p>}

          {(canRenew || (!embedded && onCancel)) && (
            <div className="tvlink__actions" data-nav-row="tvlink-actions">
              {canRenew && (
                <NyxButton data-testid="tvlink-renew" className="tvlink__renew" type="button" variant="primary" size="md" color="blue" onClick={renew}>
                  {t('tvlink_new_code')}
                </NyxButton>
              )}
              {!embedded && onCancel && (
                <NyxButton data-testid="tvlink-cancel" className="tvlink__cancel" type="button" variant="secondary" size="md" color="blue" onClick={onCancel}>
                  {t('tvlink_back')}
                </NyxButton>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TvLinkPanel;
