/**
 * Inner Datum — client entry point.
 *
 * Holds the whole client state (it is nine variables), wires the socket to the
 * renderer, and does nothing else. The rules it exists to enforce:
 *
 *   THE SERVER IS AUTHORITATIVE. Pressing a key sends an intent and changes
 *   nothing locally. The token moves when `moved` comes back; the turn changes
 *   when `turn` comes back. At LAN and home-broadband latencies that is 5-30 ms,
 *   which is invisible, and it buys the property that two browser tabs cannot
 *   disagree about where anyone is standing or whose turn it is. Prediction and
 *   rollback are explicitly out of scope — they are how a co-op game acquires a
 *   class of bug that only reproduces on someone else's connection.
 *
 *   RENDER ON DEMAND, NOT AT 60 FPS. This is a turn-based game: between two
 *   keypresses the screen is byte-identical, so a permanently spinning
 *   requestAnimationFrame loop would redraw ~3600 identical frames a minute,
 *   keep the GPU awake and cost a laptop real battery for nothing. Instead a
 *   dirty flag coalesces every state change into ONE rAF callback — several
 *   `moved` frames arriving in the same tick still produce a single draw, and an
 *   idle client draws nothing at all.
 *
 *   M4: THE CASE LOG IS A SURFACE, NOT A CONSOLE, AND THE MARGIN IS RESERVED.
 *   game-design.md § 11 splits the log into Record (mechanical, cream) and
 *   Margin (what people say and where they point, violet). The client gives the
 *   Margin a band the Record cannot spend — see ui/caselog.ts for why that
 *   reservation is the whole design and not a styling choice. `say` is typed
 *   into a real `<input>` in index.html rather than into something drawn on the
 *   canvas, because an IME, a caret and a clipboard are not things a canvas has;
 *   `point` is SHIFT + a map click, which is the one gesture people in a voice
 *   channel already make with their hands.
 *
 *   M4: WHAT IS ON A BODY IS DRAWN TWICE, AT TWO RESOLUTIONS. The party pane
 *   carries 24x24 badges with names and turn counts; a token carries a bounded
 *   column of four dots. The map answers "is something on that thing" and the
 *   pane answers "what" — a token that disappears under its own status display
 *   is a token nobody can find at the exact moment it matters.
 *
 *   M5: NOBODY COULD TELL WHEN THE FIGHT STARTED. Reported from the first live
 *   session, and it is the failure game-design.md § 4 warns about arriving in
 *   person. The server now says so on the wire (`TurnMsg.inCombat`), and the
 *   client says it three ways at once: a loud banner on the crossing itself, a
 *   crimson frame around the playfield for as long as the fight lasts, and a
 *   Record line in the Case Log — plus the same fact in the status line below,
 *   which is the `aria-live` region and therefore the heard copy. One of those
 *   is an animation; the other three are not, which is the whole point.
 *
 *   M2 ADDS EXACTLY TWO BOUNDED TIMERS, M3 A THIRD, M4 A FOURTH, M5 A FIFTH AND
 *   v6 A SIXTH AND A SEVENTH. No unbounded one:
 *     - the SWEEP BEAT (render/sweep.ts): one setTimeout per monster sweep, two
 *       draws, then nothing;
 *     - the BELL TICKER (below): a 4 Hz interval that exists only while a
 *       countdown is visible and stops itself when it reaches zero. A countdown
 *       that only moves when a packet arrives is not a countdown, and the server
 *       deliberately does not stream one — it sends the remaining milliseconds
 *       once and the client renders the clock.
 *     - the NOTICE (M3): one setTimeout that wipes a refusal line after a few
 *       seconds. It replaces itself rather than stacking, so a player mashing a
 *       talent on cooldown gets one line that stays fresh, not a queue.
 *     - the COMBAT BANNER (M5, ui/combatbanner.ts): one setTimeout for the hold,
 *       then a ~60 ms interval for the 600 ms fade, which stops itself. It runs
 *       twice per fight — once when contact is made and once when it ends — and
 *       not at all in between. Under `prefers-reduced-motion` the fade interval
 *       is never armed at all.
 *     - the INVITE EXPIRY (v6, below): ONE setTimeout for the whole list, aimed
 *       at the nearest deadline and re-armed only while an offer is still
 *       pending. It exists because an invite lapses and, out of combat, the pump
 *       idles — there may be no frame for minutes, and an ACCEPT button that has
 *       quietly stopped working is worse than no button.
 *     - the HOVER SETTLE (v6, the mouse layer): ONE setTimeout, armed only when
 *       the pointer moves onto a DIFFERENT actor and replaced rather than
 *       stacked, which is what makes a mouse swept across a room send zero
 *       `inspect` frames — the pointer has to come to rest before one goes out.
 *       It fires once and does not re-arm itself. See `noteHoveredActor`.
 *   All of them are bounded loops that stop when the thing they animate stops,
 *   which is the shape the M1 header promised and the only shape allowed here.
 *
 *   v6: THE PARTY IS A THING YOU JOIN, AND IT IS ON THE LEFT. Real multiplayer
 *   reported a solo player being shown — and blocked by — somebody who had shut
 *   the tab. The server now scopes the barrier to an explicit party
 *   (`party_state`); this client draws that party in the LEFT-hand pane
 *   (ui/partypanel.ts), takes invites there with two buttons rather than in a
 *   log line that scrolls away, and offers the same verbs three ways: a
 *   right-click menu on any detective's token (ui/contextmenu.ts), the same menu
 *   on a pane row for somebody off screen, and `/party invite <name>` typed into
 *   the command line, because this is a MUD and typing must work.
 *
 *   v6: THE MOUSE CAN PLAY THE GAME, AND IT DECIDES NOTHING. Left-click walks
 *   there or hits that, hover says what a thing is, right-click lists the verbs.
 *   Not one of those rules lives in this file: `input/mouseintent.ts` says what a
 *   click means, `input/travel.ts` is the walk's whole state machine, `ui/verbs.ts`
 *   is the menu's decision table, and every one of them is a pure function tested
 *   with nothing drawn. What is left here is wiring — turn a pointer into a tile,
 *   ask, and send. TRAVEL AUTO-COMMITS ONE STEP PER TURN and sends `move` and
 *   NOTHING ELSE (see the tick in `onMessage`, which says at length why a
 *   following `commit` would cost every traveller a second turn per tile), and it
 *   is interrupted by eleven things, seven of which are call sites in this file
 *   marked "TRAVEL INTERRUPT". The tooltip asks the server what a body is
 *   (`inspect`/`inspected`) rather than fattening `ActorView`, because that frame
 *   streams every turn and this answer is wanted a few times a session.
 *
 *   M3: A REFUSAL IS ALWAYS VISIBLE, NEVER A NO-OP. Pressing a hotbar key ALWAYS
 *   sends a frame, even when this client believes the slot is on cooldown, out
 *   of range or unaffordable. That is deliberate: the moment the client starts
 *   swallowing inputs on its own arithmetic it is enforcing a second copy of the
 *   rules, and the first time the two copies disagree a player is holding a
 *   button that does nothing and cannot be told why. So every refusal comes back
 *   from the authority as a typed `ErrorCode`, and `refusalText` turns it into a
 *   sentence with the number in it — "too close — Sniper's Mark needs 3 tiles".
 *   In a turn-based game an action that silently does nothing is the worst
 *   failure mode there is; it is indistinguishable from a dropped packet.
 *
 *   WHOSE TURN IT IS, ALWAYS ON SCREEN. game-design.md § 4 is blunt about this
 *   being the way co-op turn-based dies, so the answer is drawn several times
 *   over and never in one place only: the banner sentence, the card strip under
 *   it (ui/turncards.ts), and the frame around the playfield — plus the same
 *   phase in the status line below the canvas, which is the `aria-live` region
 *   and therefore the accessible copy.
 *
 *   M5: MANY TELLINGS, ONE TELLER. Those surfaces all read `TurnMsg.actors` —
 *   the server's own per-actor answer — and nothing in this client derives the
 *   barrier's precedence any more. The old `chipFor` did, from three id arrays,
 *   and it got the case that matters most wrong: a Downed detective is in
 *   neither `whoseTurn` nor `standingBy`, so it fell through to "committed" and
 *   told the party that the person on the floor had taken their turn. Several
 *   places SAYING one fact is the design; two places DECIDING it was the bug.
 *
 *   M5: THE TOP HUD IS MEASURED, NOT ASSUMED. `turnHudHeight` is the banner plus
 *   the card strip, and the strip is 78 logical pixels IN COMBAT and zero out of
 *   it. Everything that stacks under the HUD — the dock, the combat banner, the
 *   panel hit test — takes that number from the one function, so a fight
 *   starting cannot leave a panel overlapping the cards on one surface only.
 */

import { DIR_ORDER, chebyshev, sameTile, step } from '../shared/coords.ts';
import { parseCommand } from './input/commands.ts';
import { bindGameKeys, TurnCommand, UiCommand } from './input/keys.ts';
import { MouseIntentKind, mouseIntentAt, travelTargetAllowed } from './input/mouseintent.ts';
import { createTargeting } from './input/targeting.ts';
import {
  TravelObservation,
  TravelStart,
  createTravel,
  isHostileBody,
  liveActorAt,
} from './input/travel.ts';
import { establishDiscordSession } from './net/discord.ts';
import { connectGameSocket, SocketStatus } from './net/socket.ts';
import { loadAssetLibrary } from './render/assets.ts';
import { createRenderer, PALETTE } from './render/canvas.ts';
import { createSweepPlayback } from './render/sweep.ts';
import { createCaseLog, SCROLL_STEP } from './ui/caselog.ts';
import { createCombatBanner, PLAYFIELD_FRAME_MAX_PX } from './ui/combatbanner.ts';
// `isSlotDisabled` is deliberately NOT imported. Whether a slot looks dead is
// the hotbar's business; whether a press is legal is the server's. Reading it
// here would be the first step towards refusing to send, which is exactly the
// silent no-op this file's header forbids.
import { drawHotbar, HOTBAR_TOTAL_H, hotbarSlotAt } from './ui/hotbar.ts';
import { createContextMenu, MapVerb } from './ui/contextmenu.ts';
import {
  drawPartyPane,
  partyPaneHitAt,
  partyPaneLayout,
  partyPaneView,
  PARTY_PANE_MARGIN,
} from './ui/partypanel.ts';
import { drawResource, RESOURCE_H, resourceLabel } from './ui/resource.ts';
import {
  drawRespawnPrompt,
  RESPAWN_PROMPT_SPEECH,
  respawnPromptHit,
  respawnPromptRect,
} from './ui/respawnprompt.ts';
import { drawTooltip } from './ui/tooltip.ts';
import { drawTurnBar, TURN_BAR_H, turnHudHeight } from './ui/turnbar.ts';
import { drawTurnCards, owedCount, selfCard } from './ui/turncards.ts';
import { verbsFor } from './ui/verbs.ts';
import {
  ActorKind,
  DownedStatus,
  ErrorCode,
  LogLane,
  PartyAction,
  SAY_MAX_CHARS,
  TalentShape,
  TurnActorState,
} from '../shared/protocol.ts';
import { PROTOCOL_VERSION } from '../shared/version.ts';
import type { Dir, TileXY } from '../shared/coords.ts';
import type {
  ActorView,
  DownedView,
  EffectView,
  InspectView,
  LevelView,
  LoadoutTalent,
  PartyInviteView,
  PartyMember,
  PartyStateMsg,
  ResourceView,
  ServerMsg,
  TurnEvent,
  TurnMsg,
} from '../shared/protocol.ts';
import type { CommandContext, RosterEntry } from './input/commands.ts';
import type { Targeting, TargetingWorld } from './input/targeting.ts';
import type { Travel, TravelWorld } from './input/travel.ts';
import type { DiscordParticipant } from './net/discord.ts';
import type { AssetEntry } from './render/assets.ts';
import type { HudPainter, PingMarker, Scene } from './render/canvas.ts';
import type { SweepPlayback } from './render/sweep.ts';
import type { SpriteSource } from './render/assets.ts';
import type { CaseLog } from './ui/caselog.ts';
import type { CombatBanner } from './ui/combatbanner.ts';
import type { ContextMenu, MenuItem } from './ui/contextmenu.ts';
import type { HotbarSlot, HotbarView } from './ui/hotbar.ts';
import type { PanelRect } from './ui/panel.ts';
import type { PartyPaneLayout, PartyPaneView } from './ui/partypanel.ts';
import type { TurnView } from './ui/turncards.ts';
import type { VerbTarget } from './ui/verbs.ts';

/**
 * Load the art this build can actually draw, not all 99 files in the manifest.
 * Prefixes rather than a hand-listed set so adding a sixth player class to the
 * pipeline does not need a code change here.
 *
 * `icon_ability_` matches nothing in today's placeholder manifest — the talent
 * icons are cut but not yet indexed — and it is listed anyway so that the day
 * they land is a pipeline run rather than a code change. Until then the hotbar
 * draws initials, which is a fallback it needs regardless.
 */
const NEEDED_ASSET_PREFIXES = [
  'chr_player_',
  'chr_npc_',
  // The M3 roster (src/server/content/monsters.ts) draws with `enemy_*` keys.
  // Two of them are in the manifest today and the Redacted family is not yet
  // promoted, which is fine and deliberate: `loadSprites` collects a failed PNG
  // into `missing` and the renderer paints its loud fallback box, so an
  // unpromoted husk is a visible placeholder rather than a client that will not
  // boot.
  'enemy_',
  'ui_token_ring_',
  'ui_tile_marker_',
  'ui_icon_turn_',
  'ui_hotbar_slot_',
  'ui_pip_',
  'icon_ability_',
  // M4. `chr_player_` above already covers the three `*_downed_s` bodies.
  'icon_status_',
  // M5. The turn cards' portraits (`icon_character_the_*`). Half the family is
  // uncut today — the manifest has the alchemist and the cipher-clerk and not
  // the watchman, the inspector or the generic detective — so ui/turncards.ts
  // treats a miss as the common case and draws initials rather than a blank.
  // Listing the prefix now means the day the rest are promoted is a pipeline run
  // and not a code change.
  'icon_character_',
  'ui_panel_',
  'ui_marker_',
  'ui_icon_speaking',
] as const;

/**
 * How often the Bell's digits are repainted. Four times a second: fast enough
 * that a one-second granularity display never appears to stall, slow enough to
 * be free. It is not a frame rate — nothing else redraws on this schedule.
 */
const BELL_TICK_MS = 250;

/**
 * How long a refusal stays on screen.
 *
 * Long enough to read a sentence twice, short enough that it is gone before it
 * becomes furniture. It does NOT persist until the next action, because a stale
 * "too close" sitting under a successful shot is worse than no message at all.
 */
const NOTICE_MS = 4500;

/** One line of HUD prose: the notice, and the targeting hint. */
const LINE_H = 14;
const FONT_HUD = 'bold 10px ui-monospace, Consolas, monospace';

/**
 * How long a `point` marker stays on the map.
 *
 * THE FOURTH AND LAST BOUNDED TIMER. Six seconds is long enough for somebody who
 * was looking at their hotbar to follow a finger, and short enough that four
 * people pointing during one fight do not leave the board covered in stale
 * markers. The Margin lane keeps the transcript, so nothing is lost when the
 * marker goes: that split — a marker that expires, a line that does not — is why
 * `point` produces two frames rather than one.
 */
const PING_MS = 6000;

/**
 * How long the pointer must REST on a token before this client asks the server
 * what it is.
 *
 * ═══ THIS NUMBER IS A RATE LIMIT, NOT A FEEL SETTING ═══
 * net/gateway.ts gives one token bucket per SOCKET — 20 frames a second, burst
 * 20 — and it is shared with `move`, `commit` and `hold`. An unthrottled hover
 * would spend the whole bucket sweeping across a room, and an exhausted bucket
 * does not merely drop frames: it answers with an `error`, which this client
 * turns into a refusal banner AND uses to cancel an open targeting ring. So the
 * failure mode of getting this wrong is not a busy socket, it is a player being
 * told "too many commands" and losing their aim because they moved the mouse.
 *
 * 120 ms is under the threshold at which a tooltip feels laggy and well over the
 * time a pointer spends crossing a token on the way somewhere else, so a sweep
 * sends NOTHING and a rest sends at most one frame per game turn (the cache
 * absorbs the rest).
 */
const HOVER_SETTLE_MS = 120;

/**
 * THE FLOOR ON HOW OFTEN A WALK MAY PUT A `move` ON THE WIRE.
 *
 * ═══ THIS NUMBER IS A RATE LIMIT TOO, AND IT IS THE ONE THAT BITES ═══
 * Travel is the only thing in this client that sends frames nobody pressed a key
 * for, and its loop is otherwise paced by ROUND-TRIP TIME with no floor at all:
 * send `move`, the server pumps, `moved` and `turn` come back, send the next
 * `move`. On the documented deployment — self-hosted on a PC at home, everyone
 * on the same LAN — that round trip is one or two milliseconds, so a click 30
 * tiles away drains the socket's whole 20-frame bucket in well under a second.
 * The bucket does not merely drop the 21st frame: `noteThrottled` answers
 * `rate_limited`, `case 'error'` stops the walk, and the player is stranded two
 * thirds of the way across the room having been told the ROUTE was refused.
 *
 * 150 ms leaves the walk at under seven frames a second against a budget of
 * twenty, with room for the hover card's own one-per-turn `inspect` beside it.
 * It is also a pace a human can watch and interrupt, which a 500-tiles-a-second
 * teleport across the room is not.
 */
const TRAVEL_STEP_MS = 150;

/**
 * THE TWO SIDES: the party pane on the LEFT, the Case Log on the RIGHT.
 *
 * THEY USED TO BE ONE COLUMN, stacked on the right, and the party panel starved
 * the log (or the reverse) on any window that was not tall. Splitting them is
 * what v6's explicit parties bought: the pane is now the answer to "who am I
 * playing with and are they still there", it is where invites are accepted, and
 * it has to be somewhere the eye already goes rather than under a scrolling
 * transcript. ui/partypanel.ts owns its own width and can collapse to
 * portraits-only; this file owns the RIGHT-hand dock and the vertical band both
 * of them live in.
 *
 * BOTH OVERLAY THE MAP, exactly like the hotbar overlays the bottom. Shrinking
 * the camera to make room would mean the world was drawn at a different logical
 * width depending on whether the log was open, which changes the integer scale
 * factor and makes toggling a panel resize the art. The camera centres on the
 * player, so the tile that matters most is never underneath either of them.
 *
 * 208 PIXELS is wide enough for roughly thirty characters of a Record line at
 * 10px monospace — one clause of "Dalt saves (phys 38 vs power 31, 68%)" per
 * wrapped row. Below `DOCK_MIN_VIEWPORT_W` there is no log at all rather than a
 * squeezed one: a 120-pixel log is not a readable log, and a player on a small
 * window would rather have the map.
 */
