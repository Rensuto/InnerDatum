// @ts-check
//
// Inner Datum — ESLint flat config (ESLint 9/10; eslintrc is gone in 10).
//
// This file exists to make the plan's working rules MECHANICAL. Six rule
// groups do essentially all of the work:
//
//   1. src/shared/ determinism — the gap tsconfig.shared.json cannot close.
//   2. No async anywhere in the turn engine.
//   3. Layering (shared ⊅ server|client, client ⊅ server, engine ⊅ I/O).
//   4. no-floating-promises + no-misused-promises.
//   5. switch-exhaustiveness-check.
//   6. No innerHTML in the client.
//
// Anything that is merely taste has been deleted. There are NO formatting
// rules here at all — Prettier owns formatting, and because zero stylistic
// rules are enabled, eslint-config-prettier is unnecessary (one fewer
// dependency in a public repo).
//
// DEPENDENCIES: @eslint/js and typescript-eslint. That is the whole list.
// Requires "type": "module" in package.json.
//
// MERGE SEMANTICS, IMPORTANT: flat-config `rules` entries REPLACE per rule
// name, they do not deep-merge. `src/server/engine/**` matches both the server
// block and the engine block, so the engine block re-states everything it
// still wants. The shared arrays below exist so those restatements cannot
// silently drift apart.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const PURE =
  'src/shared/ and the engine must stay deterministic and platform-free — seeded replay and every unit test depend on it.';
const SYNC =
  'Turn resolution is fully synchronous; that synchronicity IS the mutex. Hoist the I/O to the caller.';

// ---------------------------------------------------------------------------
// Reusable restriction sets
// ---------------------------------------------------------------------------

/** Makes the turn engine structurally unable to become asynchronous. */
const NO_ASYNC_SYNTAX = [
  { selector: 'AwaitExpression', message: SYNC },
  { selector: 'FunctionDeclaration[async=true]', message: SYNC },
  { selector: 'FunctionExpression[async=true]', message: SYNC },
  { selector: 'ArrowFunctionExpression[async=true]', message: SYNC },
  { selector: 'ForOfStatement[await=true]', message: SYNC },
  { selector: "NewExpression[callee.name='Promise']", message: SYNC },
  { selector: "MemberExpression[object.name='Promise']", message: SYNC },
];

/** Closes the determinism holes the empty-lib tsconfig cannot: these are ES built-ins. */
const NO_NONDETERMINISM_SYNTAX = [
  {
    selector: "NewExpression[callee.name='Date']",
    message: `${PURE} Take the turn or tick number as a parameter.`,
  },
  {
    selector: "CallExpression[callee.name='Date']",
    message: `${PURE} Take the turn or tick number as a parameter.`,
  },
  {
    selector: "MemberExpression[object.name='globalThis']",
    message: `${PURE} globalThis is a bypass route around every rule in this block.`,
  },
];

const NO_NONDETERMINISM_PROPERTIES = [
  { object: 'Date', property: 'now', message: `${PURE} Pass the turn number in.` },
  {
    object: 'Math',
    property: 'random',
    message: `${PURE} Use the seeded PCG32 in src/shared/rng.ts.`,
  },
  { object: 'performance', property: 'now', message: PURE },
  {
    object: 'crypto',
    property: 'randomUUID',
    message: `${PURE} Server-generated ids belong in src/server/, not the sim.`,
  },
  {
    object: 'crypto',
    property: 'getRandomValues',
    message: `${PURE} Use the seeded PCG32 in src/shared/rng.ts.`,
  },
];

/**
 * Branded types with exactly ONE sanctioned producer each. A cast is the only
 * way to forge one, so casts are banned everywhere and the producer carries a
 * single `// eslint-disable-next-line no-restricted-syntax` with a reason.
 * That disable is a feature: it makes the one legal cast in the codebase
 * visible, and reportUnusedDisableDirectives fails the build if it goes stale.
 *
 * These selectors are inert until the types exist (M1-M2). That is deliberate —
 * they must be in place BEFORE the first cast, not retrofitted after fifty.
 */
const BRAND_PRODUCERS = {
  Projected:
    'src/server/view/projector.ts — the only place an unfiltered world becomes a PlayerView',
  DiscordUserId:
    'src/server/http/auth.ts — identity comes from a server-side GET /users/@me, never the wire',
  TurnBoundary: 'src/server/engine/scheduler.ts — only pump may declare a turn finished',
};

const NO_BRAND_CASTS = Object.entries(BRAND_PRODUCERS).map(([brand, producer]) => ({
  selector: `TSAsExpression[typeAnnotation.typeName.name='${brand}']`,
  message: `Do not cast to ${brand}. It has one producer: ${producer}.`,
}));

/** Host/platform globals that must never be reachable from deterministic code. */
const NO_PLATFORM_GLOBALS = [
  'process',
  'console',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'fetch',
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'XMLHttpRequest',
  'WebSocket',
  'Buffer',
  '__dirname',
  '__filename',
  'require',
].map((name) => ({ name, message: PURE }));

