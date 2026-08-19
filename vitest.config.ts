import { defineConfig } from 'vitest/config';

// Inner Datum — test runner.
//
// Test the pure math and nothing else. Node environment
// only: there is deliberately no test for the canvas, no jsdom, and no mocked
// Discord SDK — mocking the SDK would test the mock, and the real integration
// only fails inside a real Discord desktop client, which is what the M0 DoD
// checklist exercises by hand.

export default defineConfig({
  test: {
    // Tests live in test/ mirroring src/, NEVER colocated inside src/. This is
    // structural, not stylistic: the server runs src/**/*.ts DIRECTLY with no
    // build step, so a stray *.test.ts would ship to the host, sit on the
    // public repo's runtime path, and pull vitest onto the server's import
    // graph.
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    restoreMocks: true,
    clearMocks: true,

    // A test that asserts nothing passes silently forever and reads as
    // coverage — strictly worse than no test. This makes that impossible
    // rather than asking anyone to remember expect.hasAssertions. It is the
    // one setting here aimed squarely at AI-assisted authoring, where a
    // plausible test body arrives with the expect simply missing.
    //
    // CAVEAT, and it will bite exactly once: only Vitest's `expect` counts,
    // and assert-style assertions do not. A property-based test whose
    // predicate RETURNS a boolean therefore records zero assertions and fails
    // for a reason that has nothing to do with the code under test. Write the
    // predicate so that it calls expect on the value instead of returning
    // true or false.
    expect: { requireAssertions: true },

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * 20 SECONDS, BECAUSE ELEVEN OF THESE FILES BOOT A REAL SERVER.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Eleven suites call `app.listen` and open real WebSockets — the gateway
     * cannot be tested any other way, and the bugs those files have caught
     * (an instance leaking on every follow, a region line wired to nothing)
     * are exactly the ones a mock would have hidden.
     *
     * Vitest runs files in parallel and the default timeout is five seconds.
     * MEASURED, on one full-gate run: four socket suites timed out at 5.1s,
     * 5.1s, 5.2s and 10.0s, and every one of them passed in isolation and on
     * the next full run. Nothing was wrong with the code; a hundred-odd files
     * competing for the CPU delayed a handshake past the deadline.
     *
     * A SUITE THAT FAILS AT RANDOM IS WORSE THAN A SLOW ONE, because the next
     * random failure is the one nobody looks at properly. This is not a licence
     * for a slow test — it is the recognition that WS handshake latency under
     * load says nothing about the server, and that a genuine hang still fails,
     * twenty seconds later, with the same message.
     */
    testTimeout: 20_000,

    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],

      // Measured, but NOT gated. Coverage
      // targets under "deliberately skipped", and that decision stands: a
      // threshold you meet by accident enforces nothing, and one you miss
      // produces a test written to touch a line rather than assert a
      // behaviour. Coverage here answers one question — "did an entire file go
      // untested?" — and nothing else.
      //
      // The include list is restricted to the two trees where a bug is a
      // desync or a wrong formula, so the canvas, the net layer and the ops
      // panel are absent from the report entirely and can never create
      // pressure to write a rendering test.
      include: ['src/shared/**/*.ts', 'src/server/engine/**/*.ts'],
      exclude: ['**/*.d.ts'],
    },
  },
});
