// @ts-check
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

/**
 * The boundary rules ARE the architecture (ADR-0001). They are a build failure,
 * not a review comment, because the rule that decays first is `app/*` importing
 * `db/*` to "just run one query".
 */

/** One `boundaries` v7 policy: element `type` may import only `allowedTypes`. */
const policy = (type, allowedTypes) => ({
  from: [{ element: { type } }],
  allow: allowedTypes.map((t) => ({ to: { element: { type: t } } })),
});
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist/**',
      'coverage/**',
      '*.config.mjs',
      // Spike artefacts are evidence, kept exactly as they were run.
      'docs/**',
    ],
  },

  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'scripts/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['src/**/*'],
      'boundaries/elements': [
        { type: 'shared', pattern: 'src/shared/**' },
        { type: 'config', pattern: 'src/config/**' },
        { type: 'db', pattern: 'src/db/**' },
        { type: 'domain', pattern: 'src/modules/*/domain/**' },
        { type: 'app-layer', pattern: 'src/modules/*/application/**' },
        { type: 'infra', pattern: 'src/modules/*/infrastructure/**' },
        { type: 'module-api', pattern: 'src/modules/*', partialMatch: false },
        { type: 'transport', pattern: ['src/app/**', 'src/worker/**'] },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          // v7 syntax: `policies`, with object entity selectors.
          policies: [
            // The core rule: the domain layer is pure.
            policy('domain', ['shared', 'domain']),
            policy('app-layer', ['shared', 'domain', 'module-api', 'config']),
            policy('infra', ['shared', 'domain', 'db', 'config']),
            policy('module-api', ['shared', 'domain', 'app-layer', 'infra']),
            policy('transport', ['shared', 'module-api', 'config']),
            policy('shared', ['shared']),
            policy('db', ['shared', 'config', 'db']),
            policy('config', ['shared']),
          ],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Everything outside db/ reaches the database through withTenant(ctx, fn).
  // There is no other path — that is what makes invariant 1 hold.
  //
  // NOTE: `src/modules/*/domain/**` is excluded here and handled by the block
  // BELOW. In flat config a later block replaces `no-restricted-imports`
  // wholesale rather than merging, so overlapping `files` globs silently
  // disable the stricter rule. Caught by deliberately violating it (§11.7).
  {
    files: ['src/app/**/*.ts', 'src/app/**/*.tsx', 'src/worker/**/*.ts', 'src/modules/**/*.ts'],
    ignores: ['src/modules/*/infrastructure/**', 'src/modules/*/domain/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/db/pool', '**/db/pool.js', '@db/pool', '@db/pool.js'],
              message: 'Use withTenant(ctx, fn) — there is no other path to the database (§5.4).',
            },
            {
              group: ['**/modules/*/domain/**', '**/modules/*/infrastructure/**'],
              message: 'Import a module through its index.ts only (ADR-0001).',
            },
          ],
        },
      ],
    },
  },

  // The domain layer imports NOTHING from a framework, an ORM or an SDK.
  // Unit-testable with no database, or it is not domain logic (ADR-0001).
  // Placed AFTER the block above so it wins for domain files.
  {
    files: ['src/modules/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'next', 'next/*', 'react', 'react-dom',
                'drizzle-orm', 'drizzle-orm/*', 'pg', 'pg-boss',
                '@aws-sdk/*', '@sentry/*', '@node-rs/*', 'next-intl',
              ],
              message:
                'domain/ must stay framework-free and unit-testable without a database (ADR-0001).',
            },
            {
              group: ['**/db/**', '@db/*'],
              message: 'domain/ never touches the database layer (ADR-0001).',
            },
            {
              group: ['**/modules/*/domain/**', '**/modules/*/infrastructure/**'],
              message: 'Import another module through its index.ts only (ADR-0001).',
            },
          ],
        },
      ],
    },
  },

  // Money arithmetic lives in one place, so the rounding rule cannot be
  // reimplemented per module (invariant 2).
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/shared/money.ts', 'src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'BinaryExpression[operator=/^[*/%+-]$/] > MemberExpression.left > Identifier.property[name="minor"]',
          message:
            'Arithmetic on Money.minor belongs in shared/money.ts — use Money.add/sub/mulRatio/allocate (invariant 2).',
        },
      ],
    },
  },

  // Tests may reach further than production code.
  {
    files: ['src/**/*.test.ts', 'scripts/**/*.ts'],
    rules: {
      'boundaries/dependencies': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