const NODE_BUILTIN_PATTERNS = [
  { group: ['node:*'], message: `${PURE} Node built-ins belong in src/server/.` },
  {
    group: [
      'fs',
      'fs/*',
      'path',
      'os',
      'crypto',
      'child_process',
      'worker_threads',
      'http',
      'https',
      'net',
      'tls',
      'dns',
      'zlib',
      'stream',
      'stream/*',
      'buffer',
      'util',
      'events',
      'process',
      'perf_hooks',
      'timers',
      'timers/*',
      'url',
      'v8',
      'vm',
      'module',
      'readline',
      'assert',
    ],
    message: `${PURE} Node built-ins belong in src/server/.`,
  },
];

const RUNTIME_PACKAGE_PATTERNS = [
  {
    group: ['fastify', '@fastify/*', 'pino', 'pino-*', 'ws', 'vite', '@discord/*'],
    message: `${PURE} Host-runtime packages belong in src/server/ or src/client/.`,
  },
];

const NO_CLIENT_PATTERNS = [
  {
    group: ['**/client/**', '**/client'],
    message: 'Server and shared code must never import client code.',
  },
];

const NO_SERVER_PATTERNS = [
  {
    group: ['**/server/**', '**/server'],
    message:
      'The client must never import server code — the server is authoritative and the client renders what it is sent.',
  },
];

const NO_COMBAT_MATH_PATTERNS = [
  {
    group: ['**/shared/checkhit*', '**/shared/scale*', '**/shared/energy*'],
    message:
      'No combat math in the client bundle. A second copy of the formula always diverges, and the divergence shows up as a monster that was already dead. Every displayed number (hit chance, damage preview, save odds) is computed server-side and sent.',
  },
];

const NO_IO_LAYER_PATTERNS = [
  {
    group: ['**/persist/**', '**/net/**', '**/ops/**', '**/http/**'],
    message:
      'The engine must not reach into I/O layers. Persistence is queued by the CALLER after pump returns.',
  },
];

/**
 * Hand-written rather than pulled from the `globals` package — one fewer
 * dependency, and this is the only place globals are needed (TypeScript files
 * get `no-undef` disabled by typescript-eslint, so only plain JS needs them).
 */
