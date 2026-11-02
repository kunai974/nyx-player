// @vitest-environment node
// Essai complet du script de publication Windows (scripts/windows-release.ps1), lancé pour de vrai
// avec PowerShell dans une copie jetable du dépôt et de faux outils (node pour la vérification de
// mpv.exe, pnpm pour la compilation et la signature). Les tests de publication-sauvegarde.test.mjs
// lisent le texte du script ; ceux-ci vérifient ce qu'il FAIT : chaque refus avant la clé, la clé
// jamais visible de la compilation, la signature vérifiée (clé et version), latest.json écrit sans BOM.
//
// Seulement hors Windows (pwsh) : les faux outils sont des scripts shell, comme dans
// release-apk-paquet.test.mjs. La saisie masquée (Read-Host -AsSecureString) ne lit pas une entrée
// redirigée : une fonction Read-Host la remplace pour l'essai (une fonction passe avant la commande
// de PowerShell), avec la clé et le mot de passe factices donnés par l'environnement.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const depot = fileURLToPath(new URL('../..', import.meta.url));
const script = path.join(depot, 'scripts', 'windows-release.ps1');
const conf = JSON.parse(readFileSync(path.join(depot, 'src-tauri', 'tauri.conf.json'), 'utf8'));

const shell = process.platform === 'win32'
  ? null
  : ['pwsh'].find((s) => spawnSync(s, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0);

// Identifiant de la clé publique de l'app : octets 2 à 9 de la 2e ligne du texte minisign
function octetsCle(pubkeyB64) {
  const texte = Buffer.from(pubkeyB64, 'base64').toString('utf8');
  const ligne = texte.split('\n').find((l) => l.trim() && !l.startsWith('untrusted comment'));
  return Buffer.from(ligne.trim(), 'base64').subarray(2, 10);
}
const OCTETS_APP = octetsCle(conf.plugins.updater.pubkey);
const ID_APP = Buffer.from(OCTETS_APP).reverse().toString('hex').toUpperCase();
const AUTRE_CLE = Buffer.from('0102030405060708', 'hex');

// Clé privée factice : même début que les vraies (« untrusted comment: rsign »), jamais une vraie
const CLE_FACTICE = Buffer.from(['untrusted comment: ', 'rsign encrypted secret key\nfaux'].join('')).toString('base64');
const CLE_PUBLIQUE = conf.plugins.updater.pubkey;
// Liste lue dans le script lui-même ($VariablesInterdites)
const VARIABLES_INTERDITES = [...(readFileSync(script, 'utf8').match(/^\$VariablesInterdites = ([^\n]+\n[^\n]+)/m)?.[1] ?? '')
  .matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);

// Faux pnpm : `tauri build` pose l'installeur, `tauri signer sign` écrit une signature au format de
// tauri (base64 d'un texte minisign). Il note dans journal.txt si la clé lui était visible.
const FAUX_PNPM = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), env = process.env;
const journal = (l) => fs.appendFileSync(env.NYX_ESSAI_JOURNAL, l + '\\n');
const cleVisible = env.TAURI_SIGNING_PRIVATE_KEY ? 'oui' : 'non';
const mdpVisible = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ? 'oui' : 'non';
if (args[0] === 'tauri' && args[1] === 'build') {
  journal('build cle=' + cleVisible + ' mdp=' + mdpVisible);
  if (env.NYX_ESSAI_BUILD_CODE) process.exit(Number(env.NYX_ESSAI_BUILD_CODE));
  const dossier = path.join('src-tauri', 'target', 'release', 'bundle', 'nsis');
  fs.mkdirSync(dossier, { recursive: true });
  const installeur = path.join(dossier, 'Nyx Player_' + env.NYX_ESSAI_VERSION + '_x64-setup.exe');
  fs.writeFileSync(installeur, 'installeur factice');
  if (env.NYX_ESSAI_BUILD_SIGNE) fs.writeFileSync(installeur + '.sig', 'signature de la compilation');
  process.exit(0);
}
if (args[0] === 'tauri' && args[1] === 'signer' && args[2] === 'sign') {
  const fichier = args[3].replace(/\\\\/g, '/');
  journal('sign ' + path.basename(fichier) + ' cle=' + cleVisible + ' mdp=' + mdpVisible);
  if (env.NYX_ESSAI_SIGNE_ERREUR) { console.error(env.NYX_ESSAI_SIGNE_ERREUR); process.exit(1); }
  const cle = Buffer.from(env.NYX_ESSAI_CLE_HEX, 'hex');
  const ligne2 = Buffer.concat([Buffer.from('ED'), cle, Buffer.alloc(64)]).toString('base64');
  const nom = env.NYX_ESSAI_SIGNE_POUR || path.basename(fichier);
  const texte = 'untrusted comment: signature from tauri secret key\\n' + ligne2 +
    '\\ntrusted comment: timestamp:1\\tfile:' + nom + '\\n' + Buffer.alloc(64).toString('base64') + '\\n';
  fs.writeFileSync(fichier + '.sig', Buffer.from(texte).toString('base64'));
  process.exit(0);
}
journal('inattendu ' + args.join(' '));
process.exit(2);
`;

// Faux node : seule la vérification de mpv.exe (binaires-natifs.mjs) est simulée
const FAUX_NODE = `#!/bin/sh
case "$*" in
  *binaires-natifs*) echo "verification mpv.exe simulee"; exit "\${NYX_ESSAI_MPV_CODE:-0}" ;;
