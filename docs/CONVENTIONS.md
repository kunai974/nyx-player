# Conventions de Code — Nyx Player

> Guide des conventions à suivre pour maintenir la cohérence du codebase.
> Dernière mise à jour : 9 Avril 2026 (Security Conventions + EPG + DRY Schema)

---

## 1. Nommage

### Fichiers

| Type | Convention | Exemple |
|------|------------|---------|
| Composants React | PascalCase | `EpisodeCard.tsx` |
| Hooks | camelCase + prefix `use` | `useGlobalSearch.ts` |
| Services | camelCase | `playbackProgressService.ts` |
| Utils/Helpers | camelCase | `normalizeTmdb.ts` |
| Types | camelCase | `xtream.ts` |
| Tests | `*.test.ts(x)` | `EpisodeCard.test.tsx` |

### Dossiers

| Type | Convention | Exemple |
|------|------------|---------|
| Composants | PascalCase | `Dashboard/`, `Lists/`, `Player/` |
| Sous-systèmes | PascalCase | `Common/`, `Navigation/`, `Settings/` |
| Tests | `__tests__/` | `hooks/__tests__/` |

### Variables et Fonctions

```typescript
// ✅ Bon
const isLoading = true;          // Préfixe "is" pour booléens
const currentAudioId = 1;        // Préfixe "current" pour état courant
const hasSavedSession = true;    // Préfixe "has" pour existence
function getTmdbTrendingAndMatch() {}

// ❌ Mauvais
const loading = true;            // Préférer "isX" pour booléens
const audioId = 1;               // Préférer "currentX" pour état courant
```

### Interfaces et Types

```typescript
// Interface: PascalCase, préfixée selon contexte
interface TrendingItem {}
interface PlayerControlsProps {}
interface XtreamEpisode {}

// Type alias
type TmdbId = number;
type TabType = 'dashboard' | 'movies' | 'series' | ...;
```

---

## 2. Structure des Fichiers

### Composant React

```typescript
// 1. Imports React
import React, { useState, useEffect } from 'react';

// 2. Imports locaux (composants, hooks)
import { SomeComponent } from './SomeComponent';

// 3. Imports types (type-only imports)
import type { SomeType } from '../types/someType';

// 4. Imports CSS
import './ComponentName.css';

// 5. Interfaces/Types locaux
interface ComponentNameProps {
  onPlay: () => void;
}

// 6. Composant principal
export const ComponentName: React.FC<ComponentNameProps> = ({ onPlay }) => {
  // États
  const [state, setState] = useState();

  // Effects
  useEffect(() => {}, []);

  // Handlers
  const handleClick = () => {};

  // Render
  return <div />;
};
```

### Service

```typescript
// 1. Imports types
import type { SomeType } from '../types/someType';

// 2. Imports services
import { getDatabase } from './dbCore';

// 3. Types locaux (exportés seulement si nécessaire hors fichier)
interface InternalType {}

// 4. Fonctions exportées avec JSDoc
/** Description de la fonction */
export async function someFunction(param: Type): Promise<Result> {
  const db = await getDatabase();
  // Implementation
}
```

---

## 3. Limites & Interdictions

