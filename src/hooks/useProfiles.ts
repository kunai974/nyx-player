/**
 * useProfiles — Profils du compte Nyx (écran « Qui regarde ? »), sortis d'App.tsx.
 *
 * Charge les profils une fois le compte connecté, retient le profil choisi et s'il l'a été,
 * gère l'erreur réseau et le renommage. Le comportement est celui qu'avait App.tsx.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadProfiles, needsActiveProfileUpdate, setActiveProfile as setActiveProfileSupabase } from '../services/profileService';
import type { UserProfile } from '../services/profileService';
import { createLogger } from '../utils/logger';

const log = createLogger('App');

interface UseProfilesParams {
  /** Compte Supabase connecté (undefined : pas de compte) */
  userId: string | undefined;
  /** Session IPTV ouverte : les profils ne sont (re)chargés que tant qu'elle ne l'est pas */
  isLoggedIn: boolean;
  /** Session IPTV sauvegardée : reprise automatique après le choix du profil */
  hasSavedSession: boolean;
  /** Sélection du profil côté session (SessionContext) */
  selectSessionProfile: (profileId: string) => Promise<void>;
  resumeSession: () => Promise<void>;
  /** Sans compte (espace invité) : pas de profils, l'écran « Qui regarde ? » est sauté */
  guest?: boolean;
  /** Lecture de la session sauvegardée en cours : la reprise d'un invité attend sa fin */
  isCheckingSavedSession?: boolean;
}

export function useProfiles({
  userId,
  isLoggedIn,
  hasSavedSession,
  selectSessionProfile,
  resumeSession,
  guest = false,
  isCheckingSavedSession = false,
}: UseProfilesParams) {
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [profileSelected, setProfileSelected] = useState(false);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [profilesInitialized, setProfilesInitialized] = useState(false);
  // Compte courant : une réponse lente du compte précédent ne doit pas s'afficher chez le suivant.
  const currentUserIdRef = useRef(userId);
  useEffect(() => {
    currentUserIdRef.current = userId;
  }, [userId]);

  // Dérivation du profil actif
  const activeProfile = activeProfileId ? profiles.find(p => p.id === activeProfileId) : undefined;

  // =========================================================================
  // FETCH PROFILES after Supabase auth
  // =========================================================================
  const fetchProfiles = useCallback(async () => {
    if (!userId) return;
    setProfilesLoading(true);
    setProfilesError(null);
    try {
      // Sans réseau : profils gardés sur l'appareil, l'app s'ouvre sur ses données locales
      const { profiles: result } = await loadProfiles(userId);
      if (currentUserIdRef.current !== userId) return;
      setProfiles(result);
    } catch (err) {
      if (currentUserIdRef.current !== userId) return;
      log.error('Failed to fetch profiles:', err);
      setProfilesError((err as Error).message);
    } finally {
      if (currentUserIdRef.current === userId) {
        setProfilesLoading(false);
        setProfilesInitialized(true);
      }
    }
  }, [userId]);

  useEffect(() => {
    if (userId && !isLoggedIn) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement des profils (réseau) : indicateur posé avant l'appel
      void fetchProfiles();
    }
  }, [userId, isLoggedIn, fetchProfiles]);

  // =========================================================================
  // INVITÉ — aucun profil à choisir : l'app s'ouvre sur le fournisseur de l'appareil
  // =========================================================================
  const guestOpenedRef = useRef(false);
  useEffect(() => {
    if (!guest) {
      guestOpenedRef.current = false;
      return;
    }
    if (guestOpenedRef.current || isCheckingSavedSession || isLoggedIn) return;
    guestOpenedRef.current = true;
    if (hasSavedSession) void resumeSession();
  }, [guest, isCheckingSavedSession, isLoggedIn, hasSavedSession, resumeSession]);

  // =========================================================================
  // PROFILE ACTIONS
  // =========================================================================
  const selectProfile = useCallback(async (profileId: string) => {
    if (!userId) return;
    // Marque « profil actif » dans Supabase sans l'attendre : sans réseau, l'ouverture continue.
    // Seulement s'il ne l'est pas déjà : deux écritures inutiles à chaque ouverture sinon
    if (needsActiveProfileUpdate(profiles, profileId)) {
      setActiveProfileSupabase(userId, profileId).catch((err) =>
        log.warn('setActiveProfile failed (non-blocking):', err));
    }
    await selectSessionProfile(profileId);
    setProfileSelected(true);
    setActiveProfileId(profileId);

    // Auto-resume si session sauvegardée
    if (hasSavedSession) {
      await resumeSession();
      // sourceChanged sera détecté par App (bandeau « source changée »)
    }
  }, [userId, profiles, selectSessionProfile, hasSavedSession, resumeSession]);

  // Callback après rename profil — re-fetch les profils pour mettre à jour le nom
  const refreshProfiles = useCallback(async () => {
    if (!userId) return;
    try {
      const { profiles: result } = await loadProfiles(userId);
      setProfiles(result);
    } catch (err) {
      log.error('Failed to refresh profiles after rename:', err);
    }
  }, [userId]);

  /** Après une déconnexion : retour à l'écran des profils, rechargés à la prochaine connexion */
  const resetProfiles = useCallback(() => {
    setProfileSelected(false);
    setProfiles([]);
    setProfilesError(null);
    setProfilesLoading(false);
    setProfilesInitialized(false);
  }, []);

  return {
    profiles,
    profilesLoading,
    profilesError,
    profilesInitialized: guest || profilesInitialized,
    // Invité : le « choix » du profil est fait dès que la session sauvegardée est lue
    profileSelected: guest ? !isCheckingSavedSession : profileSelected,
    setProfileSelected,
    activeProfileId,
    activeProfile,
    fetchProfiles,
    selectProfile,
    refreshProfiles,
    resetProfiles,
  };
}
