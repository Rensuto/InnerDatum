import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { TURN_BAR_H } from '../../src/client/ui/turnbar.ts';
import { HOTBAR_TOTAL_H } from '../../src/client/ui/hotbar.ts';
import { HUD_MIN_H, HUD_MIN_W } from '../../src/client/render/canvas.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BAND THE TURN CARDS USED TO SPEND, MEASURED BACK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ruled by the author on 2026-09-18: *"lets just go no cards at all, no turn
 * order indicator. it will also free up more space. we can use the 'Party' hud
 * UI to indicate that its the players turn, even when doing multiplayer."*
 *
 * "It will also free up more space" is a claim with a number in it, and this
 * file is where the number is. The strip was full-width and 46 logical pixels
 * tall IN COMBAT and zero out of it, so the top HUD was 14 walking around and 60
 * in a fight — and every band in main.ts was stacked against that, which is why
 * the Case Log used to ratchet smaller every time somebody walked into a room.
 *
 * ═══ WHY THE ARITHMETIC IS REBUILT HERE RATHER THAN IMPORTED ═══
 * `panelBand`, `logBand` and `hotbarBand` are module-private in main.ts, which
 * calls `boot()` at load and reaches for `document`, the Discord SDK and a
 * WebSocket — vitest.config.ts is emphatic that the environment is `node` with
 * deliberately no jsdom, so there is no way to import them. The house answer is
 * test/client/hudwiring.test.ts's: read the source, and pin the arithmetic
 * against the constants the source actually uses.
 *
 * ═══ AND THE FIXTURE IS THE REAL CONSTANT, WHICH IS THE POINT ═══
 * Memory, and this repo's own recurring bug: a band fixture that drifts from the
 * band is how a height layout passes its test and drops content live. So
 * `TURN_BAR_H` and `HOTBAR_TOTAL_H` are IMPORTED, `DOCK_MARGIN` and `LINE_H` are
 * READ OUT OF main.ts, and the two expressions are asserted to still be the
 * lines they are read from. Nothing below is a number typed twice.
 */

const SOURCE = readFileSync('src/client/main.ts', 'utf8');

/** main.ts with its comments removed — the same guard hudwiring.test.ts uses. */
const CODE = SOURCE.split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
  })
  .join('\n');

/** A numeric literal constant, read out of main.ts by name. */
function read(name: string): number {
  const found = new RegExp(`const ${name} = (\\d+);`).exec(CODE);
  expect(found, `${name} is no longer a numeric literal in main.ts`).not.toBeNull();
  return Number(found?.[1]);
}

const DOCK_MARGIN = read('DOCK_MARGIN');
const LINE_H = read('LINE_H');

/**
 * WHAT THE STRIP COST, and it is the one number here that cannot be imported
 * because the module it lived in is deleted.
 *
 *   TURN_CARDS_H = BAND_PAD * 2 + CARET_H + CARD_H
 *                = 3 * 2      + 4       + (32 + 2 * 2)
 *                = 46
 *
 * It is written out with its derivation so that "the playfield grew" is a
 * measurement against the thing that was actually there, rather than against a
 * round number chosen to make the difference look good.
 */
const WAS_CARDS_H = 46;

/** The two bands main.ts computes from the top HUD, rebuilt from its own terms. */
const panelBand = (height: number, hudTop: number) => ({
  top: hudTop + DOCK_MARGIN,
  bottom: height - HOTBAR_TOTAL_H - LINE_H * 2 - DOCK_MARGIN,
});
const logBand = (height: number, hudTop: number) => ({
  top: hudTop + DOCK_MARGIN,
  bottom: height - HOTBAR_TOTAL_H - DOCK_MARGIN,
});

describe('the bands are rebuilt from the lines main.ts actually ships', () => {
  it('still computes them the way this file models them', () => {
    // WITHOUT THIS EVERY MEASUREMENT BELOW IS A MODEL OF A FILE THAT MOVED ON.
    expect(CODE, 'panelBand’s top moved').toContain('    top: hudTop + DOCK_MARGIN,\n');
    expect(CODE, 'panelBand’s floor moved').toContain(
      '    bottom: height - HOTBAR_TOTAL_H - LINE_H * 2 - DOCK_MARGIN,\n',
    );
    expect(CODE, 'logBand’s floor moved').toContain(
      '    bottom: height - HOTBAR_TOTAL_H - DOCK_MARGIN,\n',
    );
    // And the top HUD is the constant, not a measurement of a `turn` frame.
    expect(CODE, 'the top HUD is a function of the frame again').toContain(
      'const hudTop = TURN_BAR_H;',
    );
  });
});