| Règle | Limite | Action si violation |
|-------|--------|---------------------|
| Taille fichier | **Repère : 500 lignes** | Au-delà, se demander s'il y a un morceau autonome à extraire (hook, sous-composant) |
| `console.*` | **Journal central** pour tout nouveau message | `createLogger('Zone')` (`src/utils/logger.ts` : niveaux `debug`/`info`/`warn`/`error`, identifiants IPTV masqués d'office) ; `devLog(category, msg)` pour les traces détaillées activables à la main. Les `console.*` existants passent au journal quand on touche leur fichier (migration progressive). Exception : debug commands `window.debug*` (dans `debugTools.ts`, `debugCache.ts`, `tmdbCacheSqlite.ts`). Vérifié par ESLint (`no-console`), anciens appels gelés |
| `any` | **Interdit** | Utiliser types stricts ou `unknown` |
| Promesse lancée sans `await` | **Interdit** (ESLint `no-floating-promises`, `no-misused-promises`) | `await`, `.catch(…)` qui journalise, ou `void maPromesse()` quand l'échec est déjà géré à l'intérieur. Les anciens cas sont gelés dans `eslint-suppressions.json` |
| Dépendances d'un effet (`useEffect`, `useCallback`…) | **Complètes** (ESLint `exhaustive-deps`, bloquant) | Une omission voulue s'écrit `// eslint-disable-next-line react-hooks/exhaustive-deps -- raison` |
| Texte affiché ou lu à l'utilisateur | **Toujours `t(…)`**, y compris `aria-label`, `title` et `placeholder` | ESLint le vérifie hors tests et outils de développement |
| Pixels fixes CSS | **Préférer** unités relatives | Voir section 5 pour les exceptions autorisées |
| Prop drilling | **Max 2 niveaux** | Utiliser Context ou hooks |
| Outils de test (`src/dev`) | **Jamais importés par le code de l'appli** (ESLint `no-restricted-imports`) ; seule porte : `src/main.tsx` | L'appli offre des prises vides (`src/services/outilsTest.ts`), lues derrière l'indicateur de leur version (`VERSION_BANC`, `VERSION_AUDIT`, `VERSION_MESURE`, `import.meta.env.DEV`) ; les outils s'y branchent eux-mêmes (`src/dev/prises.ts`, `src/dev/prisesBanc.ts`). Une version normale n'en garde aucune trace (`audit/nyx/banc/verifier-bundle.mjs`) |
| Regex Kotlin/Java (Android) | **Jamais de crochet ouvrant suivi de deux-points** | Android compile les regex avec ICU, qui y voit le début d'une propriété Unicode dès qu'un `:]` suit plus loin dans la regex, et plante au lancement alors que les tests Kotlin (JVM) passent. Mettre le deux-points ailleurs (`[=:]`) ou l'échapper (`[\:=]`). Vérifié par `scripts/test/android-regex-icu.test.mjs` |

> **Les 500 lignes sont un repère, pas une obligation**. On découpe quand un morceau est vraiment autonome et que le sortir réduit un risque (doublon, conflits fréquents, logique impossible à tester), jamais pour passer sous la barre. Exemple : la gestion des profils est sortie d'`App.tsx` dans `hooks/useProfiles.ts` ; le reste d'`App.tsx` (~725 lignes, orchestrateur principal) y reste volontairement, en particulier le bouton Retour de dernier recours (sa place dans la pile de `useBackHandler` dépend du moment où il est installé) et le signal « premier écran prêt » qui fait apparaître la fenêtre Windows. Autres fichiers au-delà du repère : on les découpe quand une PR y touche et qu'un morceau s'y prête. Deuxième exemple : les étapes de la session qui ne dépendent pas de React (lecture du catalogue, changement de fournisseur, re-liaison de Ma liste) sont sorties de `hooks/useSessionLifecycle.ts` dans `services/sessionSteps.ts` ; le hook garde l'enchaînement de la connexion, de la reprise et de l'actualisation. Troisième exemple : les envois vers le cloud de `services/sync/syncPush.ts` sont rangés par sujet dans `services/sync/push/` (Ma liste, placement des titres de Ma liste, préférences, lecture, Live TV, catégories masquées, envoi groupé des catégories) ; `syncPush.ts` ne fait plus que les réunir, pour que les appels existants ne changent pas. Quatrième exemple : l'écran Compte des Réglages (`components/Settings/AccountSection.tsx`) est découpé en un bloc par réglage dans `components/Settings/account/` (nom du profil, adresse email, mot de passe, suppression du compte), avec le champ mot de passe à œil et les contrôles de saisie en commun ; `AccountSection.tsx` ne fait plus que les poser dans l'ordre. Cinquième exemple : les boutons du lecteur (`components/PlayerControls.tsx`) sont sortis dans `components/Player/controls/` (cadenas, barre du haut, barre de progression, lecture et épisodes, volume, bouton des épisodes ou des chaînes, boutons de droite) et ses morceaux de logique autonomes dans des hooks (`usePlayerMenus`, `useEpisodeButtons`, `useFlashIcon`, `useZapChannel`, `useProgressScrub`) ; `PlayerControls.tsx` garde l'appel de tous les hooks du lecteur dans le même ordre, parce que la pile du bouton Retour et la télécommande en dépendent, et pose les morceaux de l'écran. Sixième exemple : le contexte du lecteur (`contexts/PlayerContext.tsx`) est rangé dans `contexts/player/` : la préparation d'une lecture sans React (`streamRequest.ts` : adresse du flux, position de départ, début de lecture), la connexion au moteur, les effets sur la page, la purge mémoire différée et les épisodes suivant / précédent ; lecture, arrêt, zap et relance restent ensemble dans `usePlaybackSession.ts`, parce qu'ils partagent le numéro de la dernière demande qui protège le bouton Retour et le zap rapide.

---

## 4. Patterns React

### Props avec Callbacks

```typescript
// ✅ Préfixe "on" pour callbacks
interface Props {
  onPlay: () => void;
  onSelectTrack: (id: number) => void;
}

// ❌ Éviter
interface Props {
  playCallback: () => void;
  handleSelect: (id: number) => void;
}
```

### États Dérivés

```typescript
// ✅ Calculer dans le render, pas dans state
const isValid = name.length > 0 && email.includes('@');

// ❌ Éviter état redondant
const [isValid, setIsValid] = useState(false);
useEffect(() => setIsValid(name.length > 0), [name]);
```

### Extraction de Logique

```typescript
// ✅ Extraire en hook si > 50 lignes ou réutilisable entre composants
// hooks/useMovieSourceSelection.ts

// ✅ Garder inline si < 20 lignes et usage unique
const LoadingSpinner = () => <div className="spinner" />;
```

---

## 5. CSS

### Unités

```css
/* ✅ Relatif pour responsive (préféré) */
font-size: 1rem;
padding: 1.5rem;
width: 100%;

/* ❌ Éviter pixels fixes pour le layout structurel */
padding: 24px;  /* → préférer rem */
width: 300px;   /* → préférer %, vw, ou clamp() */
```

### Exceptions px Autorisées

```css
/* ✅ blur/shadows pour effets premium (Glassmorphism) */
backdrop-filter: blur(64px);
background-color: rgba(18, 18, 18, 0.85);
box-shadow: 0 4px 30px rgba(0,0,0,0.5);

/* ✅ Bordures fines */
border: 1px solid rgba(255,255,255,0.1);

/* ✅ Media queries */
@media (min-width: 768px) {}

/* ✅ Transforms mineurs */
transform: translateY(-2px);

/* ✅ Composants à taille fixe (cartes, posters, scrollbars) */
width: 160px;   /* poster card */
height: 240px;  /* poster card */

/* ✅ Indicateurs et petits éléments UI */
width: 6px;     /* scrollbar, progress handle */
height: 4px;    /* progress bar track */
```

### Classes

```css
/* ✅ BEM-like pour composants */
.episode-card {}
.episode-card-thumbnail {}
.episode-card-title {}

/* ✅ Suffixes pour variants */
.channel-logo--loading {}
.dashboard-mode-content.mode-switching {}
```

### Layout

- **Flexbox ou CSS Grid** exclusivement pour le positionnement structurel
- **Pas de `position: absolute`** pour le layout structurel de la page (accepté pour overlays, tooltips, progress handles, badges)
- **Design fluide** et responsive Desktop en priorité

### Inline Styles

```tsx
// ✅ Valeurs dynamiques calculées au runtime
style={{ width: `${progress}%` }}
style={{ backgroundImage: `url(${movie.backdropUrl})` }}
style={{ cursor: isDragging ? 'grabbing' : 'grab' }}

// ❌ Style statique → utiliser une classe CSS
style={{ color: 'red', fontSize: '14px' }}
```

---

## 6. TypeScript

### Type-Only Imports

```typescript
// ✅ Séparer les imports de types
import type { TmdbMovieDetails } from '../types/tmdb';
import type { LightMovie } from '../types/lightIndex';

// ✅ Inline type import (quand on importe aussi des valeurs du même module)
import { getIconUrl, type LightIndexes } from '../types/lightIndex';

// ❌ Mélanger types et valeurs sans annotation
import { TmdbMovieDetails, tmdbApi } from '../services/tmdb';
```

> **Note** : les fichiers `types/*.ts` exportent parfois des fonctions utilitaires (ex: `getIconUrl`, `NO_TMDB_ID`). Dans ce cas, l'import mixte avec `import { fn, type T }` est acceptable.

### Type Guards

```typescript
// ✅ Type guards dans utils/itemHelpers.ts
function isIptvStream(item: IptvItem): item is IptvStream {
  return 'stream_id' in item;
}
```

### TMDB ID Normalization

```typescript
// ✅ Toujours normaliser avant comparaison
import { normalizeTmdbId, hasValidTmdbId } from '../utils/normalizeTmdb';

const id = normalizeTmdbId(item.tmdb); // "0" → 0, undefined → 0
if (hasValidTmdbId(id)) { /* ID valide (> 0) */ }

// ❌ NE JAMAIS faire de comparaison directe
if (s.tmdb === identifier.tmdbId) // BUG: "0" !== 0
```

---

## 7. Tests

### Structure

```
src/
├── __tests__/App.test.tsx            # Tests App orchestrateur
├── components/Player/__tests__/      # Tests par sous-dossier
├── hooks/__tests__/                  # Tests hooks
├── services/__tests__/              # Tests services
└── utils/__tests__/                 # Tests utils
```

### Nommage

```typescript
describe('ModuleName', () => {
  describe('Rendu', () => {
    it('affiche le bouton play', () => {});
    it('n\'affiche pas le menu quand fermé', () => {});
  });
  describe('Interactions', () => {
    it('appelle onPlay au clic', () => {});
  });
});
```

### Règle « 1 bug = 1 test »

Tout correctif de bug ajoute, **dans la même PR**, de quoi empêcher le bug de revenir :

1. **Un test automatique qui échoue sans le correctif** et passe avec. On le vérifie une fois en
   relançant le test sans le correctif : il doit échouer. Un test qui passe dans les deux cas ne
   protège de rien. Le test décrit le symptôme vu par l'utilisateur (« le menu caché ne prend pas
   le focus »), pas le détail du code corrigé. Pour un bug Rust, le test se lance avec
   `cargo test` ; pour un bug Kotlin, il n'est exécuté qu'à la CI complète : la PR le signale.
