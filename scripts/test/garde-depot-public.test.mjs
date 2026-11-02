// @vitest-environment node
// Garde du dépôt public (scripts/public/garde-depot-public.mjs) : une PR qui ajoute un fichier interne,
// un secret ou un lien privé est refusée ; une PR ordinaire passe. Les exemples de secrets sont écrits en
// morceaux pour que ce fichier ne se signale pas lui-même.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chargerInterdits, estInterdit, examinerLigne, juger, lireDiff, lireArbre, globVersRegex } from '../public/garde-depot-public.mjs';

const garde = fileURLToPath(new URL('../public/garde-depot-public.mjs', import.meta.url));
const regles = chargerInterdits();
const bloquants = (l) => examinerLigne(l).filter((t) => t.type === 'bloquant');

describe('liste des chemins interdits', () => {
  it.each([
    'CLAUDE.md', '.claude/agents/x.md', ['docs/PASSA', 'TION_2026.md'].join(''), 'docs/plans/ANDROID_TV_PLAN.md', 'audit/nyx/registre.json',
    'PRODUCT.md', 'web-lab/index.html', 'supabase/seance/01.sql', '.env', '.env.local', 'src-tauri/.env.production', 'keys/release.jks',
    'a/b/cle.pem', '.ENV', 'Claude.md', 'app/release.key', 'ios/AuthKey.p8', 'home/id_rsa', 'android/local.properties', 'app/google-services.json', 'scripts/ci-locale.ps1', 'resources/mpv/mpv.exe', 'zz-preview-remote-TEST-ONLY.json',
    'src-tauri/capabilities/zz-preview-remote-TEST-ONLY.json', 'graphify-out/graph.json', '.graphify_cache', 'tv-harness.html',
  ])('refuse %s', (chemin) => expect(estInterdit(chemin, regles), chemin).toBe(true));

  it.each([
    '.env.example', 'docs/CONVENTIONS.md', 'docs/CSS_RULES.md', 'docs/BUILDING.md', 'README.md', 'CONTRIBUTING.md',
    '.vscode/extensions.json', 'src/App.tsx', 'src-tauri/src/lib.rs', '.github/workflows/ci.yml', 'DESIGN.md', 'web/index.html',
    'src-tauri/plugins/tauri-plugin-nyx-android/android/libs/README.md', 'scripts/public/garde-depot-public.mjs',
  ])('admet %s', (chemin) => expect(estInterdit(chemin, regles), chemin).toBe(false));

  it('« ** » et « **/ » : racine ou dossiers imbriqués', () => {
    expect(globVersRegex('**/x.pem').test('x.pem')).toBe(true);
    expect(globVersRegex('**/x.pem').test('a/b/x.pem')).toBe(true);
    expect(globVersRegex('a/*').test('a/b/c')).toBe(false);
  });
});

describe('secrets et liens privés', () => {
  const faux = {
    cle: ['-----BEGIN', ' PRIVATE KEY-----'].join(''),
    signature: ['untrusted comment: ', 'minisign secret key'].join(''),
    tauri: 'TAURI_SIGNING_PRIVATE_KEY=' + 'A'.repeat(40),
    supabase: ['sb_', 'secret_', 'a'.repeat(30)].join(''),
    github: ['gh', 'p_', 'a'.repeat(36)].join(''),
    aws: 'AKIA' + 'A'.repeat(16),
    dossier: 'voir ' + ['/mnt/project', '-files/x.md'].join(''),
    artefact: 'https://claude.ai/' + 'artifact/abc',
    message: 'cm' + 'sg_' + 'A'.repeat(20),
    jwtService: ['eyJhbGciOiJIUzI1NiJ9', Buffer.from('{"role":"service_role"}').toString('base64url'), 'c2lnbmF0dXJlMTIzNDU2'].join('.'),
  };
  for (const [nom, valeur] of Object.entries(faux)) {
    it(`bloque : ${nom}`, () => expect(bloquants(`const x = '${valeur}';`).length, nom).toBeGreaterThan(0));
  }

  it('un jeton JWT ordinaire (clé publique, exemple de test) n\'est qu\'un avertissement', () => {
    const jeton = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from('{"role":"anon"}').toString('base64url'), 'c2lnbmF0dXJlMTIzNDU2'].join('.');
    expect(bloquants(jeton)).toEqual([]);
    expect(examinerLigne(jeton).some((t) => t.type === 'avertissement')).toBe(true);
  });

  it('« gitleaks:allow » n\'exempte aucun secret', () => {
    expect(bloquants(`const k = '${faux.supabase}'; // gitleaks:allow`).length).toBeGreaterThan(0);
  });

  it('une adresse d\'abonnement d\'exemple et un identifiant interne : avertissement seulement', () => {
    const r = examinerLigne('http://h.example/get.php?username=u&password=p  (voir ' + 'L' + '-12)');
    expect(r.every((t) => t.type === 'avertissement')).toBe(true);
    expect(r.length).toBe(2);
  });

  it('du code ordinaire ne signale rien', () => {
    expect(examinerLigne('const sha = createHash("SHA-256"); // courbe P-256, AES-256')).toEqual([]);
    expect(examinerLigne('export function lire(): string { return "bonjour"; }')).toEqual([]);
  });
});