esac
exec "${process.execPath}" "$@"
`;

let racine;
let outils;

// Sans la configuration git de la machine (signature des commits, crochets) : rien ne bloque l'essai
function git(dossier, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: dossier,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} : ${r.stderr}`);
}

// Copie minimale du dépôt, commitée : seuls les fichiers que le script lit
function preparerDepot({ version = '0.8.0', versionCargo = version, versionPaquet = version, productName = conf.productName, notes = true } = {}) {
  const dossier = mkdtempSync(path.join(racine, 'depot-'));
  mkdirSync(path.join(dossier, 'scripts'));
  mkdirSync(path.join(dossier, 'src-tauri'));
  mkdirSync(path.join(dossier, 'docs'));
  mkdirSync(path.join(dossier, 'web', 'updates'), { recursive: true });
  copyFileSync(script, path.join(dossier, 'scripts', 'windows-release.ps1'));
  writeFileSync(path.join(dossier, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ ...conf, version, productName }, null, 2));
  writeFileSync(path.join(dossier, 'src-tauri', 'Cargo.toml'), `[package]\nname = "nyx"\nversion = "${versionCargo}"\n`);
  writeFileSync(path.join(dossier, 'package.json'), JSON.stringify({ name: 'nyx', version: versionPaquet }));
  writeFileSync(path.join(dossier, 'web', 'updates', 'latest.json'), '{}\n');
  writeFileSync(path.join(dossier, '.gitignore'), 'src-tauri/target/\n');
  if (notes) {
    writeFileSync(path.join(dossier, 'docs', `NOTES_DE_VERSION_${version}.md`),
      '# Notes\n\n## Texte court pour `latest.json`\n\n```text\nCorrections et nouveautés de l\'essai.\n```\n');
  }
  git(dossier, 'init', '-q');
  git(dossier, '-c', 'user.name=essai', '-c', 'user.email=essai@exemple.test', 'add', '-A');
  git(dossier, '-c', 'user.name=essai', '-c', 'user.email=essai@exemple.test', 'commit', '-q', '-m', 'essai');
  return dossier;
}