2. **Si le bug ne se reproduit pas automatiquement** (rendu réel, vraie télécommande, vraie vidéo,
   comportement propre à un appareil ou au bundle de production) : une vérification manuelle
   décrite dans la PR : comment reproduire le bug, sur quel appareil, et ce qui doit se passer. La
   description de la PR explique aussi pourquoi un test automatique n'est pas possible.

Les deux se cumulent quand c'est utile : le test automatique couvre la logique, la vérification
manuelle couvre l'appareil (exemple : la télécommande dans le lecteur TV, tests de `usePlayerRemote` et
de `spatialNavigation` plus un essai sur la télé).

### Pattern TestConsumer (pour Contextes)

```tsx
function TestConsumer() {
  const ctx = useSession();
  return <div data-testid="state">{JSON.stringify(ctx)}</div>;
}

render(
  <SessionProvider>
    <TestConsumer />
  </SessionProvider>
);
```

### Mocks

```typescript
// vi.mock pour les services
vi.mock('../services/dbCore', () => ({
  getDatabase: vi.fn().mockResolvedValue({
    select: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Props par défaut
const defaultProps = {
  onPlay: vi.fn(),
  onBack: vi.fn(),
};
```

---

## 8. SQLite (via Tauri Rust)

### Convention d'accès

```typescript
// ✅ Bon — via Repository
import { getAllMovies } from '../services/movieRepository';
const movies = await getAllMovies();

// ✅ Bon — via Service
import { getPlaybackProgress } from '../services/playbackProgressService';

// ❌ Mauvais — accès direct réservé aux repositories/services
import { getDatabase } from '../services/dbCore';
```