const DOCK_W = 208;
const DOCK_MARGIN = 3;
const DOCK_MIN_VIEWPORT_W = 480;
/** Below this the dock is dropped entirely — a panel too short to read is noise. */
const DOCK_MIN_H = 84;

/**
 * The band both side panels live in: under the top HUD, above the bottom bands.
 *
 * `hudTop` is the whole top HUD — the banner plus the turn cards, which exist
 * only in combat — and it is PASSED IN rather than read from a constant. The
 * panels therefore give up 78 pixels when a fight starts and take them back when
 * it ends, which is the trade that lets the card strip be as tall as it is.
 */
function panelBand(height: number, hudTop: number): { top: number; bottom: number } {
  return {
    top: hudTop + DOCK_MARGIN,
    // Stops above the resource pips, the targeting hint and the notice line, all
    // of which are full-width strips. Derived from the modules' own exported
    // heights so no two bands can overlap because a slot changed size.
    bottom: height - HOTBAR_TOTAL_H - RESOURCE_H - LINE_H * 2 - DOCK_MARGIN,
  };
}

/**
 * Where the Case Log sits, or null for "no room".
 *
 * ONE function, called by the painter AND by every hit test, for exactly the
 * reason `slotRect` in ui/hotbar.ts is: two copies of this arithmetic is how a
 * click lands on a tile that is underneath a panel, and the bug only shows up on
 * somebody else's window size.
 */
function logPanelRect(
  width: number,
  height: number,
  hudTop: number,
  showLog: boolean,
): PanelRect | null {
  if (!showLog || width < DOCK_MIN_VIEWPORT_W) return null;
  const band = panelBand(height, hudTop);
  const h = band.bottom - band.top;
  if (h < DOCK_MIN_H) return null;
  return { x: width - DOCK_W - DOCK_MARGIN, y: band.top, w: DOCK_W, h };
}

/** True when a LOGICAL backbuffer point is over either dock panel. */
function inRect(rect: PanelRect | null, px: number, py: number): boolean {
  if (rect === null) return false;
  return px >= rect.x && px < rect.x + rect.w && py >= rect.y && py < rect.y + rect.h;
}

function isNeeded(entry: AssetEntry): boolean {
  return NEEDED_ASSET_PREFIXES.some((prefix) => entry.id.startsWith(prefix));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------

/**
 * Resolved through a function rather than narrowed at the top level: a
 * narrowing on a module-scope const is not carried into the closures below, so
 * the binding has to be non-null by declaration.
 */
function requireCanvas(id: string): HTMLCanvasElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLCanvasElement)) {
    throw new Error(`index.html is missing <canvas id="${id}">`);
  }
  return element;
}

/**
 * Narrowed the same way as `requireCanvas` and for the same reason, but nullable
 * rather than throwing: the command line is the only piece of DOM this client
 * can do without. An index.html that predates M4 loses the ability to talk and
 * keeps everything else, which is a better failure than refusing to boot.
 */
function optionalInput(id: string): HTMLInputElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement ? element : null;
}

const canvas = requireCanvas('game');
const logEl = document.getElementById('log');
const marginEl = document.getElementById('margin');
const cmdEl = optionalInput('cmd');

/** textContent, never innerHTML: actor names come from Discord nicknames. */
function setStatusText(text: string): void {
  if (logEl !== null) logEl.textContent = text;
}

/**
 * Mirror one Margin line into the DOM's `aria-live` region.
 *
 * THE LANE ON THE CANVAS IS INVISIBLE TO A SCREEN READER, and player speech is
 * the one thing in this game that has to be readable without eyes. Only the
 * Margin is mirrored: piping the Record here would announce twenty lines of
 * arithmetic per turn and make the region useless for the three lines a minute
 * that actually matter.
 *
 * `textContent`, and the speaker is concatenated HERE rather than trusted from
 * the text — same rule as the canvas lane, for the same reason.
 */
function setMarginText(speaker: string | undefined, text: string): void {
  if (marginEl === null) return;
  marginEl.textContent = speaker === undefined ? text : `${speaker}: ${text}`;
}

// ---------------------------------------------------------------------------
// Client state. All of it.
// ---------------------------------------------------------------------------

const actors = new Map<string, ActorView>();
let level: LevelView | null = null;
let selfId: string | null = null;
let connection = 'connecting';
let lastError: string | null = null;

/**
 * WHY THE SIGN-IN FAILED, or null when it did not.
 *
 * Separate from `lastError` because the two have different lifetimes and
 * different cures: a server refusal is about the frame just sent and is gone by
 * the next one, while this is about the whole session and stays true until the
 * player relaunches. Kept as a sentence rather than a code — the server's own
 * refusals already read as instructions ("this Discord account is not on the
 * allowlist — ask to be added"), and there is nothing this file could add.
 */
let authError: string | null = null;

/**
 * WHO IS ACTUALLY IN THE ACTIVITY, from the Discord SDK.
 *
 * NOT the party and NOT the voice channel: docs/discord-activity.md gotcha 4 —
 * `getInstanceConnectedParticipants` answers "who has this game open", which is
 * a different set from both the party panel (server-authored, keyed by actor id)
 * and the people sitting in the VC. It is displayed as a COUNT and nothing else
 * for exactly that reason: joining these rows to party rows needs a Discord id
 * on a frame the server composes, and the client inventing that join would be
 * the client deciding who somebody is.
 */
let participants: readonly DiscordParticipant[] = [];

/** The last `turn` frame. Null until the server first says whose turn it is. */
let turn: TurnMsg | null = null;

/**
 * When the Bell expires, on THIS machine's clock.
 *
 * Stored as a deadline rather than as the remaining milliseconds so the display
 * counts down between frames instead of freezing at whatever the last packet
 * said. The conversion happens once, on arrival: the wire carries remaining
 * time precisely because the two clocks are not synchronised (protocol.ts says
 * so at `TurnMsg.bellMs`), and doing the arithmetic here confines the skew to
 * one flight time instead of letting it accumulate.
 */
let bellEndsAt: number | null = null;

/**
 * THE VIEWER'S OWN FOUR TALENTS, in server order, NEVER re-sorted here.
 *
 * `loadout` arrives once (M3 loadouts are fixed), `cooldowns` is a COMPLETE
 * absolute map of talent id -> game turns remaining — anything absent from it is
 * ready — and `resource` is the class pool. Three frames rather than one because
 * they change at wildly different rates: the loadout never, the cooldowns every
 * turn, the resource on every hit taken.
 */
let loadout: readonly LoadoutTalent[] = [];
let cooldowns: Readonly<Record<string, number>> = {};
let resource: ResourceView | null = null;

/** Hotbar index under the pointer, or -1. Cosmetic; the keyboard is the real input. */
let hoveredSlot = -1;

/**
 * The refusal line. See the header: an action that silently does nothing is the
 * worst failure mode in a turn-based game, so every rejected frame becomes one
 * of these.
 */
let notice: string | null = null;

/**
 * The talent this client last asked for.
 *
 * Kept solely so that an `error` frame can be turned into a sentence with a
 * NUMBER in it. The wire carries a typed `ErrorCode` and a human message, but
 * not the talent's own `minRange` or `range` — and "too close" without "needs 3
 * tiles" teaches nothing. The client already has the loadout, so it supplies the
 * number rather than the server duplicating it into every refusal.
 *
 * One outstanding talent is enough: `commit`-on-submit resolves immediately, so
 * there is never a queue of them in flight.
 */
let pendingTalentId: string | null = null;

/**
 * WHO HAS WHAT ON THEM, from the `effects` frame. Actor id -> badges.
 *
 * COMPLETE AND ABSOLUTE, replaced wholesale, never patched — protocol.ts says so
 * and this map is the only source of truth for a badge or a pip. The
 * `effect_applied` and `effect_expired` turn events deliberately do NOT write
 * here; see `applyTurnEvent`.
 */
let effects: ReadonlyMap<string, readonly EffectView[]> = new Map();

/** The `party` frame. Empty until the server first describes the party. */
let party: readonly PartyMember[] = [];

/**
 * THE `party_state` FRAME — who shares your barrier (v6).
 *
 * DISTINCT FROM `party` ABOVE, and the two are not interchangeable. `party` is
 * the whole FLOOR's roster: it drives the downed markers and the revive prompt,
 * and reviving a stranger is legal. This is YOUR PARTY — the people the server
 * makes you wait for, who leads, and the invites waiting on your answer.
 *
 * Null until the first frame arrives, which is not the same as "a party of one":
 * every player is always in a party, so an empty pane means the server has not
 * spoken yet, and drawing "you are alone" before it has would be a guess.
 */
let partyState: PartyStateMsg | null = null;

/** Panel visibility. Both default on; `c` and `p` toggle them. */
let logVisible = true;
let partyVisible = true;

/**
 * Live `point` markers, oldest first, each with the wall-clock instant it dies.
 *
 * A LIST WITH DEADLINES AND ONE TIMER, not a timer per ping. Four people
 * pointing in the same second would otherwise arm four independent timeouts, and
 * the bounded-timer promise at the top of this file is about being able to say
 * how many are running.
 */
type Ping = {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly diesAt: number;
};
let pings: readonly Ping[] = [];

/**
 * WAITING FOR A DIRECTION TO REVIVE IN.
 *
 * Only ever set when TWO OR MORE downed allies are adjacent, which is rare and
 * is exactly the case where guessing would pick the wrong person. One adjacent
 * ally resolves on the keypress; none says so. See `attemptRevive`.
 */
let reviveArmed = false;

/**
 * WHEN EACH PENDING INVITE LAPSES, on THIS machine's clock, keyed by inviter.
 *
 * `PartyInviteView.expiresInMs` is a DURATION rather than a deadline because the
 * two clocks are not synchronised — the same argument `TurnMsg.bellMs` makes —
 * so the conversion happens once, on arrival, and the skew is confined to one
 * flight time instead of accumulating. protocol.ts asks the client to drop a
 * lapsed row itself, and it has to: out of combat the pump idles, so there may
 * be no frame for minutes and a button that has quietly stopped working is worse
 * than no button.
 */
let inviteDeadlines: ReadonlyMap<string, number> = new Map();

/** True while the pointer is over the erased plate, so it reads as pressable. */
let respawnHovered = false;

/** Set in boot(), before the socket exists — so no frame can arrive first. */
let sweep: SweepPlayback | null = null;
let sprites: SpriteSource | null = null;
let targeting: Targeting | null = null;
let caseLog: CaseLog | null = null;
let combatBanner: CombatBanner | null = null;
/**
 * THE TOKEN MENU. Created in boot() like every other widget, and null before it,
 * so a frame that arrives during startup cannot open one.
 */
let tokenMenu: ContextMenu | null = null;
/**
 * THE WALK. Created in boot() with every other widget, for the same reason: a
 * `turn` frame arriving during startup must have something to observe or nothing
 * at all, never half a machine.
 *
 * It is asked for a step in `onMessage` and observed from `applyServerMessage`;
 * both are module scope, which is why this is not a `const` inside boot().
 */
let travel: Travel | null = null;

// ---------------------------------------------------------------------------
// THE HOVER CARD'S STATE
//
// Module scope because `applyServerMessage` (the `inspected` frame) and
// `paintHud` (the painter) both live out here, while the pointer events that
// drive it are inside boot(). See decision (d) for the four stacked guards these
// four variables implement between them.
// ---------------------------------------------------------------------------

/**
 * THE ACTOR UNDER THE POINTER, BY ID AND NEVER BY TILE.
 *
 * By id because the pointer crosses a dozen tiles of bare floor between two
 * tokens, and a hover tracked by tile would re-ask the server on every one of
 * them. Null means "nothing to describe", which is the normal state.
 */
let hoveredActorId: string | null = null;

/**
 * WHERE THE POINTER IS, in LOGICAL backbuffer pixels, or null.
 *
 * The card is anchored to the POINTER rather than to the actor's tile, and that
 * is forced rather than chosen: `lastCamX`/`lastCamY` are written at the very end
 * of `draw()` and render/canvas.ts exports no tile->screen transform, so a
 * tile-anchored card would need the second copy of `cameraAxis` that file warns
 * about repeatedly.
 */
let pointerPoint: TileXY | null = null;

/**
 * THE ANSWERS, KEYED BY ACTOR ID AND STAMPED WITH THE TURN THEY DESCRIBE.
 *
 * A hit for the CURRENT game turn draws immediately and sends nothing, so
 * sweeping back and forth between two husks costs one frame each per turn rather
 * than one per crossing. Invalidated wholesale on a turn edge and on the two
 * frames that replace the board — a hit chance from three turns ago is a wrong
 * number stated confidently, which is worse than an empty card.
 *
 * A `null` view is CACHED LIKE ANY OTHER ANSWER. It is the server's single reply
 * to "no such actor", "you cannot see it" and "that monster is dead"; re-asking
 * every 120 ms would be the one case that defeats the cache entirely.
 */
const inspectCache = new Map<
  string,
  { readonly view: InspectView | null; readonly gameTurn: number }
>();

/**
 * THE ONE OUTSTANDING QUESTION, or null. There is never more than one: a new
 * hover replaces it, and an answer that names anybody else is discarded on
 * arrival — protocol.ts's `InspectedMsg` says why matching is by target and not
 * by arrival order.
 */
let inspectInFlight: string | null = null;

/**
 * THE PINNED CARD — right-click, Inspect. Null unless a menu pinned one.
 *
 * A pin outranks the hover so the card survives the pointer leaving the token it
 * describes, which is the entire difference between "Inspect" and hovering. It
 * is dropped the moment the pointer finds a DIFFERENT actor, and on mouseleave.
 */
let pinnedInspectId: string | null = null;
let pinnedInspectView: InspectView | null = null;

/**
 * Show a refusal. Replaced in boot() with the real, self-clearing implementation.
 *
 * `applyServerMessage` is at module scope but the notice's timer belongs with
 * the Bell and the sweep beat inside `boot()`, where every other bounded timer
 * lives. This binding joins the two without hoisting a `setTimeout` handle into
 * module state, and the no-op default means a frame arriving before boot()
 * finishes is dropped rather than throwing.
 */
let onRefusal: (text: string) => void = () => {
  // No canvas and no timer yet. Nothing to show it on.
};

/**
 * Put a `point` marker on the board. Replaced in boot() with the real,
 * self-expiring implementation, for the same reason `onRefusal` is: the marker's
 * timer belongs with the Bell and the sweep beat inside `boot()`, where every
 * other bounded timer lives, and a frame arriving before boot() finishes is
 * dropped rather than throwing.
 */
let addPing: (actorId: string, x: number, y: number) => void = () => {
  // No timer yet.
};

/**
 * Take the invites off a fresh `party_state`: stamp each one's deadline, arm the
 * expiry timer, and announce anything new.
 *
 * Replaced in boot() with the real implementation, for the same reason
 * `addPing` is — the timer belongs with the other bounded timers, and a frame
 * arriving before boot() finishes is dropped rather than throwing.
 */
let noteInvites: (invites: readonly PartyInviteView[]) => void = () => {
  // No timer yet.
};

/**
 * STOP THE WALK, and say why if the player deserves a sentence.
 *
 * The same shape as `onRefusal` above and for the same reason: seven of the
 * eleven travel interrupts fire from `applyServerMessage`, which is module scope,
 * while the machine, the notice and the redraw all live inside boot(). Replaced
 * there; a no-op until then, so a frame arriving mid-startup is dropped rather
 * than throwing.
 *
 * IDEMPOTENT AND SILENT WHEN NOTHING WAS TRAVELLING. That is what lets every one
 * of those call sites be careless: `case 'error'` cancels a walk that is usually
 * not happening, and it must not print "travel stopped" over the server's own
 * refusal when it was not.
 */
let cancelTravel: (why?: string) => void = () => {
  // No machine yet.
};

/**
 * A `moved` frame named the viewer. Replaced in boot() with the real observation.
 *
 * ONE BINDING FOR BOTH LANES, and that is the whole point of it: a self move
 * arrives either as an immediate `moved` frame or inside a batched `sweep`, and
 * the walk's step-landed evidence must not depend on which. It is module scope
 * because `applyServerMessage` is, while the machine lives inside boot().
 */
let onSelfMoved: (x: number, y: number) => void = () => {
  // No machine yet.
};

/**
 * RE-ASK ABOUT THE PINNED CARD'S SUBJECT. Replaced in boot(), which owns the
 * socket; a no-op until then and a no-op when nothing is pinned.
 *
 * ═══ A PIN MUST NOT OUTLIVE THE TURN ITS NUMBERS DESCRIBE ═══
 * `inspectCache` is invalidated wholesale on every game-turn edge because hit
 * points, hit chances and blocked reasons are answers about ONE game turn. The
 * pin is a separate variable and `tooltipView()` consults it FIRST, so it used
 * to shadow that invalidation entirely: a card pinned on a husk went on stating
 * `42/42` and `Chance to hit 65%` in bold for as long as the player left it
 * there, through four bumps, a debuff and the husk's death. Worse than stale —
 * `inspectActor` would refuse to disclose anything about a dead monster or one
 * out of sight, so the card was showing what the server had stopped answering.
 *
 * Re-asking rather than clearing is what keeps the pin's one useful property,
 * which is that it outlives the pointer. A `view: null` reply retires the pin,
 * so the card correctly VANISHES when its subject dies or goes out of sight.
 */
let refreshPinnedInspect: () => void = () => {
  // No socket yet.
};

function bellRemainingMs(): number | null {
  return bellEndsAt === null ? null : Math.max(0, bellEndsAt - Date.now());
}

/**
 * ONE view, shared by the banner and the card strip, built once per frame.
 *
 * IT NO LONGER CARRIES THE ACTOR MAP OR `selfId`, and that is the M5 point. The
 * `turn` frame now names every card, its state, its hp, its portrait and which
 * one is you (`TurnActor.isSelf` — the reason the frame is unicast). Joining
 * against the local actor map to rebuild any of that would put a second answer
 * on screen beside the server's, and it would disagree first for the aggregate
 * hostile card, which has no body to join to.
 */
function turnView(): TurnView {
  return { turn, bellMs: bellRemainingMs() };
}

