import { defineConfig } from 'vite';

// Inner Datum — client build.
//
// Vite builds the CLIENT only. Server code has no build step at all (Node 24
// type-strips src/server/**/*.ts directly), which is why there is no SSR or
// library config here and why this file never sees src/server/.
//
// The dev loop is two processes: `npm run dev` (Fastify on 127.0.0.1:3000) and
// `vite` (5173, this config). The proxy below is what joins them, so the client
// talks to a same-origin '/ws' in dev exactly as it does in production and no
// code branches on the environment.

export default defineConfig({
  // The repo root IS the Vite root: index.html lives there, and the entry it
  // points at is ./src/client/main.ts.
  root: import.meta.dirname,

  // ===================================================================
  // SECRET CONTAINMENT. Stated explicitly rather than left to the default.
  // ===================================================================
  // Vite inlines matching env vars into the bundle AS PLAIN TEXT — `import.meta
  // .env.VITE_FOO` becomes a string literal in the shipped JS. Anyone who opens
  // devtools, or reads the file the Discord proxy served them, can read it.
  //
  // 'VITE_' is already Vite's default, so this line changes no behaviour today.
  // It is here so that the rule is VISIBLE at the point where it matters: the
  // failure mode is somebody widening the prefix (or setting it to '') to make
  // one convenient variable reachable, and shipping DISCORD_CLIENT_SECRET to
  // every player in the same commit.
  //
  // The only secret-shaped thing that may ever carry a VITE_ prefix is the
  // client ID, which is public by construction — it is in the Activity's own
  // URL. `npm run check:secrets` greps the built bundle and fails if anything
  // else gets through, so this is belt AND braces.
  envPrefix: 'VITE_',

  // RELATIVE BASE, and it is not a preference. Inside a Discord Activity the
  // app is served through Discord's proxy, which can mount it under a '/.proxy/'
  // path prefix. With the default base of '/', every emitted <script> and <link>
  // would resolve against the proxy root instead of the app's own path and 404.
  // './' makes the built HTML reference its own siblings, which is correct under
  // '/', under '/.proxy/', and from the filesystem.
  base: './',

  // Copied verbatim into outDir. This is the author's proprietary art: it must
  // land on disk as ordinary PNG files, byte-identical to the source.
  publicDir: 'client/public',

  build: {
    outDir: 'client/dist',
    emptyOutDir: true,

    // ===================================================================
    // LICENSING CONTROL. NOT A PERFORMANCE SETTING. DO NOT RAISE THIS.
    // ===================================================================
    // Vite's default (4096) base64-inlines any asset under 4 KB directly into
    // the JS chunk. Most of client/public/assets/ is well under that: the 24x32
    // character sprites, every 32x32 token ring and tile marker, all twelve
    // 12x12 pips.
    //
    // This repository is public and GPL-3.0-or-later. The author's art is NOT
    // GPL — it is separately licensed (see ASSETS-LICENSE.md) and is not even
    // distributed here. Inlining a PNG into the bundle fuses proprietary art
    // into a file made of GPL-licensed ported ToME logic, producing one artifact
    // under two incompatible licences, with no way to distribute the code
    // without the art or to relicense the art later. Zero means every asset
    // stays a separate, deletable, replaceable file with its own licence.
    //
    // The art being untracked does NOT retire this setting. It applies at BUILD
    // time, to whatever art is present in the working tree — which on the
    // author's machine, and on any fork that supplies its own, is all of it. The
    // repository being clean says nothing about what `npm run build:client`
    // emits.
    //
    // The perf argument for inlining is worth ~15 requests over HTTP/2 on a
    // self-hosted server serving under ten players. It does not come close.
    assetsInlineLimit: 0,

    // Bundle output goes to 'bundle/', NOT the default 'assets/'. publicDir is
    // copied to outDir root, so client/public/assets/ becomes client/dist/assets/
    // — with the default the generated JS and CSS would be emitted into that same
    // directory and interleave with the art tree. Same separation as above, at
    // the directory level: everything under client/dist/assets/ is art, and
    // everything under client/dist/bundle/ is code.
    assetsDir: 'bundle',

    sourcemap: true,
    target: 'es2022',
  },

  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // ws: true is the load-bearing flag — without it Vite proxies the HTTP
      // GET but not the Upgrade, and the handshake fails with a 400 that looks
      // like a server bug.
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
      // So the dev client can hit the real endpoints on the real server.
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/healthz': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      // '/assets/*' is deliberately ABSENT: publicDir above already serves
      // client/public/assets/** at /assets/** in dev and copies it to
      // client/dist/assets/** in the build, so one relative './assets/…' URL in
      // the client resolves identically in both. Proxying it to the Fastify
      // server would introduce a second, divergent path to the same files.
    },
  },
});
