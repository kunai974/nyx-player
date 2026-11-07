/**
 * Version jointe aux envois Sentry (erreurs et retours), pour comparer les versions entre elles.
 * Lue dans package.json à la compilation : seul le champ `version` entre dans le paquet.
 */
import { version } from '../../package.json';

export const SENTRY_RELEASE = `nyx-player@${version}`;
