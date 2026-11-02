// Contrôle des PR du dépôt public : refuse tout ce qui n'a rien à faire dans un dépôt ouvert à tous.
//   - un fichier interne ou sensible (liste : scripts/public/interdits.txt) ;
//   - un secret (clé privée, jeton, clé de signature, adresse d'abonnement IPTV avec identifiants) ;
//   - un lien vers un document de travail privé.
// Les identifiants internes de travail et les adresses d'abonnement d'exemple donnent un avertissement seulement.
//
// Usage : node garde-depot-public.mjs --base <commit> --tete <commit>   (ce que la PR ajoute)
//         node garde-depot-public.mjs --arbre <dossier>                 (tout le contenu d'un dossier)
// Code de sortie : 0 = rien à signaler (avertissements possibles), 1 = bloquant, 2 = mauvais appel.
//
// Le workflow qui l'appelle (.github/workflows/garde-depot-public.yml) lit la PR sans jamais en
// exécuter le code : seul ce fichier, tel qu'il est sur `main`, s'exécute.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ici = path.dirname(fileURLToPath(import.meta.url));

/** Convertit un motif simple : une étoile = un niveau, deux étoiles = plusieurs niveaux (suivies d'une barre : dossiers facultatifs). */
export function globVersRegex(g) {
  const re = g
    .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0000/g, '.*');
  return new RegExp('^' + re + '$', 'i');
}

/** Lit une liste de règles : lignes vides et « # » ignorées, « ! » = à garder. */
export function lireRegles(texte) {
  return texte
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.startsWith('!') ? { garder: true, re: globVersRegex(l.slice(1)) } : { garder: false, re: globVersRegex(l) }));
}

export function chargerInterdits(fichier = path.join(ici, 'interdits.txt')) {
  return lireRegles(fs.readFileSync(fichier, 'utf8'));
}

/** Un chemin est interdit si la dernière règle qui lui correspond est un retrait. */
export function estInterdit(chemin, regles) {
  let interdit = false;
  for (const r of regles) if (r.re.test(chemin)) interdit = !r.garder;
  return interdit;
}