### Écriture

L'écriture dans SQLite se fait **uniquement côté Rust** (ingestion catalogue, ingestion EPG).
Côté JS, seules les tables de métadonnées (preferences, progress, watchlist, cache) sont modifiées.

### Full Reset (remise à zéro)

```
Reset (fullResetService.ts)          Login (useSessionLifecycle.ts)
═══════════════════════════           ════════════════════════════════
1. Clear Keychain                    1. getDatabase() → recrée .db + migrations
2. Clear localStorage                2. ingestCatalog() → Rust écrit
3. Clear Cache API                   3. refreshConnection() → WAL sync
4. db.close() + singleton = null     4. buildIndexes()
5. Rust: delete .db + .wal + .shm
```

**Règles** :
- Le login est **auto-réparant** : `getDatabase()` avant `ingestCatalog()` garantit que le .db existe avec ses tables
- `purgeAllTables()` dans `dbCore.ts` est **dev-only** (console `debugClearSQLite`), pas utilisé en prod
- `fullReset()` (dans `useSessionLifecycle.ts`, exposé via `SessionContext`) remet le state React à zéro, appelé **après** `performFullReset()`

### Ressources bundlées Tauri

```rust
// ✅ Bon — un programme lancé par l'app est résolu côté Rust, jamais choisi par la page web
let path = app.path().resolve("mpv/mpv.exe", tauri::path::BaseDirectory::Resource)?;
```

