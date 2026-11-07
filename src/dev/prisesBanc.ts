/**
 * Branchement du banc de tests automatiques (versions VITE_BANC=1) sur les prises de l'appli : verrou
 * « jamais de vrai flux » du lecteur, lecteur simulé, guide factice. Importé par src/dev/prises.ts ;
 * les tests du verrou l'importent aussi, comme le démarrage.
 */
import { brancherOutilsTest, VERSION_BANC } from '../services/outilsTest';
import { adresseGuideBanc, adresseRelaisTmdbBanc, erreurLectureRefusee, estLectureRefusee, natureAdresse, noterTentative } from './bancAdresses';
import * as simule from './lecteurSimule';

if (VERSION_BANC) {
  brancherOutilsTest({
    bancLecteur: {
      verrouLecture(args) {
        const cible = natureAdresse(args?.[0]);
        noterTentative(cible, cible === 'faux', args?.[0]);
        if (cible === 'faux') return null;
        console.warn('[BANC] lecture refusée : adresse hors du faux fournisseur');
        return erreurLectureRefusee();
      },
      refuser() {
        noterTentative('autre', false);
        return erreurLectureRefusee();
      },
      estLectureRefusee,
      // Variante « vrai lecteur » : pas de lecteur simulé, il disparaît de son bundle
      ...(import.meta.env.VITE_BANC_LECTEUR !== 'reel' ? { simule } : {}),
    },
    guideBanc: adresseGuideBanc,
    relaisTmdbBanc: adresseRelaisTmdbBanc,
  });
}