const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  fetch: 'readonly',
  crypto: 'readonly',
  performance: 'readonly',
  structuredClone: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'client/dist/**',
      'client/public/assets/**',
      'coverage/**',
      'data/**',
      'logs/**',
      'reference/**',
      'content/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,

  // Type-aware linting is not optional here: untyped rules cannot see promises,
  // so they cannot catch the bugs that actually kill this server. `recommended`
  // rather than `strict` on purpose — the strict preset's stylistic half
  // (no-unnecessary-condition, no-non-null-assertion) should only be turned on
  // once there is real ported ToME code to measure its false-positive rate
  // against. Revisit at M3;
  tseslint.configs.recommendedTypeChecked,

  // -------------------------------------------------------------------------
  // Project-wide
  // -------------------------------------------------------------------------
  {
    linterOptions: {
      // An eslint-disable that no longer suppresses anything is a lie about the
      // codebase. Make it a failure.
      reportUnusedDisableDirectives: 'error',
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- group 4: the bugs this project will actually have -----------------
      // no-misused-promises with checksVoidReturn is the load-bearing half and
      // the one usually forgotten: `socket.on('message', async (d) => {...})`
      // type-checks fine and turns every throw inside it into an
      // unhandledRejection that takes the process down.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: true, checksConditionals: true },
      ],

      // --- group 5: adding a protocol variant must break every switch --------
      // considerDefaultExhaustiveForUnions:false is the important setting — a
      // `default:` clause must NOT let you off the hook for a union, because
      // that is precisely the loophole that hides a missing case.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {
          allowDefaultCaseForExhaustiveSwitch: false,
          considerDefaultExhaustiveForUnions: false,
          requireDefaultForNonUnion: true,
        },
      ],

      // --- type-stripping correctness ---------------------------------------
      // Not style. A type-only value import survives erasure and dies at ESM
      // link time. `separate-type-imports` means the whole statement
      // disappears, so a types-only module is not loaded at runtime for nothing.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],

      // --- suppressions must expire -----------------------------------------
      // An expect-error suppression self-destructs once the underlying error is
      // fixed; an ignore-style one rots silently forever.
      //
      // NB: the directive names are deliberately NOT spelled literally at the
      // start of these comment lines. This rule matches on comment text, so a
      // line beginning with the bare directive is flagged as a real suppression
      // — which is exactly what happened here on the first run.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
          minimumDescriptionLength: 10,
        },
      ],

      // --- ergonomics --------------------------------------------------------
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // --- small, high-value core rules --------------------------------------
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // -------------------------------------------------------------------------
  // GROUP 1 — src/shared/: THE PURITY BOUNDARY
  //
  // tsconfig.shared.json already makes process/fs/window/console/setTimeout
  // COMPILE errors (no node types, no DOM lib). What it cannot catch is
  // Date.now and Math.random, because those are ES built-ins present in
  // lib ES2024. That is what this block is for, and it is the only thing
  // standing between src/shared/ and a non-reproducible engine.
  // -------------------------------------------------------------------------
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...NODE_BUILTIN_PATTERNS,
            ...RUNTIME_PACKAGE_PATTERNS,
            ...NO_CLIENT_PATTERNS,
            ...NO_SERVER_PATTERNS,
          ],
        },
      ],
      'no-restricted-properties': ['error', ...NO_NONDETERMINISM_PROPERTIES],
      'no-restricted-globals': ['error', ...NO_PLATFORM_GLOBALS],
      'no-restricted-syntax': ['error', ...NO_ASYNC_SYNTAX, ...NO_NONDETERMINISM_SYNTAX],
    },
  },

  // -------------------------------------------------------------------------
  // src/server/ — general
  // -------------------------------------------------------------------------
  {
    files: ['src/server/**/*.ts'],
    rules: {
      // Everything goes through the logger, so redaction and correlation ids
      // cannot be bypassed. Overridden below for the surfaces that legitimately
      // own stdout.
      'no-console': 'error',
      'no-restricted-imports': ['error', { patterns: [...NO_CLIENT_PATTERNS] }],
      'no-restricted-syntax': ['error', ...NO_BRAND_CASTS],
    },
  },

  // -------------------------------------------------------------------------
  // GROUPS 2 + 3 — THE SYNCHRONOUS, DETERMINISTIC CORE.
  // No await, ever. No I/O layers, ever. No wall clock, ever.
  //
  // The first `await` in this call graph lets two WebSocket messages interleave
  // mid-turn, producing desyncs that depend on network timing and cannot be
  // reproduced locally. Six AST selectors make that structurally impossible.
  // -------------------------------------------------------------------------
  {
    files: [
      'src/server/engine/**/*.ts',
      'src/server/talents/**/*.ts',
      'src/server/ai/**/*.ts',
      'src/server/world/**/*.ts',
      'src/server/view/**/*.ts',
    ],
    rules: {
      'no-console': 'error',
      // Restated, not inherited — flat-config rules REPLACE per rule name.
      'no-restricted-syntax': [
        'error',
        ...NO_ASYNC_SYNTAX,
        ...NO_NONDETERMINISM_SYNTAX,
        ...NO_BRAND_CASTS,
      ],
      'no-restricted-properties': ['error', ...NO_NONDETERMINISM_PROPERTIES],
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: SYNC },
        { name: 'setInterval', message: SYNC },
        { name: 'setImmediate', message: SYNC },
        { name: 'queueMicrotask', message: SYNC },
        { name: 'fetch', message: SYNC },
      ],
      // NOTE: restated, not inherited — flat-config rules REPLACE per rule name.
      'no-restricted-imports': [
        'error',
        { patterns: [...NO_CLIENT_PATTERNS, ...NO_IO_LAYER_PATTERNS] },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // src/server/talents/ — every tunable number must live in the talent's JSON,
  // or `reloadcontent` cannot retune it mid-session and you are back to
  // restarting the server to change a 3 into a 4.
  //
  // Deliberately 'warn', not 'error': no-magic-numbers cannot tell a balance
  // constant from a loop bound, so at error level the ignore list grows monthly
  // until the rule means nothing. Advisory here, honestly labelled.
  // -------------------------------------------------------------------------
  {
    files: ['src/server/talents/**/*.ts'],
    rules: {
      'no-magic-numbers': [
        'warn',
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          enforceConst: true,
          detectObjects: false,
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // Surfaces that legitimately own stdout
  // -------------------------------------------------------------------------
  {
    files: ['src/server/ops/**/*.ts', 'src/server/gm/console.ts'],
    rules: { 'no-console': 'off' },
  },

  // -------------------------------------------------------------------------
  // GROUP 6 — src/client/
  //
  // Discord explicitly does not sanitise nicknames, and in-game `say` text is
  // written by other players. The Activity iframe holds a live session token in
  // memory, so a nickname-delivered XSS steals the token and the socket. One
  // rule removes the class permanently; remembering to escape at ~30 render
  // sites does not.
  // -------------------------------------------------------------------------
  {
    files: ['src/client/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...NO_SERVER_PATTERNS, ...NO_COMBAT_MATH_PATTERNS] },
      ],
      'no-restricted-syntax': ['error', ...NO_BRAND_CASTS],
      'no-restricted-properties': [
        'error',
        {
          property: 'innerHTML',
          message: 'Use.textContent. Nicknames and chat are hostile input.',
        },
        {
          property: 'outerHTML',
          message: 'Use.textContent. Nicknames and chat are hostile input.',
        },
        {
          property: 'insertAdjacentHTML',
          message: 'Use.textContent + createElement. Nicknames and chat are hostile input.',
        },
        { object: 'document', property: 'write', message: 'Never.' },
        { object: 'document', property: 'writeln', message: 'Never.' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // -------------------------------------------------------------------------
  // Tests and tools
  // -------------------------------------------------------------------------
  {
    files: ['test/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    files: ['tools/**/*.ts', '*.config.ts'],
    rules: { 'no-console': 'off' },
  },

  // -------------------------------------------------------------------------
  // Plain JS (this file, tools/*.mjs) — no type information available.
  // -------------------------------------------------------------------------
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: NODE_GLOBALS },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