describe('PR réelle dans un dépôt jetable', () => {
  let dossier;
  const git = (...a) => execFileSync('git', ['-C', dossier, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  const ecrire = (rel, texte) => {
    fs.mkdirSync(path.dirname(path.join(dossier, rel)), { recursive: true });
    fs.writeFileSync(path.join(dossier, rel), texte);
  };
  beforeAll(() => {
    dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'garde-'));
    execFileSync('git', ['init', '-q', '-b', 'main', dossier]);
    ecrire('src/a.ts', 'export const a = 1;\n');
    ecrire('docs/CONVENTIONS.md', '# Conventions\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
  });
  afterAll(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const pr = (nom, fichiers, supprimer = []) => {
    git('switch', '-q', '-c', nom, 'main');
    for (const [rel, texte] of Object.entries(fichiers)) ecrire(rel, texte);
    for (const rel of supprimer) fs.rmSync(path.join(dossier, rel));
    git('add', '-A');
    git('commit', '-qm', nom);
    const res = spawnSync('node', [garde, '--depot', dossier, '--base', 'main', '--tete', nom], { encoding: 'utf8' });
    git('switch', '-q', 'main');
    return res;
  };

  it('laisse passer une PR ordinaire', () => {
    const r = pr('ok', { 'src/a.ts': 'export const a = 2;\n', 'docs/CONVENTIONS.md': '# Conventions\nDe plus.\n' });
    expect(r.status, r.stdout).toBe(0);
  });
  it('refuse l\'ajout d\'un fichier interne', () => {
    const r = pr('interne', { [['docs/PASSA', 'TION_2026.md'].join('')]: 'notes\n' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(['docs/PASSA', 'TION_2026.md'].join(''));
  });
  it('refuse un secret ajouté dans un fichier ordinaire, avec son numéro de ligne', () => {
    const r = pr('secret', { 'src/b.ts': `// ok\nconst k = '${['gh', 'p_', 'a'.repeat(36)].join('')}';\n` });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/file=src\/b\.ts,line=2::secret/);
  });
  it('ne regarde que ce que la PR ajoute : un secret déjà présent ailleurs ne la bloque pas', () => {
    const r = pr('autre', { 'src/c.ts': 'export const c = 3;\n' });
    expect(r.status).toBe(0);
  });
  it('la suppression d\'un fichier interne n\'est jamais refusée', () => {
    git('switch', '-q', '-c', 'prep', 'main');
    ecrire('CLAUDE.md', 'regles\n');
    git('add', '-A'); git('commit', '-qm', 'prep');
    git('switch', '-q', 'main'); git('merge', '-q', '--ff-only', 'prep');
    const r = pr('retrait', {}, ['CLAUDE.md']);
    expect(r.status, r.stdout).toBe(0);
  });
  it('lireDiff et juger : mêmes résultats par l\'API', () => {
    git('switch', '-q', '-c', 'api', 'main');
    ecrire('.env.local', 'X=1\n');
    git('add', '-A', '-f'); git('commit', '-qm', 'api'); git('switch', '-q', 'main');
    const { bloquants: b } = juger(lireDiff(dossier, 'main', 'api'), regles);
    expect(b.map((x) => x.fichier)).toEqual(['.env.local']);
  });
  it('mode arbre : examine tout le contenu', () => {
    const { bloquants: b } = juger(lireArbre(dossier), regles);
    expect(b.map((x) => x.fichier)).toEqual(['CLAUDE.md']);
  });
  it('un secret n\'échappe pas au contrôle par la forme du diff (ligne « ++ », nom non ASCII, binaire)', () => {
    const cle = ['-----BEGIN', ' RSA PRIVATE KEY-----'].join('');
    const r = pr('forme', {
      'ok.txt': 'propre\n',
      'plus.txt': `++ astuce\n${cle}\n`,
      'clé.txt': `${cle}\n`,
      'bin.dat': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(cle)]),
    });
    expect(r.status).toBe(1);
    for (const f of ['plus.txt', 'bin.dat']) expect(r.stdout, f).toContain(`file=${f},`);
    expect(r.stdout).toContain('file=clé.txt,');
    expect(r.stdout).toContain('fichier binaire ajouté');
  });
  it('mauvais appel : code 2', () => {
    expect(spawnSync('node', [garde], { encoding: 'utf8' }).status).toBe(2);
  });
});
