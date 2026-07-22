module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist', 'node_modules', 'scripts/.cache', '*.cjs'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'smart'],
  },
  overrides: [
    {
      // The simulation must stay reproducible. `Math.random()` has global,
      // unseedable, unsaveable state: a single call makes replays, saves and
      // desync-free multiplayer impossible, and the damage is silent. Use
      // `world.rng`, whose state is saved and hashed with everything else.
      files: ['src/core/**/*.ts'],
      excludedFiles: ['**/*.test.ts'],
      rules: {
        'no-restricted-properties': [
          'error',
          {
            object: 'Math',
            property: 'random',
            message: 'Use world.rng (see src/core/math/random.ts) — Math.random breaks determinism.',
          },
        ],
      },
    },
    {
      // The map pipeline is a Node script, not browser code.
      files: ['scripts/**/*.mjs'],
      env: { node: true, browser: false },
      // Progress output is the whole point of a CLI script.
      rules: { 'no-console': 'off' },
    },
  ],
};