function lancer(dossier, { env = {}, notes, cle = CLE_FACTICE, motDePasse = 'mot-de-passe-factice' } = {}) {
  const journal = `${dossier}.journal.txt`; // hors de la copie : il compterait comme fichier modifié
  writeFileSync(journal, '');
  // Saisies masquées et presse-papiers remplacés pour l'essai (le vrai presse-papiers de la personne
  // qui lance les tests n'est jamais vidé), puis le vrai script, avec son code de sortie
  const commande = [
    '$global:saisies = @($env:NYX_ESSAI_SAISIE_CLE, $env:NYX_ESSAI_SAISIE_MDP)',
    '$global:rang = 0',
    'function global:Read-Host { param($Prompt, [switch]$AsSecureString) $t = $global:saisies[$global:rang]; $global:rang++;',
    '  if ($t) { ConvertTo-SecureString $t -AsPlainText -Force } else { New-Object Security.SecureString } }',
    'function global:Set-Clipboard { param($Value) }',
    '$s = $env:NYX_ESSAI_SCRIPT',
    'try { if ($null -ne $env:NYX_ESSAI_NOTES) { & $s -Notes $env:NYX_ESSAI_NOTES } else { & $s }; exit 0 }',
    'catch { Write-Host "REFUS : $($_.Exception.Message)"; exit 1 }',
  ].join('\n');
  const variables = { ...process.env };
  // Variables interdites par le script (reste d'une compilation du banc dans le terminal de test) et
  // clé posée : retirées, seuls les cas qui les posent exprès les voient
  for (const v of ['NYX_ESSAI_NOTES', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', ...VARIABLES_INTERDITES]) delete variables[v];
  const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', commande], {
    cwd: dossier,
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      ...variables,
      PATH: `${outils}${path.delimiter}${process.env.PATH}`,
      NYX_ESSAI_JOURNAL: journal,
      NYX_ESSAI_SCRIPT: path.join(dossier, 'scripts', 'windows-release.ps1'),
      NYX_ESSAI_VERSION: '0.8.0',
      NYX_ESSAI_CLE_HEX: OCTETS_APP.toString('hex'),
      NYX_ESSAI_SAISIE_CLE: cle,
      NYX_ESSAI_SAISIE_MDP: motDePasse,
      ...(notes === undefined ? {} : { NYX_ESSAI_NOTES: notes }),
      ...env,
    },
  });
  return {
    code: r.status,
    sortie: `${r.stdout}${r.stderr}`,
    journal: readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean),
  };
}

// latest.json : écrit par .NET avec un chemin à barres obliques inverses, qu'il ne convertit pas
// hors de Windows. Les deux emplacements sont donc cherchés ; sous Windows, c'est web/updates.
function lireManifeste(dossier) {
  const chemins = [path.join(dossier, 'web', 'updates', 'latest.json'), path.join(dossier, 'web\\updates\\latest.json')];
  const ecrit = chemins.map((c) => (existsSync(c) ? readFileSync(c) : null)).find((b) => b && b.toString() !== '{}\n');
  return ecrit ?? null;
}

