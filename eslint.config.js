import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import i18next from 'eslint-plugin-i18next';
import tseslint from 'typescript-eslint';

// Règles de qualité. Les écarts déjà présents dans le code sont gelés dans
// eslint-suppressions.json : seule une nouvelle erreur fait échouer `pnpm lint`.

/** Fichiers gelés tant que la branche du banc de tests n'est pas fusionnée : hors des règles strictes. */
const FROZEN_FILES = [
  'src/services/player/mpvApi.ts',
  'src/services/mpvBridge.ts',
  'src/main.tsx',
  'src/dev/auditBridge.tsx',
  'src/dev/auditBridge.test.tsx',
  'src/dev/preview/**',
];

const TEST_FILES = ['src/**/__tests__/**', 'src/**/*.test.{ts,tsx}', 'src/test/**'];

/** Écrans et outils de développement, jamais montrés aux utilisateurs. */
const DEV_FILES = ['src/dev/**', 'src/components/DevPanel.tsx'];

/** Attributs lus ou affichés à l'utilisateur : leur texte passe par i18n comme le texte visible. */
const TRANSLATED_ATTRIBUTES = '/^(aria-label|title|placeholder)$/';
/** Texte contenant au moins un mot (deux lettres), sauf les adresses d'exemple (« http://… »). */
const WORDY_LITERAL = 'Literal[value=/^(?!https?:)[^]*\\p{L}{2}/u]';
const UNTRANSLATED_ATTRIBUTE_MESSAGE =
  'Texte non traduit dans aria-label, title ou placeholder : utiliser t(…) (fr et en dans src/i18n).';

export default tseslint.config(
  { ignores: ['dist', 'out', 'graphify-out', 'src-tauri', 'web'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    linterOptions: {
      // Une directive eslint-disable devenue inutile cache une future erreur : la retirer.
      reportUnusedDisableDirectives: 'error',
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      // Analyse avec les types : nécessaire aux règles sur les promesses ci-dessous.
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'i18next': i18next,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Dépendance oubliée d'un effet = valeur périmée à l'écran : bloquant.
      'react-hooks/exhaustive-deps': 'error',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      // Le préfixe « _ » marque une variable volontairement inutilisée.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      // Promesses : un rejet ni attendu ni capturé disparaît sans trace (ou casse la suite).
      // Lancer sans attendre : `void maPromesse()` si l'échec est géré ailleurs.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/only-throw-error': ['error', { allowThrowingUnknown: true }],
      // Un `switch` sur une union doit traiter chaque cas (ou avoir un `default`).
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      // `==` seulement pour comparer à null.
      'eqeqeq': ['error', 'smart'],
      // Journal central (src/utils/logger.ts) : niveaux et identifiants IPTV masqués d'office.
      'no-console': 'error',
      // i18n : Détecte les textes non traduits (mode recommandé: jsx-text-only)
      'i18next/no-literal-string': ['error', {
        mode: 'jsx-text-only',
        // Ignorer emojis, symboles, caractères uniques, unités courtes
        words: {
          exclude: [
            // Emojis et symboles (✓, ❌, ⚠️, 📺, ▼) : expression avec le drapeau « u », sans lequel
            // \p{…} n'est pas reconnu (le plugin compile les textes sans drapeau).
            /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200D\uFE0F\p{Symbol}\s]+$/u,
            '^.$',                          // Caractères uniques
            '^\\d+[smhx%]?$',               // Nombres avec unités (10s, 50%, 2x)
            '^(min|max|px|rem|vh|vw)$',     // Unités CSS/temps
            '^https?://',                   // URLs
            '^[A-Z][a-z]+$',                // Noms propres (Phoenix, TMDB)
          ],
        },
        // (Les options contenant une expression ne comptent pas dans l'empreinte de `eslint --cache` :
        // après les avoir modifiées, effacer le cache.)
        // Ignorer les composants i18n
        'jsx-components': {
          exclude: ['Trans'],
        },
        // Ignorer les attributs techniques
        'jsx-attributes': {
          exclude: [
            'className', 'class', 'style', 'type', 'key', 'id', 'name',
            'href', 'src', 'alt', 'role', 'data-testid', 'htmlFor',
            'viewBox', 'fill', 'stroke', 'd', 'strokeWidth',
            'xmlns', 'width', 'height', 'value', 'min', 'max', 'step',
          ],
        },
      }],
      // i18n des attributs lus à l'utilisateur (le mode jsx-text-only ne les voit pas) :
      // title="…", title={'…'}, title={cond ? '…' : '…'}, title={x || '…'} et title={`… ${x}`}.
      'no-restricted-syntax': ['error',
        { selector: `JSXAttribute[name.name=${TRANSLATED_ATTRIBUTES}] > ${WORDY_LITERAL}`, message: UNTRANSLATED_ATTRIBUTE_MESSAGE },
        { selector: `JSXAttribute[name.name=${TRANSLATED_ATTRIBUTES}] > JSXExpressionContainer > ${WORDY_LITERAL}`, message: UNTRANSLATED_ATTRIBUTE_MESSAGE },
        { selector: `JSXAttribute[name.name=${TRANSLATED_ATTRIBUTES}] > JSXExpressionContainer > ConditionalExpression > ${WORDY_LITERAL}`, message: UNTRANSLATED_ATTRIBUTE_MESSAGE },
        { selector: `JSXAttribute[name.name=${TRANSLATED_ATTRIBUTES}] > JSXExpressionContainer > LogicalExpression > ${WORDY_LITERAL}`, message: UNTRANSLATED_ATTRIBUTE_MESSAGE },
        { selector: `JSXAttribute[name.name=${TRANSLATED_ATTRIBUTES}] > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/\\p{L}{2}/u]`, message: UNTRANSLATED_ATTRIBUTE_MESSAGE },
      ],
    },
  },
  {
    // Sens unique : les outils de test (src/dev) se branchent sur l'appli par ses prises
    // (src/services/outilsTest.ts) ; l'appli ne les importe jamais. Seule porte : main.tsx.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/dev/**', 'src/main.tsx', ...TEST_FILES],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/dev', '**/dev/*', '**/dev/**'],
          message: "Le code de l'appli n'importe pas src/dev : passer par une prise de src/services/outilsTest.ts, branchée dans src/dev/prises.ts.",
        }],
      }],
    },
  },
  {
    // Le journal central et les traces de développement écrivent eux-mêmes dans la console.
    files: ['src/utils/logger.ts', 'src/utils/devLog.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: TEST_FILES,
    rules: {
      // Les tests imitent Tauri, dont les commandes échouent avec un simple texte.
      '@typescript-eslint/only-throw-error': 'off',
      'no-console': 'off',
      'i18next/no-literal-string': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: DEV_FILES,
    rules: {
      'no-console': 'off',
      'i18next/no-literal-string': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    // Règles strictes désactivées sur les fichiers gelés : comportement d'avant pour eux.
    files: FROZEN_FILES,
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'off',
      'eqeqeq': 'off',
      'no-console': 'off',
      'i18next/no-literal-string': 'warn',
      'no-restricted-syntax': 'off',
    },
  },
);
