// @vitest-environment node
// Économie des minutes GitHub Actions : aucun workflow ne doit repartir tout seul sur les
// branches de travail. Chaque tâche ne tourne qu'avec l'étiquette `ci-github`, le bouton « Run
// workflow » ou (sauf l'APK) une PR vers main. Un envoi qui réintroduirait `push:` consommerait de
// nouveau tout le quota en quelques jours.
// Dépôt public `kunai974/nyx-player` (minutes gratuites) : les mêmes fichiers y tournent à chaque PR
// et à chaque envoi sur main, grâce à une condition sur `github.repository`. Un `push:` n'est admis
// que vers main, et seulement si chaque tâche écarte les envois hors du dépôt public.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
const tous = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
// La recette de publication et la garde du dépôt public ont leurs propres règles (plus bas).
const workflows = tous.filter((f) => f !== 'release.yml' && f !== 'garde-depot-public.yml');

// Bloc `on:` du workflow (jusqu'à la prochaine clé de premier niveau)
function triggers(text) {
  const match = text.match(/^on:\n((?:[ #].*\n|\n)*)/m);
  return match ? match[1] : '';
}

// Tâches : chaque clé à deux espaces sous `jobs:`, avec leur texte
function jobs(text) {
  const body = text.slice(text.search(/^jobs:\n/m) + 'jobs:\n'.length);
  const parts = body.split(/^(?= {2}[\w-]+:\s*$)/m).filter((p) => /^ {2}[\w-]+:/.test(p));
  return parts.map((p) => ({ name: p.match(/^ {2}([\w-]+):/)[1], text: p }));
}

describe('workflows GitHub : pas de passage automatique', () => {
  it('trouve les workflows', () => {
    expect(workflows).toEqual(expect.arrayContaining(['ci.yml', 'android.yml', 'rust.yml', 'windows.yml']));
  });

  for (const file of workflows) {
    // Fins de ligne Windows (core.autocrlf) ramenées à \n
    const text = readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');

    it(`${file} : seulement des déclencheurs à la demande (ni push ni autre)`, () => {
      // Un `on:` écrit sur une ligne (`on: push`) donnerait un bloc vide : refusé aussi
      const on = triggers(text);
      expect(on.trim(), `${file} : bloc « on: » introuvable ou sur une ligne`).not.toBe('');
      const events = [...on.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]);
      for (const event of events) {
        expect(['pull_request', 'push', 'workflow_dispatch', 'schedule'], `${file} : « ${event} »`).toContain(event);
      }
    });

    it(`${file} : un envoi ne lance rien sur l'atelier privé, et seulement vers main sur le public`, () => {
      const on = triggers(text);
      const push = on.match(/^ {2}push:\n((?: {4}.*\n)*)/m);
      if (!push) return;
      expect(push[1], `${file} : « push » limité à main`).toMatch(/^ {4}branches: \[main\]$/m);
      expect(push[1]).not.toMatch(/branches-ignore|tags:/);
      for (const job of jobs(text)) {
        const gate = job.text.match(/^ {4}if: >-\n((?: {6}.*\n)+)/m);
        expect(gate, `${file} › ${job.name} : condition « if » manquante`).not.toBeNull();
        // Hors du dépôt public, un envoi n'ouvre aucune des autres branches de la condition
        expect(gate[1]).toContain("(github.repository == 'kunai974/nyx-player' && github.event.action != 'labeled')");
        expect(gate[1]).toContain("(github.event_name != 'pull_request' && github.event_name != 'push')");
        expect(gate[1]).toContain("(github.event_name == 'pull_request' && github.event.action != 'labeled'");
        expect(gate[1]).not.toMatch(/^\s*github\.event_name != 'pull_request' \|\|/m);
      }
    });

    it(`${file} : les PR ne passent que par l'étiquette ci-github (ou vers main)`, () => {
      const on = triggers(text);
      if (!/^ {2}pull_request:/m.test(on)) return;
      expect(on).toMatch(/types: \[opened, synchronize, reopened, labeled\]/);
      for (const job of jobs(text)) {
        const gate = job.text.match(/^ {4}if: >-\n((?: {6}.*\n)+)/m);
        expect(gate, `${file} › ${job.name} : condition « if » manquante`).not.toBeNull();
        expect(gate[1]).toContain("github.event.label.name == 'ci-github'");
        // Sans cette condition, poser n'importe quelle étiquette relancerait tout
        expect(gate[1]).toContain("github.event.action != 'labeled'");
        expect(gate[1]).toContain("contains(github.event.pull_request.labels.*.name, 'ci-github')");
      }
    });

    it(`${file} : une autre étiquette n'annule pas un passage en cours`, () => {
      const group = text.match(/^ {2}group: (.*)$/m);
      if (!group) return;
      expect(group[1]).toContain("github.event.label.name != 'ci-github'");
    });
  }
});

describe('garde-depot-public.yml : contrôle des PR du dépôt public', () => {
  const text = readFileSync(path.join(dir, 'garde-depot-public.yml'), 'utf8').replace(/\r\n/g, '\n');
  const taches = jobs(text);

  it('ne part que des PR vers main, et ne tourne jamais sur l\'atelier privé', () => {
    const on = triggers(text).split('\n').filter((l) => l.trim() && !l.startsWith('#')).join('\n');
    expect(on).toBe('  pull_request_target:\n    types: [opened, synchronize, reopened]\n    branches: [main]');
    for (const job of taches) expect(job.text, job.name).toMatch(/^ {4}if: github\.repository == 'kunai974\/nyx-player'$/m);
  });

  it('lit la PR sans jamais la sortir dans le dossier de travail ni l\'exécuter', () => {
    // pull_request_target donne des droits : l'extraction de la PR (ref = tête de PR) serait une faille
    expect(text).not.toMatch(/^\s+ref:/m);
    // Le commit jugé est lu par son empreinte (variable d'environnement), jamais par un nom de branche
    expect(text).not.toMatch(/head\.ref|head\.repo/);
    expect(text).not.toMatch(/pnpm|npm (ci|install)|cargo|gradlew/);
    expect(text).toMatch(/refs\/pull\/\$\{NUMERO\}\/head:refs\/garde\/pr/);
    expect(text).toMatch(/test "\$\(git rev-parse refs\/garde\/pr\)" = "\$TETE"/);
    expect(text).toMatch(/persist-credentials: false/);
  });

  it('aucun droit par défaut, lecture seule, aucun secret, actions épinglées', () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(text).not.toMatch(/: write|secrets\./);
    for (const [, action] of text.matchAll(/uses: (\S+)/g)) expect(action).toMatch(/@[0-9a-f]{40}$/);
  });

  it('aucune donnée de la PR n\'est écrite directement dans une commande (injection)', () => {
    expect(text.split('\n').filter((l) => /^\s+(run:|git |test |node |#)/.test(l) && !l.trim().startsWith('#')).join('\n')).not.toMatch(/\$\{\{/);
  });
});

describe('release.yml : publication, dépôt public seulement', () => {
  const text = readFileSync(path.join(dir, 'release.yml'), 'utf8').replace(/\r\n/g, '\n');

  it('ne part que d\'une étiquette de version envoyée', () => {
    const on = triggers(text).split('\n').filter((l) => l.trim() && !l.startsWith('#')).join('\n');
    expect(on).toBe("  push:\n    tags: ['v*.*.*']");
  });

  it('ne tourne jamais sur l\'atelier privé : la première tâche le refuse, les autres en dépendent', () => {
    const [premiere, ...suivantes] = jobs(text);
    expect(premiere.text).toMatch(/^ {4}if: github\.repository == 'kunai974\/nyx-player'$/m);
    for (const job of suivantes) expect(job.text, job.name).toMatch(/^ {4}needs: .*verifier/m);
  });

  it('aucun droit par défaut, écriture seulement pour la release brouillon', () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    for (const job of jobs(text)) {
      if (job.name === 'publier') {
        expect(job.text).toMatch(/contents: write/);
        expect(job.text).toMatch(/id-token: write/);
      } else {
        expect(job.text, job.name).toMatch(/^ {6}contents: read$/m);
        expect(job.text, job.name).not.toMatch(/: write/);
      }
    }
  });

  it('les clés ne servent que dans les tâches de l\'environnement « publication », aux étapes de signature', () => {
    for (const job of jobs(text)) {
      if (!job.text.includes('secrets.')) continue;
      expect(job.text, job.name).toMatch(/^ {4}environment: publication$/m);
      const etapes = job.text.split(/^(?= {6}- )/m);
      for (const etape of etapes.filter((e) => e.includes('secrets.'))) {
        expect(etape, job.name).toMatch(/^ {6}- name: Signature$/m);
      }
    }
  });

  it('les tâches qui ont les clés ne compilent rien et n\'installent pas les dépendances de l\'app', () => {
    for (const job of jobs(text)) {
      if (!job.text.includes('secrets.')) continue;
      expect(job.text, job.name).not.toMatch(/pnpm|cargo|gradlew|tauri build|tauri android/);
      expect(job.text, job.name).toMatch(/runs-on: ubuntu/);
    }
    // Et les compilations n'ont aucun environnement, donc aucune clé
    for (const job of jobs(text).filter((j) => /tauri (android )?build/.test(j.text))) {
      expect(job.text, job.name).not.toMatch(/environment:|secrets\./);
    }
  });

  it('aucune compilation ne tourne pendant une signature, et « publier » recontrôle les fichiers signés', () => {
    const parNom = Object.fromEntries(jobs(text).map((j) => [j.name, j.text]));
    for (const nom of ['signer-windows', 'signer-android']) {
      expect(parNom[nom], nom).toMatch(/^ {4}needs: \[verifier, compiler-windows, compiler-android\]$/m);
      expect(parNom[nom], nom).toMatch(/^ {6}sha256: \$\{\{ steps\.signe\.outputs\.sha256 \}\}$/m);
    }
    expect(parNom.publier).toContain('needs.signer-windows.outputs.sha256');
    expect(parNom.publier).toContain('needs.signer-android.outputs.sha256');
    expect(parNom.publier).toMatch(/- name: Fichiers signés reçus[\s\S]*- name: Fichiers de mise à jour/);
  });

  it('aucun cache partagé avec les autres recettes, aucune action non épinglée', () => {
    expect(text).not.toMatch(/rust-cache|cache: (?!false)/);
    expect(text.match(/setup-node@/g).length).toBe(text.match(/package-manager-cache: false/g).length);
    for (const [, action] of text.matchAll(/uses: (\S+)/g)) expect(action).toMatch(/@[0-9a-f]{40}$/);
    expect(text).not.toMatch(/pull_request_target/);
    // Tous les secrets d'un coup échapperaient à la règle « une étape de signature »
    expect(text).not.toMatch(/toJSON\(secrets|secrets\[/);
  });
});