describe('the playfield grew, and only where the strip was being spent', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * MEASURED AT THE FLOOR VIEWPORT, IN COMBAT AND OUT OF IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `HUD_MIN_W` x `HUD_MIN_H` is 640x320 — the box every ui/ module is laid out
   * against and the smallest interface this client ever renders. The second
   * viewport is the measured Discord Activity box from DECISIONS.md's own
   * UI-scale table, so nothing here can pass by being true of a special case.
   */
  const VIEWPORTS: readonly (readonly [string, number, number])[] = [
    ['the HUD floor', HUD_MIN_W, HUD_MIN_H],
    ['the measured Discord box', 1262, 428],
  ];

  /** The top of the playfield: the HUD strip above it is opaque and full-width. */
  const wasHudTop = (inCombat: boolean): number => TURN_BAR_H + (inCombat ? WAS_CARDS_H : 0);

  it('gives the map back 46 pixels of every fight, at every viewport', () => {
    for (const [label, , height] of VIEWPORTS) {
      const was = height - wasHudTop(true);
      const now = height - TURN_BAR_H;
      expect(now - was, `${label}: the playfield did not grow in combat`).toBe(WAS_CARDS_H);
    }
    // 640x320: 260 -> 306 logical pixels of map below the HUD, +17.7%.
    expect(HUD_MIN_H - wasHudTop(true)).toBe(260);
    expect(HUD_MIN_H - TURN_BAR_H).toBe(306);
  });

  it('changes nothing out of combat, because the strip cost nothing there', () => {
    // THE HALF THAT MUST NOT MOVE. The cards were already drawn only in combat,
    // so a "reclaim" that also moved the quiet layout would mean something else
    // had been changed by accident.
    for (const [label, , height] of VIEWPORTS) {
      expect(height - wasHudTop(false), `${label}: free movement moved`).toBe(height - TURN_BAR_H);
      expect(panelBand(height, wasHudTop(false)), `${label}: the quiet band moved`).toEqual(
        panelBand(height, TURN_BAR_H),
      );
    }
  });

  it('hands the same 46 to every docked panel, in combat', () => {
    /**
     * `panelBand` is the sheet, the talents, the inventory, the escape menu and
     * the party pane; `logBand` is the Case Log, which reaches further down. At
     * the floor the shared band goes 63..217 to 17..217 — 154 pixels to 200,
     * which is 46 more rows of anything and the reason the pane can now hold
     * more of the party in a fight (test/client/partypanel.test.ts measures that
     * in people rather than pixels).
     */
    const before = panelBand(HUD_MIN_H, wasHudTop(true));
    const after = panelBand(HUD_MIN_H, TURN_BAR_H);
    expect(before).toEqual({ top: 63, bottom: 217 });
    expect(after).toEqual({ top: 17, bottom: 217 });
    expect(after.bottom - after.top).toBe(before.bottom - before.top + WAS_CARDS_H);

    const logBefore = logBand(HUD_MIN_H, wasHudTop(true));
    const logAfter = logBand(HUD_MIN_H, TURN_BAR_H);
    expect(logAfter.bottom - logAfter.top).toBe(logBefore.bottom - logBefore.top + WAS_CARDS_H);

    // The FLOOR of both bands is the hotbar's reserve and must not have moved —
    // reclaiming the top by taking it off the bottom would be no reclaim at all.
    expect(after.bottom).toBe(before.bottom);
    expect(logAfter.bottom).toBe(logBefore.bottom);
  });

  it('stacks every band against the constant, so none of them can move again', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG.
     * ═══════════════════════════════════════════════════════════════════════
     * Comparing two bands built from `TURN_BAR_H` to each other proves nothing —
     * they are the same expression. What can actually regress is a call site
     * going back to a per-frame height, so every `hudTop` argument in main.ts is
     * read out of the source and checked to be the constant.
     */
    const args = [...CODE.matchAll(/(?:panelBand|logBand|hotbarBand)\(([^)]*)\)/g)]
      .map((m) => (m[1] ?? '').split(',')[1]?.trim())
      // The DECLARATIONS match too, and their second argument is the parameter
      // list rather than an argument. They are what the call sites are checked
      // against, so they are skipped rather than asserted about.
      .filter((arg) => arg !== undefined && !arg.includes(':'));
    expect(args.length, 'nothing stacks against the top HUD any more').toBeGreaterThan(3);
    for (const arg of args) {
      expect(arg, `a band is stacked against ${String(arg)} rather than the constant`).toMatch(
        /^(TURN_BAR_H|hudTop)$/,
      );
    }
    // ...and `hudTop`, the one indirection, is the constant itself.
    expect(CODE).toContain('const hudTop = TURN_BAR_H;');
    expect(TURN_BAR_H, 'the top HUD is no longer one line of prose').toBe(14);
  });
});