```typescript
// ✅ Bon — un asset (image, fichier de données) peut être résolu côté web
import { resolveResource } from '@tauri-apps/api/path';
const asset = await resolveResource('assets/exemple.json');

// ❌ Mauvais — Chemin hardcodé ou relatif fragile
const mpvPath = 'C:\\Program Files\\mpv\\mpv.exe';
```

**Convention** : Tout binaire ou asset distribué avec l'app doit :
1. Être déclaré dans `tauri.conf.json` (`bundle.resources`)
2. Être résolu au runtime (`resolveResource()` côté web pour un asset ; côté Rust pour un programme)
3. Ne jamais utiliser de chemin absolu ou relatif hardcodé

**Exemple** : `mpv.exe` est dans `resources/mpv/`, déclaré dans la config Tauri. Son chemin est fixé
dans `src-tauri/src/mpv_guard.rs` (`nyx_mpv_init`) : depuis la mise en liste blanche, la page web ne choisit plus
le programme lancé ni ses options, et n'envoie à mpv que les commandes dont l'app se
sert (`nyx_mpv_command`) ; les marges vidéo passent par `nyx_mpv_set_margins`. Une nouvelle commande ou propriété mpv utilisée par l'app s'ajoute à ces
listes blanches, avec un test (un test vérifie que chaque `setProperty` de `src/` y figure).

---

## 9. i18n

### Usage

```typescript
const { t } = useTranslation('dashboard');
<span>{t('carousel_trending')}</span>

// ❌ Texte hardcodé interdit
<span>Tendances</span>
```

### Namespaces (9 fichiers FR + 9 EN)

`auth`, `common`, `dashboard`, `details`, `navigation`, `player`, `search`, `settings`, `tv`

---

## 10. Anti-Patterns à Éviter

| ❌ Éviter | ✅ Préférer |
|-----------|-------------|
| État redondant | Calculer dans render / useMemo |
| Prop drilling > 2 niveaux | Context ou hooks |
| useEffect pour transformer data | useMemo |
| Strings magiques | Constantes / types union |
| `any` | Types stricts ou `unknown` |
| Index comme key | ID unique |
| `console.*` direct | `createLogger('Zone')` (journal central) ou `devLog(category, msg)` |
| `position: absolute` pour layout | Flexbox / CSS Grid |
| Fichier > 500 lignes (repère) | Extraire un morceau autonome s'il y en a un, sinon laisser |
| `CREATE TABLE` inline (Rust) | Utiliser `crate::schema::*` constantes |
| `ALTER TABLE` inline (Rust) | Utiliser `crate::schema::run_auto_repair()` |

---

## 11. Git

### Messages de Commit

