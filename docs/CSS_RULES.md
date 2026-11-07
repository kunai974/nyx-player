# Règlement CSS de Nyx Player

> S'applique à tout le CSS de `src/`, pour les trois plateformes (Windows, téléphone,
> Android TV). Configuration : [`stylelint.config.mjs`](../stylelint.config.mjs).
> Recettes et jetons de la version bureau (avril 2026) : [`CSS_PATTERNS.md`](CSS_PATTERNS.md),
> [`DESIGN_TOKENS.md`](DESIGN_TOKENS.md).

## 1. Fonctionnement

- Ce qui se vérifie en lisant le CSS est vérifié **automatiquement** par Stylelint, à chaque
  modification : `pnpm lint:css` en local, et dans la CI GitHub. Le reste (section 3) sera mesuré
  sur l'écran réel par l'outil de vérification de l'affichage.
- **Le CSS ancien est gelé** dans `stylelint-suppressions.json` (477 alertes au 21/09), fichier par
  fichier et règle par règle. Tout ajout qui dépasse ce compte fait échouer la vérification : le code
  nouveau ou modifié doit respecter le règlement.
- **Résorber l'ancien** : corriger par lots. Quand `pnpm lint:css` passe, `pnpm lint:css --suppress`
  resserre le gel sur ce qui reste. **Jamais** pour faire passer une alerte nouvelle.
- **Exception ponctuelle** : un commentaire qui donne la raison, sinon Stylelint la refuse (une
  exception devenue inutile est refusée aussi) :

  ```css
  /* stylelint-disable-next-line defensive-css/no-fixed-sizes -- affiche TMDB au ratio fixe 2:3 */
  ```

  Ces commentaires forment le registre des exceptions ponctuelles (`grep -rn "stylelint-disable" src`).

## 2. Règles vérifiées automatiquement

| Règle Nyx | Règle Stylelint | Pourquoi |
|---|---|---|
| Pas de `!important` | `declaration-no-important` | Une priorité passe par la spécificité ou la surcouche de plateforme. Les `!important` ont causé les conflits entre le CSS bureau et les surcouches |
| Pas de survol nu | `defensive-css/no-accidental-hover` | `:hover` dans `@media (hover: hover)` : sur téléphone, un toucher laisse l'élément « survolé » ; la télécommande ne survole pas |
| Tailles encadrées, pas fixes | `defensive-css/no-fixed-sizes` | Largeur, hauteur, taille de texte, marges en pixels cassent chez les autres appareils. Les points de rupture en px restent permis |
| Focus visible | `defensive-css/require-focus-visible` | `:focus-visible` plutôt que `:focus` : le liseré apparaît au clavier et à la télécommande, pas au clic |
| Hauteur d'écran réelle | `defensive-css/require-dynamic-viewport-height` | `100vh` ignore les barres et le clavier d'un navigateur de téléphone. Dans Nyx, `100dvh` est refusé par la règle WebView (Chrome 108+, cible Chrome 90) : on garde `100vh` avec l'exception écrite, voir le registre |
| Passage à la ligne décidé | `defensive-css/require-flex-wrap` | Un conteneur flex déclare `wrap` ou `nowrap` : cause des libellés écrasés des Paramètres (v6) |
| Colonnes qui rétrécissent | `defensive-css/require-grid-minmax` | `minmax(0, 1fr)` plutôt que `1fr`, qu'un long mot fait déborder |
| Pas de défilement en chaîne | `defensive-css/require-overscroll-behavior` | Une liste ou une fenêtre qui défile ne fait pas défiler la page derrière (bug de la recherche Live TV, v8). `overscroll-behavior: auto` écrit = comportement par défaut gardé tel quel (lot qualité A2, 30/10) ; `contain` se choisit écran par écran, avec un essai sur appareil |
| Images de fond maîtrisées | `defensive-css/require-background-repeat` | Pas de répétition imprévue sur un grand écran |
| Polices de secours | `defensive-css/require-system-font-fallback` | Une police qui ne charge pas retombe sur une police système |
| `clamp()` sûr, `will-change` mesuré | `no-unsafe-clamp-font-size`, `no-unsafe-will-change` | Zoom du texte respecté ; pas de calques GPU permanents (coûteux sur le Chromecast) |
| Préfixes cohérents | `no-mixed-vendor-prefixes` | |
| Compris par les box TV | `plugin/no-unsupported-browser-features` (Chrome 90) | WebView minimale visée le 21/09 : box Android TV 9+ à jour, Fire TV, Chromecast. Une règle inconnue d'une vieille WebView est ignorée en entier et casse la mise en page |
| Erreurs de CSS | `stylelint-config-recommended` | Propriétés inconnues ou obsolètes, doublons, valeurs invalides |

## 3. Règles vérifiées sur l'écran (outil de vérification de l'affichage, à construire)