describe.skipIf(!shell)('publication Windows : essai complet du script avec de faux outils', () => {
  beforeAll(() => {
    racine = mkdtempSync(path.join(tmpdir(), 'nyx-publication-'));
    outils = path.join(racine, 'outils');
    mkdirSync(outils);
    writeFileSync(path.join(outils, 'pnpm'), FAUX_PNPM);
    writeFileSync(path.join(outils, 'node'), FAUX_NODE);
    chmodSync(path.join(outils, 'pnpm'), 0o755);
    chmodSync(path.join(outils, 'node'), 0o755);
  });
  afterAll(() => rmSync(racine, { recursive: true, force: true }));

  it('cas normal : clé vérifiée avant la compilation, compilation sans la clé, latest.json écrit sans BOM', () => {
    const dossier = preparerDepot();
    const r = lancer(dossier);
    expect(r.code, r.sortie).toBe(0);
    // Ordre : signature d'essai (clé visible), compilation (clé invisible), signature de l'installeur
    expect(r.journal).toEqual([
      'sign essai.txt cle=oui mdp=oui',
      'build cle=non mdp=non',
      'sign Nyx Player_0.8.0_x64-setup.exe cle=oui mdp=oui',
    ]);
    expect(r.sortie).toContain(`clé attendue par l'app : ${ID_APP}`);
    expect(r.sortie).toContain('Signature vérifiée');
    const brut = lireManifeste(dossier);
    expect(brut, r.sortie).not.toBeNull();
    expect(brut[0]).not.toBe(0xef); // pas de BOM : l'app ne lirait pas le fichier
    const manifeste = JSON.parse(brut.toString('utf8'));
    expect(manifeste.version).toBe('0.8.0');
    expect(manifeste.notes).toBe('Corrections et nouveautés de l\'essai.');
    expect(manifeste.platforms['windows-x86_64'].url).toBe('https://releases.nyxplayer.app/Nyx-Player_0.8.0_x64-setup.exe');
    // La signature écrite est celle de l'installeur, faite pour cette version
    const signature = Buffer.from(manifeste.platforms['windows-x86_64'].signature, 'base64').toString('utf8');
    expect(signature).toContain('file:Nyx Player_0.8.0_x64-setup.exe');
    // Ni la clé ni le mot de passe factices n'apparaissent à l'écran
    expect(r.sortie).not.toContain(CLE_FACTICE);
    expect(r.sortie).not.toContain('mot-de-passe-factice');
  });

  it('-Notes : remplace le fichier de notes, absent ici', () => {
    const dossier = preparerDepot({ notes: false });
    const r = lancer(dossier, { notes: 'Texte passé à la main.' });
    expect(r.code, r.sortie).toBe(0);
    expect(JSON.parse(lireManifeste(dossier).toString('utf8')).notes).toBe('Texte passé à la main.');
  });

  // Refus avant la clé : rien n'est demandé, rien n'est compilé ni signé
  const refusAvantCle = [
    {
      nom: 'variable du banc restée dans le terminal',
      env: { VITE_BANC: '1' },
      motif: /Compilation refusée : VITE_BANC défini dans ce terminal/,
    },
    {
      nom: 'clé posée dans le terminal par l\'ancienne méthode',
      env: { TAURI_SIGNING_PRIVATE_KEY: 'ancienne' },
      motif: /Une clé de signature est déjà posée dans ce terminal/,
    },
    {
      nom: 'lecteur mpv.exe resté pointeur Git LFS',
      env: { NYX_ESSAI_MPV_CODE: '1' },
      motif: /mpv\.exe n'est pas le vrai programme.*git lfs pull/,
    },
  ];
  for (const cas of refusAvantCle) {
    it(`refus avant la clé : ${cas.nom}`, () => {
      const r = lancer(preparerDepot(), { env: cas.env });
      expect(r.code).toBe(1);
      expect(r.sortie).toMatch(cas.motif);
      expect(r.journal).toEqual([]);
    });
  }

  it('refus avant la clé : fichier modifié hors version (suivi, puis non suivi)', () => {
    const dossier = preparerDepot();
    writeFileSync(path.join(dossier, 'docs', `NOTES_DE_VERSION_0.8.0.md`), '# changé\n');
    let r = lancer(dossier);
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/fichiers modifiés hors version \(docs\/NOTES_DE_VERSION_0\.8\.0\.md\)/);
    git(dossier, 'checkout', '--', '.');
    writeFileSync(path.join(dossier, 'oublié.txt'), 'nouveau');
    r = lancer(dossier);
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/fichiers modifiés hors version \(oublié\.txt\)/);
    expect(r.journal).toEqual([]);
  });

  it('les fichiers de version modifiés ne bloquent pas, ni un fichier dont seules les fins de ligne changent', () => {
    const dossier = preparerDepot();
    writeFileSync(path.join(dossier, 'web', 'updates', 'latest.json'), '{"ancien": true}\n');
    writeFileSync(path.join(dossier, 'src-tauri', 'Cargo.toml'), readFileSync(path.join(dossier, 'src-tauri', 'Cargo.toml'), 'utf8').replace(/\n/g, '\r\n'));
    const fichierFins = path.join(dossier, '.gitignore');
    writeFileSync(fichierFins, readFileSync(fichierFins, 'utf8').replace(/\n/g, '\r\n'));
    const r = lancer(dossier);
    expect(r.code, r.sortie).toBe(0);
  });

  it('refus avant la clé : trois numéros de version différents', () => {
    const r = lancer(preparerDepot({ versionCargo: '0.7.6' }));
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/Versions différentes : tauri\.conf\.json 0\.8\.0, Cargo\.toml 0\.7\.6, package\.json 0\.8\.0/);
    expect(r.journal).toEqual([]);
  });

  it('refus avant la clé : productName changé (l\'app n\'accepterait plus la mise à jour)', () => {
    const r = lancer(preparerDepot({ productName: 'Nyx' }));
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/productName a changé \(Nyx\)/);
    expect(r.journal).toEqual([]);
  });

  it('refus avant la clé : notes de version absentes', () => {
    const r = lancer(preparerDepot({ notes: false }));
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/Notes introuvables/);
    expect(r.journal).toEqual([]);
  });

  it('refus avant la clé : notes sur plusieurs lignes', () => {
    const r = lancer(preparerDepot(), { notes: 'ligne 1\nligne 2' });
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/tiennent sur une seule ligne/);
    expect(r.journal).toEqual([]);
  });

  it('clé PUBLIQUE collée à la place de la privée : refus clair, rien de signé', () => {
    const r = lancer(preparerDepot(), { cle: CLE_PUBLIQUE });
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/ne ressemble pas à une clé privée Tauri/);
    expect(r.journal).toEqual([]);
  });

  it('mot de passe vide : refus, rien de signé', () => {
    const r = lancer(preparerDepot(), { motDePasse: '' });
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/Mot de passe vide/);
    expect(r.journal).toEqual([]);
  });

  it('autre clé que celle de l\'app : refus AVANT la compilation', () => {
    const r = lancer(preparerDepot(), { env: { NYX_ESSAI_CLE_HEX: AUTRE_CLE.toString('hex') } });
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(new RegExp(`Ce n'est PAS la clé de l'app : elle signe en 0807060504030201, l'app attend ${ID_APP}`));
    expect(r.journal).toEqual(['sign essai.txt cle=oui mdp=oui']);
  });

  it('signature refusée par l\'outil : sa ligne d\'erreur est montrée avec un indice sur le mot de passe', () => {
    const r = lancer(preparerDepot(), { env: { NYX_ESSAI_SIGNE_ERREUR: 'Error: wrong password for that key' } });
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/Signature refusée par tauri signer : Error: wrong password for that key\. Le mot de passe ne correspond sans doute pas/);
    expect(r.journal).toEqual(['sign essai.txt cle=oui mdp=oui']);
  });

  it('compilation en échec : arrêt, rien de signé ni écrit', () => {
    const dossier = preparerDepot();
    const r = lancer(dossier, { env: { NYX_ESSAI_BUILD_CODE: '3' } });
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/Compilation échouée \(3\)/);
    expect(r.journal).toEqual(['sign essai.txt cle=oui mdp=oui', 'build cle=non mdp=non']);
    expect(lireManifeste(dossier)).toBeNull();
  });

  it('signature produite par la compilation elle-même : alerte, rien publié', () => {
    const dossier = preparerDepot();
    const r = lancer(dossier, { env: { NYX_ESSAI_BUILD_SIGNE: '1' } });
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/Une signature a été produite par la compilation elle-même/);
    expect(lireManifeste(dossier)).toBeNull();
  });

  it('signature faite pour un autre fichier que l\'installeur de cette version : latest.json non écrit', () => {
    const dossier = preparerDepot();
    const r = lancer(dossier, { env: { NYX_ESSAI_SIGNE_POUR: 'Nyx Player_0.7.6_x64-setup.exe' } });
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/Signature faite pour « Nyx Player_0\.7\.6_x64-setup\.exe », pas pour la version 0\.8\.0/);
    expect(lireManifeste(dossier)).toBeNull();
  });
});