describe('the turn card strip is gone, not hidden', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A HALF-REMOVED FEATURE IS EXACTLY WHAT `npm run check:inert` HUNTS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * That tool's own header lists what this project keeps shipping: systems that
   * are written, correct, wired and called by nobody. The mirror image — a
   * module deleted while its callers, its constants and its asset lookups stay
   * behind — is the same failure read backwards, and it typechecks for exactly
   * as long as somebody keeps a stub around.
   *
   * So this walks the whole of src/, test/ and tools/ and refuses the module by
   * name and every symbol that only it ever exported.
   */
  function walk(dir: string): readonly string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) {
        out.push(...walk(full));
        continue;
      }
      if (/\.(ts|mts|mjs|js)$/.test(entry)) out.push(full);
    }
    return out;
  }

  const FILES = [...walk('src'), ...walk('test'), ...walk('tools')];
  /**
   * WHERE A CALLER COULD ACTUALLY BE. Production code and the tooling that runs
   * against it; a test naming a deleted symbol is caught by the compiler,
   * because there is no module left to import it from.
   */
  const SHIPPED = [...walk('src'), ...walk('tools')];
  /**
   * THE ONE FILE ALLOWED TO SAY THE NAME, because saying it is its job: a guard
   * that cannot name what it forbids is a guard nobody can read. Asserted to be
   * exactly this file, so the exemption cannot quietly grow a second entry.
   */
  const GUARD = 'test/client/turnband.test.ts';

  it('has no module left to import', () => {
    expect(existsSync('src/client/ui/turncards.ts')).toBe(false);
    expect(existsSync('test/client/turncards.test.ts')).toBe(false);
    // And the file that replaced its surviving half is here.
    expect(existsSync('test/client/turnbar.test.ts')).toBe(true);
  });

  it('is named by nothing anywhere in src, test or tools', () => {
    const named = FILES.filter((file) => readFileSync(file, 'utf8').includes('turncards'));
    expect(named, `these files still name the deleted module: ${named.join(', ')}`).toEqual([
      GUARD,
    ]);
  });

  it('is imported by nothing, whatever it is called', () => {
    // The import specifier, separately from the prose: a module reached through
    // a re-export or an alias would slip a name check and not this one.
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      if (file === GUARD) continue;
      expect(source, `${file} still imports it`).not.toMatch(/from\s+'[^']*turncards[^']*'/);
    }
  });

  it('has no caller left for any symbol that lived only in it', () => {
    /**
     * `selfCard`, `owedCount`, `bellSeconds` and `TurnView` are NOT in this list
     * and must not be: they were never about a card. They describe a `turn`
     * frame, the banner has always read them, and they MOVED to ui/turnbar.ts
     * rather than being deleted with the painter. Everything below is something
     * the strip alone could have meant.
     */
    const gone = [
      'drawTurnCards',
      'turnCardsHeight',
      'TURN_CARDS_H',
      'TurnCardsOptions',
      // The measurement that existed because the strip made the HUD's height
      // depend on whether there was a fight on.
      'turnHudHeight',
      // ...and the band the Case Log needed because of that.
      'quietLogBand',
    ];
    for (const file of SHIPPED) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
        })
        .join('\n');
      for (const symbol of gone) {
        expect(code, `${file} still calls ${symbol}`).not.toContain(symbol);
      }
    }
  });

  it('kept the Warrant Clock, which is not a card and was not asked for', () => {
    /**
     * ui/turnbar.ts draws ONE line of prose at the very top — "YOUR MOVE — free
     * movement, nothing is hunting you", "TURN OVER — waiting on 2" — and
     * game-design.md § 4 makes it the mechanism that keeps a voice channel
     * pointed at the same moment. It is not a card, not an order, and deleting
     * it was not what was asked for.
     */
    const bar = readFileSync('src/client/ui/turnbar.ts', 'utf8');
    expect(bar).toContain('export function bannerFor(');
    expect(bar).toContain('export function isYourTurn(');
    expect(bar).toContain('export function drawTurnBar(');
    expect(CODE, 'main.ts stopped drawing the banner').toContain('drawTurnBar({ ctx, view, width');
    // And the three readers moved here rather than dying with the painter.
    for (const kept of ['selfCard', 'owedCount', 'bellSeconds']) {
      expect(bar, `${kept} did not survive the deletion`).toContain(`export function ${kept}(`);
    }
  });
});