/**
 * Who is on the floor, keyed by actor id, for the renderer's under-token pass.
 *
 * DERIVED FROM `party` RATHER THAN HELD SEPARATELY. The party frame is the one
 * place Downed state arrives, and a second map maintained from `downed` and
 * `revived` events would be a second copy that drifts — the same mistake the
 * `damage` case avoids by taking absolute hp instead of subtracting.
 */
function downedMap(): ReadonlyMap<string, DownedView> {
  const out = new Map<string, DownedView>();
  for (const member of party) {
    if (member.downed !== null) out.set(member.id, member.downed);
  }
  return out;
}

/** The live pings, as the renderer wants them. */
function pingMarkers(): readonly PingMarker[] {
  return pings.map((ping) => ({ x: ping.x, y: ping.y, label: ping.label }));
}

/**
 * Every adjacent Downed ally, with the DIRECTION that reaches them.
 *
 * The direction is found by walking `DIR_ORDER` and comparing `step()` to the
 * ally's tile rather than by deriving one from a delta. That is deliberate: the
 * eight-way geometry already exists in src/shared/coords.ts, and a second
 * hand-rolled `dx,dy -> Dir` in the client is one sign flip away from sending a
 * revive at the person on the opposite side.
 *
 * ERASED BODIES ARE EXCLUDED. The timer has run out; only a floor reset brings
 * them back, and offering a rescue that cannot happen is worse than offering
 * none.
 */
function adjacentDowned(): { readonly id: string; readonly dir: Dir; readonly name: string }[] {
  const me = selfId === null ? undefined : actors.get(selfId);
  if (me === undefined) return [];

  const out: { id: string; dir: Dir; name: string }[] = [];
  for (const member of party) {
    if (member.downed === null || member.downed.status !== DownedStatus.Downed) continue;
    const body = actors.get(member.id);
    if (body === undefined || body.id === me.id) continue;
    if (chebyshev(me, body) !== 1) continue;
    const dir = DIR_ORDER.find((candidate) => {
      const cell = step(me, candidate);
      return cell.x === body.x && cell.y === body.y;
    });
    if (dir !== undefined) out.push({ id: member.id, dir, name: member.name });
  }
  return out;
}

/**
 * THE VIEWER'S OWN SURVIVAL STAGE, or null when they are on their feet.
 *
 * READ OFF `party`, exactly as `adjacentDowned` and `downedMap` are, because the
 * party frame is the one place Downed and Erased arrive and a second copy
 * maintained from events would be a second copy that drifts. It is what decides
 * whether the respawn prompt is on screen — and the prompt is the only place a
 * player ever learns the key exists, because it is the only moment it works.
 */
function selfDowned(): DownedView | null {
  if (selfId === null) return null;
  return party.find((member) => member.id === selfId)?.downed ?? null;
}

/** True while the viewer's countdown has run out and only a respawn is left. */
function selfErased(): boolean {
  return selfDowned()?.status === DownedStatus.Erased;
}

// ---------------------------------------------------------------------------
// THE PARTY PANE — one view, one layout, read by the painter and every hit test
// ---------------------------------------------------------------------------

/**
 * The invites that have NOT lapsed, on this machine's clock.
 *
 * Filtered HERE rather than in ui/partypanel.ts because the pane may not read a
 * clock for the same reason src/shared may not: a drawer that decided for itself
 * whether a row still exists would be a second answer to a question the frame
 * and the deadline map already answer together.
 */
function liveInvites(): PartyInviteView[] {
  if (partyState === null) return [];
  const now = Date.now();
  return partyState.invites.filter((invite) => (inviteDeadlines.get(invite.fromId) ?? 0) > now);
}

/**
 * THE PANE'S WHOLE VIEW, or null before the server has described the party.
 *
 * Null rather than an invented party of one: `party_state` arrives on the first
 * pump after `hello`, and drawing "you are alone" before it has landed would be
 * a guess about the one thing this pane exists to state.
 */
function partyView(): PartyPaneView | null {
  if (partyState === null) return null;
  return partyPaneView({
    state: partyState,
    invites: liveInvites(),
    roster: party,
    actors,
    effects,
    inCombat: turn?.inCombat === true,
  });
}

/** Everybody in the viewer's party, as ids — for the token menu's questions. */
function partyIds(): ReadonlySet<string> {
  return new Set((partyState?.members ?? []).map((member) => member.id));
}

/** True when the viewer leads their own party, and may therefore kick. */
function selfLeads(): boolean {
  return partyState?.members.some((member) => member.isSelf && member.isLeader) === true;
}

/**
 * EVERY OVERLAY'S GEOMETRY, IN ONE PLACE.
 *
 * The painter draws from this and every hit test reads it, which is the same
 * rule `slotRect` established in ui/hotbar.ts: two copies of a panel's position
 * is how a click lands on a tile that is underneath it, and the bug only shows
 * up on somebody else's window size. It is rebuilt per call — the party is at
 * most six rows, so this is a handful of objects, and a cached layout would be
 * one more thing that can be stale at the moment a button is pressed.
 */
type HudLayout = {
  readonly hudTop: number;
  readonly party: PartyPaneView | null;
  readonly pane: PartyPaneLayout | null;
  readonly log: PanelRect | null;
  /** The erased plate, or null when the viewer is on their feet. */
  readonly respawn: PanelRect | null;
};

function hudLayout(width: number, height: number): HudLayout {
  const hudTop = turnHudHeight(turnView());
  const band = panelBand(height, hudTop);
  const log = logPanelRect(width, height, hudTop, logVisible);
  const view = partyView();
  const pane =
    view === null || !partyVisible
      ? null
      : partyPaneLayout({
          view,
          width,
          top: band.top,
          bottom: band.bottom,
          // What the log is taking on the other side, so the pane can work out
          // how much map is left before it decides which form to wear.
          rightReserved: log === null ? 0 : log.w + PARTY_PANE_MARGIN * 2,
        });

  return {
    hudTop,
    party: view,
    pane,
    log,
    respawn: selfErased() ? respawnPromptRect({ width, top: band.top, bottom: band.bottom }) : null,
  };
}

function talentById(id: string | null): LoadoutTalent | null {
  if (id === null) return null;
  return loadout.find((talent) => talent.id === id) ?? null;
}

/**
 * Can this client see a reason the talent is unpayable?
 *
 * ADVISORY, and used only to grey a button. The server re-checks every budget on
 * arrival and answers `no_resource`; nothing here refuses to send.
 *
 * ONLY THE CLASS RESOURCE IS CHECKED, because only the class resource is on the
 * wire. `TalentCostView` also carries `ap` and `mp` — the intra-turn budget — and
 * there is no frame yet that says how much of either the viewer has left, so a
 * talent that is unaffordable purely on AP shows as ready and is refused by the
 * server with a sentence. That is the honest failure: guessing at a number
 * nobody sent would grey buttons that are fine. When an AP/MP frame lands, the
 * two extra comparisons go here and nothing else changes.
 */
function affordable(talent: LoadoutTalent): boolean {
  if (talent.cost.resource <= 0) return true;
  if (resource === null) return true;
  return resource.current >= talent.cost.resource;
}

function hotbarView(): HotbarView {
  const slots: HotbarSlot[] = loadout.map((talent) => ({
    talent,
    // Absent from `cooldowns` means READY — the server deletes the entry at
    // zero, mirroring ToME's `talents_cd[tid] = nil`.
    cooldown: cooldowns[talent.id] ?? 0,
    affordable: affordable(talent),
  }));

  const armedId = targeting?.talent()?.id ?? null;
  return {
    slots,
    hovered: hoveredSlot,
    armed: armedId === null ? -1 : loadout.findIndex((talent) => talent.id === armedId),
  };
}

/**
 * WHERE THE VIEWER IS STANDING, or null before `welcome` puts a body on the map.
 *
 * A COPY, not the ActorView: everything that asks this question — the click
 * intent, the walk, the menu's adjacency — wants a tile and nothing else, and
 * handing out the live actor invites somebody to read `hp` off it and call that
 * a rule.
 */
function selfTile(): TileXY | null {
  const me = selfId === null ? undefined : actors.get(selfId);
  return me === undefined ? null : { x: me.x, y: me.y };
}

/**
 * Everything the walk needs, rebuilt from the board on every call — the same
 * shape and the same reasoning as `targetingWorld` below.
 *
 * Every field may legitimately be null or empty before the first `welcome`;
 * input/travel.ts answers "no step this frame" for all of them rather than
 * throwing, which is why nothing here guards.
 */
function travelWorld(): TravelWorld {
  return { self: selfTile(), level, actors: [...actors.values()], turn };
}

/** Everything targeting needs, rebuilt from the board on every call. */
function targetingWorld(): TargetingWorld {
  const me = selfId === null ? undefined : actors.get(selfId);
  return {
    level,
    origin: me === undefined ? null : { x: me.x, y: me.y },
    // Living hostiles, so the cursor opens on something worth aiming at.
    // M4 SEAM: Mend Wounds wants ALLIES here, and `LoadoutTalent` does not yet
    // say which a talent prefers. Until it does, the opening pick is a
    // convenience and the player moves the cursor for a heal.
    candidates: [...actors.values()]
      .filter((actor) => actor.alive && actor.kind === ActorKind.Monster)
      .map((actor) => ({ x: actor.x, y: actor.y })),
    // EVERY living body, allies and the caster included. `single` needs one
    // present, `tile` (Fog Step) needs one absent — see `TargetingWorld`.
    // Corpses are excluded because they neither block movement nor answer to a
    // talent; protocol.ts is explicit that the body stays on the map.
    occupied: [...actors.values()]
      .filter((actor) => actor.alive)
      .map((actor) => ({ x: actor.x, y: actor.y })),
  };
}

/**
 * One line of prose, centred, on a strip dark enough to read over the map.
 *
 * Drawn rather than pushed into `#log` because `#log` is the `aria-live` region
 * and a canvas the player is staring at is not somewhere a screen reader looks.
 * Both get the text — this is the seen copy, `updateStatus` is the heard one.
 */
function drawLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  colour: string,
  width: number,
  y: number,
): void {
  ctx.save();
  ctx.font = FONT_HUD;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Inset, and CLIPPED. The inset leaves the playfield frame intact down both
  // edges — a full-width strip would paint two 14-pixel gaps in the two signals
  // a player catches out of the corner of their eye ("it is your move", in gold,
  // and "the fight is on", in crimson). It is derived from the frame's own
  // maximum thickness rather than hand-tuned, so a ring that changes weight
  // cannot silently start being painted over. The clip means a long talent name
  // truncates instead of bleeding off the backbuffer and into the letterbox.
  const inset = PLAYFIELD_FRAME_MAX_PX + 1;
  ctx.fillStyle = PALETTE.INK;
  ctx.fillRect(inset, y, width - inset * 2, LINE_H);
  ctx.beginPath();
  ctx.rect(inset, y, width - inset * 2, LINE_H);
  ctx.clip();
  ctx.fillStyle = colour;
  ctx.fillText(text, Math.floor(width / 2), y + LINE_H / 2);
  ctx.restore();
}

/**
 * The HUD layer, handed to the renderer as a painter so that render/ never has
 * to import ui/ (see `HudPainter` in render/canvas.ts).
 *
 * The bottom of the viewport is stacked UPWARD from the hotbar, using heights
 * the modules export, so no two of these bands can overlap because someone
 * changed a slot size: hotbar, then the resource pips, then the targeting hint,
 * then the refusal notice.
 */
const paintHud: HudPainter = (ctx, width, height) => {
  if (sprites === null) return;
  const view = turnView();
  // THE TOP HUD, IN TWO PIECES AND ONE MEASUREMENT. The banner is the sentence
  // and the playfield frame; the cards are the strip of faces under it, drawn
  // ONLY in combat. `turnHudHeight` is what both the dock and the combat banner
  // stack against, so nothing below can overlap the strip by carrying its own
  // copy of how tall it is.
  drawTurnBar({ ctx, view, width, height });
  const layout = hudLayout(width, height);
  const hudTop = layout.hudTop;
  drawTurnCards({ ctx, sprites, view, width, y: TURN_BAR_H });

  // THE TWO SIDE PANELS, between the turn HUD and the hotbar, and BEFORE the
  // prose lines below — `drawLine` paints an opaque full-width strip, so a
  // notice must be able to sit on top of a panel rather than under it.
  //
  // THE PARTY IS ON THE LEFT NOW. It is the surface that answers "who am I
  // playing with, are they still there, and who is asking to join", which is
  // what the first real multiplayer session found nobody could answer.
  if (layout.pane !== null && layout.party !== null) {
    drawPartyPane({ ctx, sprites, view: layout.party, layout: layout.pane });
  }
  if (layout.log !== null && caseLog !== null) {
    caseLog.draw({ ctx, sprites, rect: layout.log, gameTurn: turn?.gameTurn ?? -1 });
  }

  drawHotbar({ ctx, sprites, view: hotbarView(), width, height });

  const resourceY = height - HOTBAR_TOTAL_H - RESOURCE_H;
  drawResource({ ctx, sprites, resource, x: 4, y: resourceY + 3, width: width - 8 });

  const hint = targeting?.hint() ?? '';
  const hintY = resourceY - LINE_H;
  if (hint !== '') {
    // GOLD for a legal aim, ORANGE for one this client expects to be refused —
    // and the words say which, because colour is never the only signal here.
    const ok = targeting?.advice() === 'ok';
    drawLine(ctx, hint, ok ? PALETTE.GOLD : PALETTE.ORANGE, width, hintY);
  } else if (selfErased()) {
    // ═══ THE RESPAWN PROMPT, AND IT OUTRANKS THE REVIVE ONE ═══
    //
    // An erased player cannot act at all — they cannot revive anybody, so the
    // prompt below would be an instruction they cannot follow — and this is the
    // only key in the game that does anything for them. It is also the only
    // place the key is ever advertised: it works in exactly one state, so a
    // permanent legend would be furniture for the whole rest of the session.
    //
    // This is the fix for "I was stuck": the player who has run out of turns is
    // now told, on the canvas, in the slot their eyes are already on, that there
    // is a way back.
    drawLine(ctx, 'F — refile yourself and get back up', PALETTE.GOLD, width, hintY);
  } else {
    // THE REVIVE PROMPT, in the hint's slot when nothing is being aimed.
    //
    // It is a PROMPT rather than a permanent legend, and it appears only while
    // somebody is actually within reach — a line of prose that is always there
    // becomes furniture and stops being read, which is the same reason the
    // hotbar's talent name only shows on hover. game-design.md § 9 puts a
    // five-turn clock on this; the one moment it must be impossible to miss is
    // the moment a rescuer is standing next to a body.
    const reachable = adjacentDowned();
    const first = reachable[0];
    if (first !== undefined) {
      const who = reachable.length === 1 ? first.name : `${reachable.length} allies`;
      drawLine(ctx, `R — revive ${who}`, PALETTE.GOLD, width, hintY);
    }
  }

  if (notice !== null) {
    drawLine(ctx, notice, PALETTE.ORANGE, width, hintY - LINE_H);
  }

  // ═══ THE ERASED PLATE, OVER THE MAP AND IMPOSSIBLE TO MISS ═══
  //
  // The line above is the quiet copy in the slot the eye is already on; this is
  // the loud one, because the player who needs it is by definition stuck,
  // pressing keys that are all being refused, on a screen where nothing is
  // moving. See ui/respawnprompt.ts. It is also a button.
  if (layout.respawn !== null) {
    drawRespawnPrompt({ ctx, sprites, rect: layout.respawn, hovered: respawnHovered });
  }

  // ═══ THE HOVER CARD, AND IT LOSES TO BOTH OF THE SURFACES BELOW ═══
  //
  // Drawn AFTER the erased plate and BEFORE the combat banner, which fixes its
  // precedence exactly: the banner wins, the token menu wins, this loses to
  // both. Of the three claims on that piece of screen the incidental one is the
  // weakest — the banner is on for two and a half seconds and answers "the fight
  // has started", the menu was opened deliberately and is about to be clicked,
  // and this appeared because a pointer came to rest. A card that covered either
  // of them would be the mouse interrupting the two surfaces most likely to be
  // urgent, in exchange for a number the player can see again by hovering again.
  //
  // SUPPRESSED ENTIRELY WHILE THE MENU IS OPEN rather than merely drawn under
  // it: the menu opens AT THE POINTER, so the two overlap by construction, and a
  // card peeking out from behind the rows it is hiding reads as a rendering bug.
  const tip = tooltipView();
  if (tip !== null && pointerPoint !== null && tokenMenu?.visible() !== true) {
    drawTooltip({
      ctx,
      sprites,
      view: tip,
      px: pointerPoint.x,
      py: pointerPoint.y,
      viewportW: width,
      viewportH: height,
    });
  }

  // THE COMBAT BANNER IS DRAWN LAST, over the dock and everything else.
  //
  // For the two and a half seconds it is up it is the most important thing on
  // the screen — "the players do not know when combat starts" is the bug it
  // exists for — and a banner tucked underneath the party panel would answer
  // that report with "well, it was there". It costs the top of the dock for
  // three seconds, once per fight, which is the cheapest thing in this file.
  //
  // `hudTop`, not `TURN_BAR_H`: it opens at the top of the MAP, below the card
  // strip that has just appeared with it. Covering the cards with the banner
  // announcing them would hide the answer at the moment it was being given.
  combatBanner?.draw({ ctx, width, top: hudTop });

  // ...EXCEPT THE TOKEN MENU, which is drawn after even the banner. It is the
  // only surface here the player opened deliberately and is about to click, and
  // a menu underneath a three-second announcement is a menu whose rows cannot be
  // read at the moment they are being aimed at.
  tokenMenu?.draw({ ctx, sprites });
};

/**
 * WHAT THE HOVER CARD SHOULD SAY RIGHT NOW, or null for "draw nothing".
 *
 * THE PIN OUTRANKS THE HOVER, which is the whole of the difference between the
 * two gestures. Below it, a cached answer for the actor under the pointer — and
 * `null` is a legitimate cached answer (no such actor / cannot see it / a dead
 * monster), so a miss and a null both come out here as "draw nothing". Do NOT
 * try to tell those three apart: the server went to some trouble to make them
 * indistinguishable, and a client that sorted them would be the oracle
 * `InspectedMsg` exists to close.
 */
/**
 * Drop every inspect answer and any card on screen.
 *
 * Called from the two frames that replace the board wholesale. An actor id is
 * only meaningful within one session's world, so a cache carried across a
 * `welcome` could describe the wrong body — and a pinned card describing
 * somebody who is not on this floor is worse than no card.
 */
function forgetInspections(): void {
  inspectCache.clear();
  inspectInFlight = null;
  hoveredActorId = null;
  pinnedInspectId = null;
  pinnedInspectView = null;
}

