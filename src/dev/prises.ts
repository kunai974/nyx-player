/**
 * Branchement des outils de test sur les prises de l'appli (services/outilsTest.ts).
 *
 * Importé par la seule porte d'entrée, main.tsx. Chaque branchement est derrière l'indicateur de sa
 * version, évalué à la compilation : dans une version normale, rien n'est branché et les outils
 * disparaissent du bundle.
 */
import { brancherOutilsTest, VERSION_AUDIT } from '../services/outilsTest';
import './prisesBanc';
import { useAuditScreen } from './auditBridge';
import ChannelCardDebug from './ChannelCardDebug';

if (VERSION_AUDIT) brancherOutilsTest({ ecranAudit: useAuditScreen });

if (import.meta.env.DEV) brancherOutilsTest({ pastilleChaine: ChannelCardDebug });
