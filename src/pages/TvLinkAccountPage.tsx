/**
 * TvLinkAccountPage — Connexion au compte depuis le téléphone (Android TV, accueil « Avec mon téléphone »).
 *
 * Le téléphone envoie l'e-mail et le mot de passe du compte, et peut-être le fournisseur. La TV vérifie
 * le fournisseur auprès de son serveur, puis se connecte elle-même au compte ; le fournisseur attend en mémoire l'écran du fournisseur, après le
 * choix du profil (services/tvLink/pendingProvider.ts).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import TvLinkPanel from '../components/TvLink/TvLinkPanel';
import { useSupabaseAuth } from '../contexts/SupabaseAuthContext';
import { setPendingTvLinkProvider, clearPendingTvLinkProvider } from '../services/tvLink/pendingProvider';
import type { TvLinkAck } from '../services/tvLink/tvLinkSession';
import { checkTvLinkProvider } from '../services/tvLink/tvLinkProviderCheck';
import { announceTvLinkConnection } from '../services/tvLink/tvLinkSummary';
import type { TvLinkPayload } from '../services/tvLink/tvLinkPayload';

interface TvLinkAccountPageProps {
  onCancel: () => void;
}

const TvLinkAccountPage: React.FC<TvLinkAccountPageProps> = ({ onCancel }) => {
  const { t } = useTranslation(['auth', 'common']);
  const { signIn } = useSupabaseAuth();
  const [error, setError] = useState<string | null>(null);

  // Écran quitté pendant la vérification du fournisseur (Retour) : la TV ne se connecte plus au compte
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const handlePayload = useCallback(async (payload: TvLinkPayload): Promise<TvLinkAck> => {
    if (!payload.account) return { ok: false, reason: 'invalid' };
    setError(null);
    // Fournisseur essayé d'abord : refusé, l'erreur s'affiche sur le téléphone (où on le corrige), et la
    // TV ne se connecte pas au compte pour rien
    if (payload.provider) {
      const check = await checkTvLinkProvider(payload.provider);
      if (!mountedRef.current) return { ok: false, reason: 'closed' };
      if (!check.ok) return { ok: false, reason: check.reason };
      // Posé avant la connexion : la session ouvre aussitôt l'écran des profils, puis celui du fournisseur
      setPendingTvLinkProvider(payload.provider);
    }
    const { errorKey } = await signIn(payload.account.email, payload.account.password);
    if (errorKey) {
      clearPendingTvLinkProvider();
      setError(t(errorKey));
      return { ok: false, reason: 'account' };
    }
    announceTvLinkConnection({ email: payload.account.email, provider: payload.provider });
    return { ok: true };
  }, [signIn, t]);

  return (
    <div className="tvlink-page" data-testid="tvlink-account-page">
      <TvLinkPanel mode="account" onPayload={handlePayload} onCancel={onCancel} error={error} />
    </div>
  );
};

export default TvLinkAccountPage;