function tooltipView(): InspectView | null {
  if (pinnedInspectView !== null) return pinnedInspectView;
  if (hoveredActorId === null) return null;
  return inspectCache.get(hoveredActorId)?.view ?? null;
}

function scene(): Scene {
  return {
    level,
    actors: [...actors.values()],
    selfId,
    targeting: targeting?.cells(),
    cursor: targeting?.cursor() ?? null,
    // THE ROUTE PREVIEW, PASSED UNCONDITIONALLY AND WITHOUT A GUARD. Both
    // accessors answer "nothing" while idle — `preview()` is empty and
    // `destination()` is null — and render/canvas.ts treats an empty array and
    // an absent one identically, so the preview clears itself on arrival with
    // nothing to reset here.
    path: travel?.preview(),
    pathEnd: travel?.destination() ?? null,
    overlays: sweep?.overlays(),
    downed: downedMap(),
    effects,
    pings: pingMarkers(),
    hud: paintHud,
  };
}

/**
 * Turn a refusal into a sentence the player can act on.
 *
 * THE NUMBER IS THE ENTIRE LESSON. "too close" tells someone their input was
 * wrong; "too close — Sniper's Mark needs 3 tiles" tells them what to do next,
 * and it is the one moment the game gets to teach the Inspector's dead zone. The
 * five M3 codes each map to a different instruction, which is exactly why
 * protocol.ts refused to collapse them into one `illegal_move`.
 *
 * Exhaustive over `ErrorCode` with no `default`, so a sixth refusal cannot ship
 * as an opaque code with a raw server string under it.
 */
function refusalText(code: ErrorCode, fallback: string): string {
  const talent = talentById(pendingTalentId);
  const name = talent === null ? 'that talent' : talent.name;

  switch (code) {
    case ErrorCode.TooClose:
      return talent === null ? 'too close' : `too close — ${name} needs ${talent.minRange} tiles`;
    case ErrorCode.OutOfRange:
      return talent === null
        ? 'out of range'
        : `out of range — ${name} reaches ${talent.range} tiles`;
    case ErrorCode.NoLos:
      return `no line of sight — something is between you and that tile`;
    case ErrorCode.OnCooldown: {
      const left = talent === null ? 0 : (cooldowns[talent.id] ?? 0);
      return left > 0
        ? `${name} is cooling down — ${left} more turn(s)`
        : `${name} is cooling down`;
    }
    case ErrorCode.NoResource: {
      const pool = resource === null ? 'resource' : resourceLabel(resource.kind);
      const cost = talent === null ? null : talent.cost.resource;
      const have = resource === null ? null : Math.floor(resource.current);
      return cost === null || have === null
        ? `not enough ${pool} for ${name}`
        : `not enough ${pool} — ${name} costs ${cost}, you have ${have}`;
    }
    case ErrorCode.NotYourTurn:
      return 'not your turn yet — the clock has not asked you';
    case ErrorCode.IllegalMove:
      return 'you cannot go that way';
    case ErrorCode.RateLimited:
      return 'too many commands — slow down';
    case ErrorCode.BadMessage:
    case ErrorCode.VersionMismatch:
    case ErrorCode.NotAuthenticated:
    case ErrorCode.Internal:
      // Not a game rule — a protocol fault. Show the server's own words; there
      // is nothing useful this file can add and inventing prose would hide it.
      return fallback;
  }
}

/**
 * WHY THE WALK STOPPED, when an `error` frame is what stopped it.
 *
 * Separate from `refusalText` because the two answer different questions. That
 * one explains the REFUSAL — it is shown for every error, walking or not, and it
 * is where the number goes. This one explains what happened TO THE ROUTE, and it
 * is shown only when a walk was actually running.
 *
 * ═══ IT EXISTS BECAUSE ONE SENTENCE FOR EVERY CODE WAS A LIE ═══
 * "the way was refused" used to be printed for all of them, `rate_limited`
 * included — so a walk killed by the socket's own 20-a-second bucket blamed the
 * route, and the actual diagnosis (the client is sending too fast; see
 * TRAVEL_STEP_MS) was thrown away at the one moment somebody was looking at it.
 * A wrong cause is worse than no cause: it sends the next hour of debugging into
 * the map generator.
 */
function travelStopText(code: ErrorCode): string {
  switch (code) {
    // The two the ROUTE can actually be wrong about. `illegal_move` is a wall or
    // a body — including the refund the server unicasts when a move that was
    // legal on arrival is refused at resolution — and `not_your_turn` is the
    // barrier saying this step came at the wrong moment.
    case ErrorCode.IllegalMove:
    case ErrorCode.NotYourTurn:
      return 'the way was refused — travel stopped';
    case ErrorCode.RateLimited:
      return 'the server is throttling this client — travel stopped';
    // Everything else stopped the walk without being about the walk: a talent
    // refusal that happened to land mid-stride, or a protocol fault. Say that
    // the walk stopped and nothing more — `refusalText` has already shown the
    // server's own words for what actually went wrong.
    case ErrorCode.TooClose:
    case ErrorCode.OutOfRange:
    case ErrorCode.NoLos:
    case ErrorCode.OnCooldown:
    case ErrorCode.NoResource:
    case ErrorCode.BadMessage:
    case ErrorCode.VersionMismatch:
    case ErrorCode.NotAuthenticated:
    case ErrorCode.Internal:
      return 'travel stopped';
  }
}

function replaceActors(next: readonly ActorView[]): void {
  actors.clear();
  for (const actor of next) actors.set(actor.id, actor);
}

/**
 * The COARSE turn phase, for the status line.
 *
 * Deliberately not `bannerFor`, and deliberately without the Bell's seconds:
 * `#log` is `aria-live="polite"`, so every change to it is announced, and a
 * countdown wired into it would read the whole line aloud four times a second.
 * The canvas carries the live clock; this carries the state, which changes a
 * handful of times per turn.
 *
 * IT LEADS WITH WHETHER THERE IS A FIGHT, because this is the copy a screen
 * reader hears and "the players do not know when combat starts" is the bug. The
 * combat banner announces the CROSSING once; this states the CONDITION for as
 * long as it lasts, which is what somebody who tabbed back in needs.
 *
 * Read off `TurnActor.state` — the server's own answer, the same one the cards
 * are drawn from — rather than re-deriving the barrier's precedence from the
 * three id arrays. Exhaustive with no `default`, so a sixth state cannot ship as
 * silence in the one region a screen reader is listening to.
 */
function turnPhase(): string {
  if (turn === null) return 'no turn yet';
  if (!turn.inCombat) return 'free movement';

  const card = selfCard(turn);
  const owed = owedCount(turn);
  if (card === null) return `in combat, waiting on ${owed}`;

  switch (card.state) {
    case TurnActorState.Waiting:
    case TurnActorState.Bell:
      return 'IN COMBAT — YOUR TURN';
    case TurnActorState.Committed:
      return owed === 0 ? 'in combat, committed' : `in combat, committed, waiting on ${owed}`;
    case TurnActorState.StandingBy:
      return card.downed ? 'DOWN — an ally can reach you' : 'in combat, standing by';
    case TurnActorState.Acting:
      return 'in combat, resolving';
  }
}

/**
 * Apply ONE thing that happened, from either lane.
 *
 * There is exactly one of these on purpose: a monster's step arrives inside a
 * batched `sweep` and a player's arrives as `attacked`/`damaged`/`died`, and two
 * implementations of "an actor took damage" are two implementations that
 * eventually disagree. protocol.ts wraps the identical payload in both lanes so
 * that this function can be the only reader.
 */