```
type(scope): description courte

Types: feat, fix, refactor, test, docs, style, chore

Exemples:
feat(player): add speed menu component
fix(dashboard): resolve TMDB cache issue
refactor(helpers): extract tmdbMatching module
test(hooks): add useSmartLock tests
```

---

## 12. Memory Purge

### Convention

```typescript
// ✅ Changement de page/tab → purge immédiate
import { forceMemoryPurge } from '../services/memoryService';
forceMemoryPurge();

// ✅ Scroll → purge debounced
import { requestMemoryPurge } from '../services/memoryService';
requestMemoryPurge(); // 1s debounce

// ✅ Player open/close → mode Low/Normal
import { enterPlayerMode, exitPlayerMode } from '../services/memoryService';
enterPlayerMode();  // set_memory_low permanent
exitPlayerMode();   // set_memory_normal + purge

// ✅ Démontage de listes avec images (optimisé)
import { requestMemoryPurge } from '../services/memoryService';
useEffect(() => {
  return () => {
    if (hadImagesRef.current) requestMemoryPurge();
  };
}, []);

// ❌ Ne jamais appeler invoke('trim_memory') directement
// ❌ Ne jamais appeler invoke('set_memory_low') directement
```

**Règle** : Toute purge mémoire passe par `memoryService.ts` — jamais d'appel `invoke()` direct.

---

_Dernière mise à jour : 9 Avril 2026_

---

## 13. Sécurité

> Règles obligatoires validées par l'audit de sécurité (9 Avril 2026).

### Interdictions Absolues

| ❌ INTERDIT | Raison |
|-----------|--------|
| `dangerouslySetInnerHTML` | Vecteur XSS direct |
| `eval()`, `new Function()` | Exécution de code arbitraire |
| `innerHTML` / `outerHTML` | Vecteur XSS direct |
| Concaténation SQL (`${var}`) | Injection SQL — utiliser `?` placeholders |
| Credentials en localStorage/SQLite | Utiliser OS Keychain (commandes `nyx_secret_*`, `secret_vault.rs`) |
| `openUrl()` avec URL dynamique | Open redirect — URLs hardcodées uniquement |
| Chemins fichier depuis input utilisateur | Path traversal — valider via `validate_db_name()` |

### Obligations

```typescript
// ✅ SQL : toujours paramétrisé
await db.execute('INSERT INTO table (col) VALUES (?)', [value]);
await db.select('SELECT * FROM search_index WHERE name MATCH ?', [query]);

// ✅ Credentials : le journal central masque les URLs IPTV (texte, erreurs, objets)
import { createLogger } from '../utils/logger';
const log = createLogger('MPV');
log.info('loadfile →', url);
// Hors journal central, masquer soi-même : console.info('[MPV]', sanitizeIptvUrl(url));

// ✅ JSON parsing : toujours avec fallback
function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; }
  catch { return fallback; }
}

// ✅ Erreurs : afficher via React text interpolation (auto-escape)
<div>{errorMessage}</div>  // React échappe automatiquement

// ❌ JAMAIS de HTML brut pour afficher des données
element.innerHTML = userProvidedData;
```

### Checklist pour nouveau service

1. Les queries SQL utilisent `?` placeholders ?
2. Les credentials ne sont jamais loguées en clair ?
3. Les URLs IPTV sont scrubées avant `console.*` ou Sentry ?
4. Les accès fichier passent par `validate_db_name()` (Rust) ?
5. Aucun `innerHTML` / `dangerouslySetInnerHTML` ?
6. Les `import.meta.env` sont `VITE_*` (publiques) ou `DEV` flags ?

### Variables d'environnement

```typescript
// ✅ Autorisé côté frontend (publiques par définition)
import.meta.env.VITE_SUPABASE_URL
import.meta.env.VITE_SUPABASE_ANON_KEY  // anon key = publishable, pas secret
import.meta.env.VITE_SENTRY_DSN
import.meta.env.DEV  // flag dev mode

// ❌ JAMAIS côté frontend
// SUPABASE_SERVICE_ROLE_KEY, TMDB_API_KEY, clés privées
// → Utiliser Supabase Edge Functions (proxy serveur)
```