// Secrets : motifs précis, pour ne pas bloquer à tort. Une ligne portant « gitleaks:allow » est admise
// (la clé « publishable » de Supabase, publique par nature) ; le jeton d'exemple de jwt.io aussi.
const jetonExemple = /eyJhbGciOiJIUzI1NiJ9\.eyJzdWIiOiIxMjM0NTY3ODkwIn0\./;
export const SECRETS = [
  ['clé privée', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY/],
  ['clé de signature des mises à jour', /untrusted comment: (?:minisign|rsign) (?:encrypted )?secret key/i],
  ['clé de signature en clair', /TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?\s*[=:]\s*['"]?[A-Za-z0-9+/=]{24,}/],
  ['clé secrète Supabase', /\bsb_secret_[A-Za-z0-9_-]{16,}/],
  ['jeton GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/],
  ['clé AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['jeton Slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['clé d\'API Stripe', /\b[sr]k_live_[A-Za-z0-9]{16,}/],
];
// Un jeton JWT n'est refusé que s'il porte le rôle « service_role » (clé d'administration Supabase) ;
// les autres (clé publique « anon », jetons d'exemple des tests) donnent un avertissement.
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;
function roleServiceDuJwt(ligne) {
  for (const m of ligne.matchAll(JWT)) {
    try {
      if (Buffer.from(m[1], 'base64url').toString('utf8').includes('service_role')) return true;
    } catch { /* jeton illisible : traité comme un jeton ordinaire */ }
  }
  return false;
}
// Écrits en morceaux pour que ce fichier ne se signale pas lui-même.
export const LIENS_PRIVES = [
  ['lien vers un document de travail privé', new RegExp(['/mnt/project' + '-files', 'claude\\.ai/(?:artifact|code)\\b', '\\bcm' + 'sg_[0-9A-Za-z]{10,}'].join('|'))],
];
export const AVERTISSEMENTS = [
  ['identifiant interne de travail', /\b(?:[LDBSINP])-\d{2,3}\b(?<!\bP-256)/],
  ['adresse d\'abonnement IPTV avec identifiants (vérifier qu\'ils sont factices)', /get\.php\?username=[^&\s'"]+&password=[^&\s'"]+/i],
  ['jeton JWT (vérifier qu\'il est factice ou public)', new RegExp(JWT.source)],
];

/** Examine une ligne ajoutée. Rend [{ type: 'bloquant'|'avertissement', raison }]. */
export function examinerLigne(ligne) {
  const trouves = [];
  // « gitleaks:allow » n'exempte aucun motif bloquant : un secret factice se construit en morceaux.
  if (!jetonExemple.test(ligne)) {
    for (const [raison, re] of SECRETS) if (re.test(ligne)) trouves.push({ type: 'bloquant', raison: `secret : ${raison}` });
    if (roleServiceDuJwt(ligne)) trouves.push({ type: 'bloquant', raison: 'secret : jeton Supabase « service_role »' });
  }
  for (const [raison, re] of LIENS_PRIVES) if (re.test(ligne)) trouves.push({ type: 'bloquant', raison });
  for (const [raison, re] of AVERTISSEMENTS) if (re.test(ligne)) trouves.push({ type: 'avertissement', raison });
  return trouves;
}

const binaire = (buf) => buf.subarray(0, 8000).includes(0);

/** Examine un texte entier (fichier). */
export function examinerTexte(fichier, texte) {
  const res = [];
  texte.split('\n').forEach((ligne, i) => {
    for (const t of examinerLigne(ligne)) res.push({ fichier, ligne: i + 1, ...t });
  });
  return res;
}

const EXTENSIONS_BINAIRES_ADMISES = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp4|webm|wav|mp3|ogg)$/i;

/**
 * Ce qu'une PR touche : chaque fichier ajouté ou modifié est lu en entier dans `tete` (objet git, jamais
 * extrait), binaires compris (cherchés comme du texte latin1). Rien ne dépend de l'affichage du diff.
 */
export function lireDiff(depot, base, tete) {
  const git = (...a) => execFileSync('git', ['-C', depot, ...a], { maxBuffer: 1 << 29 });
  const noms = git('diff', '--no-renames', '--name-status', '-z', `${base}...${tete}`).toString('utf8').split('\0').filter(Boolean);
  const fichiers = [];
  const trouvailles = [];
  for (let i = 0; i + 1 < noms.length; i += 2) {
    const statut = noms[i];
    const chemin = noms[i + 1];
    fichiers.push({ statut, chemin });
    if (statut === 'D') continue;
    let buf;
    try {
      buf = git('cat-file', 'blob', `${tete}:${chemin}`);
    } catch {
      trouvailles.push({ fichier: chemin, ligne: 1, type: 'avertissement', raison: 'objet illisible (sous-module ?) : à vérifier à la main' });
      continue;
    }
    if (binaire(buf)) {
      if (statut === 'A' && !EXTENSIONS_BINAIRES_ADMISES.test(chemin)) {
        trouvailles.push({ fichier: chemin, ligne: 1, type: 'avertissement', raison: 'fichier binaire ajouté : vérifier ce qu\'il contient' });
      }
      trouvailles.push(...examinerTexte(chemin, buf.toString('latin1')));
    } else if (chemin !== 'pnpm-lock.yaml' && !chemin.endsWith('Cargo.lock')) {
      trouvailles.push(...examinerTexte(chemin, buf.toString('utf8')));
    }
  }
  return { fichiers, trouvailles };
}

/** Parcourt un dossier (hors .git). */
export function lireArbre(dossier) {
  const fichiers = [];
  const trouvailles = [];
  (function parcourir(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { parcourir(p); continue; }
      if (!e.isFile()) continue;
      const rel = path.relative(dossier, p).split(path.sep).join('/');
      fichiers.push({ statut: 'A', chemin: rel });
      if (rel === 'pnpm-lock.yaml' || rel.endsWith('Cargo.lock')) continue;
      const buf = fs.readFileSync(p);
      if (binaire(buf)) continue;
      trouvailles.push(...examinerTexte(rel, buf.toString('utf8')));
    }
  })(dossier);
  return { fichiers, trouvailles };
}

/** Rapport : { bloquants: [], avertissements: [] }. Un fichier supprimé n'est jamais refusé. */
export function juger({ fichiers, trouvailles }, regles = chargerInterdits()) {
  const bloquants = [];
  const avertissements = [];
  for (const f of fichiers) {
    if (f.statut === 'D') continue;
    if (estInterdit(f.chemin, regles)) bloquants.push({ fichier: f.chemin, ligne: 1, raison: 'fichier interne ou sensible, absent du dépôt public' });
  }
  for (const t of trouvailles) (t.type === 'bloquant' ? bloquants : avertissements).push({ fichier: t.fichier, ligne: t.ligne, raison: t.raison });
  return { bloquants, avertissements };
}

function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []),
  );
  let lecture;
  if (args.arbre) lecture = lireArbre(path.resolve(args.arbre));
  else if (args.base && args.tete) lecture = lireDiff(path.resolve(args.depot ?? '.'), args.base, args.tete);
  else {
    console.error('Usage : garde-depot-public.mjs --base <commit> --tete <commit> | --arbre <dossier>');
    process.exit(2);
  }
  const { bloquants, avertissements } = juger(lecture);
  const annoter = (niveau, r) => console.log(`::${niveau} file=${r.fichier},line=${r.ligne}::${r.raison}`);
  for (const r of avertissements) annoter('warning', r);
  for (const r of bloquants) annoter('error', r);
  console.log(`Fichiers examinés : ${lecture.fichiers.length} ; bloquants : ${bloquants.length} ; avertissements : ${avertissements.length}`);
  if (bloquants.length) {
    console.log('Cette PR contient un fichier interne, un secret ou un lien privé : le retirer (et changer le secret s\'il était réel).');
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