function applyTurnEvent(event: TurnEvent): void {
  switch (event.k) {
    case 'move': {
      const actor = actors.get(event.id);
      if (actor === undefined) {
        // An actor we have never seen. Not fatal — the next `state` resyncs.
        console.warn(`sweep move for unknown actor ${event.id}`);
        break;
      }
      // Absolute destination. `fromX`/`fromY` are ignored: they exist for a
      // client that interpolates the step, and this one deliberately does not.
      actors.set(event.id, { ...actor, x: event.x, y: event.y });
      // THE SWEEP LANE'S COPY OF "I MOVED". A player's own step normally comes
      // back as a `moved` frame, but this lane carries the identical fact for a
      // move resolved inside a batch — and the walk must not conclude it was
      // refused (interrupt 10) merely because the confirmation took the other
      // road. protocol.ts wraps the same payload in both lanes precisely so this
      // function can be the only reader; that is exactly why the hook is here.
      if (event.id === selfId) onSelfMoved(event.x, event.y);
      break;
    }
    case 'attack':
      // No swing art in M2. The sweep marks the struck tile for a beat instead,
      // and M5's hit flashes hang off this case.
      break;
    case 'damage': {
      const actor = actors.get(event.id);
      if (actor === undefined) break;
      // ABSOLUTE, never `hp - amount`: a client that missed a frame heals or
      // kills itself back into agreement on the next hit instead of drifting
      // forever. `amount` is for the floating number in M4, not for arithmetic.
      actors.set(event.id, { ...actor, hp: event.hp, maxHp: event.maxHp });
      // TRAVEL INTERRUPT (5): SOMETHING HIT YOU. Walking on while your health
      // bar drops is the single worst thing an auto-walk can do — it is how a
      // player dies to a fight they never saw start — and it is worth stopping
      // for even when the source is a trap or a friend's misfire, because in
      // every one of those cases the plan the player agreed to is stale.
      if (event.id === selfId) cancelTravel('you were hit — travel stopped');
      break;
    }
    case 'death': {
      // THE BODY STAYS ON THE MAP. protocol.ts is explicit: a corpse stops
      // acting and stops blocking, but absence is never the death signal —
      // deleting it here would make a kill look identical to an actor walking
      // out of view, and would delete a Downed player in M4.
      const actor = actors.get(event.id);
      if (actor === undefined) break;
      actors.set(event.id, { ...actor, alive: false, hp: 0 });
      break;
    }
    case 'talent':
      // THE FX STAMP, and deliberately NO STATE CHANGE. A talent event says
      // "this went off here, in this shape"; the hit points it moved arrive as
      // the ordinary `damage` events that follow it, through the case above.
      // Applying anything here would be a second implementation of "an actor
      // took damage", which is exactly what this one function exists to prevent.
      //
      // FX SEAM (M3 client): the stamp hangs off here and off `markersFor` in
      // render/sweep.ts, built from `shape` and `radius` alone.
      break;

    // -----------------------------------------------------------------------
    // M4. THE BADGES AND THE DOWNED TIMER ARE SNAPSHOT-DRIVEN, NOT EVENT-DRIVEN.
    //
    // `effects` and `party` arrive complete in the same pump as these events —
    // every actor's whole badge row, every party member's whole state — so
    // applying a patch here as well would be a second source of truth for the
    // same fact. `cooldowns` documents where that ends: a client that dropped
    // one frame leaves a Stun icon on a monster forever, and "is that one still
    // stunned?" is a question that gets somebody killed.
    //
    // What these events ARE for is the BEAT. They arrive inside a paced `sweep`,
    // so the client knows which step of the playback the badge popped on and
    // where to float "Stunned 1, not 3". That is the FX seam below, and it is
    // the only thing that should ever hang off these five cases.
    // -----------------------------------------------------------------------
    case 'effect_applied':
    case 'effect_expired':
      break;
    case 'downed': {
      // NOT a death: 0 hp, `alive` still true, a five-turn timer and an ally who
      // can still reach them (game-design.md § 9). The COUNTDOWN is drawn from
      // the `party` frame — this event carries neither the marker nor the
      // denominator — and the token stays exactly where it fell.
      //
      // The VITALS are applied, because 0 hp is the definition of Downed and the
      // bar must not sit at 7/58 for the frame between this event and the party
      // snapshot. `alive` is deliberately untouched: the M3 client treated 0 hp
      // as a corpse, and a corpse is not something anybody runs to.
      const actor = actors.get(event.id);
      if (actor === undefined) break;
      actors.set(event.id, { ...actor, hp: 0 });
      // TRAVEL INTERRUPT (6): YOU WENT DOWN. Every move you send from here is
      // refused anyway, so a walk left running would spend the five-turn rescue
      // window firing frames at a server that answers `not_your_turn` — and it
      // would leave a route drawn across the map from a body that is not going
      // anywhere.
      if (event.id === selfId) cancelTravel('you went down — travel stopped');
      break;
    }
    case 'revived': {
      // SOMEBODY GOT THERE IN TIME. Absolute hp, like every other vital on the
      // wire and for the same reason — a client that dropped a frame is
      // corrected here rather than drifting. Whether the timer is gone is the
      // `party` frame's answer, as above.
      const actor = actors.get(event.id);
      if (actor === undefined) break;
      actors.set(event.id, { ...actor, hp: event.hp, maxHp: event.maxHp, alive: true });
      break;
    }
    case 'erased':
      // Erased is followed by the floor resetting and a fresh `welcome`, which
      // replaces the board wholesale. Deleting the token here would race that.
      break;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

setStatusText('starting...');

async function boot(): Promise<void> {
  // --- identity ------------------------------------------------------------
  // FIRST, AND BEFORE ANYTHING ELSE EXISTS. Three reasons, in order:
  //
  //   1. The socket wants the session id in its very first frame, and `hello`
  //      is sent from the `open` listener — there is no later moment at which
  //      to hand it over without inventing a re-hello.
  //   2. A refusal is a thing to SAY, not a thing to discover. Somebody who is
  //      not on the allowlist should read that sentence before the art loads,
  //      not after a minute of watching a map they cannot play on.
  //   3. It is the one step that can open a modal in front of the player. Doing
  //      it while the canvas is still blank means the consent dialog is not
  //      covering a half-drawn dungeon.
  //
  // `establishDiscordSession` never throws — every failure comes back as a
  // sentence — so this cannot take the boot path down, and a browser tab
  // returns in microseconds with `session: null` and no error at all.
  setStatusText('authorising with Discord...');
  const discord = await establishDiscordSession();
  authError = discord.error;

  setStatusText('loading assets...');
  const library = await loadAssetLibrary(isNeeded);
  if (library.missing.length > 0) {
    console.warn(`${library.missing.length} asset(s) failed to load`, library.missing);
  }
  sprites = library;

  const renderer = createRenderer({ canvas, sprites: library });
  renderer.resize();

  // --- draw scheduling ------------------------------------------------------
  // One pending rAF at a time. `frameHandle` doubles as the dirty flag: nonzero
  // means "a draw is already queued for the next frame, fold this change into
  // it". requestAnimationFrame never returns 0, so 0 is a safe sentinel.
  let frameHandle = 0;
  function requestDraw(): void {
    if (frameHandle !== 0) return;
    frameHandle = window.requestAnimationFrame(() => {
      frameHandle = 0;
      renderer.draw(scene());
    });
  }

  // The status line is an aria-live region: writing the same string again still
  // announces it, so only genuine changes are written.
  let lastStatus = '';
  function updateStatus(): void {
    const me = selfId === null ? undefined : actors.get(selfId);
    const parts = [connection, turnPhase()];
    // THE CRIMSON FRAME'S ACCESSIBLE TWIN, and it is a persistent state rather
    // than an event on purpose. `#log` is the aria-live region, and it is
    // announced only when the whole string changes — so this line says itself
    // once, at the crossing, and then stays true for anyone who asks again.
    // The canvas has the banner and the border; this is the heard copy, and it
    // names the RULE CHANGE rather than just the fact, because "combat" does
    // not tell a new player that their next step now costs a turn.
    if (turn !== null) {
      parts.push(turn.inCombat ? 'CONTACT — turn by turn' : 'clear — free movement');
    }
    parts.push(`${actors.size} actor(s)`);
    if (me !== undefined) parts.push(`${me.name} @ ${me.x},${me.y}`);
    parts.push(`${renderer.metrics().scale}x`);
    // The refusal goes through the aria-live region too. The canvas line is the
    // seen copy; this is the heard one, and a refusal nobody can hear is a
    // silent no-op for exactly the players who most need to be told.
    // THE REVIVE AFFORDANCE, IN THE HEARD COPY TOO. The canvas prompt is the
    // seen one; this is what a screen reader announces the moment somebody steps
    // into reach of a body, which is the only notification a five-turn window
    // gets. It is announced once because `lastStatus` suppresses repeats.
    //
    // THE RESPAWN AFFORDANCE COMES FIRST for the same reason it does on the
    // canvas: a player who is Erased cannot revive anybody, and being told about
    // somebody else's countdown while stuck inside their own is the announcement
    // that helps least.
    if (selfErased()) {
      // ONE COPY OF THE SENTENCE, shared with the plate on the canvas
      // (ui/respawnprompt.ts). The plate is the seen one, this is the heard one,
      // and a screen reader and a canvas disagreeing about the way out would be
      // the cruellest possible bug in this particular state.
      parts.push(RESPAWN_PROMPT_SPEECH);
    } else {
      const reachable = adjacentDowned();
      const firstDown = reachable[0];
      if (firstDown !== undefined) {
        parts.push(
          reachable.length === 1
            ? `R: revive ${firstDown.name}`
            : `R: revive (${reachable.length} down)`,
        );
      }
    }
    // AN INVITATION IS ANNOUNCED, because it lapses. `party_state` carries the
    // offers waiting on this player and nobody else's; the canvas pane draws
    // them, and this is the heard copy — an offer a screen-reader user never
    // learns about is an offer that quietly expires. The name is drawn from the
    // frame's own `fromName`, which the server has already filtered.
    //
    // `liveInvites`, not `partyState.invites`: an offer that has lapsed on this
    // machine's clock is one the pane has already dropped and the server will
    // refuse, and a status line still announcing it would be the one surface
    // telling a screen-reader user to press a button that is no longer there.
    const invite = liveInvites()[0];
    if (invite !== undefined) {
      parts.push(`${invite.fromName} invites you to a party`);
    }
    if (participants.length > 0) parts.push(`${participants.length} in the activity`);
    if (notice !== null) parts.push(notice);
    // The sign-in failure OUTLIVES every other line here on purpose: it is the
    // one condition that does not fix itself, and a player who missed the
    // notice needs to still be able to read why nobody knows their name.
    if (authError !== null) parts.push(`sign-in failed: ${authError}`);
    if (lastError !== null) parts.push(`! ${lastError}`);

    const next = parts.join('  ·  ');
    if (next === lastStatus) return;
    lastStatus = next;
    setStatusText(next);
  }

  // --- the notice ----------------------------------------------------------
  // The third and last bounded timer. It REPLACES rather than queues: a player
  // mashing a talent that is on cooldown sees one line that keeps resetting, not
  // four seconds of backlog after they have stopped.
  let noticeTimer = 0;
  function showNotice(text: string): void {
    notice = text;
    if (noticeTimer !== 0) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      noticeTimer = 0;
      notice = null;
      requestDraw();
      updateStatus();
    }, NOTICE_MS);
    requestDraw();
    updateStatus();
  }
  function clearNotice(): void {
    if (noticeTimer !== 0) {
      window.clearTimeout(noticeTimer);
      noticeTimer = 0;
    }
    if (notice === null) return;
    notice = null;
    requestDraw();
    updateStatus();
  }
  onRefusal = showNotice;

  // --- the Bell ------------------------------------------------------------
  // A bounded loop, armed only while a countdown is on screen and disarmed by
  // its own last tick. If the deadline passes before the server rules on it the
  // display sits at 0 rather than going negative or vanishing: the Bell has
  // expired as far as this client knows, and the authoritative answer is the
  // next `turn` frame.
  let bellTimer = 0;
  function stopBellTimer(): void {
    if (bellTimer === 0) return;
    window.clearInterval(bellTimer);
    bellTimer = 0;
  }
  function syncBellTimer(): void {
    if (bellEndsAt === null) {
      stopBellTimer();
      return;
    }
    if (bellTimer !== 0) return;
    bellTimer = window.setInterval(() => {
      const left = bellRemainingMs();
      requestDraw();
      updateStatus();
      if (left === null || left === 0) stopBellTimer();
    }, BELL_TICK_MS);
  }

  // --- the point markers ---------------------------------------------------
  // THE FOURTH BOUNDED TIMER, and the only one whose queue can hold more than
  // one thing. ONE timeout for the whole list, always aimed at the next deadline
  // and re-armed only if something is still alive — four people pointing in the
  // same second cost one timer, not four, which is what makes the count at the
  // top of this file a number anybody can state.
  let pingTimer = 0;
  function sweepPings(): void {
    pingTimer = 0;
    const now = Date.now();
    const before = pings.length;
    pings = pings.filter((ping) => ping.diesAt > now);
    if (pings.length !== before) requestDraw();
    armPingTimer();
  }
  function armPingTimer(): void {
    if (pingTimer !== 0 || pings.length === 0) return;
    const next = Math.min(...pings.map((ping) => ping.diesAt));
    pingTimer = window.setTimeout(sweepPings, Math.max(16, next - Date.now()));
  }
  addPing = (actorId, x, y) => {
    // ONE MARKER PER POINTER. Somebody jabbing at three tiles in a row means
    // "that one, no, THAT one", and leaving the first two up says the opposite.
    const label = actors.get(actorId)?.name ?? '';
    pings = [
      ...pings.filter((ping) => ping.label !== label || label === ''),
      { x, y, label, diesAt: Date.now() + PING_MS },
    ];
    armPingTimer();
    requestDraw();
  };

  // --- pending invites -----------------------------------------------------
  // THE SIXTH BOUNDED TIMER, and it has the same shape as the point markers
  // above for the same reason: ONE timeout for the whole list, aimed at the
  // nearest deadline and re-armed only while something is still pending. Two
  // people inviting you in the same second cost one timer, not two.
  //
  // It exists because an invite LAPSES and out of combat the pump idles — there
  // may be no frame for minutes, and an ACCEPT button that has quietly stopped
  // working is worse than no button at all.
  let inviteTimer = 0;
  function sweepInvites(): void {
    inviteTimer = 0;
    const now = Date.now();
    const live = new Map([...inviteDeadlines].filter(([, diesAt]) => diesAt > now));
    if (live.size !== inviteDeadlines.size) {
      inviteDeadlines = live;
      requestDraw();
      updateStatus();
    }
    armInviteTimer();
  }
  function armInviteTimer(): void {
    if (inviteTimer !== 0 || inviteDeadlines.size === 0) return;
    const next = Math.min(...inviteDeadlines.values());
    inviteTimer = window.setTimeout(sweepInvites, Math.max(16, next - Date.now()));
  }
  noteInvites = (invites) => {
    // The deadline is computed ONCE, on arrival — see `inviteDeadlines`. An
    // invite already known keeps its original deadline rather than being
    // refreshed by every repeat of the frame, which would make an offer immortal
    // while the party panel kept re-sending it.
    const next = new Map<string, number>();
    const now = Date.now();
    for (const invite of invites) {
      next.set(invite.fromId, inviteDeadlines.get(invite.fromId) ?? now + invite.expiresInMs);
    }
    // A NEW OFFER IS SAID OUT LOUD. The pane draws it, but the pane can be
    // toggled off, collapsed to portraits, or simply not where somebody is
    // looking — and an invite that lapses unseen is the whole feature failing
    // quietly. `updateStatus` carries the same sentence to the aria-live region.
    for (const invite of invites) {
      if (inviteDeadlines.has(invite.fromId)) continue;
      onRefusal(`${invite.fromName} invites you — click ACCEPT, or type /accept`);
    }
    inviteDeadlines = next;
    armInviteTimer();
    requestDraw();
  };

  // --- the walk ------------------------------------------------------------
  // Created here with every other widget, so no frame can arrive before it
  // exists. The MACHINE holds no timer; the pacing timer below is this file's,
  // and it is the only clock in the feature.
  travel = createTravel();

  // THE EIGHTH BOUNDED TIMER, and the last. One shot, never stacked (the handle
  // is the guard), cleared on every cancel. See TRAVEL_STEP_MS for why a walk
  // needs a floor on its own send rate at all.
  let travelTimer = 0;
  /** Earliest wall-clock time the next step may go out. See TRAVEL_STEP_MS. */
  let nextStepAtMs = 0;

  /**
   * STOP THE WALK. The one place it is stopped, and it is deliberately dull.
   *
   * `wasWalking` is read BEFORE the cancel so that the sentence and the redraw
   * happen only when something was actually interrupted. Seven call sites hand
   * this a reason for a walk that is usually not running — `case 'error'` most
   * of all — and a notice printed for every one of them would sit on top of the
   * server's own typed refusal, which is the one sentence with the number in it.
   */
  cancelTravel = (why) => {
    const wasWalking = travel !== null && travel.active();
    travel?.cancel();
    // Unconditionally, even when nothing was walking: a pending tick for a walk
    // that has just been cancelled would wake up, find `active()` false and do
    // nothing — but a handle left set is a tick that never gets scheduled again.
    if (travelTimer !== 0) {
      window.clearTimeout(travelTimer);
      travelTimer = 0;
    }
    if (!wasWalking) return;
    if (why !== undefined) showNotice(why);
    requestDraw();
  };

  onSelfMoved = (x, y) => {
    travel?.observeSelfMoved({ x, y });
  };

  /** For Escape's ordered chain: did this press actually back out of a walk? */
  function cancelTravelIfActive(): boolean {
    if (travel === null || !travel.active()) return false;
    cancelTravel();
    return true;
  }

  /**
   * ASK FOR A STEP AND SEND IT. THE ONLY PLACE TRAVEL PUTS A FRAME ON THE WIRE.
   *
   * ═══ IT SENDS `move` AND NEVER, EVER A FOLLOWING `commit` ═══
   * This is the single most consequential line in the mouse layer, and it is
   * exactly the line a future reader will try to "fix" by adding the commit that
   * the keyboard's Enter key sends. Why it must not:
   *
   *   barrier.ts:293-305 is COMMIT-ON-SUBMIT — "a submitted intent IS the
   *   commitment, even before it resolves" — so the `move` below has already
   *   committed this player's turn by the time the server has read it.
   *   scheduler.ts:718 then resolves a player's intent inside the same pump,
   *   spending the energy. A `commit` arriving after that lands at
   *   turn-engine.ts:1008 with `pendingIntent === null`, which submits
   *   HOLD_INTENT — and that hold sits queued and burns the NEXT turn.
   *
   * So travel-with-commit costs every traveller TWO turns per tile, in a game
   * where the whole party is phase-locked behind one barrier. The keyboard
   * already proves the correct shape: `onMove` sends `move` alone.
   *
   * Called from `onMessage` (the one place every applied frame passes through
   * with the board settled), once at `begin`, because out of combat the pump
   * idles and no frame would arrive to tick the first step, and from its own
   * pacing timer.
   *
   * ═══ THE PACING TIMER IS NOT A FEEL SETTING ═══
   * Without it the loop runs at one step per round trip with no floor, which on
   * a LAN empties the gateway's 20-a-second bucket in half a room — see
   * TRAVEL_STEP_MS. The timer is what lets a step be DEFERRED rather than
   * dropped: out of combat the server pump idles, so a tick that simply returned
   * would leave the walk waiting for a frame that is never coming.
   */
  function tickTravel(): void {
    if (travel === null || !travel.active()) return;
    // A tick is already booked. Two would double the rate the floor exists to
    // hold, which is the one thing this must not do.
    if (travelTimer !== 0) return;

    const now = Date.now();
    if (now < nextStepAtMs) {
      travelTimer = window.setTimeout(() => {
        travelTimer = 0;
        tickTravel();
        // The step may have moved the preview; nothing else in this path draws.
        requestDraw();
      }, nextStepAtMs - now);
      return;
    }

    const walk = travel.nextStep(travelWorld());
    if (walk === null) return;
    nextStepAtMs = now + TRAVEL_STEP_MS;
    // A SEND THAT DID NOT HAPPEN MUST NOT LOOK LIKE A STEP IN FLIGHT. `send`
    // answers false whenever the socket is not OPEN — which during a reconnect
    // backoff can be fifteen seconds — and the machine has already recorded the
    // step as sent. Left unread, the route stays painted across the map, the
    // token never moves, and nothing on screen says why.
    if (!socket.send({ v: PROTOCOL_VERSION, t: 'move', dir: walk.dir })) {
      cancelTravel('lost connection — travel stopped');
    }
  }

  /**
   * Start a walk to a tile, and say what happened — or deliberately say nothing.
   *
   * The three answers are path.ts's own three and they are never conflated:
   * a route, "you are already there" (silence, because the player can see they
   * are standing on it) and "no route" (a sentence, because an unreachable tile
   * looks identical to a click that did not register).
   */
  function beginTravel(to: TileXY, stopShort: boolean): void {
    const from = selfTile();
    if (travel === null || from === null || level === null) {
      showNotice('the floor has not arrived yet');
      return;
    }
    switch (travel.begin({ from, to, level, stopShort })) {
      case TravelStart.Started:
        clearNotice();
        // The first step goes out NOW rather than waiting for a frame that, out
        // of combat, may never come — the pump idles when nobody is fighting.
        tickTravel();
        requestDraw();
        return;
      case TravelStart.NoRoute:
        showNotice('no route to that tile');
        return;
      case TravelStart.AlreadyThere:
        // path.ts:303-311: `[]` is "you are standing on it", which is not a
        // refusal and gets no sentence.
        return;
    }
  }

  // --- the hover card ------------------------------------------------------
  // THE SEVENTH AND LAST BOUNDED TIMER. One shot, replaced rather than stacked,
  // and armed only when the pointer moves onto a DIFFERENT actor. See
  // HOVER_SETTLE_MS for why the delay is a rate limit rather than a taste.
  let hoverTimer = 0;

  /**
   * The pointer has come to rest on a token. Ask, unless we already know.
   *
   * THREE OF DECISION (d)'S FOUR GUARDS ARE HERE — the cache, the one-in-flight
   * rule, and the fact that nothing is sent for a hover that has already moved
   * on. The fourth (track by id, not by tile) is in `noteHoveredActor`.
   */
  function requestInspect(): void {
    const id = hoveredActorId;
    if (id === null) return;
    const known = inspectCache.get(id);
    // A HIT FOR THIS TURN DRAWS AND SENDS NOTHING. The stamp is the whole cache:
    // hit points and hit chances are answers about one game turn, and a stale
    // one is a wrong number stated confidently.
    if (known !== undefined && known.gameTurn === (turn?.gameTurn ?? -1)) {
      requestDraw();
      return;
    }
    if (inspectInFlight === id) return;
    inspectInFlight = id;
    // `targetId` is REQUIRED by the schema — a bare `{t:'inspect'}` is refused
    // as `bad_message`, so there is no "clear the tooltip" frame and none is
    // wanted: forgetting is a local act.
    socket.send({ v: PROTOCOL_VERSION, t: 'inspect', targetId: id });
  }

  // THE PIN'S OWN REFRESH, fired from the game-turn edge that clears the cache.
  // Deliberately NOT routed through `requestInspect`: that one is about the
  // pointer and would answer "the pointer is not on anything" for a pin that has
  // outlived its hover, which is the pin's entire purpose. See the binding's
  // header for what a pin that is never re-asked goes on displaying.
  refreshPinnedInspect = () => {
    const id = pinnedInspectId;
    if (id === null) return;
    socket.send({ v: PROTOCOL_VERSION, t: 'inspect', targetId: id });
  };

  /**
   * The pointer is over `tile` (or over nothing at all).
   *
   * GUARD ONE OF DECISION (d): the comparison is BY ACTOR ID. A pointer walking
   * from one side of a room to the other crosses a dozen tiles of bare floor, and
   * a hover tracked by tile would re-arm the timer on every one of them. It also
   * means the card does not flicker when the token under a resting pointer is
   * redrawn by an unrelated frame.
   *
   * AND IT REDRAWS ONLY ON A GENUINE CHANGE. An unconditional `requestDraw` per
   * mousemove would quietly convert this client's dirty-flag renderer into a
   * 60 fps one, which the header at the top of this file forbids at length.
   */
  function noteHoveredActor(tile: TileXY | null): void {
    const all = [...actors.values()];
    // The LIVING body first, then anything at all: a corpse is still a thing
    // worth naming, and `liveActorAt` mirrors the server's own "a dead body is
    // scenery" rule rather than re-deciding it here.
    const under =
      tile === null
        ? undefined
        : (liveActorAt(all, tile) ?? all.find((actor) => actor.x === tile.x && actor.y === tile.y));
    const id = under?.id ?? null;
    if (id === hoveredActorId) return;

    hoveredActorId = id;
    // A PIN IS ABOUT ONE BODY. Finding a different one under the pointer ends it
    // — otherwise the card would go on describing a husk while the player is
    // clearly asking about the thing they have moved to.
    pinnedInspectId = null;
    pinnedInspectView = null;
    inspectInFlight = null;

    if (hoverTimer !== 0) {
      window.clearTimeout(hoverTimer);
      hoverTimer = 0;
    }
    if (id !== null) {
      hoverTimer = window.setTimeout(() => {
        hoverTimer = 0;
        requestInspect();
      }, HOVER_SETTLE_MS);
    }
    requestDraw();
  }

  // --- the token menu ------------------------------------------------------
  // Right-click a detective, or a row in the party pane. Created here with every
  // other widget so no frame can arrive before it exists.
  tokenMenu = createContextMenu({
    onChange: () => {
      requestDraw();
    },
  });

  // --- the Case Log --------------------------------------------------------
  // Created before the socket, so a `log` frame cannot arrive with nothing to
  // hold it. It owns its own buffers and scroll positions — see ui/caselog.ts.
  caseLog = createCaseLog({
    onChange: () => {
      requestDraw();
    },
  });

  // --- the combat crossing -------------------------------------------------
  // THE FIFTH AND LAST BOUNDED TIMER, and the one that answers the bug report
  // from the first live session: nobody could tell when a fight had started.
  // Created before the socket for the same reason the log and the sweep are —
  // the very first `turn` frame is the one that establishes which side of the
  // crossing this client is on, and there must be nothing for it to arrive
  // before. See ui/combatbanner.ts: a hold timeout, then a fade interval that
  // stops itself, and nothing at all in between banners.
  combatBanner = createCombatBanner({
    onChange: () => {
      requestDraw();
    },
  });

  // --- the monster sweep ---------------------------------------------------
  // Created before the socket, so there is no window in which a `sweep` frame
  // can arrive with nothing to play it.
  sweep = createSweepPlayback({
    onBoard: (events) => {
      // ONE pass over the whole batch. This loop is what "the enemy sweep is
      // one batched update" means on the client: every monster's step lands in
      // the same synchronous block and therefore in the same drawn frame.
      for (const event of events) applyTurnEvent(event);
    },
    onChange: () => {
      requestDraw();
    },
  });

  // --- viewport ------------------------------------------------------------
  function onViewportChange(): void {
    // resize() returns false when nothing moved, so a resize storm (dragging a
    // window edge fires continuously) does not queue a draw per event.
    if (renderer.resize()) requestDraw();
    updateStatus();
  }
  window.addEventListener('resize', onViewportChange);
  // ResizeObserver, not just window.resize: inside a Discord Activity the
  // iframe can be resized by the host without the window firing anything.
  new ResizeObserver(onViewportChange).observe(canvas);
  watchDevicePixelRatio(onViewportChange);

  // --- network -------------------------------------------------------------
  setStatusText('connecting...');
  const socket = connectGameSocket({
    // The opaque handle, and the only thing this client can say about who it
    // is: the server maps it to the identity it verified itself. Null in a
    // browser tab and after a failed handshake — the server decides what an
    // unauthenticated socket may do, and it is the only thing that can.
    sessionId: discord.session,
    onStatus: (status, detail) => {
      connection = status === SocketStatus.Open ? 'connected' : `${status}: ${detail}`;
      if (status === SocketStatus.Open) lastError = null;
      updateStatus();
    },
    onMessage: (msg) => {
      applyServerMessage(msg);
      // RE-ANCHOR THE RING. The caster can be shoved while it is open —
      // Backdraft pushes, and so will monsters — and a ring still drawn around
      // where they used to stand is a picture of a rule that is no longer true.
      // The cursor is kept: the player is aiming at a thing, and having their
      // aim moved because they got knocked back would be the UI taking the shot.
      if (targeting !== null && targeting.active()) targeting.refresh(targetingWorld());
      // ═══ THE WALK TAKES ITS STEP HERE, AND NOWHERE ELSE ═══
      //
      // After `applyServerMessage`, so the board is settled and the machine is
      // deciding from the world as of this frame rather than the last one; and
      // BEFORE `syncBellTimer`, so a step that is going out this turn goes out
      // before the countdown is re-armed around it. It is the one place every
      // applied frame passes through, which is exactly what auto-commit needs:
      // one step per turn, taken the instant the previous one is confirmed.
      tickTravel();
      syncBellTimer();
      requestDraw();
      updateStatus();
    },
  });

  // --- the Discord roster --------------------------------------------------
  // No timer and no polling: the SDK pushes, exactly like the socket does. The
  // count is cosmetic, so it touches the status line only — a roster change
  // cannot repaint the map or move a token.
  discord.onParticipants((next) => {
    participants = next;
    updateStatus();
  });

  // A FAILED SIGN-IN IS SAID TWICE, for the same reason a refusal is: the
  // notice is the seen copy on the canvas for a few seconds, `updateStatus` is
  // the heard one and it keeps the sentence until it stops being true. The
  // socket is still opened — whether an unauthenticated player may do anything
  // is the server's ruling, and a client that refused to connect would replace
  // a readable refusal from the authority with a blank screen from itself.
  if (authError !== null) showNotice(`sign-in failed — ${authError}`);

  // --- talents -------------------------------------------------------------

  /**
   * Send a `talent` frame. The ONLY place one is constructed.
   *
   * `target` is omitted entirely for a `self` shape rather than sent as null —
   * protocol.ts is explicit that an absent target and a null one would be two
   * spellings of the same thing, and `strictObject` rejects the second.
   */
  function sendTalent(talent: LoadoutTalent, tile: TileXY | null): void {
    pendingTalentId = talent.id;
    socket.send(
      tile === null
        ? { v: PROTOCOL_VERSION, t: 'talent', talentId: talent.id }
        : {
            v: PROTOCOL_VERSION,
            t: 'talent',
            talentId: talent.id,
            target: { x: tile.x, y: tile.y },
          },
    );
  }

  targeting = createTargeting({
    onChange: () => {
      requestDraw();
    },
    onCommit: (talent, tile) => {
      // Sent even when targeting.ts believes the tile is illegal. See its
      // header: the server is the authority and it answers with a typed refusal,
      // which is strictly better than this file guessing and staying silent.
      clearNotice();
      sendTalent(talent, tile);
    },
  });

  /**
   * Press a hotbar slot.
   *
   * THREE OUTCOMES, and none of them is "nothing happens":
   *   - a `self` shape fires immediately, because a targeting mode with exactly
   *     one legal target only costs a keypress;
   *   - anything else opens targeting mode;
   *   - and pressing the ARMED slot again closes it, so 2-2 is a cancel and the
   *     key that opened a mode is also the key that backs out of it.
   *
   * A DISABLED SLOT IS STILL SENT. The grey frame is this client's opinion; the
   * server's is the one that counts, and it comes back as `on_cooldown` or
   * `no_resource` and prints a sentence. Refusing locally would swallow the
   * input on arithmetic that could be one frame out of date.
   */
  function activateSlot(index: number): void {
    const talent = loadout[index];
    if (talent === undefined) {
      showNotice(
        loadout.length === 0
          ? 'no loadout yet — waiting for the server'
          : `slot ${index + 1} is empty`,
      );
      return;
    }

    const armed = targeting?.talent();
    if (armed !== null && armed !== undefined && armed.id === talent.id) {
      targeting?.cancel();
      return;
    }
    targeting?.cancel();
    clearNotice();

    if (talent.shape === TalentShape.Self) {
      sendTalent(talent, null);
      return;
    }
    if (targeting === null || !targeting.begin(talent, targetingWorld())) {
      // No level, or no body on it yet. Say so rather than eating the key.
      showNotice(`cannot aim ${talent.name} yet — waiting for the map`);
    }
  }

  // --- the command line ----------------------------------------------------
  // The one piece of interactive DOM in the client. See the note in index.html:
  // a real <input> exists so that `say` has an IME, a caret and a clipboard.
  //
  // The maxlength comes from the SCHEMA'S constant rather than from the markup,
  // so the field and the server agree by construction. Two numbers means the day
  // they drift a player types a sentence, watches the field accept it, and gets
  // `bad_message` back.
  if (cmdEl !== null) cmdEl.maxLength = SAY_MAX_CHARS;

  function openCommandLine(): void {
    if (cmdEl === null) {
      showNotice('this build has no command line — index.html is missing #cmd');
      return;
    }
    cmdEl.focus();
    cmdEl.select();
  }

  /**
   * WHAT THE COMMAND LINE CAN NAME. Built fresh at each submission.
   *
   * THE ROSTER IS THE ACTOR MAP, NOT THE PARTY, and that is the point: you
   * invite people who are NOT in your party, so a roster taken from
   * `party_state` could only ever name the people you can already reach.
   *
   * The invites come from `party_state`, which carries exactly the ones waiting
   * on this player — so `/accept` with no name can only ever resolve to an offer
   * that is genuinely addressed here.
   */
  function commandContext(): CommandContext {
    const roster: RosterEntry[] = [];
    for (const actor of actors.values()) {
      if (actor.kind !== ActorKind.Player) continue;
      roster.push({ id: actor.id, name: actor.name, isSelf: actor.id === selfId });
    }
    return {
      selfId,
      roster,
      invites: (partyState?.invites ?? []).map((invite) => ({
        fromId: invite.fromId,
        fromName: invite.fromName,
      })),
      // A party of one is not "in a party" as far as `/leave` is concerned —
      // there is nothing to leave, and the server refuses it in the same words.
      inParty: (partyState?.members.length ?? 1) > 1,
    };
  }

  function sendSay(): void {
    if (cmdEl === null) return;
    const raw = cmdEl.value.trim();
    // Empty is not a refusal, it is a no-op with a visible cause: the field is
    // right there and obviously blank. Sending it would cost a `bad_message`
    // round trip to be told what the player can already see.
    if (raw === '') return;
    cmdEl.value = '';

    // ANYTHING NOT STARTING WITH '/' IS SPEECH. `parseCommand` owns that rule
    // and every party spelling around it, so this file never learns to parse a
    // verb — the day `/party` grows a sixth one, nothing here changes.
    const outcome = parseCommand(raw, commandContext());
    switch (outcome.kind) {
      case 'say':
        socket.send({ v: PROTOCOL_VERSION, t: 'say', text: outcome.text });
        // The line comes back as a `log` frame like everyone else's. No local
        // echo: this file has no optimistic path, and a message that appeared
        // instantly and then again from the server would double every line.
        return;
      case 'party':
        // `PartyVerb` and the wire's `PartyAction` are the same five strings by
        // construction (protocol.ts), so there is no mapping table here to get
        // out of step with either end.
        socket.send({
          v: PROTOCOL_VERSION,
          t: 'party',
          action: outcome.verb,
          // Omitted rather than null for `leave`: `PartySchema` is a
          // `strictObject` and an absent optional is the only spelling of "no
          // target" it accepts.
          ...(outcome.targetId === null ? {} : { targetId: outcome.targetId }),
        });
        return;
      case 'notice':
        // REFUSED LOCALLY AND STILL ANSWERED. A command line that swallows a
        // line is indistinguishable from one that is broken.
        //
        // THE TEXT GOES BACK IN THE FIELD, selected. Every one of these notices
        // is about the line that was just typed — "did you mean Sam or Sammy?" —
        // and answering "type more" while having thrown away what they typed
        // would make the advice impossible to follow.
        if (cmdEl !== null) {
          cmdEl.value = raw;
          cmdEl.select();
        }
        showNotice(outcome.text);
        return;
      case 'none':
        return;
    }
  }

  cmdEl?.addEventListener('keydown', (event: KeyboardEvent) => {
    // The field swallows every game key by itself — keys.ts's `isTextEntry`
    // returns early for an INPUT — so only these two need handling, and both are
    // stopped here rather than being allowed to bubble into a commit.
    if (event.key === 'Enter') {
      event.preventDefault();
      sendSay();
      // FOCUS IS KEPT. People talk in bursts, and having to press T between two
      // sentences is how a chat box stops being used. Escape is the way out, and
      // it is already the "put that back" key everywhere else in this client.
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cmdEl?.blur();
    }
  });

  /**
   * Stand up the ally beside you, or say why not.
   *
   * THREE OUTCOMES AND NONE OF THEM IS SILENCE, the same rule `activateSlot`
   * follows. One adjacent body resolves immediately, because a five-turn window
   * is not the place for a confirmation step. Two or more arms a direction —
   * guessing which friend to save is exactly the decision a UI must not make.
   * None says so, with the reason, because a key that appears dead during a
   * rescue is indistinguishable from a dropped packet.
   */
  function attemptRevive(): void {
    const candidates = adjacentDowned();
    const first = candidates[0];
    if (first === undefined) {
      reviveArmed = false;
      showNotice('nobody is down within reach — step next to them first');
      return;
    }
    if (candidates.length === 1) {
      reviveArmed = false;
      socket.send({ v: PROTOCOL_VERSION, t: 'revive', dir: first.dir });
      return;
    }
    reviveArmed = true;
    showNotice(
      `${candidates.length} are down beside you — press a direction (${candidates
        .map((c) => c.name)
        .join(', ')})`,
    );
  }

  /**
   * Get yourself back up, or say why not.
   *
   * ═══ THE ONE PLACE THIS CLIENT ANSWERS A KEY WITHOUT SENDING A FRAME ═══
   * and it is the same exception `attemptRevive` above already makes, for the
   * same reason: the answer is in a snapshot this client was sent, the sentence
   * it can write is BETTER than the one that would come back (it has the turns
   * left on the countdown), and the whole point of the M3 rule is that a key
   * must never appear to do nothing. Sending anyway would cost a round trip to
   * be told something already on screen, and the refusal text for a
   * `not_your_turn` is generic prose about the clock.
   *
   * THE STAGES READ OPPOSITE WAYS AND THE WORDING HAS TO SAY SO:
   *   ERASED  — the only stage this key works in. Send it.
   *   DOWNED  — refused by the server too, and correctly: the countdown and the
   *             ally running at you are the mechanic. The sentence says how many
   *             turns are left rather than "no", because a player pressing this
   *             key is asking "is anyone coming?".
   *   UP      — nothing to file. Almost always a stray press.
   */
  function attemptRespawn(): void {
    const stage = selfDowned();
    if (stage === null) {
      showNotice('you are on your feet — nothing to refile');
      return;
    }
    if (stage.status === DownedStatus.Downed) {
      showNotice(
        `you are DOWN, not erased — ${stage.turnsLeft} turn(s) left for an ally to reach you`,
      );
      return;
    }
    clearNotice();
    // No direction, no target, no id: the frame is `{v, t}` and the server
    // resolves whose body it is. See `RespawnSchema` in shared/protocol.ts.
    socket.send({ v: PROTOCOL_VERSION, t: 'respawn' });
  }

  // --- the party ------------------------------------------------------------

  /**
   * Send one party verb. The ONLY place a `party` frame is constructed.
   *
   * Both surfaces come through here — the command line and the token menu — so
   * the two cannot drift into sending different shapes for the same intent, and
   * a socket that is not open produces a sentence rather than a silence. That
   * last part matters more here than anywhere else in this file: a party invite
   * is a message to another PERSON, and "nothing happened" is indistinguishable
   * from "they ignored me".
   */
  function sendParty(action: PartyAction, targetId: string | null): void {
    const sent = socket.send({
      v: PROTOCOL_VERSION,
      t: 'party',
      action,
      // Omitted rather than null: `PartySchema` is a `strictObject` and an absent
      // optional is the only spelling of "no target" it accepts.
      ...(targetId === null ? {} : { targetId }),
    });
    if (!sent) showNotice('not connected — that did not go out');
  }

  /**
   * Open the menu for one classified target at a backbuffer point. False when
   * there is nothing to offer, so the caller can fall back to right-click's older
   * meaning.
   *
   * ═══ ZERO ROWS IS A RESULT, AND RETURNING FALSE FOR IT IS LOAD-BEARING ═══
   * It is what preserves right-click-to-cancel over a wall, and over yourself
   * when you have no party to leave. ui/verbs.ts's header says the same thing
   * from the other end.
   *
   * WHICH ACCESSOR THE MENU CARRIES IS THE DISAMBIGUATOR, and it is decided here
   * rather than by the row: "Walk up to" (a husk) and "Travel here" (bare floor)
   * are both `MapVerb.Travel`, and they differ only in whether the open menu
   * answers `targetId()` or `targetTile()`.
   */
  function openVerbMenu(target: VerbTarget, px: number, py: number): boolean {
    if (tokenMenu === null || selfId === null) return false;

    const me = selfTile();
    const at = target.kind === 'tile' ? target.tile : target.actor;
    const menu = verbsFor({
      target,
      // From the local session's own id, never from a field on a frame.
      selfId,
      partyIds: partyIds(),
      selfLeads: selfLeads(),
      // Decides ONLY whether Attack is greyed. Chebyshev, because a diagonal
      // step costs the same as an orthogonal one everywhere in this game.
      adjacent: me !== null && chebyshev(me, at) === 1,
    });
    if (menu.items.length === 0) return false;

    const { logicalW, logicalH } = renderer.metrics();
    tokenMenu.open({
      x: px,
      y: py,
      title: menu.title,
      items: menu.items,
      viewportW: logicalW,
      viewportH: logicalH,
      ...(target.kind === 'tile' ? { targetTile: target.tile } : { targetId: target.actor.id }),
    });
    return true;
  }

  /**
   * The menu for a PARTY PANE ROW, which is always about a detective.
   *
   * It resolves the row's id to a body, and offers nothing when there is not one
   * yet. That window is a race and a narrow one — `party_state` can land in the
   * pump before the `joined` that describes the body — and the honest answer
   * during it is silence rather than a menu about somebody the server has not
   * described. Everything the rows depend on (their name, and whether they are
   * you) comes off that body.
   */
  function openPartyRowMenu(actorId: string, px: number, py: number): boolean {
    const actor = actors.get(actorId);
    if (actor === undefined) return false;
    return openVerbMenu({ kind: 'player', actor }, px, py);
  }

  /**
   * WHAT IS ON THIS TILE, in the four kinds ui/verbs.ts asks about.
   *
   * THE CLASSIFICATION IS THE CALLER'S JOB and it is done ONCE, here. `hostile`
   * is `isHostileBody` and the live body is `liveActorAt`, both from
   * input/travel.ts, which mirror engine/actor.ts:724 and world.ts respectively —
   * a second opinion about either question in this file would be the copy that
   * drifts.
   *
   * A DOWNED OR ERASED DETECTIVE IS STILL A `player`, not a `body`, and that is
   * deliberate: `alive` stays true while somebody is on the floor, and inviting
   * the person bleeding out in front of you is exactly when you most want to —
   * they are about to need a party. Only a genuine corpse (`alive` false) falls
   * through to the look-at-it list.
   */
  function targetAt(tile: TileXY): VerbTarget {
    const all = [...actors.values()];
    const occupant =
      liveActorAt(all, tile) ?? all.find((actor) => actor.x === tile.x && actor.y === tile.y);
    if (occupant !== undefined) {
      if (!occupant.alive) return { kind: 'body', actor: occupant };
      return isHostileBody(occupant)
        ? { kind: 'hostile', actor: occupant }
        : { kind: 'player', actor: occupant };
    }
    // `walkable` is exactly `travelTargetAllowed` and nothing else — the ONE
    // named predicate the future "has this tile been seen" clause lands behind.
    // Asking `canWalk` directly here would be the second site that still permits
    // travel into unexplored dark on the day the first one stops.
    return { kind: 'tile', tile, walkable: level !== null && travelTargetAllowed(level, tile) };
  }

  /**
   * Do what a menu row says. The only place a picked row is turned into an act.
   *
   * A `switch` over the WIDENED union with no `default`, so the day a fifth
   * `MapVerb` or a sixth `PartyAction` appears it breaks here at lint time rather
   * than becoming a row that quietly does nothing. The two halves are disjoint by
   * construction (contextmenu.ts says so), which is what makes the check possible.
   */
  function runMenuItem(item: MenuItem, targetId: string | null, targetTile: TileXY | null): void {
    switch (item.action) {
      case PartyAction.Leave:
        // ═══ LEAVE KEEPS ITS null-targetId SPECIAL CASE ═══
        // You leave a party, you do not leave a PERSON. A `leave` naming a
        // target is refused as `bad_message`, and widening this union without
        // carrying the exception across is exactly how that regression arrives.
        sendParty(PartyAction.Leave, null);
        return;
      case PartyAction.Invite:
      case PartyAction.Kick:
      case PartyAction.Accept:
      case PartyAction.Decline:
        // THE GUARD BELONGS TO THE PARTY ARM ALONE. It used to wrap the whole
        // dispatch, and left where it was it would silently swallow every ground
        // row — a menu opened on bare floor has `targetId() === null` by
        // construction, and Travel here / Point here would do nothing at all.
        if (targetId === null) return;
        sendParty(item.action, targetId);
        return;

      case MapVerb.Travel: {
        // ONE ROW, TWO MEANINGS, TOLD APART BY WHICH TARGET IS SET. A tile is
        // "travel here"; an actor is "walk up to", which stops one tile short and
        // deliberately does NOT swing on arrival.
        if (targetTile !== null) {
          beginTravel(targetTile, false);
          return;
        }
        const actor = targetId === null ? undefined : actors.get(targetId);
        if (actor === undefined) return;
        beginTravel({ x: actor.x, y: actor.y }, true);
        return;
      }
      case MapVerb.Attack: {
        // THERE IS NO ATTACK INTENT. Walking into an adjacent hostile IS the
        // attack — the scheduler strikes the occupant before it consults terrain
        // — so this is one `move` and nothing else.
        const actor = targetId === null ? undefined : actors.get(targetId);
        const me = selfTile();
        if (actor === undefined || me === null) return;
        // The sanctioned idiom: walk DIR_ORDER and compare `step()`, never a
        // hand-rolled dx/dy table.
        const dir = DIR_ORDER.find((candidate) => sameTile(step(me, candidate), actor));
        if (dir === undefined) {
          // They moved between the menu opening and the row being clicked. The
          // row was enabled when it was drawn, so saying nothing here would be a
          // click that visibly did nothing.
          showNotice('too far to reach — step closer first');
          return;
        }
        socket.send({ v: PROTOCOL_VERSION, t: 'move', dir });
        return;
      }
      case MapVerb.Inspect: {
        if (targetId === null) return;
        // PINNED, so the card outlives the pointer leaving the token — that is
        // the whole difference between this row and simply hovering. The answer
        // lands in `case 'inspected'` and fills the pin in.
        pinnedInspectId = targetId;
        pinnedInspectView = inspectCache.get(targetId)?.view ?? null;
        inspectInFlight = targetId;
        socket.send({ v: PROTOCOL_VERSION, t: 'inspect', targetId });
        requestDraw();
        return;
      }
      case MapVerb.Point:
        if (targetTile === null) return;
        // The frame that has existed since M4 — shift+click's own verb, offered
        // a second way for the player who does not know the modifier exists.
        socket.send({ v: PROTOCOL_VERSION, t: 'point', x: targetTile.x, y: targetTile.y });
        return;
    }
  }

  // --- input ---------------------------------------------------------------
  // Every key skips the sweep beat first. A player who has already decided must
  // never be made to watch a flourish finish, and settling is idempotent.
  bindGameKeys(window, {
    onMove: (dir) => {
      sweep?.settle();
      // THE MODE ROUTES THE KEY, not the keymap. While a talent is being aimed
      // the movement keys steer the cursor and no frame is sent; keys.ts still
      // reported a plain direction and knows nothing about either case.
      if (targeting !== null && targeting.active()) {
        targeting.moveCursor(dir);
        return;
      }
      // A REVIVE WAITING FOR A DIRECTION outranks a step, and consumes the key
      // whether or not anybody is actually lying that way — the server rules on
      // that and answers with a sentence. Walking instead would move the rescuer
      // out of reach of the person they were trying to pick up.
      if (reviveArmed) {
        reviveArmed = false;
        clearNotice();
        socket.send({ v: PROTOCOL_VERSION, t: 'revive', dir });
        return;
      }
      // Intent only. Nothing local changes here; the world moves when the
      // server says it did.
      socket.send({ v: PROTOCOL_VERSION, t: 'move', dir });
    },
    onCommand: (command) => {
      sweep?.settle();
      if (targeting !== null && targeting.active()) {
        // Enter/space confirms the aim. Hold ('.') backs out — it is the other
        // "I am done" key, and in a mode the honest reading of it is "not this".
        if (command === TurnCommand.Commit) targeting.confirm();
        else targeting.cancel();
        return;
      }
      // Written as a switch rather than a computed tag so that adding a third
      // verb breaks here instead of producing a frame no server understands.
      switch (command) {
        case TurnCommand.Commit:
          socket.send({ v: PROTOCOL_VERSION, t: 'commit' });
          return;
        case TurnCommand.Hold:
          socket.send({ v: PROTOCOL_VERSION, t: 'hold' });
          return;
      }
    },
    onSlot: (slot) => {
      sweep?.settle();
      activateSlot(slot);
    },
    onCancel: () => {
      sweep?.settle();
      // Escape backs out of ONE thing, in the order they were opened, so a
      // single key never does two things at once: the token menu, then a walk in
      // progress, then the targeting ring, then the armed revive, then a
      // scrolled-back log, then the notice.
      //
      // THE MENU IS FIRST because it is the most recently opened and the most
      // modal-feeling: it sits over the map with the pointer already on it.
      if (tokenMenu?.close() === true) return;
      // TRAVEL INTERRUPT (3), AND IT IS INSIDE THE CHAIN RATHER THAN BESIDE IT.
      // Appending it after the chain would let one press stop a walk AND clear
      // the notice, or worse, stop a walk that had already been stopped by the
      // window-level listener below while leaving a targeting ring up. Above
      // targeting because a walk is the more recent thing the player started —
      // travel is begun with the mouse, and an aim that is open at the same time
      // was opened before it.
      if (cancelTravelIfActive()) return;
      if (targeting !== null && targeting.active()) {
        targeting.cancel();
        return;
      }
      if (reviveArmed) {
        reviveArmed = false;
        clearNotice();
        return;
      }
      // BOTH LANES SNAP TOGETHER. `toBottom` reports whether it actually moved,
      // and Escape means "put the log back where it was" as one action — leaving
      // the Margin scrolled up because only the Record had moved would make the
      // key feel like it half worked.
      const record = caseLog?.toBottom(LogLane.Record) ?? false;
      const margin = caseLog?.toBottom(LogLane.Margin) ?? false;
      if (!record && !margin) clearNotice();
    },
    onUi: (command) => {
      sweep?.settle();
      // Exhaustive, no `default`: a fifth verb breaks here at lint time rather
      // than becoming a key that quietly does nothing.
      switch (command) {
        case UiCommand.Say:
          openCommandLine();
          return;
        case UiCommand.Revive:
          attemptRevive();
          return;
        case UiCommand.Respawn:
          attemptRespawn();
          return;
        case UiCommand.ToggleLog:
          logVisible = !logVisible;
          requestDraw();
          return;
        case UiCommand.ToggleParty:
          partyVisible = !partyVisible;
          requestDraw();
          return;
      }
    },
    onScroll: (steps, alternate) => {
      // SHIFT PICKS THE MARGIN. That mapping lives here and not in keys.ts,
      // because which lane a modifier selects is a fact about a panel and keys.ts
      // deliberately knows nothing about panels.
      caseLog?.scroll(alternate ? LogLane.Margin : LogLane.Record, steps * SCROLL_STEP);
    },
  });

  // ═══ TRAVEL INTERRUPT (2): ANY KEY AT ALL STOPS THE WALK ═══
  //
  // AND IT IS NOT A `KeyHandlers` MEMBER, WHICH LOOKS LIKE AN OVERSIGHT AND IS
  // NOT. `bindGameKeys` dispatches only keys it has a meaning for: keys.ts:348-351
  // drops an unmapped key on the floor, and :297 drops EVERY key while a text
  // entry has focus. So a rule phrased as "any keyboard input cancels travel" is
  // literally unreachable through the keymap — q, w, e, Tab, F1 and every other
  // unbound key would sail past while the player's token kept walking, which is
  // the exact moment somebody reaches for a key they are not sure about.
  //
  // It carries the ONE exemption keys.ts makes, restated rather than imported
  // because `isTextEntry` is module-private there: a key typed into the command
  // line is speech, not input, and travelling while saying "on my way" must not
  // stop the walk mid-sentence. The four lines are a copy, and a copy that drifts
  // costs a cancelled walk rather than a wrong frame.
  //
  // REGISTERED AFTER `bindGameKeys`, AND THAT ORDER IS LOAD-BEARING. Listeners on
  // one target fire in registration order, so Escape reaches the ordered cancel
  // chain above with the walk STILL RUNNING and is consumed there by
  // `cancelTravelIfActive`. Registered first, this would stop the walk and then
  // let the same press also cancel an aim — one key doing two things, which is
  // the one thing that chain exists to prevent.
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    const focus = event.target;
    if (focus instanceof HTMLElement) {
      if (focus.isContentEditable) return;
      const tag = focus.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    }
    // NOTHING ELSE. Not `preventDefault`, not a sweep settle, not a notice: this
    // listener runs beside `bindGameKeys` on the same event, and anything it did
    // to the key would be a second opinion about a key the keymap owns.
    cancelTravel();
  });

  // --- the mouse -----------------------------------------------------------
  // Hover moves the cursor, left click confirms, right click cancels. The
  // keyboard remains the primary input — this is for the player who reaches for
  // the mouse to point at a tile across the room, which is what people in a
  // voice channel actually do.

  /** Which hotbar slot a pointer event is over, or -1. */
  function slotUnder(event: MouseEvent): number {
    const point = renderer.backbufferPoint(event.clientX, event.clientY);
    if (point === null) return -1;
    const { logicalW, logicalH } = renderer.metrics();
    return hotbarSlotAt(point.x, point.y, loadout.length, logicalW, logicalH);
  }

  /**
   * True when the pointer is over a PANEL rather than over the world.
   *
   * The dock and the top HUD both OVERLAY the map, so without this a click meant
   * for the log lands on whatever tile is underneath it — and with `point` on
   * shift-click, a gesture over a panel would drop a marker on a tile the player
   * cannot even see. Computed from `dockLayout` and `turnHudHeight`, the same two
   * functions the painter uses, so the two cannot disagree about where a panel is.
   *
   * THE TURN CARDS ARE INCLUDED, and that is new. They are a row of faces the
   * size of a hotbar slot, so people WILL click one — to check on somebody, or
   * out of BG3 habit where a portrait is a button. Cards are not buttons here
   * (there is nothing to select: everyone who owes a move acts in the same
   * window), so the honest behaviour is that the click does nothing at all
   * rather than pinging a tile behind the strip that nobody can see.
   */
  function overPanel(clientX: number, clientY: number): boolean {
    const point = renderer.backbufferPoint(clientX, clientY);
    if (point === null) return false;
    const { logicalW, logicalH } = renderer.metrics();
    const layout = hudLayout(logicalW, logicalH);
    if (point.y < layout.hudTop) return true;
    if (tokenMenu?.contains(point.x, point.y) === true) return true;
    if (respawnPromptHit(layout.respawn, point.x, point.y)) return true;
    return (
      inRect(layout.pane?.rect ?? null, point.x, point.y) || inRect(layout.log, point.x, point.y)
    );
  }

  canvas.addEventListener('mousemove', (event) => {
    const slot = slotUnder(event);
    if (slot !== hoveredSlot) {
      hoveredSlot = slot;
      requestDraw();
    }

    // THE TWO HOVERS THAT MEAN "THIS IS PRESSABLE": a menu row and the erased
    // plate. Both are cosmetic, and both report whether anything changed so an
    // idle mouse crossing the canvas cannot queue a draw per pixel.
    const point = renderer.backbufferPoint(event.clientX, event.clientY);
    // THE CARD'S ANCHOR, kept up to date on every move even when nothing is
    // hovered: it is where the card WOULD open, and a stale one would put the
    // next card wherever the pointer was when it last crossed a token.
    pointerPoint = point;
    if (point !== null) {
      tokenMenu?.hoverAt(point.x, point.y);
      const { logicalW, logicalH } = renderer.metrics();
      const over = respawnPromptHit(hudLayout(logicalW, logicalH).respawn, point.x, point.y);
      if (over !== respawnHovered) {
        respawnHovered = over;
        requestDraw();
      }
    }

    // Over the hotbar, the turn cards OR either side panel, the pointer is on a
    // PANEL, not a tile. Letting it drag the aim while it crosses one would move
    // the cursor to whatever happens to be under the HUD on the way there.
    if (slot === -1 && !overPanel(event.clientX, event.clientY)) {
      const tile = renderer.tileAtClient(event.clientX, event.clientY);
      targeting?.hover(tile);
      // THE HOVER CARD, from the same tile and inside the same gate. It is
      // deliberately NOT given `point`: `backbufferPoint` and `tileAtClient` both
      // return `TileXY`, so passing pixels where tiles are expected typechecks
      // cleanly and lands about 32x off. `point` is pixels, `tile` is tiles, and
      // this file keeps those two names apart everywhere for that reason.
      noteHoveredActor(tile);
    } else {
      // Onto a panel. Whatever the card was describing is no longer under the
      // pointer, and a card left painted over the panel that swallowed the
      // pointer is the stale-tooltip bug in its most visible form.
      noteHoveredActor(null);
    }
  });

  // THE LOG SCROLLS UNDER THE WHEEL, and only over the log. `passive: false`
  // plus `preventDefault` because the default action inside a Discord Activity
  // iframe is to scroll the page, which drags the canvas out of view — the same
  // failure the arrow keys have, with the same fix.
  canvas.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      const point = renderer.backbufferPoint(event.clientX, event.clientY);
      if (point === null || caseLog === null) return;
      const lane = caseLog.laneAt(point.x, point.y);
      if (lane === null) return;
      event.preventDefault();
      // Wheel up (negative deltaY) goes BACK in time, which is what every
      // document and every chat client does.
      caseLog.scroll(lane, event.deltaY < 0 ? SCROLL_STEP : -SCROLL_STEP);
    },
    { passive: false },
  );

  canvas.addEventListener('mouseleave', () => {
    // ═══ THE CARD IS DROPPED FIRST, ABOVE THE HOTBAR GUARD ═══
    //
    // The early return below fires on exactly the path a tooltip is most likely
    // to be up: the pointer was over the MAP (so `hoveredSlot` is already -1) and
    // left the canvas. Clearing after that guard would leave the card painted
    // forever, over a canvas the pointer is no longer on, until something else
    // happened to change the hover.
    //
    // The pin goes with it. A pinned card that survived the pointer leaving the
    // window would be the one surface here with no way to dismiss it.
    pointerPoint = null;
    noteHoveredActor(null);

    if (hoveredSlot === -1) return;
    hoveredSlot = -1;
    requestDraw();
  });

  canvas.addEventListener('mousedown', (event) => {
    // ═══ TRAVEL INTERRUPT (1), AND IT IS THE VERY FIRST LINE ON PURPOSE ═══
    // Before the sweep settle, before the menu branch, before every early return
    // below it. A click that is later swallowed by a panel, by an open menu or by
    // the erased plate STILL means "stop what you are doing" — the player reached
    // for the mouse, and a walk that carried on because the click happened to
    // land on the Case Log would be the most confusing possible outcome.
    cancelTravel();
    sweep?.settle();
    const point = renderer.backbufferPoint(event.clientX, event.clientY);
    const { logicalW, logicalH } = renderer.metrics();
    const layout = hudLayout(logicalW, logicalH);

    // ═══ 1. AN OPEN MENU TAKES THE WHOLE CLICK ═══
    // Either button, anywhere: pick a row, or close. A menu that stayed open
    // while the click underneath it walked the party into a wall would be the
    // worst of both. A DISABLED row still closes it and still does nothing else,
    // so "Kick" as a non-leader cannot fall through and ping the tile behind it.
    if (tokenMenu !== null && tokenMenu.visible()) {
      event.preventDefault();
      // BOTH ACCESSORS ARE READ BEFORE THE CLOSE, because closing forgets them,
      // and which of the two is set is how `runMenuItem` tells "walk up to that
      // husk" from "travel to that patch of floor" — the same row carries both.
      const targetId = tokenMenu.targetId();
      const targetTile = tokenMenu.targetTile();
      const item = point === null ? null : tokenMenu.itemAt(point.x, point.y);
      tokenMenu.close();
      if (item !== null) runMenuItem(item, targetId, targetTile);
      return;
    }

    // ═══ 2. RIGHT-CLICK IS THE VERB MENU, ON WHATEVER IS UNDER IT ═══
    //
    // THE TILE COMES FROM `renderer.tileAtClient` AND NOWHERE ELSE. Undoing the
    // letterbox, the integer scale and the camera clamp is render/canvas.ts's
    // job — a second inverse transform here would be a second copy of
    // `cameraAxis`, and it would go wrong first at the map edges where the clamp
    // bites, which is exactly where somebody stands when they are being invited
    // from across a room.
    //
    // Right-click keeps its old meaning everywhere else: cancel the aim, clear
    // the notice. The browser's own menu is suppressed on the canvas only, by
    // the `contextmenu` listener below.
    if (event.button !== 0) {
      event.preventDefault();

      // ═══ AN OPEN AIM TAKES THE CLICK, AND OPENS NOTHING ═══
      //
      // FIRST, unconditionally, and this one rule is what keeps
      // right-click-to-cancel alive now that the menu has something to offer on
      // very nearly every tile. It used to be preserved by accident: the old
      // menu found rows only on a detective, so a right-click anywhere else fell
      // through to the cancel below. `verbsFor` answers with rows for a husk, a
      // corpse and bare floor as well — so without this the ring could no longer
      // be dismissed with the mouse at all, and the bug would present as "the
      // targeting ring is stuck", miles from anything anyone would think to
      // look at.
      if (targeting !== null && targeting.active()) {
        targeting.cancel();
        return;
      }

      if (point !== null) {
        // A row in the party pane offers the same menu as the token does. It is
        // the only way to reach somebody who is off screen — which is most of
        // the party, most of the time.
        const paneHit =
          layout.pane === null || layout.party === null
            ? null
            : partyPaneHitAt(layout.party, layout.pane, point.x, point.y);
        if (paneHit !== null && paneHit.kind === 'member') {
          if (openPartyRowMenu(paneHit.id, point.x, point.y)) return;
        } else if (paneHit === null && !overPanel(event.clientX, event.clientY)) {
          // THE TILE COMES FROM `tileAtClient` AND THE MENU'S POSITION FROM
          // `point`. Two different quantities from two different functions that
          // share a return type: one says which tile, the other says where on the
          // backbuffer to draw the box.
          const tile = renderer.tileAtClient(event.clientX, event.clientY);
          if (tile !== null && openVerbMenu(targetAt(tile), point.x, point.y)) return;
        }
      }
      // Nothing to offer — a wall, the letterbox, or yourself with no party to
      // leave. Right-click keeps its oldest meaning.
      clearNotice();
      return;
    }

    // ═══ 3. THE ERASED PLATE IS A BUTTON ═══
    // Checked before the hotbar and the panels: it is drawn over the map, the
    // player who is looking at it cannot do anything else, and it is the one
    // click in the game that has to work when everything else is being refused.
    if (point !== null && respawnPromptHit(layout.respawn, point.x, point.y)) {
      event.preventDefault();
      attemptRespawn();
      return;
    }

    const slot = slotUnder(event);
    if (slot >= 0) {
      event.preventDefault();
      activateSlot(slot);
      return;
    }

    // ═══ 4. THE PARTY PANE'S OWN CONTROLS ═══
    // ACCEPT and DECLINE, and a row that opens the token menu. Hit-tested
    // through `partyPaneHitAt`, which reads the same geometry the painter drew
    // with, so a button can never be one row off where it appears.
    if (point !== null && layout.pane !== null && layout.party !== null) {
      const hit = partyPaneHitAt(layout.party, layout.pane, point.x, point.y);
      if (hit !== null) {
        event.preventDefault();
        switch (hit.kind) {
          case 'accept':
            sendParty(PartyAction.Accept, hit.fromId);
            return;
          case 'decline':
            sendParty(PartyAction.Decline, hit.fromId);
            return;
          case 'member':
            openPartyRowMenu(hit.id, point.x, point.y);
            return;
        }
      }
    }

    // A click on a panel is a click on a panel. Checked before both the ping and
    // the targeting confirm, so neither side panel nor the turn cards can fire
    // either.
    if (overPanel(event.clientX, event.clientY)) {
      event.preventDefault();
      return;
    }

    // SHIFT + CLICK IS `point` — "there, behind the pillar", which is the
    // gesture people in a voice channel are already making with their hands.
    //
    // IT OUTRANKS TARGETING, deliberately. Someone shift-clicking mid-aim is
    // showing the party a tile, not taking the shot, and firing a talent because
    // they wanted to point at something would be the worst possible reading of
    // the input. The ring stays open; nothing is cancelled.
    if (event.shiftKey) {
      event.preventDefault();
      const tile = renderer.tileAtClient(event.clientX, event.clientY);
      if (tile === null) {
        showNotice('point at a tile on the map');
        return;
      }
      socket.send({ v: PROTOCOL_VERSION, t: 'point', x: tile.x, y: tile.y });
      return;
    }

    // ═══ 5. AN OPEN AIM STILL TAKES THE PLAIN CLICK ═══
    //
    // Written as a positive block rather than the bare guard it used to be, so
    // that the branch below can follow it: targeting keeps priority, and a player
    // who is aiming a talent has said what this click is for.
    if (targeting !== null && targeting.active()) {
      event.preventDefault();
      // Aim at what was clicked, then fire it — one gesture, so a click on a
      // distant tile does not require a hover first.
      targeting.hover(renderer.tileAtClient(event.clientX, event.clientY));
      targeting.confirm();
      return;
    }

    // ═══ 6. THE PLAIN LEFT-CLICK: HIT THAT, OR WALK THERE ═══
    //
    // The LAST branch in this handler, and it has to be: every branch above
    // returns, and each one is a surface that overlays the map. Moved any higher
    // it would eat shift+click's `point`, or let a click meant for the Case Log
    // walk the whole party across a room.
    //
    // THE DECISION IS NOT MADE HERE. `mouseIntentAt` is a pure function over a
    // snapshot, tested in test/client/mouseintent.test.ts, and every rule it
    // knows — an adjacent hostile is a bump, an ally is not, a corpse does not
    // block, a wall is a sentence rather than a walk — is one this file must not
    // acquire a second opinion about.
    event.preventDefault();
    // `tileAtClient`, NEVER `backbufferPoint`: the two share a return type and
    // differ by a factor of the tile size. And it is null-checked, because
    // `overPanel` answers FALSE on the letterbox — "not over a panel" is not the
    // same fact as "over a tile".
    const tile = renderer.tileAtClient(event.clientX, event.clientY);
    if (tile === null) return;

    const me = selfTile();
    // Decision (f): A CLICK ON YOUR OWN TOKEN DOES NOTHING AT ALL, not even a
    // sentence. mouseintent.ts supplies one for callers that want it; this one
    // does not, because the player is looking at the tile they are standing on
    // and does not need to be told so.
    if (me !== null && sameTile(me, tile)) return;

    const intent = mouseIntentAt({ self: me, tile, actors: [...actors.values()], level });
    switch (intent.kind) {
      case MouseIntentKind.Bump:
        // ONE `move`, and nothing else. Walking into an adjacent hostile IS the
        // attack (there is no attack intent on the wire), and no `commit`
        // follows it for the reason `tickTravel` sets out at length.
        socket.send({ v: PROTOCOL_VERSION, t: 'move', dir: intent.dir });
        return;
      case MouseIntentKind.Travel:
        beginTravel(intent.to, intent.stopShort);
        return;
      case MouseIntentKind.None:
        // ALWAYS A SENTENCE. A click that silently does nothing is
        // indistinguishable from one the game never received, which is the M3
        // rule at the top of this file applied to the mouse.
        showNotice(intent.reason);
        return;
    }
  });

  // THE BROWSER'S OWN MENU IS SUPPRESSED ON THE CANVAS AND NOWHERE ELSE. The
  // listener is on `canvas`, not on `window` or `document`, so a right-click on
  // the command line still gets Paste and a right-click on the status line still
  // gets Inspect — taking those away from the whole page to win one gesture over
  // the map would be a bad trade, and inside a Discord Activity it is also the
  // difference between "the game has a menu" and "the app broke my browser".
  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  requestDraw();
  updateStatus();
}