| Règle Nyx | Mesure prévue |
|---|---|
| **Largeurs réelles des appareils** : téléphone 320, **360** (la plus répandue, S21 FE d'usine), 411, 480 points, tablette ; TV : toile 1280 × 720 | Aucun débordement horizontal à chaque largeur |
| **Tailles encadrées** : une grille choisit le nombre de colonnes qui garde une carte entre ≈ 92 et 150 points (décision du 17/09) ; aucune valeur fixe ne décide seule de la mise en page | Taille des cartes mesurée dans la fourchette, à chaque largeur |
| **Textes** : ni coupés, ni chevauchés, ni écrasés par un contrôle voisin | Débordements de texte et chevauchements |
| **Focus** : visible, entier (pas rogné par un conteneur qui défile), jamais seulement au survol | Liseré entièrement dans la zone visible ; contenu du survol présent au focus sur TV |
| **Zones tactiles** : au moins 44 points sur téléphone | Taille des éléments cliquables |
| **Contraste** lisible, y compris à 3 m sur TV | axe-core |
| **Surcouches préfixées** : toute règle de `mobile.css` sous `.nyx-mobile`, de `tv.css` sous `.nyx-tv` | Déjà vérifié par les tests (`src/styles/__tests__`) |
| **Rendu jugé sur le bundle de production** (APK, émulateurs, app Windows) : l'ordre du CSS y diffère de la prévisualisation | L'outil tourne sur les émulateurs et l'app Windows |

## 4. Registre des exceptions

**Règles du plugin désactivées** (contraires aux choix de Nyx, ou reportées) :

| Règle | Alertes au 21/09 | Raison |
|---|---|---|
| `require-at-layer` | 1 558 | Nyx n'utilise pas `@layer` : l'ordre App.css → mobile.css → tv.css et le préfixe de marque font ce travail. Y passer serait un chantier à part |
| `require-custom-property-fallback` | 2 402 | Tous les jetons sont définis dans `:root` (App.css) ; une valeur de secours dupliquerait chaque jeton |
| `no-user-select-none` | 12 | Choix de la v12 : pas de sélection de texte à l'appui long sur téléphone et TV ; les champs de saisie restent sélectionnables |
| `no-list-style-none` | 2 | Le problème visé concerne VoiceOver sur Safari, absent des cibles (WebView2, WebView Android) |
| `require-prefers-reduced-motion` | 84 | **Reportée, pas rejetée** : à traiter avec l'optimisation TV (mode allégé) |
| `require-scrollbar-gutter` | 34 | Décalage à l'apparition d'une barre de défilement, sous Windows seulement : à réévaluer si l'audit de l'affichage le mesure |
| `require-forced-colors-focus` | 2 | Mode contraste élevé de Windows, non prioritaire : à réévaluer |
| `require-named-grid-lines`, `require-pure-selectors` | 7, 14 | Conventions d'écriture sans effet sur l'affichage |
| `no-descending-specificity` (Stylelint) | 24 | Les surcouches `.nyx-mobile` / `.nyx-tv` surchargent volontairement le bureau |

**Supports partiels tolérés** par la règle WebView (`ignorePartialSupport`) : masques (`mask-image`, toujours doublé de `-webkit-mask-image` dans Nyx), barres de défilement stylées, `position: sticky` et `display: contents` (limites mineures sur Chrome 90).

**Alerte ancienne réglée** : le `:has()` de `SettingsCarousels.css` (Chrome 105+, gelé le 21/09) est remplacé le 30/10 par une classe posée dans le composant (`settings-section--carousels`).

**Exceptions par fichier** :

| Fichier | Règle désactivée | Raison |
|---|---|---|
| `src/styles/tv.css` | `no-fixed-sizes` | Toile fixe de 1280 × 720 mise à l'échelle de l'écran : le pixel y est la bonne unité |
| `src/styles/tv.css` | `require-focus-visible` | La télécommande ne produit pas toujours `:focus-visible` dans la WebView : `:focus` sous `:not(.nyx-pointer)`, qui retire le cadre après un clic souris |
| Tous | `no-fixed-sizes` sur `@media` / `@container` | Points de rupture en px admis par `CONVENTIONS.md` |

**Exceptions ponctuelles** (registre : `grep -rn "stylelint-disable" src`), en plus de celles de leur fichier :

| Règle | Où | Raison |
|---|---|---|
| `require-dynamic-viewport-height` | 11 hauteurs en `100vh` (App.css, pages, mobile.css) | La WebView de Nyx n'a pas de barre d'adresse : `100vh` et `100dvh` y valent la même chose, et `dvh` est inconnu avant Chrome 108 (une déclaration inconnue est ignorée en entier sur une vieille box) |
| `require-focus-visible` | `:focus` général d'App.css | Remise à zéro voulue : pas de contour au clic ni au toucher ; le contour clavier et télécommande vient de la règle `:focus-visible` qui suit |
| `declaration-no-important` | App.css (fond de `html`/`body`, lecteur transparent, interface masquée), tv.css (contour des boutons ronds), ChannelGrid.css (`overflow` de react-window), ContentCarousel.css (cartes-boutons) | Seul un `!important` bat un style en ligne (anti-flash d'`index.html`, react-window) ou un autre `!important` (contre-règles TV). Posées le 02/11, comme étape « raisons écrites » du lot C : le CSS produit est identique octet pour octet |
| `no-accidental-hover` | ContentCarousel.css (7 survols), CategoryDetailPage.css (carte de catégorie), mobile.css (rustine de la barre latérale) | tv.css annule le survol de bureau des cartes sur TV avec les mêmes sélecteurs, sans media ; entourer ces survols de `(hover: hover)` changerait cet équilibre dans la zone fluidité validée. Sur téléphone, la rustine annule volontairement le survol au doigt |
| `no-fixed-sizes` | EpisodeSwitcher.css (panneau des épisodes du lecteur : plafond de 450 px, indicateur de chargement, vignette 16:9, équaliseur) | Éléments décoratifs ou à ratio fixe, ou borne de confort d'un panneau déjà en pourcentage. Raisons écrites le 04/11 ; la vérification en « grand texte » sur téléphone a été jugée inutile le 06/11 (cas trop rare). Le gel Stylelint est à 0 |