/**
 * Apply one server frame.
 *
 * No `default` clause, on purpose: `switch-exhaustiveness-check` is configured
 * so a default cannot stand in for a missing case, which means adding a variant
 * to `ServerMsg` breaks this switch at lint time instead of being silently
 * ignored at runtime.
 */
function applyServerMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case 'welcome':
      selfId = msg.selfId;
      level = msg.level;
      replaceActors(msg.actors);
      lastError = null;
      // A welcome is also the reconnect path, and it replaces the board
      // wholesale. Anything mid-flight is about to be about the wrong world:
      // drop the beat and forget the Bell until the server states it again.
      sweep?.settle();
      turn = null;
      bellEndsAt = null;
      // The fight this client was in belonged to the world that has just been
      // replaced. Forgetting which side of the crossing we were on means the
      // next `turn` frame re-baselines silently rather than announcing a
      // "CONTACT" or an "the Index closes" about a floor that no longer exists.
      combatBanner?.reset();
      // The ring was drawn around a body that may now be somewhere else, or be
      // somebody else. A stale ring is worse than none: it is a picture of a
      // rule that is no longer true.
      targeting?.cancel();
      pendingTalentId = null;
      // M4. A welcome is the reconnect path AND the floor reset after a party
      // wipe, so every snapshot-driven surface is emptied rather than carried
      // across: the badges, the party rows and the point markers all describe a
      // world that is about to be replaced. THE CASE LOG IS EMPTIED TOO, and
      // that is a real cost — a transcript that survived the reset would be nice
      // — but `seq` restarts with the session, so keeping the old lines would
      // make the de-duplication reject every new one. The server's own log is
      // the durable copy.
      effects = new Map();
      party = [];
      // The party pane is snapshot-driven like the rest of them, and a welcome
      // is the reconnect path: the server sends a fresh `party_state` in the
      // same breath, so holding the old one would draw a party that may have
      // dissolved while this client was away.
      partyState = null;
      // ...and the invites with it. A deadline stamped against the old session's
      // frame would keep an ACCEPT button alive for an offer that no longer
      // exists, which is the one kind of stale button this pane must not have.
      inviteDeadlines = new Map();
      // A menu is a question about somebody who may not be on this floor any
      // more. Closing it is cheaper than answering that.
      tokenMenu?.close();
      // TRAVEL INTERRUPT (7): THE BOARD WAS REPLACED. A welcome is the reconnect
      // path and the floor reset after a wipe, so the route is a plan across a
      // map that no longer exists — and the tile it ends on may be a wall now.
      // No sentence: the player did not do anything wrong and has a whole new
      // floor to look at.
      cancelTravel();
      // ...and every hover card with it. The answers are stamped with a game
      // turn from the old session, and the ids they are keyed by may belong to
      // somebody else entirely on the new floor.
      forgetInspections();
      pings = [];
      reviveArmed = false;
      caseLog?.clear();
      setMarginText(undefined, '');
      break;
    case 'state':
      // The dumb recovery path: a full list replaces everything known.
      replaceActors(msg.actors);
      // TRAVEL INTERRUPT (7), the other half. A resync means this client and the
      // server had drifted, so every tile of the route was computed from a board
      // that was wrong. Silently, for the same reason as `welcome`.
      cancelTravel();
      forgetInspections();
      break;
    case 'moved': {
      const actor = actors.get(msg.id);
      if (actor === undefined) {
        // An actor we have never seen. Not fatal — the next `state` resyncs.
        console.warn(`moved for unknown actor ${msg.id}`);
        break;
      }
      // Absolute position from the server, never a local delta.
      actors.set(msg.id, { ...actor, x: msg.x, y: msg.y });
      // THE STEP LANDED — or somebody put us somewhere we did not ask to be.
      // The machine tells those apart; all this has to do is be the FIRST of the
      // two observations, which the wire guarantees by dispatching `moved`
      // before `turn` in the same pump.
      if (msg.id === selfId) onSelfMoved(msg.x, msg.y);
      break;
    }
    case 'joined':
      actors.set(msg.actor.id, msg.actor);
      break;
    case 'left':
      // The BODY is gone — which no longer happens on a disconnect. A dropped
      // player stands where they fell and shows up under `standingBy` in the
      // next `turn` frame instead.
      actors.delete(msg.id);
      break;
    case 'turn': {
      // THE HOVER CARD'S CACHE IS A ONE-TURN CACHE, invalidated wholesale here
      // rather than entry by entry. Hit points, hit chances and blocked reasons
      // are all answers about one game turn; keeping them across an edge would
      // let a card state, confidently and in bold, a number that stopped being
      // true while the pointer sat still.
      // A PINNED CARD IS INVALIDATED BY THE SAME EDGE, and it has to be done
      // explicitly: `tooltipView()` consults the pin BEFORE the cache, so
      // clearing the cache alone leaves the pin shadowing the whole rule. It is
      // RE-ASKED rather than dropped so the pin keeps outliving the pointer —
      // and a `view: null` reply retires it, which is what makes the card vanish
      // when its subject dies or the viewer loses sight of it.
      if (msg.gameTurn !== turn?.gameTurn) {
        inspectCache.clear();
        refreshPinnedInspect();
      }
      turn = msg;
      bellEndsAt = msg.bellMs === null ? null : Date.now() + msg.bellMs;
      // ═══ EVERY `turn` FRAME REFRESHES THE WALK'S HOSTILE SNAPSHOT ═══
      //
      // Fed on ALL of them, including the many that are somebody else's pump —
      // a monster that walked into range during another player's turn is exactly
      // as dangerous as one that walked in during ours, and there is nothing here
      // that needs a game-turn edge. A REFUSED MOVE IS NOT DETECTED HERE and
      // never was detectable here: the server unicasts the refund as an `error`
      // (gateway.ts's `pumpAndBroadcast`), which `case 'error'` already acts on.
      // The interrupt is the machine's own; it has cancelled itself by the time
      // it answers, so all that is owed here is the sentence.
      //
      // `onRefusal` rather than `showNotice`: this function is module scope and
      // the notice's timer lives inside boot().
      switch (travel?.observeTurn(travelWorld()) ?? TravelObservation.Continue) {
        case TravelObservation.Hostile:
          onRefusal('something is moving nearby — travel stopped');
          break;
        case TravelObservation.Continue:
          break;
      }
      // THE COMBAT CROSSING, ONCE PER CROSSING. `sync` compares `inCombat`
      // against the last frame and answers null for every one of the many turn
      // frames that do not change it — a banner that re-fired on each frame
      // would be worse than none, because a warning that is always on screen is
      // furniture rather than a warning. The FIRST frame is never a crossing:
      // reconnecting into a fight already in progress must not announce an
      // ambush that happened five minutes ago (ui/combatbanner.ts).
      const crossing = combatBanner?.sync(msg) ?? null;
      if (crossing !== null) {
        // The durable third copy, in the lane people scroll back through. The
        // banner fades and the crimson frame only says the CURRENT state; this
        // is the line that still says "the fight started on turn 41" afterwards.
        caseLog?.note({ lane: LogLane.Record, gameTurn: msg.gameTurn, text: crossing.record });
      }
      break;
    }
    case 'sweep':
      // The whole monster turn, in one frame, played as one beat. If a previous
      // beat is still on screen it settles instantly rather than queueing.
      sweep?.play(msg);
      break;
    case 'attacked':
    case 'damaged':
    case 'died':
    case 'used':
      // The immediate lane: a player's own action, which must land at once
      // rather than being paced behind the monsters. `used` rides the same lane
      // and the same single `applyTurnEvent` — a talent is one more kind of
      // thing that happened, not a parallel system.
      applyTurnEvent(msg.ev);
      break;
    // THE THREE VIEWER-PRIVATE FRAMES: this socket's own loadout, cooldowns and
    // resource, and nobody else's — protocol.ts makes broadcasting them a
    // compile error server-side, because another player's cooldowns are both a
    // leak (they say what someone is holding for the boss) and noise.
    case 'loadout':
      // Wholesale replacement, in SERVER ORDER, never sorted: slot 1 is
      // `talents[0]` and muscle memory for which key is Ward Rush outranks any
      // ordering this renderer could impose.
      loadout = msg.talents;
      // Whatever was being aimed may not be in the new loadout, and its range
      // ring certainly is not. M3 sends this once, but M6's talent points make
      // it a mid-session frame and the cancel is what makes that safe.
      targeting?.cancel();
      break;
    case 'cooldowns':
      // COMPLETE AND ABSOLUTE, never a patch: anything in the loadout that is
      // not named here is READY. Merging would leave a button grey forever the
      // first time a frame went missing.
      cooldowns = msg.cooldowns;
      break;
    case 'resource':
      resource = msg.resource;
      break;

    // -----------------------------------------------------------------------
    // M4 — THE FOUR FRAMES THE PANELS ARE BUILT FROM.
    //
    // Each one is DELEGATED, not implemented: the Case Log, the badge row and
    // the party panel are widgets under src/client/ui/, exactly as the hotbar
    // and the resource pips already are. This entry point holds the state and
    // wires the socket to the renderer; a scrolling transcript does not belong
    // in it.
    // -----------------------------------------------------------------------
    case 'log':
      // A BATCH, oldest first, each line tagged with its lane. The log widget
      // de-duplicates on `seq` (a resync resends the tail) and holds the scroll,
      // which is why it owns the buffer rather than this file.
      caseLog?.append(msg.lines);
      // The newest MARGIN line is mirrored into the DOM's `aria-live` region.
      // Only the Margin: the Record would announce twenty lines of arithmetic a
      // turn and drown the three lines a minute somebody actually said.
      for (const line of msg.lines) {
        if (line.lane === LogLane.Margin) setMarginText(line.speaker, line.text);
      }
      break;
    case 'effects':
      // COMPLETE, like `cooldowns`: every actor with a badge appears, anything
      // absent is clean. REPLACED, never merged — merging would leave a Stun
      // icon on a monster forever the first time a frame went missing, and "is
      // that one still stunned?" is a question that gets somebody killed.
      effects = new Map(msg.actors.map((entry) => [entry.id, entry.effects]));
      break;
    case 'party':
      // COMPLETE, and low-frequency by construction — it changes when somebody
      // goes down, gets up, mutes or drops, not when they take a hit. Hit points
      // are deliberately NOT on it; the panel joins to the actor of the same id.
      party = msg.members;
      // A revive prompt is about who is lying next to you RIGHT NOW, and this
      // frame is exactly the thing that changes that answer. Leaving it armed
      // across a party change would let the next direction key revive somebody
      // who has already been picked up.
      reviveArmed = false;
      break;
    case 'party_state':
      // v6 — WHO SHARES YOUR BARRIER. A whole-list replacement, never merged,
      // for the same reason `party` and `effects` are: a client that dropped a
      // frame is corrected by the next one rather than showing somebody in a
      // party they left half an hour ago.
      //
      // The pane itself is drawn from this; the aria-live status line announces
      // a pending invite, because an offer nobody sees is an offer that lapses.
      partyState = msg;
      // AND THE INVITES GET A DEADLINE ON THIS CLOCK. `expiresInMs` is a
      // duration, so it is converted once here (see `inviteDeadlines`), the
      // expiry timer is armed, and anything genuinely new is said out loud.
      noteInvites(msg.invites);
      break;
    case 'pinged':
      // A transient marker. Its transcript line arrives separately in `log`,
      // because a marker that expires and a line that does not are two different
      // promises — see the note on PING_MS.
      addPing(msg.id, msg.x, msg.y);
      break;

    case 'inspected':
      // THE ANSWER TO ONE HOVER, MATCHED BY TARGET AND NEVER BY ARRIVAL ORDER.
      // Nothing on this wire carries a correlation id, so `targetId` is echoed
      // from the request — verbatim, even for an id that does not exist — and it
      // is the only thing that can join an answer to its question. The painter
      // reads `hoveredActorId` and the pin, so a reply about somebody the pointer
      // has already left is simply never drawn.
      //
      // `view: null` IS A REAL ANSWER AND IT IS CACHED LIKE ANY OTHER. It means
      // "no such actor" and "you cannot see it" and "that monster is dead", all
      // three, and this client must not try to tell them apart — the sameness is
      // the security property (protocol.ts's `InspectedMsg` calls the alternative
      // an id oracle), so there is one behaviour for it: draw nothing.
      if (inspectInFlight === msg.targetId) inspectInFlight = null;
      inspectCache.set(msg.targetId, { view: msg.view, gameTurn: turn?.gameTurn ?? -1 });
      if (pinnedInspectId === msg.targetId) {
        pinnedInspectView = msg.view;
        // A NULL ANSWER RETIRES THE PIN ENTIRELY, not just its view. The server
        // has stopped disclosing anything about that body — it died, it went out
        // of sight, or it is gone — and there is nothing to re-ask about, so
        // going on asking once a turn forever would be a poll for an answer that
        // cannot change back into anything this card may draw.
        if (msg.view === null) pinnedInspectId = null;
      }
      break;

    case 'pong':
      // Liveness only; the socket's watchdog already noted the frame's arrival.
      break;
    case 'error':
      // THE REFUSAL IS SHOWN, ALWAYS. `lastError` is the developer's copy — the
      // raw code and the server's own words, in the status line and the console.
      // `onRefusal` is the PLAYER'S copy: one sentence with the number in it,
      // large, on the canvas, for the few seconds after the key they pressed
      // appeared to do nothing. Without the second one a refusal is
      // indistinguishable from a dropped packet, which is the worst thing that
      // can happen to a turn in a turn-based game.
      lastError = `${msg.code}: ${msg.message}`;
      onRefusal(refusalText(msg.code, msg.message));
      // The aim was refused, so the mode is over — reopening it on the same
      // talent is one keypress, and leaving a ring up after a "too close" makes
      // it look as though the shot is still pending.
      targeting?.cancel();
      // TRAVEL INTERRUPT (4): ANY REFUSAL AT ALL, AND INTERRUPT (10) BESIDES.
      //
      // The walk is the only thing in this client that sends frames the player
      // did not personally press a key for, so a refusal arriving while a walk is
      // running is almost certainly the walk's own move — including the one the
      // server now unicasts when the scheduler REFUNDS a move at resolution
      // (gateway.ts's `pumpAndBroadcast`), which is the only frame that will ever
      // mention that refund. It says nothing at all when nothing was travelling.
      //
      // THE SENTENCE IS THE CODE'S, NOT THE WALK'S: see `travelStopText`. A rate
      // limit or a protocol fault stopped the walk with nothing whatsoever wrong
      // with the route, and "the way was refused" throws that diagnosis away.
      cancelTravel(travelStopText(msg.code));
      console.warn('server rejected a message', msg);
      break;
  }
}

/**
 * Fire `onChange` when devicePixelRatio changes — which happens when the window
 * is dragged between a laptop screen and an external monitor, or when Windows
 * display scaling is adjusted. Neither fires a resize event on its own, and
 * without this the canvas keeps a backing store sized for the old ratio and
 * goes soft: exactly the "crisp at dpr 1 AND 2" case, seen live.
 *
 * The media query is re-armed after each change because it tests one specific
 * ratio and is therefore only ever true once.
 */
function watchDevicePixelRatio(onChange: () => void): void {
  const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  query.addEventListener(
    'change',
    () => {
      onChange();
      watchDevicePixelRatio(onChange);
    },
    { once: true },
  );
}

boot().catch((error: unknown) => {
  console.error(error);
  setStatusText(`failed to start: ${describeError(error)}`);
});
