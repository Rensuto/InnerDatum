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

import type { TalentCell } from './ui/talents.ts';
import { DIR_ORDER, chebyshev, sameTile, step } from '../shared/coords.ts';
import { parseCommand } from './input/commands.ts';
import { bindGameKeys, gameKeymap, setKeymap, TurnCommand, UiCommand } from './input/keys.ts';
// v11 — THE KEYMAP'S OWN VERBS. `labelFor` is why no key mnemonic in this file
// is a hard-coded letter any more: a printed "press g" is a lie the moment
// somebody rebinds, and the three of them here had already been written twice.
// The three mutators are the menu's buttons and nothing else reaches them.
import {
  ACTIONS,
  clearBinding,
  labelFor,
  migrateStoredKeymap,
  resetAll,
  resetOne,
  SLOTS_PER_ACTION,
} from './input/keymap.ts';
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
// v7 — THE ORB'S ONLY LOGIC, and it is three pure functions. It lives in its own
// module rather than inline here for the reason state/projectiles.ts sets out:
// vitest has no jsdom, so the half of this feature with a rule in it has to be
// reachable from a node test, and the half that draws must have nothing in it
// worth reaching.
import { applyProjectilesFrame, clearProjectiles, orbsAimedAt } from './state/projectiles.ts';
import { createCaseLog, SCROLL_STEP } from './ui/caselog.ts';
import {
  charSheetHitAt,
  charSheetRect,
  charSheetRows,
  charSheetTipAt,
  drawCharSheet,
} from './ui/charsheet.ts';
// v12 — THE DRAG PRIMITIVES. Pure arithmetic and a closed set of panel names.
// The offsets themselves live in THIS file (see `panelOffsets`) because they are
// session-local browser state; what lives there is the one clamp, the one
// threshold and the one offset-composition rule, so no two readers of a moved
// panel can disagree about where it is.
import {
  DragKind,
  DraggablePanel,
  NO_OFFSET,
  createPanelOffsets,
  moveIntoBand,
  nextOffset,
  passesThreshold,
  settleOffset,
} from './ui/drag.ts';
import {
  ClassPickerHitKind,
  classPickerCards,
  classPickerHitAt,
  classPickerRect,
  drawClassPicker,
} from './ui/classpicker.ts';
import { drawRoster, rosterHitAt, RosterHitKind, rosterRect } from './ui/roster.ts';
import { createCombatBanner, PLAYFIELD_FRAME_MAX_PX } from './ui/combatbanner.ts';
// `isSlotDisabled` is deliberately NOT imported. Whether a slot looks dead is
// the hotbar's business; whether a press is legal is the server's. Reading it
// here would be the first step towards refusing to send, which is exactly the
// silent no-op this file's header forbids.
//
// v12 — SEVEN MORE NAMES, AND EVERY ONE OF THEM IS THE ITEM HALF OF THE BAR.
// `itemSlotAction` and `wornSlotOf` are the state machine: a binding stores an
// `itemId` and nothing else, so what pressing it MEANS is recomputed from the
// last `inventory` frame on every frame. `hotbarDropTargetAt` is the release,
// `isItemSlotIndex` is the right-click's guard, and the three constants are what
// keeps slot 4 the first item slot in this file as well as in that one.
import {
  drawHotbar,
  HOTBAR_ITEM_SLOTS,
  HOTBAR_SLOTS,
  HOTBAR_TALENT_BINDINGS,
  HOTBAR_TALENT_SLOTS,
  HOTBAR_TOTAL_H,
  HotbarDropKind,
  HotbarSlotKind,
  ItemSlotAction,
  hotbarDropTargetAt,
  hotbarSlotAt,
  isItemSlotIndex,
  itemSlotAction,
  wornSlotOf,
} from './ui/hotbar.ts';
import { createContextMenu, MapVerb } from './ui/contextmenu.ts';
// v11 — THE ESCAPE MENU. Every rule it has is in that module and is pure: the
// rows, the capture state machine, the geometry and the hit test. What is here
// is wiring — where the panel goes, when it is painted, and what a hit means.
import {
  CaptureKind,
  drawEscapeMenu,
  escapeMenuHitAt,
  escapeMenuPaging,
  escapeMenuRect,
  escapeMenuRows,
  MenuHitKind,
  MenuRowKind,
  MenuScreen,
  applyCapture,
  escapeMenuDragAt,
} from './ui/escapemenu.ts';
import {
  drawInventoryPanel,
  focusForHit,
  InventoryHitKind,
  InventoryTab,
  inventoryPanelDragAt,
  inventoryPanelHitAt,
  inventoryPanelRect,
  inventoryPanelRows,
  hasSomethingToBuy,
  hasSomethingToWear,
} from './ui/inventory.ts';
import {
  drawPartyPane,
  partyPaneHitAt,
  partyPaneLayout,
  partyPaneTipAt,
  partyPaneView,
  PARTY_PANE_MARGIN,
} from './ui/partypanel.ts';
import { drawResource, RESOURCE_H, resourceLabel } from './ui/resource.ts';
import {
  TalentHitKind,
  drawTalentPanel,
  pressSpend,
  talentPanelDragAt,
  talentPanelHitAt,
  talentIdAt,
  talentPanelGeometry,
  talentTipAt,
  talentPanelRect,
  talentPanelRows,
  TalentRowKind,
} from './ui/talents.ts';
// v12 — THE LEVEL BADGE AND THE XP TRACK. Its own file rather than a section of
// ui/resource.ts on that file's own argument: resource.ts is a sustained case
// that its strip is a row of COUNTABLE PIPS and not a bar, and a continuous
// gauge authored inside it is a comment that will mislead somebody within a
// month. They share one 18px strip and nothing else.
import { drawXpBar } from './ui/xpbar.ts';
import {
  drawRespawnPrompt,
  respawnPromptHit,
  respawnPromptRect,
  respawnPromptSpeech,
} from './ui/respawnprompt.ts';
import { drawTooltip } from './ui/tooltip.ts';
import { drawHoverCard } from './ui/panel.ts';
import { hotbarTipAt } from './ui/hotbar.ts';
import { inventoryTipAt } from './ui/inventory.ts';
import { drawTurnBar, TURN_BAR_H, turnHudHeight } from './ui/turnbar.ts';
import {
  CROSSING_INK,
  doorwayAt,
  doorwayLine,
  minimapReserveH,
  MINIMAP_RADIUS,
  minimapRect,
  paintMap,
  partyMarks,
} from './ui/mapview.ts';
import { drawTurnCards, owedCount, selfCard } from './ui/turncards.ts';
import { REVEAL_RADIUS as SHARED_REVEAL_RADIUS } from '../shared/fog.ts';
import { TileLoot, verbsFor } from './ui/verbs.ts';
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
  ClassOptionView,
  RosterMsg,
  DownedView,
  EffectView,
  GroundItemView,
  InspectView,
  InventoryMsg,
  ShopMsg,
  ItemTier,
  LevelView,
  LoadoutTalent,
  PartyInviteView,
  PartyMember,
  PartyStateMsg,
  ProgressMsg,
  UnlockableTree,
  ProjectileView,
  ResourceView,
  ServerMsg,
  RegionView,
  SiteView,
  Slot,
  TurnEvent,
  TurnMsg,
} from '../shared/protocol.ts';
import type { CommandContext, RosterEntry } from './input/commands.ts';
import type { KeyRemap } from './input/keymap.ts';
import type { DragSubject, PanelOffset } from './ui/drag.ts';
import type {
  ArmedCapture,
  EscapeMenuView,
  MenuEffect,
  MenuHit,
  MenuRow,
} from './ui/escapemenu.ts';
import type { Targeting, TargetingWorld } from './input/targeting.ts';
import type { Travel, TravelWorld } from './input/travel.ts';
import type { DiscordParticipant } from './net/discord.ts';
import type { AssetEntry } from './render/assets.ts';
import type { HudPainter, LootMarker, PingMarker, Scene } from './render/canvas.ts';
import type { SweepPlayback } from './render/sweep.ts';
import type { SpriteSource } from './render/assets.ts';
import type { CaseLog } from './ui/caselog.ts';
import type { CombatBanner } from './ui/combatbanner.ts';
import type { ContextMenu, MenuItem } from './ui/contextmenu.ts';
import type { HotbarSlot, HotbarView } from './ui/hotbar.ts';
import type { InventoryFocus, InventoryHit, InventoryPanelView } from './ui/inventory.ts';
import { PanelSkin, drawPanel } from './ui/panel.ts';
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
  // THE OVERWORLD TILESET (ART-OVERWORLD.md). Nothing matches this yet, and
  // that is the expected state while the art is being drawn: `paintTerrain`
  // falls back to a flat palette colour per code, so Alderbrook is legible and
  // playable with zero tiles on disk and improves one file at a time as they
  // land. No code change accompanies the art.
  //
  // The prefix is `tile_ow_` and it must stay in step with `TILE_SPRITES` in
  // render/canvas.ts — that pair is exactly the trap `icon_ability_` was below:
  // a prefix matching nothing filters the whole family out before it can load,
  // and the fallback then looks like a deliberate art choice rather than a bug.
  // test/client/assets.test.ts greps this list for that reason.
  'tile_ow_',
  'ui_token_ring_',
  'ui_tile_marker_',
  'ui_icon_turn_',
  'ui_hotbar_slot_',
  'ui_pip_',
  // THE TALENT ICONS. This read `icon_ability_` for the whole of M3-M6 and that
  // prefix matches NOTHING: every talent in src/server/talents/ declares
  // `iconId: 'icon_active_<name>'`, and there has never been an `icon_ability_*`
  // asset in the manifest. The hotbar therefore filtered out all twelve icons
  // before they could load and fell through to its initials path — which is why
  // four hand-drawn icons showed as "AF AV B MW" long after the art landed.
  //
  // The failure was invisible from both ends. From here the prefix looks like
  // every other line in this list; from ui/hotbar.ts the initials path is a
  // documented, deliberate fallback for art that has not arrived. Neither side
  // is wrong on its own, and nothing in between compared the two spellings.
  'icon_active_',
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
  // ═══ v10 — THREE PREFIXES FOR ART THAT IS ALREADY IN THE MANIFEST ═══
  //
  // THAT DISTINCTION IS THIS ARRAY'S ENTIRE PURPOSE and it is the one thing to
  // check before adding a fourth. A prefix here does not CREATE art: `isNeeded`
  // filters the manifest, so listing a family that exists loads it and listing
  // one that does not is a no-op (`icon_ability_` above has been exactly that
  // since M3, deliberately). What it must never be is a prefix invented FOR art
  // that does not exist — that is how a feature ships demanding a PNG of every
  // clone, and client/public/assets/ is gitignored wholesale so there is no
  // fallback file to hide behind. render/canvas.ts's `paintLoot` refuses a
  // `ui_tile_marker_loot` blit for precisely that reason, and the floor mark is
  // drawn with `fillRect` instead.
  //
  // ALL THREE FAMILIES WERE VERIFIED PRESENT, as ids in
  // client/public/assets/manifest.placeholders.json AND as PNGs on disk:
  //   `item_*`             — 23 ids under items/ (22 authored items plus
  //                          item_iron_ingot, which has an icon and no item).
  //   `ui_item_frame_*`    — 5 ids under ui/chrome/ (common/uncommon/rare are
  //                          drawn; epic and legendary are art waiting for a
  //                          rarity that does not exist — ui/inventory.ts).
  //   `ui_inventory_cell_` — 2 ids under ui/chrome/, and BOTH are drawn. `_empty`
  //                          backs every unfilled doll cell; `_hover` replaces it
  //                          on the one cell a live item drag could land in
  //                          (ui/inventory.ts's `drawCell`). The pointer-hover
  //                          ring is a different signal and is drawn, not blitted.
  // Without these three, `isNeeded` filters every one of those entries out,
  // `sprites.sprite()` answers undefined for all of them, and the panel silently
  // draws letter plates and traced boxes forever — a SUPPORTED state (a bare
  // clone has no art at all) and therefore one nothing would ever fail on.
  //
  // NOT ADDED, AND DELIBERATELY: any prefix for the four ids in
  // client/public/assets/items/_aliases.json. That file's own `_comment` claims
  // they resolve; it is wrong — no `icon_weapon_*` id is in the manifest and no
  // such PNG is on disk. Listing them would be the invented-prefix case above.
  'item_',
  'ui_inventory_cell_',
  'ui_item_frame_',
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
/**
 * Vertical space the log gives up to the minimap: its box, both margins, and a
 * little air so the two do not touch. Derived from the minimap's own constants
 * rather than guessed, so moving one moves the other.
 */
// DERIVED FROM THE BOX, NOT THE CAP — see `minimapReserveH`. The old form used
// MINIMAP_MAX_H and over-reserved by 31 pixels, which is what made the Case Log
// disappear on a 384-tall viewport the moment the turn cards appeared.

function logPanelRect(
  width: number,
  height: number,
  hudTop: number,
  showLog: boolean,
): PanelRect | null {
  if (!showLog || width < DOCK_MIN_VIEWPORT_W) return null;
  const band = panelBand(height, hudTop);
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE LOG STARTS BELOW THE MINIMAP, BECAUSE THEY SHARE A CORNER.
   * ═══════════════════════════════════════════════════════════════════════════
   * Both are top-right: the log because that is where this game's dock has
   * always been, the minimap because that is where every game puts one. The
   * minimap is drawn LATER, so it won — the top of the transcript disappeared
   * under it, which is exactly where the newest lines are on the Margin lane.
   *
   * Yielding the space is the right way round rather than moving the minimap:
   * the log can lose a line and still be a log, and a minimap pushed anywhere
   * else stops being where a player's eye goes for it.
   *
   * The reserve is unconditional, even when the world map has replaced the
   * minimap for a moment. A dock whose height depended on whether an overlay
   * happened to be open would re-lay the transcript every time somebody pressed
   * M, and a log that reflows on a keypress is worse than one that is a few
   * pixels short.
   */
  const top = band.top + minimapReserveH(width);
  const h = band.bottom - top;
  if (h < DOCK_MIN_H) return null;
  return { x: width - DOCK_W - DOCK_MARGIN, y: top, w: DOCK_W, h };
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
/**
 * The row `#cmd` sits in, so the whole thing can be hidden rather than leaving a
 * disabled field visibly inviting a click. Nullable for the same reason `cmdEl`
 * is: an index.html that predates M4 has neither, and losing the ability to talk
 * must not stop the client booting. See `setCommandLineReachable`.
 */
const cmdRowEl = document.getElementById('cmdrow');

/**
 * ═════════════════════════════════════════════════════════════════════════
 * THE COMMAND LINE IS TAKEN OUT OF REACH WHILE THE CLASS CHOOSER IS UP.
 * ═════════════════════════════════════════════════════════════════════════
 *
 * `onUi` returns early while the picker is open specifically so that `t`
 * cannot focus this field — the note there spells the trap out: focus leaves
 * the canvas, `isTextEntry` in keys.ts then drops EVERY subsequent keypress,
 * and the arrows, the digits and Enter all stop reaching the one screen the
 * player cannot dismiss. But that gate only covered the KEY. `#cmd` is a
 * permanently focusable `<input>` and it is the only tabbable element on the
 * page, so a single Tab, or a click on the chat row (which reads "T or / to
 * talk"), walked straight around it. And `mousedown` STEP 0 `preventDefault`s
 * both buttons while the picker is up, which suppresses the browser's own focus
 * change, so clicking the canvas could not take focus back either. The only way
 * out was Escape — which the picker documents as swallowed, so nothing on screen
 * suggested it.
 *
 * THREE THINGS, AND EACH COVERS A DIFFERENT ROUTE IN. `disabled` stops the
 * click and the caret, `tabIndex = -1` stops the Tab (a disabled input is
 * already skipped, but the two are set together so neither is load-bearing
 * alone), and `blur()` covers the field that was ALREADY focused when the
 * frame arrived — a player who was mid-sentence when they were asked to pick
 * a class.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * v12: THE ROW IS HIDDEN WITH `visibility: hidden`, AND THE VALUE IS THE POINT.
 * ═══════════════════════════════════════════════════════════════════════════
 * `hidden` RATHER THAN A CLASS, on the ROW, so a reviewer has no class name to
 * go looking for — but the attribute is NOT self-sufficient: `[hidden]` is
 * `display: none` in the user-agent stylesheet and `#cmdrow`'s author
 * `display: flex` beats it, so styles/main.css carries an explicit
 * `#cmdrow[hidden]` rule. That rule is `visibility: hidden`, NOT `display:
 * none`, and swapping it back is the edit that reintroduces a shipped bug.
 *
 * WHY. This row is ~29 CSS px of a flex COLUMN and `#game` is the
 * `flex: 1 1 auto; min-height: 0` sibling that absorbs whatever the other rows
 * do not take. `display: none` therefore handed those 29px to the canvas, the
 * ResizeObserver fired, and render/canvas.ts's `resize` (:697-747) does not
 * merely re-letterbox — it recomputes tilesW/tilesH from the new device box
 * (:727-730) and rebuilds the backbuffer (:732-742). At 1280x720/dpr1 that is
 * one whole extra tile row: `panelBand` moves 32px, the camera clamp shifts, and
 * the map jumps under the player at the instant this row is hidden. Keeping the
 * box in the column means the measured rect never changes and `resize` returns
 * false at its early-out (:707).
 *
 * AND IT MAKES THE FOCUS GATE STRONGER, NOT WEAKER. Per spec a
 * `visibility: hidden` subtree is not a focusable area: out of the sequential
 * focus order, out of the accessibility tree, and taking no pointer events. So
 * the CSS now duplicates part of what the three lines above do — which is
 * exactly why none of them may be deleted as redundant. They are the functional
 * copy, they run in a build whose stylesheet failed to load, and `blur()` in
 * particular covers what no declaration can: the field that was ALREADY focused
 * when the `class_options` frame arrived. test/client/shell-layout.test.ts fails
 * if any of the four is dropped.
 *
 * IT IS RESTORED IN `case 'loadout'`, which is where the modal is torn down and
 * the only place that knows the choice actually landed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * v11: PRIVATE, AND CALLED FROM `syncCommandLineReach` ONLY. IT IS NOT A TOGGLE.
 * ═══════════════════════════════════════════════════════════════════════════
 * There are now TWO independent surfaces that need this row out of reach, and a
 * bare boolean with two owners is a hole rather than a gate: the escape menu
 * calling `(true)` on close while the class chooser was still up would reopen
 * the exact trap this function was written to shut. So the ANSWER is computed
 * from the two facts rather than asserted by whichever surface acted last —
 * see `syncCommandLineReach`, which is the only caller.
 */
function setCommandLineReachable(reachable: boolean): void {
  if (cmdEl === null) return;
  cmdEl.disabled = !reachable;
  cmdEl.tabIndex = reachable ? 0 : -1;
  if (!reachable) cmdEl.blur();
  cmdRowEl?.toggleAttribute('hidden', !reachable);
}

/**
 * RECOMPUTE whether `#cmd` may be reached, from every reason it may not be.
 *
 * ═══ A RECOMPUTE AND NOT A SECOND TOGGLE, AND THAT IS THE WHOLE POINT ═══
 * `setCommandLineReachable` had exactly two callers, both the class chooser's
 * (`case 'class_options'` shuts it, `case 'loadout'` opens it). The escape menu
 * needs the same thing for a different reason — Tab is a legitimate key to BIND,
 * and `#cmd` is the only tabbable element on the page, so a capture field would
 * otherwise be one Tab away from moving focus off the canvas and into a field
 * whose keystrokes keys.ts correctly drops. Adding a third independent caller
 * that asserted `true` would mean the LAST surface to close decided for both:
 * open the menu while the chooser is up, close the menu, and the row comes back
 * in front of a modal that is still on screen.
 *
 * TWO TERMS, AND EVERY NEW SURFACE ADDS ONE HERE RATHER THAN A CALL SITE.
 *
 * IT IS NEEDED WHENEVER THE MENU IS OPEN AND NOT ONLY WHILE A CAPTURE IS ARMED.
 * The arm lasts one keypress; the hazard is Tab, which is not a key anyone holds
 * down to press deliberately — a player reaching for it to BIND it must not
 * discover that the first press moved their focus instead.
 */
function syncCommandLineReach(): void {
  setCommandLineReachable(classOptions === null && !menuOpen);
}

/**
 * THE ROW'S PLACEHOLDER, WITH THE LIVE KEY IN IT.
 *
 * index.html carries a fallback spelling in markup — a build whose script never
 * runs still says something useful — but the key it names is REBINDABLE, so the
 * markup is overwritten from here for exactly the reason `maxLength` is: two
 * copies of a fact drift, and the day they do a player reads an instruction that
 * does not work. Enter and Escape are NOT read off the keymap because the
 * command line handles those two itself, on the DOM event, outside the keymap
 * entirely (see the `#cmd` keydown listener).
 *
 * Re-run on every `keybinds` frame, so rebinding `say` rewrites the row.
 */
function syncCommandLinePlaceholder(): void {
  if (cmdEl === null) return;
  cmdEl.placeholder = `${labelFor('say', gameKeymap.current)} to talk · Enter sends · Esc back to the map`;
}

/** textContent, never innerHTML: actor names come from Discord nicknames. */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE SENTENCE FOR THE EAR, TWO GROUPS FOR THE EYE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `#log` is `role="status" aria-live="polite"`, so for a screen reader it is a
 * SENTENCE and the whole thing is announced whenever it changes. For everybody
 * else it is a STATUS BAR, and those are different jobs: a sentence wants to
 * read in order, a bar wants to be scanned — the thing about the world on the
 * left, the thing about the connection tucked away on the right where it can be
 * ignored until it matters.
 *
 * Serving both from one flat run of ` · ` separators is why the bar read
 * "connected · free movement · The Alderbrook Moor — safe · clear — free
 * movement · 1 actor(s) · Ren @ 150,53 · 1x · …": a sentence's worth of words,
 * laid out as a list, with the phase said twice.
 *
 * ═══ SPANS DO NOT COST THE ANNOUNCEMENT ANYTHING ═══
 * `aria-live` reads the element's text content, and text inside child spans is
 * still its text content. So the announced string is exactly what a single
 * `textContent =` would have produced — the separators are real characters, not
 * CSS — while the boxes let the visible bar group, dim and right-align.
 *
 * THE ORDER IS THE SENTENCE'S ORDER, not the layout's. `world` comes first in
 * the DOM and reads first; the session group is pushed right by `margin-left:
 * auto`, which moves the pixels without moving the words.
 */
/**
 * The BOOT line: one sentence, no groups.
 *
 * Kept beside `setStatusParts` rather than folded into it. Booting has no world
 * to describe and no session to dim — "loading assets..." is a whole status —
 * and routing it through the two-group writer would mean every caller inventing
 * an empty array to say so.
 */
function setStatusText(text: string): void {
  if (logEl !== null) logEl.textContent = text;
}

function setStatusParts(world: readonly string[], session: readonly string[]): void {
  if (logEl === null) return;
  logEl.replaceChildren();

  const group = (parts: readonly string[], cls: string): HTMLSpanElement | null => {
    if (parts.length === 0) return null;
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = parts.join(' · ');
    return el;
  };

  const left = group(world, 'st-world');
  if (left !== null) logEl.append(left);

  const right = group(session, 'st-session');
  if (right !== null) {
    // THE SEPARATOR IS A REAL CHARACTER AND IT LIVES IN THE RIGHT-HAND GROUP.
    // Without it the announcement runs "…1 talent pointconnected". A screen
    // reader cannot see the gap that CSS puts there.
    right.textContent = ` · ${right.textContent ?? ''}`;
    logEl.append(right);
  }
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
/**
 * WHERE THIS CLIENT IS, as the server last stated it.
 *
 * Both null until a `realm` frame arrives, which is the honest state: `welcome`
 * does not carry a realm, so a freshly connected client genuinely does not know
 * the name of the place it is standing in and must not invent one. Anything
 * rendering these has to handle null rather than defaulting to 'Alderbrook' —
 * a label that is confidently wrong is worse than a label that is absent.
 *
 * `realmKind` is a bare string rather than a union on purpose: it is a HUD
 * affordance ("is there combat here"), and a client that meets a kind a newer
 * server invented should fall through to the cautious branch rather than fail
 * to compile against a protocol it cannot see.
 */
let realmKind: string | null = null;
let realmName: string | null = null;
/**
 * The places on this map you can walk into. Empty until a `realm` frame says
 * otherwise — `welcome` carries none, so a freshly connected client genuinely
 * does not know where anything is and must not draw guesses.
 */
let sites: readonly SiteView[] = [];
/**
 * Which realm the markers above belong to, so a `sites` frame that crossed a
 * realm change in flight is dropped rather than painting another map's towns
 * onto this one. The server stamps every such frame with its realm for exactly
 * this; without the check the failure is silent and looks like a rendering bug.
 */
let currentRealmId: string | null = null;
/**
 * THE OVERWORLD, REMEMBERED, so the world map works from inside a delve.
 *
 * The client only ever holds the level it is standing on, and the world map is
 * specified to show the OVERWORLD and only the overworld — so from inside an
 * arena there would be nothing to draw. Cached on the way past instead: the
 * region is authored and never changes, so a copy taken on arrival is still
 * true an hour later.
 *
 * Sites are cached WITH it. They move — the roamers wander — so what this shows
 * from underground is the world as it was when you went down, which is the
 * honest thing for a map to be. It is not a live feed and must not pretend.
 */
let overworldLevel: LevelView | null = null;
/**
 * WHICH MAP THE WORLD MAP IS SHOWING.
 *
 * The title over it was the string `'THE ALDERBROOK REGION'`, hard-coded, which
 * was true of the only overworld that existed when it was written. A player who
 * walks into the Redaction and presses M now gets a picture of the dark
 * territory captioned with the name of the country they left — the most
 * confusing possible failure on a screen whose entire job is telling somebody
 * where they are.
 *
 * Set beside `overworldLevel` from the same frame, so the caption and the
 * picture cannot come from different maps.
 */
let overworldName: string | null = null;
let overworldSites: readonly SiteView[] = [];
/**
 * WHAT THE PARTS OF THE MOOR ARE CALLED. Sent once on the `realm` frame and
 * held for the world map — see `RealmMsg.regions`. Empty until the first
 * overworld frame, and empty forever against a server too old to send it, which
 * is a map without captions rather than a map that breaks.
 */
let overworldRegions: readonly RegionView[] = [];
/**
 * The overworld's realm id, learned rather than hard-coded. The client has no
 * business knowing the server's naming; it knows which frame said `overworld`.
 */
let overworldRealmId: string | null = null;
/** Is the full-screen world map open? Toggled by `M`, closed by Escape. */
let worldMapOpen = false;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FOG — WHAT THIS CLIENT HAS ACTUALLY SEEN, PER REALM.
 * ═══════════════════════════════════════════════════════════════════════════
 * A 170x100 region handed over whole on the first frame gives away every
 * settlement, every road and every place worth going before the player has
 * walked anywhere. The map should be something you EARN.
 *
 * Keyed by realm, because the overworld's exploration is not an arena's and a
 * fresh instance must not arrive pre-explored.
 *
 * ═══ THE SERVER'S COPY IS THE AUTHORITY, AND IT PERSISTS ═══
 * This map is the SESSION's, and it is seeded from the save on every realm
 * frame — see the `msg.explored` branch in the socket handler, which merges the
 * server's bitset into whatever this session has already revealed rather than
 * replacing it. The client keeps revealing locally at the same radius so
 * neither side sends anything per step; `gateway.ts` writes the bitset onto the
 * character file and `test/server/fog-persistence.test.ts` pins the round trip.
 *
 * THIS NOTE USED TO SAY THE OPPOSITE — "it is not persisted, so a reload
 * forgets the map", with a paragraph about the schema bump that persisting it
 * would need. That bump happened and the note did not, so it sat here claiming
 * a missing feature that was working eighty lines further down. It is corrected
 * rather than deleted because the correction is the useful part: in this
 * codebase a comment describing an ABSENCE is the least trustworthy thing in
 * it, since nothing fails when one goes stale.
 *
 * It is also NOT a visibility rule — the playfield still draws everything in
 * range, because the server decides what a client may know and this is a
 * drawing convenience on top of what it already sent. Anyone using it to hide
 * information from a hostile client is reading it wrong.
 */
const explored = new Map<string, Set<string>>();

/**
 * How far a body reveals. Shared with the server, which is not a nicety: the
 * server's copy is what persists and the client's is what draws, and two radii
 * would make a map that changed shape when you reloaded.
 */
const REVEAL_RADIUS = SHARED_REVEAL_RADIUS;

/**
 * Read one bit out of the base64 the server sent.
 *
 * Decoded lazily, a bit at a time, rather than materialised into a byte array:
 * this runs once per cell of a 17,000-cell region on arrival and never again,
 * and the alternative is a second copy of the whole bitset for one pass.
 */
function fogBitSet(b64: string, bit: number): boolean {
  const byteIndex = bit >> 3;
  const charIndex = Math.floor(byteIndex / 3) * 4;
  const chunk = b64.slice(charIndex, charIndex + 4);
  if (chunk.length < 4) return false;
  const n =
    (B64_ALPHABET.indexOf(chunk[0] ?? 'A') << 18) |
    (B64_ALPHABET.indexOf(chunk[1] ?? 'A') << 12) |
    (B64_ALPHABET.indexOf(chunk[2] ?? 'A') << 6) |
    B64_ALPHABET.indexOf(chunk[3] ?? 'A');
  const within = byteIndex % 3;
  const byte = within === 0 ? (n >> 16) & 255 : within === 1 ? (n >> 8) & 255 : n & 255;
  return (byte & (1 << (bit & 7))) !== 0;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Mark everything within reach of the viewer as seen, and answer the set. */
function revealAround(
  realmId: string,
  level: LevelView,
  at: { x: number; y: number },
): Set<string> {
  let seen = explored.get(realmId);
  if (seen === undefined) {
    seen = new Set<string>();
    explored.set(realmId, seen);
  }
  for (let dy = -REVEAL_RADIUS; dy <= REVEAL_RADIUS; dy += 1) {
    for (let dx = -REVEAL_RADIUS; dx <= REVEAL_RADIUS; dx += 1) {
      // A circle rather than the square the loop walks, so the edge of what you
      // have explored looks like a place someone stood rather than a stamp.
      if (dx * dx + dy * dy > REVEAL_RADIUS * REVEAL_RADIUS) continue;
      const x = at.x + dx;
      const y = at.y + dy;
      if (x < 0 || y < 0 || x >= level.w || y >= level.h) continue;
      seen.add(`${x},${y}`);
    }
  }
  return seen;
}
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
 * `loadout` is RE-SENT WHENEVER A RANK CHANGES — this comment used to say it
 * "arrives once (M3 loadouts are fixed)" and v9 made that false in two ways at
 * once: choosing a class replaces it, and spending a talent point re-renders
 * every talent's `range`, `desc` and `descNext` (protocol.ts's `LoadoutTalent`
 * says the field is stale the instant a rank moves). `cooldowns` is a COMPLETE
 * absolute map of talent id -> game turns remaining — anything absent from it is
 * ready — and `resource` is the class pool. Three frames rather than one because
 * they change at wildly different rates: the loadout on a spend, the cooldowns
 * every turn, the resource on every hit taken.
 */
let loadout: readonly LoadoutTalent[] = [];
/**
 * THE PASSIVES, HELD SEPARATELY BECAUSE THE HOTBAR READS `loadout`.
 *
 * `LoadoutMsg.passives` is its own array on the wire for exactly this reason —
 * merging the two here would put a talent with nothing to press into slot five,
 * and the bar's whole contract is that slot n is `loadout[n]` for the session.
 * The TALENT PANEL reads both; nothing else does.
 */
let passives: readonly LoadoutTalent[] = [];

/**
 * THE DISCIPLINES THERE ARE LEFT TO BUY, from the last `loadout` frame.
 *
 * WHOLESALE REPLACEMENT LIKE ITS TWO NEIGHBOURS, and the list SHRINKS as points
 * are spent — the server re-sends the frame after every unlock, so a client that
 * merged rather than replaced would go on offering a discipline the character
 * already owns.
 */
let unlockable: readonly UnlockableTree[] = [];
let cooldowns: Readonly<Record<string, number>> = {};
let resource: ResourceView | null = null;

/**
 * THE VIEWER'S OWN LEDGER (v9): level, xp into it, the next threshold, and the
 * talent points sitting unspent in their hand.
 *
 * VIEWER-PRIVATE BY CONSTRUCTION — `ProgressMsg` is in `ViewerMsg`, so the
 * server cannot broadcast it and no other player's `unspent` can ever reach this
 * variable. Null until the first frame, which arrives in the `hello` block and
 * again whenever any of the four numbers changes during a pump.
 *
 * IT IS NOT A SECOND COPY OF ANYTHING. The talent RANKS live on `loadout`
 * (`LoadoutTalent.level`) and the points in hand live here, because they change
 * on different edges and the server sends them as two frames for that reason.
 */
let progress: ProgressMsg | null = null;

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

/** Panel visibility. Both default on; `m` and `p` toggle them. */
let logVisible = true;
let partyVisible = true;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * v12 — WHERE THE PLAYER HAS DRAGGED EACH OF THE FOUR MOVABLE PANELS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A DELTA IN LOGICAL BACKBUFFER PIXELS, not a position, and ui/drag.ts's
 * `PanelOffset` says why: a stored position would have to be re-derived every
 * time the viewport changed, while a delta re-applied to a freshly computed rect
 * keeps a centred panel centred-plus-40 when the window grows.
 *
 * CLAMPED ON READ, AND SETTLED ONCE ON RELEASE. `hudLayout` runs `moveIntoBand`
 * on the way out (see the four `movePanel` calls there), so a shrunk viewport
 * walks the panel back into view on the very next frame and restoring the larger
 * window restores the position the player actually chose — nothing is written on
 * a resize, so a resize can never overwrite their choice.
 *
 * WHAT IS WRITTEN, AND ONLY AT THE END OF A GESTURE, IS WHAT THE CLAMP HONOURED.
 * `settlePanel` runs on release and replaces the raw pointer delta with the
 * offset actually realised. Leaving the raw value here was a shipped bug: the
 * next `beginDrag` re-based on it while the grab point came from the CLAMPED
 * position on screen, so one sweep past the band edge banked hundreds of pixels
 * of dead travel and the title bar stopped responding for four consecutive
 * full-height drags. See `settlePanel` for the arithmetic and the numbers.
 *
 * ═══ SESSION-LOCAL, RESET ON RELOAD, EXACTLY LIKE THE TWO BOOLEANS ABOVE ═══
 * That is a decision and not an omission (DECISIONS.md D14). Persisting it needs
 * one of two mechanisms and both are worse than forgetting: a `set_panel_layout`
 * intent would be a new client verb, a new unicast echo, a new optional
 * `SavedCharacter` field and a new validator — a protocol-and-save-file change
 * to remember where somebody put a window — and `localStorage` would be a SECOND
 * persistence mechanism competing with the save file, in a client that has none
 * at all (net/socket.ts:16 is a comment explaining the auth token is
 * memory-only). The precedent sits two lines above this one.
 */
const panelOffsets: Record<DraggablePanel, PanelOffset> = createPanelOffsets();

/**
 * THE GESTURE IN PROGRESS, or null. There is never more than one — a pointer has
 * one button down at a time and a second press cancels the first (see the guard
 * at the head of `mousedown`).
 *
 * ═══ IT IS A *PENDING* PRESS UNTIL `moved` GOES TRUE ═══
 * `passesThreshold` is 6 logical pixels, ported from Mouse.lua:177, and below it
 * the press is still a plain CLICK. That is what `click` is for: a press on an
 * inventory cell cannot equip on `mousedown`, because the same press might turn
 * out to be the start of a drag onto the hotbar — so the act is DEFERRED and run
 * by the release only if the pointer never travelled far enough. A press on a
 * panel header carries `click: null`, because a header has never done anything.
 *
 * `grabX`/`grabY` and `at` are in LOGICAL BACKBUFFER pixels, the one coordinate
 * space every rect and every hit test in this file already works in, so nothing
 * downstream converts anything.
 */
type LiveDrag = {
  readonly subject: DragSubject;
  readonly grabX: number;
  readonly grabY: number;
  /** The subject panel's offset when it was grabbed. Unused for item drags. */
  readonly offsetAtGrab: PanelOffset;
  /** What a sub-threshold release means, or null when the press means nothing. */
  readonly click: (() => void) | null;
  /** Has the pointer travelled past `DRAG_THRESHOLD_PX`? */
  moved: boolean;
  /** Where the pointer is now, for the ghost. Null while it is off the backbuffer. */
  at: TileXY | null;
};
let drag: LiveDrag | null = null;

/**
 * WHAT IS ON THE FOUR MOUSE-ONLY HOTBAR SLOTS (indices 4-7), or null for empty.
 *
 * INDEXED 0-3 AND OFFSET BY `HOTBAR_TALENT_SLOTS` AT EVERY READ, rather than an
 * eight-long array with four permanent holes: slots 0-3 are the class loadout and
 * are not bindable at all (`hotbarDropTargetAt` answers `Talent` for them and the
 * caller must refuse IN WORDS), so an array with room for them would be an array
 * with four cells that must never be written — which is an invariant somebody
 * eventually breaks.
 *
 * ═══ THE NAME AND THE ICON ARE CACHED AT BIND TIME, AND THE ACTION IS NOT ═══
 * `itemSlotAction` recomputes EQUIP / REMOVE / GONE from the last `inventory`
 * frame on every frame, because whether an id is in the bag, on the body or gone
 * is a property of the world and a slot that cached it would keep saying EQUIP
 * after the item was already worn. The name and icon are the opposite: they are
 * authored catalogue facts that never change, and GONE still has to PRINT a name
 * for an item that is in neither collection to read one off.
 *
 * SESSION-LOCAL, like the offsets above and for the same reasons. Stated plainly
 * because it is a real limitation rather than an oversight: a bar the player
 * fills is EMPTY AGAIN AFTER A REFRESH. ToME persists per character
 * (`self.actor.hotkey[i] = {drag.kind, drag.id}`, HotkeysIconsDisplay.lua:355);
 * we do not, this pass (DECISIONS.md D16).
 */
type ItemBinding = {
  readonly itemId: string;
  readonly name: string;
  readonly icon: string;
};
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHAT IS ON EACH OF THE SIX KEYED SLOTS — TALENT IDS, OR null FOR EMPTY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The bar's contract used to be "slot n IS `loadout[n]`, for the session".
 * That was exactly right while a class held six actives and the bar held six
 * slots: there was nothing to choose between, so a binding would have been a
 * setting with one legal value.
 *
 * It is the thing standing in the way now. A class may hold exactly six actives
 * because `_loadoutArityCheck` says so, and it says so because the bar is six —
 * so no class can gain a third discipline with a button in it, which is most of
 * what is left between this game and the one it is a port of.
 *
 * IDS, NOT TALENTS, for the reason `DragKind.Talent` carries an id: a
 * `LoadoutTalent` is a snapshot with a rank and a cooldown in it, and the
 * `loadout` frame is re-sent every time either changes. A captured object would
 * draw last week's rank on the bar forever.
 *
 * SEEDED FROM THE LOADOUT, so nothing about day one is different: the first six
 * a class owns land on keys 1-6 in the order they were authored, which is
 * precisely where they were before this existed. See `reseatTalentBindings`.
 */
const talentBindings: (string | null)[] = Array.from(
  { length: HOTBAR_TALENT_BINDINGS },
  () => null,
);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHICH PAGE THE BAR IS SHOWING. 0 ordinarily; 1 while Shift is down.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A MODE, NOT A TOGGLE, and that is the whole of why it is safe. A toggled
 * second page is a state a player can be in without noticing — the classic
 * failure is pressing 1 for your reliable attack and getting something else
 * because you left the bar on page 2 four minutes ago. Held-Shift cannot do
 * that: the moment you stop asking for page 2 you are back on page 1, and the
 * bar you are looking at is always the bar your keys will press.
 *
 * IT IS ALSO WHY THE BAR REDRAWS ON THE MODIFIER ALONE. Pressing Shift with no
 * digit shows you page 2 — that is how you find out what is on it, and a page
 * you can only see by committing to a press is a page nobody uses.
 */
let talentPage = 0;

/**
 * Will this bar still be here tomorrow? False for an anonymous socket and for a
 * build with no save layer — `HotbarMsg.persisted`.
 *
 * OPTIMISTIC UNTIL TOLD OTHERWISE, so a client that has not heard from the
 * server yet does not accuse it of anything. It is read once, when the player
 * first rearranges something, because a warning at join is noise to somebody
 * who was never going to touch the bar.
 */
let hotbarPersists = true;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PUT THE BAR IN ORDER AFTER A `loadout` FRAME. Called on every one of them.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `loadout` is re-sent whenever a rank changes, a talent is learned, a class
 * is chosen or a character is restored — so this runs constantly and must be
 * IDEMPOTENT and must not disturb a bar the player has arranged.
 *
 * Three rules, in order, and each one exists because the alternative is a bug
 * somebody would report as "the game moved my buttons":
 *
 *   1. A BINDING THAT STILL RESOLVES IS LEFT ALONE. This is the whole reason
 *      the function is not just a re-seed. A rank going up re-sends the frame;
 *      re-seeding there would throw away every arrangement on every spend.
 *
 *   2. A BINDING THAT NO LONGER RESOLVES IS CLEARED. A class swap or a
 *      deleted talent leaves an id nothing can press; `hotbarView` already
 *      draws that as empty, and clearing it here means the slot is genuinely
 *      free for the fill below rather than looking free and staying occupied.
 *
 *   3. EMPTY SLOTS ARE FILLED FROM THE LOADOUT, in authored order, skipping
 *      anything already bound elsewhere. On a fresh character that is exactly
 *      the old behaviour — the first six a class owns, on keys 1-6, in the
 *      order they were written. Nothing about day one changed, which is the
 *      property that lets this land without a word to anybody playing.
 */
function reseatTalentBindings(): void {
  const known = new Set(loadout.map((talent) => talent.id));
  for (let i = 0; i < talentBindings.length; i += 1) {
    const bound = talentBindings[i];
    if (bound !== null && bound !== undefined && !known.has(bound)) talentBindings[i] = null;
  }
  // WHAT IS ALREADY ON THE BAR, so the fill never puts the same talent on two
  // keys. A player CAN do that deliberately by dragging; the fill must not do
  // it by accident, because a duplicate that appeared on its own reads as the
  // bar being broken.
  const seated = new Set(talentBindings.filter((id): id is string => id !== null));
  for (const talent of loadout) {
    if (seated.has(talent.id)) continue;
    const free = talentBindings.indexOf(null);
    if (free < 0) break;
    talentBindings[free] = talent.id;
    seated.add(talent.id);
  }
}

const hotbarBindings: (ItemBinding | null)[] = Array.from(
  { length: HOTBAR_ITEM_SLOTS },
  () => null,
);

/**
 * THE CHARACTER SHEET, AND IT DEFAULTS OFF — the other two do not.
 *
 * The log and the pane answer questions that are live all session ("what just
 * happened", "who am I with"); this one answers a reference question asked a few
 * times an evening, and it sits in the middle of the map. So `c` opens it, `c`
 * closes it, and the × on its header is the mouse's copy of the same act. It is
 * NOT in the Escape chain — see `onCancel`.
 */
let sheetVisible = false;
/** True while the pointer is over the sheet's close control, so it reads pressable. */
let sheetCloseHovered = false;
/** True while the pointer is over the sheet's `[G]` control. Cosmetic. */
let sheetTalentsHovered = false;

/**
 * THE TALENT PANEL, AND IT DEFAULTS OFF FOR THE SHEET'S OWN REASON.
 *
 * `g` opens it, `g` closes it, and the × on its header is the mouse's copy of
 * that act. It is NOT in the Escape chain — see `onCancel`, which explains at
 * length why no dock surface is.
 *
 * ═══ IT IS A PANEL AND THE SERVER IS NEVER TOLD IT IS OPEN ═══
 * Nothing here parks a body, sets a standing order or touches the barrier, and
 * none of the six keyboard gates below grows a condition for it. A player
 * reading their talents can still walk, commit, hold and press 1-4, and the
 * Warrant Clock auto-passes them like anyone else. That is the whole difference
 * between this and the class chooser, and ui/talents.ts's header states the cost
 * of getting it wrong: five people waiting on somebody who is reading a menu.
 */
let talentsVisible = false;
/** True while the pointer is over the talent panel's close control. Cosmetic. */
let talentsCloseHovered = false;
/** Loadout index under the pointer on the talent panel, or null. Cosmetic. */
let talentsHoveredRow: number | null = null;
/**
 * THE TALENT ONE PRESS FROM BEING BOUGHT, or null.
 *
 * The whole of the confirm-press deviation lives in `pressSpend`
 * (ui/talents.ts); this is the single variable it reads and writes. It is
 * cleared whenever the panel closes, whenever a `loadout` frame lands (the only
 * acknowledgement a spend ever gets) and whenever the server refuses anything,
 * so an arm can never outlive the screen that explained it.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH TALENT THE DESCRIPTION COLUMN IS ABOUT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SET BY HOVER *AND* BY CLICK, and it does not clear when the pointer leaves.
 * That is the behaviour of the screen this ports: you sweep across the trees
 * reading, then stop moving to actually read the last one — and a pane that
 * emptied the moment the pointer left the icon would be blank exactly when it is
 * being read. It clears only when the panel closes.
 *
 * AN ID, so the panel resolves it against the rows it is drawing this frame. The
 * one number on that pane that must never be stale is the level, and it changes
 * on the press this screen exists to make.
 */
let talentFocusId: string | null = null;
/**
 * WHICH ATTRIBUTE IS ONE PRESS FROM BEING BOUGHT, or null.
 *
 * THE SAME TWO-PRESS RULE THE GRID USES, and for a sharper reason: `spend_stat`
 * has no refund and there is no `unspend_stat`, so a single-click `+` is a
 * permanent decision one twitch away. `pressSpend` owns the arm-then-confirm
 * machine and is reused verbatim — it is keyed on a string id and does not care
 * whether that id names a talent or a stat.
 *
 * CLEARED WHEN THE PANEL CLOSES, like `talentsArmedId`: an arming that outlived
 * the screen would confirm on the next press of a `+` the player had not looked
 * at yet.
 */
let talentsArmedStat: string | null = null;
let talentsArmedId: string | null = null;

/**
 * THE INVENTORY PANEL (v10), AND IT DEFAULTS OFF FOR THE SHEET'S OWN REASON.
 *
 * `i` opens it, `i` closes it, and the × on its header is the mouse's copy of
 * that act. It is NOT in the Escape chain — see `onCancel`, which explains at
 * length why no dock surface is.
 *
 * ═══ IT IS A PANEL AND THE SERVER IS NEVER TOLD IT IS OPEN ═══
 * Nothing here parks a body, sets a standing order or touches the barrier, and
 * none of the six keyboard gates below grows a condition for it. A player
 * deciding whether to swap a coat can still walk, commit, hold and press 1-4,
 * and the Warrant Clock auto-passes them like anyone else. That is the whole
 * difference between this and the class chooser, and ui/inventory.ts's header
 * states the cost of getting it wrong in the same words ui/talents.ts does: five
 * people waiting at the barrier on somebody who is reading a menu.
 *
 * THAT IS THE BARRIER ANSWER IN FULL. There is no mechanism to reuse here —
 * decision (g) is a decision NOT to be a modal, and this block is where it is
 * kept. The four loot verbs the panel sends (`equip`, `unequip`, `drop`, and
 * `pickup` from the keyboard) each SPEND THE SENDER'S TURN server-side and then
 * pump, which is what stops the panel becoming a free-action exploit in the
 * other direction: a free pickup would let a player loot a room mid-fight while
 * the monsters stood still, and a free equip would let one at 5 hp put on a
 * whole kit between two swings. The charge is the server's and is not visible
 * from here — gateway.ts's `spendLootTurn` submits the engine's own hold
 * intent, so the turn is spent by the same `spendTurn` a move goes through.
 * READING the panel is still free; ACTING from it is not, and that asymmetry is
 * the entire design.
 */
let invVisible = false;
/** True while the pointer is over the panel's close control. Cosmetic. */
let invCloseHovered = false;
/**
 * WHAT THE COMPARISON STRIP IS ABOUT — the last cell the pointer was over.
 *
 * ═══ IT IS STICKY, AND IT IS NOT CLEARED WHEN THE POINTER LEAVES A CELL ═══
 * ui/inventory.ts's `InventoryFocus` states the constraint and the reason: the
 * DROP control lives INSIDE the strip, so the pointer has to travel from the
 * cell to the strip to reach it. A focus that cleared on leave would empty the
 * strip on the way there and make the control unreachable by construction.
 *
 * The literal instruction for this pass named a `number | null` cell index. That
 * is not the shape ui/inventory.ts shipped: the panel has two grids with
 * different lengths and a tab that swaps between them, so an index means
 * different things a keypress apart, and the exported `focusForHit` answers a
 * FOCUS. Deviating is what keeps hover and click reading the same function — two
 * copies of "what is the strip about" would drift, and the one that drifted
 * would be the one DROP reads.
 */
let invFocus: InventoryFocus | null = null;
/** What is under the pointer RIGHT NOW, or null. Transient; clears on leave. */
let invHovered: InventoryFocus | null = null;
/** True while the pointer is over the strip's DROP control. Cosmetic. */
let invDropHovered = false;
/**
 * WHICH HALF OF `ShowEquipInven` IS ON SCREEN. Client-local; nothing is sent
 * when it changes.
 *
 * EQUIPPED OPENS, which is ToME's own choice for the doll dialog
 * (dialogs/ShowEquipment.lua:54 — `self:setFocus(self.c_doll)`), and it is the
 * only one of the two tabs that is never empty.
 */
let invTab: InventoryTab = InventoryTab.Equipped;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * v11 — THE ESCAPE MENU, AND IT IS A PANEL. THE SERVER IS NEVER TOLD IT IS OPEN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Escape opens it when the cancel chain is otherwise empty, Escape closes it,
 * and the × on its header is the mouse's copy of that act. It is the FOURTH
 * surface built the way ui/talents.ts and ui/inventory.ts are, and it inherits
 * their whole barrier answer verbatim:
 *
 *   Nothing here parks a body, sets a standing order or touches the barrier.
 *   There is no protocol verb that says "a menu is open" and there must not be
 *   one. A player reading this menu is counted in the quorum exactly like
 *   anybody else and the Warrant Clock auto-passes them exactly like anybody
 *   else — which is the difference between this and the class chooser, and
 *   `layout.menu`'s field note is where that decision is made mechanical.
 *
 * ═══ AND THE SWALLOW IS BOUNDED, WHICH IS THE HALF THAT ACTUALLY MATTERED ═══
 * The shipped CRITICAL was not caused by a surface being modal; it was caused by
 * one holding the keyboard for an UNBOUNDED time while `isBlocking` still
 * counted the player in the quorum. Two things bound it here. The menu is one
 * Escape press from being gone, and Escape is FROZEN (keymap.ts's `cancel` row
 * is `rebindable: false`), so that press cannot be edited away. And a key
 * CAPTURE is exactly ONE keypress wide — `applyCapture` disarms on every outcome
 * but a bare modifier — which is ui/talents.ts's `pressSpend` arm/confirm shape
 * reused rather than reinvented.
 */
let menuOpen = false;
/** Which of the two screens the ONE surface is showing. See `MenuScreen`. */
let menuScreen: MenuScreen = MenuScreen.Root;
/**
 * Which page of the Keys screen. Any integer is safe — the geometry clamps it —
 * but it is clamped HERE as well when the pager moves it, or a player leaning on
 * NEXT would walk `page` off to a number no screen size can reach back from.
 */
let menuPage = 0;
/**
 * WHICH SLOT THE NEXT KEYPRESS LANDS IN, or null.
 *
 * ═══ THE ONLY STATE IN THIS CLIENT THAT TAKES A KEY AWAY FROM THE KEYMAP ═══
 * The window listener registered with `{capture: true}` reads this and nothing
 * else. While it is null that listener returns on its first line and is
 * completely inert; while it is set, ONE keypress is consumed and it goes back
 * to null. There is no third state and no way to reach one: every `applyCapture`
 * outcome but `Ignored` (a bare modifier) clears it.
 */
let menuArmed: ArmedCapture | null = null;
/**
 * THE LAST THING THE CAPTURE SAID — a refusal, a conflict, or what was bound.
 *
 * Cleared when the screen changes and when the menu closes, or a "Tab is already
 * Toggle Party" would outlive the row it was about and be read as being about
 * whatever the player did next.
 */
let menuMessage: string | null = null;
/** True while the pointer is over the menu's close control. Cosmetic. */
let menuCloseHovered = false;
/**
 * WHICH ROOT ENTRY IS LIT — BY THE POINTER *OR* BY THE ARROW KEYS. ONE VARIABLE.
 *
 * Two would draw two highlights on one screen and the player would have to work
 * out which one Enter was about. Sharing it means a mouse that moves takes the
 * selection with it, which is what every menu that supports both inputs does.
 */
let menuHovered: number | null = null;
/**
 * WILL THESE BINDS STILL BE HERE TOMORROW? Off the `keybinds` frame, never
 * guessed.
 *
 * False until the server has said otherwise, which is the honest opening state:
 * a client that assumed `true` would tell an anonymous player their keys were
 * saved for the whole window between connecting and the first frame.
 *
 * ═══ AND THE BINDS THEMSELVES ARE NOT HELD HERE ═══
 * They travel ON the compiled keymap (`gameKeymap.current.remap`), which is the
 * one thing the dispatcher, the labels and the Keys screen all read. A second
 * copy in this file would be the copy that drifts, and it would drift first in
 * the direction that matters: the screen would draw what this client hoped it
 * sent rather than what the server echoed back.
 */
let keybindsPersisted = false;

/**
 * Whether the zoom the player picked will outlive the tab. `keybindsPersisted`'s
 * twin — an anonymous socket has no character file, so its preference lives on
 * its body until recall, and the screen must be able to say so rather than let
 * somebody discover a working feature looks broken.
 */
let zoomPersisted = false;

/**
 * The zoom step the server last told us it holds, or null before it has said.
 *
 * Written by `case 'settings'` and applied by `onMessage`, for the reason that
 * case gives: the frame handler cannot see the renderer and the wrapper can.
 */
let storedZoom: number | null = null;

/**
 * PUT EVERY PIECE OF THE MENU'S STATE BACK, AND NOTHING ELSE.
 *
 * ═══ WHY THIS IS MODULE SCOPE WHEN `closeMenu` IS NOT ═══
 * `closeMenu` lives inside `boot()` because it also calls `requestDraw`, which
 * is the renderer's dirty flag and belongs to that closure. `applyServerMessage`
 * is module scope and cannot see either — but it has ONE frame that must tear
 * this surface down (`class_options`), and the redraw there is already the
 * caller's. So the state reset is here, shared, and the two callers add what only
 * they need: `closeMenu` adds the recompute and the draw, and the frame adds the
 * recompute it was already making.
 *
 * THE ARM MOST OF ALL. It is the one thing in this client that takes a key away
 * from the keymap, and an arm that outlived the screen explaining it would
 * swallow the next keypress with nothing on screen to say why.
 */
function resetMenuState(): void {
  menuOpen = false;
  menuScreen = MenuScreen.Root;
  menuPage = 0;
  menuArmed = null;
  menuMessage = null;
  menuHovered = null;
  menuCloseHovered = false;
}

/**
 * THE CLASS CHOOSER'S OPTIONS, or null when there is no choice owed.
 *
 * NULL IS THE WHOLE OF "THE PICKER IS DOWN", and there is deliberately no second
 * flag beside it: the frame arrives once, unicast, for the one player who has no
 * class on file (protocol.ts's `ClassOptionsMsg`), and it is cleared when the
 * server's own follow-up says the choice landed. A `pickerVisible` boolean next
 * to this would be a second answer to "is the modal up" and the first thing to
 * desync would be the keyboard gate, which is what stands between a stray `t` and
 * a DOM input taking focus behind a modal.
 *
 * IT IS NEVER CLEARED OPTIMISTICALLY. The server is authoritative and may refuse
 * — an id this build does not have, or a second choice — and a modal torn down on
 * the click would leave that player playing the provisional rotation class with
 * no way back to the screen. See `case 'loadout'`.
 */
let classOptions: readonly ClassOptionView[] | null = null;
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SELECT SCREEN, AND WHAT IT MEANS THAT IT IS NOT NULL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NON-NULL MEANS THIS CLIENT HAS NO BODY. The server sent a `roster` INSTEAD OF
 * the world — no `welcome`, no `realm`, no `state`, and nothing added to the
 * overworld — so there is no map behind this modal and no token to move. Every
 * other modal in this client opens over a live world; this one opens over
 * nothing, which is why it is also the only one that cannot be dismissed.
 *
 * CLEARED ONLY BY `welcome`. The handshake is: roster, choose, `hello` again,
 * world. Tearing it down on the click would leave a player looking at an empty
 * screen for as long as the round trip takes, and looking at a permanently empty
 * one if the server answers with the roster again — which it does, deliberately,
 * for a character it will not open.
 */
let roster: RosterMsg | null = null;
/** Which row is picked, or null. Null on purpose: see `selectedClass`. */
let selectedCharacter: number | null = null;
/** Which row is under the pointer, or null. Cosmetic. */
let rosterHovered: number | null = null;
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHICH CHARACTER IS ONE PRESS FROM BEING PUT AWAY. BY ID, NOT BY INDEX.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The server re-sends the whole roster for every outcome — a delete that
 * worked, a delete of something already gone, a delete refused because the
 * character is being played — so the list can come back one row shorter
 * between the two presses. An armed INDEX would then be pointing at whichever
 * character slid up into that slot, and the second press would delete the
 * wrong one with no way back. `selectedCharacter` is an index and gets
 * re-anchored by id on every roster for exactly this reason; this skips the
 * re-anchoring by never being an index in the first place.
 */
let rosterArmedDeleteId: string | null = null;
/**
 * The character this client asked for, kept across the reconnect that enters the
 * world. It is the only thing the select screen leaves behind.
 */
let chosenCharacterId: string | null = null;
/**
 * True for exactly one handshake: the one that creates a character.
 *
 * CLEARED THE MOMENT `welcome` NAMES AN ID, and that is the whole reason
 * `WelcomeMsg.characterId` exists. A flag that stayed true would mean every
 * reconnect after the resume grace expired created ANOTHER character, and a
 * flaky evening would fill somebody's roster with strangers.
 */
let wantsNewCharacter = false;
/**
 * Which card is picked, or null while nothing is. Null on purpose: this choice is
 * written to a file and never offered again, so a card pre-selected by the client
 * is one stray Enter away from choosing somebody's character for them.
 */
let selectedClass: number | null = null;
/** Which card is under the pointer, or null. Cosmetic. */
let pickerHovered: number | null = null;

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
 * WHAT IS IN THE AIR — every orb currently in flight, from the `projectiles`
 * frame (v7).
 *
 * COMPLETE AND ABSOLUTE, replaced wholesale, never patched, exactly like
 * `effects` above. An empty array means the sky is clear, and the ABSENCE of an
 * id from a later frame is the only spelling of "it landed" — there is no landed
 * event and there must not be one.
 *
 * AND IT ADDS NO TIMER, which is the whole reason it can be a plain variable
 * next to `pings` rather than a machine like one. A `point` marker expires on
 * wall-clock time, so it needs a deadline and something to fire it; an orb moves
 * on the ENERGY clock, one step per resolved turn, so it changes exactly when a
 * frame arrives — and `onMessage` already calls `requestDraw()` after every
 * applied frame. The bounded-timer promise at the top of this file still counts
 * seven, and this feature is the reason it is worth counting.
 */
let projectiles: readonly ProjectileView[] = [];

/**
 * WHAT IS LYING ON THE FLOOR (v10) — every item on every tile, from the `ground`
 * frame.
 *
 * COMPLETE AND ABSOLUTE, REPLACED WHOLESALE, NEVER PATCHED, exactly like
 * `effects` and `projectiles` above. An empty array means the floor is clear, and
 * the ABSENCE of an id from a later frame is the only spelling of "somebody took
 * it" — there is no taken event and there must not be one. protocol.ts's
 * `GroundMsg` states the cost of the alternative in this feature's own terms: a
 * phantom pile sends somebody walking the length of the map to a tile with
 * nothing on it, and because the pile is UNOWNED what they will conclude is that
 * a friend took it.
 *
 * IT IS HELD FLAT, THE WAY THE WIRE SENDS IT, and grouped by tile at the two
 * places that ask a question about a tile (`lootMarkers` for the map mark and
 * `lootAt` for the menu row). Storing it pre-grouped would mean this file held a
 * second shape of the same fact and the regroup would have to be re-run on every
 * frame anyway, since the frame replaces the whole table.
 *
 * AND IT ADDS NO TIMER. A pile is a standing fact about a tile — world.ts freezes
 * the record with "a ground item is a fact about a tile, not a body: it never
 * moves" — so it changes exactly when a frame arrives, and `onMessage` already
 * calls `requestDraw()` after every applied frame. The bounded-timer list at the
 * top of this file is unchanged by this whole feature, which is the same property
 * `projectiles` above claims and for the same reason: a fact that only moves when
 * a packet lands needs nothing to move it.
 */
let ground: readonly GroundItemView[] = [];

/**
 * THE VIEWER'S OWN BAG AND DOLL (v10), from the `inventory` frame.
 *
 * VIEWER-PRIVATE BY CONSTRUCTION — `InventoryMsg` is in `ViewerMsg`, so the
 * server cannot broadcast it and nobody else's carried list can ever reach this
 * variable. That is not only privacy: `CarriedItemView.compare` is a delta
 * against THIS recipient's paper doll, so a shared copy would be arithmetically
 * wrong for everybody but its author.
 *
 * NULL UNTIL THE FIRST FRAME, AND NULL IS THE ORDINARY STATE OF A BARE
 * DETECTIVE. The server sends this on a memo seeded empty, so a player wearing
 * and carrying nothing is never sent one at all — which is what keeps the
 * pre-loot frame set byte-identical. ui/inventory.ts draws that as "nothing worn,
 * nothing carried" rather than as a panel that failed to load.
 *
 * COMPLETE AND ABSOLUTE, both halves at once, replaced and never merged — one
 * frame for the doll and the bag is the port (`SHOW_EQUIPMENT` is literally an
 * alias of `SHOW_INVENTORY`, tome/class/Game.lua:2192), and two frames could
 * arrive a pump apart and render a comparison against a slot whose contents had
 * already changed.
 */
let inventory: InventoryMsg | null = null;
/**
 * THE SHELVES OF THE ROOM YOU ARE IN, or null for a room with no shop.
 *
 * NULL IS THE WHOLE SIGNAL. The server sends a `shop` frame only for a realm
 * that HAS one, so "no frame" is how a client knows there is no shop here —
 * there is no second "is there a shop" flag free to disagree with it.
 */
let shop: ShopMsg | null = null;

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
 * SAY SOMETHING THAT IS NOT A COMPLAINT. Replaced in boot() alongside
 * `onRefusal`, and it is the SAME timer and the SAME line.
 *
 * ═══ A SECOND NAME FOR ONE MECHANISM, AND THE NAME IS THE POINT ═══
 * Everything else that reaches the notice slot is a refusal: "too close", "not
 * your turn yet", "not connected — that did not go out". Routing a LEVEL-UP
 * through a hook spelled `onRefusal` put the best news in the game in the
 * complaints channel — and left the next reader of `case 'progress'` looking at
 * a line that reads as an error path. There is no behavioural difference and
 * there deliberately is not one: a second colour or a second slot would be a
 * second thing to keep from overlapping the first, for a sentence that appears a
 * handful of times an evening.
 */
let onGoodNews: (text: string) => void = () => {
  // No canvas and no timer yet.
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

/**
 * RE-ASK ABOUT YOURSELF, FOR THE OPEN CHARACTER SHEET. Replaced in boot(), which
 * owns the socket; a no-op until then and a no-op while the sheet is shut.
 *
 * ═══ WITHOUT THIS THE SHEET GOES BLANK IN THE MIDDLE OF A FIGHT ═══
 * `inspectCache` is invalidated WHOLESALE on every game-turn edge, for the reason
 * the hover card's own header gives: hit points and hit chances are answers about
 * one game turn. The sheet reads that cache, so the turn after it was opened it
 * has nothing to draw and falls back to its "gathering…" row — permanently, on a
 * panel nobody is hovering, because the only thing that re-asks is a pointer
 * coming to rest on a token.
 *
 * ONE FRAME PER GAME TURN, and only while the panel is open. That is inside the
 * budget HOVER_SETTLE_MS sets out: the socket's bucket is 20 frames a second and
 * a game turn is a human decision long, so this is comfortably below the hover
 * card's own one-per-turn allowance sitting beside it.
 *
 * ═══ AND ONE FRAME PER LOOT CHANGE, WHICH IS THE SECOND CALLER — v10 ═══
 * The turn edge stopped being the whole rule the moment equipment could move a
 * combat sheet. `case 'inventory'` deletes this viewer's own cache entry and
 * calls this. A loot verb DOES spend the sender's turn server-side, so the clock
 * usually advances — but `tickLevel` returns `parked` without advancing anything
 * while another player still owes a decision, so "somebody got dressed while a
 * teammate was thinking" is a real loadout change with no turn edge behind it.
 * The delete is what makes the call do anything; see that call site.
 */
let refreshSelfSheet: () => void = () => {
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
  return {
    turn,
    bellMs: bellRemainingMs(),
    /**
     * v19 — WHAT IS LEFT IN THE ROUND, so the banner can answer "am I done?".
     *
     * FROM `resource`, WHICH IS VIEWER-PRIVATE, and never from the public
     * per-actor turn record — another detective's remaining budget is not yours
     * to read, and `TurnView.budget` says so at its declaration.
     *
     * NULL UNTIL ALL FOUR NUMBERS ARE PRESENT. A server that predates the MP
     * fields sends two of them, and half a budget on screen is worse than none:
     * a player reading "3/6 AP" with no MP beside it cannot tell whether the
     * round ended because the legs ran out.
     */
    budget:
      resource?.ap === undefined ||
      resource.maxAp === undefined ||
      resource.mp === undefined ||
      resource.maxMp === undefined
        ? null
        : {
            ap: resource.ap,
            maxAp: resource.maxAp,
            mp: resource.mp,
            maxMp: resource.maxMp,
          },
  };
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
 * HOW GOOD A TIER IS, for picking the one a pile is marked with.
 *
 * A TABLE RATHER THAN AN ORDERING BAKED INTO A COMPARATOR, and it is exhaustive
 * over `ItemTier` by its type, so a fourth rarity is a compile error here rather
 * than a pile that silently marks itself common. The client is not allowed to
 * decide which items are rare — `GroundItemView.tier` exists precisely so the
 * browser holds no such table (protocol.ts's `ItemTier`) — and this is only a
 * comparison BETWEEN two answers the server already gave.
 */
const TIER_RANK: Readonly<Record<ItemTier, number>> = { common: 0, uncommon: 1, rare: 2 };

/**
 * THE FLOOR, GROUPED INTO ONE MARK PER TILE.
 *
 * THE GROUPING IS THIS FILE'S JOB AND IS DONE ONCE, HERE. render/canvas.ts's
 * `LootMarker` says why the renderer must not do it — it holds no game state and
 * must not grow any — and ui/verbs.ts says why the menu must not either: a second
 * place in the client that knows what a pile is would disagree with this one the
 * first time either started filtering by what the viewer can see.
 *
 * `GroundItemView.cell` IS THE KEY, and it is a pair for exactly this reason:
 * two identical pairs of trousers on one tile are two rows with two distinct
 * world ids, and a client that grouped by `itemId` would draw one mark for two
 * items and be permanently one short.
 *
 * THE MARK CARRIES THE BEST TIER ON THE TILE, not the top one. `pickup` takes
 * index 0 whatever is underneath it, so a mark coloured by the top item would
 * dim the moment somebody dropped a common thing on a rare one — and "there is
 * something good here" is the only judgement this mark is trying to make.
 */
function lootMarkers(): readonly LootMarker[] {
  const byTile = new Map<string, { x: number; y: number; count: number; tier: ItemTier }>();
  for (const item of ground) {
    const [x, y] = item.cell;
    const key = `${String(x)},${String(y)}`;
    const seen = byTile.get(key);
    if (seen === undefined) {
      byTile.set(key, { x, y, count: 1, tier: item.tier });
      continue;
    }
    seen.count += 1;
    if (TIER_RANK[item.tier] > TIER_RANK[seen.tier]) seen.tier = item.tier;
  }
  return [...byTile.values()];
}

/**
 * WHAT THIS TILE'S LOOT MEANS TO THE VIEWER — the answer ui/verbs.ts asks for.
 *
 * THREE STATES AND NOT TWO, because `pickup` CARRIES NO COORDINATE: the server
 * reads the sender's own live x/y and takes index 0 of that tile (protocol.ts's
 * `PickupSchema`), so a row offered on a pile across the room would be a row
 * that lies about what the click will do. `Underfoot` is live, `OutOfReach` is
 * greyed and teaches "walk onto it", and `None` drops the row entirely rather
 * than leaving a permanently dead entry on the surface players right-click most.
 *
 * `selfTile()` MAY BE NULL before `welcome` puts a body on the map, and a null
 * self is `OutOfReach` rather than `Underfoot` — the honest answer, since a
 * viewer with no body is standing nowhere.
 */
function lootAt(tile: TileXY): TileLoot {
  const here = ground.some((item) => item.cell[0] === tile.x && item.cell[1] === tile.y);
  if (!here) return TileLoot.None;
  const me = selfTile();
  return me !== null && sameTile(me, tile) ? TileLoot.Underfoot : TileLoot.OutOfReach;
}

/**
 * THE ONE FRAME AND TWO PIECES OF LOCAL STATE THE INVENTORY PANEL IS BUILT FROM.
 *
 * DELIBERATELY NOT `charSheetView()`'S SHAPE. The sheet joins four frames through
 * a cache stamped with a game turn and has a "gathering…" state; this panel's one
 * input is absolute, unicast and re-sent by the server whenever it changes, so
 * the panel is correct the instant it appears and asks the server for nothing —
 * the same property `talentPanelView()` has and for the same reason.
 */
function inventoryPanelView(): InventoryPanelView {
  return {
    inventory,
    // THE SHELF OF THE ROOM YOU ARE IN, or null. It is what makes the third tab
    // exist at all — see `tabsFor`.
    shop,
    // A ROOM WITH NO SHOP CANNOT LEAVE YOU ON THE SHOP TAB. Walking out of a
    // town with the tab open would otherwise leave the panel showing a shelf
    // that is not there, with no box to click to get off it.
    tab: shop === null && invTab === InventoryTab.Shop ? InventoryTab.Carried : invTab,
    focus: invFocus,
    // ═══ THE FACE IN THE MIDDLE OF THE DOLL, JOINED FROM THE `turn` FRAME ═══
    // NOT BUILT HERE FROM THE CLASS NAME. src/server/view/projector.ts:387-393
    // picks the `icon_character_the_*` key per class WITH a generic fallback for
    // the three classes that have no art, so any literal assembled in the
    // browser would be wrong four times in five and would resolve to the loud
    // violet missing-asset box on a clone. `TurnActor.portrait` is that key,
    // already chosen by the authority; `selfCard` is the same accessor the turn
    // strip reads, so the doll and the card cannot show two different faces.
    //
    // Null before the first `turn` frame, which ui/inventory.ts draws as a
    // primitives silhouette — the same thing a bare clone with no art sees.
    portrait: selfCard(turn)?.portrait ?? null,
    // WHAT THE POINTER IS CARRYING, for the drop-target ring on the doll. See
    // `liveDragSubject`: a press that has not passed the 6px threshold is still
    // a CLICK, so it must not light anything up.
    drag: liveDragSubject(),
  };
}

/**
 * THE DRAG THE PAINTERS MAY SEE, or null.
 *
 * `drag.moved` IS THE WHOLE GATE. Between `mousedown` and the sixth pixel of
 * travel the gesture is still a plain click (ui/drag.ts's `DRAG_THRESHOLD_PX`,
 * ported from Mouse.lua:177), and a doll cell that rang the moment a button went
 * down — or a hotbar slot that lit up on every press of the inventory panel —
 * would be telling the player a drag had started when one had not.
 */
function liveDragSubject(): DragSubject | null {
  return drag !== null && drag.moved ? drag.subject : null;
}

/**
 * DID THE FOCUS CHANGE? Used only to decide whether a pointer move is worth a
 * redraw.
 *
 * NEAR-KIN TO ui/inventory.ts's PRIVATE `sameFocus` AND DELIBERATELY NOT A COPY
 * OF IT, in one case: two NULLS are the same here and are NOT the same there.
 * That difference is the whole reason it is written out rather than exported and
 * shared. The panel's version answers "does this cell wear a ring", where a null
 * focus must never match anything, so `null === null` returning true would ring
 * every empty cell at once. This one answers "is this different from what I had",
 * where two nulls are emphatically not different and a redraw per pixel of bare
 * panel is the bug at the top of this file.
 *
 * NOTHING DECIDES AN ACT HERE. The click path reads the exported `focusForHit`,
 * so the two answers to "what is the strip about" cannot disagree where it
 * matters; the worst a drift in this function could cost is a frame drawn that
 * did not need to be.
 */
function sameInvFocus(a: InventoryFocus | null, b: InventoryFocus | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'item' && b.kind === 'item') return a.itemId === b.itemId;
  if (a.kind === 'slot' && b.kind === 'slot') return a.slot === b.slot;
  return false;
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
    /**
     * ZERO COUNTS, AND IT IS THE CASE THAT MATTERS MOST.
     *
     * A Downed body does not block — `actorAt` skips anything not alive — so the
     * last step of a run to a friend lands ON them rather than beside them.
     * Requiring `chebyshev === 1` made this prompt disappear at exactly that
     * moment, with the five-turn clock still running. The server picks up
     * whoever is under your feet first (`submitRevive`), so the direction sent
     * for a body on your own tile is a formality; the prompt is the point.
     */
    const reach = chebyshev(me, body);
    if (reach > 1) continue;
    const dir =
      reach === 0
        ? DIR_ORDER[0]
        : DIR_ORDER.find((candidate) => {
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
 * IS THERE A PARTY TO LEAVE? ONE ANSWER, READ BY BOTH SURFACES THAT OFFER IT.
 *
 * A party of one is not "in a party" as far as `leave` is concerned — there is
 * nothing to leave and the server refuses it in the same words. `/leave` asks
 * this through `commandContext`, and the escape menu's LEAVE PARTY row asks it
 * directly to decide whether to draw itself greyed; two copies of the
 * comparison would grey a row for a state the command line still accepted.
 *
 * The `?? 1` is what makes a pane that has not spoken yet answer "you are
 * alone" rather than offering a verb the server has no party for.
 */
function inParty(): boolean {
  return (partyState?.members.length ?? 1) > 1;
}

/**
 * EVERYTHING THE ESCAPE MENU IS DRAWN FROM, joined in one place.
 *
 * `keymap` IS THE COMPILED OBJECT rather than a remap, because the overlay
 * travels on it — one value, not two that can disagree — and because `labelFor`
 * needs the whole thing to show a row the PERMANENT floor beside its two slots.
 * It is read live off `gameKeymap`, the same box the already-registered key
 * handler dereferences on every press, so what the screen says a key does and
 * what the key does are the same fact and not two.
 */
function escapeMenuView(): EscapeMenuView {
  return {
    screen: menuScreen,
    keymap: gameKeymap.current,
    persisted: keybindsPersisted,
    inParty: inParty(),
    page: menuPage,
    armed: menuArmed,
    message: menuMessage,
    // v12 — THE COUNT GOES ON THE CONTROL THAT ALREADY ROUTES TO THE PANEL.
    // Root row 3 opens the talent screen and never said how many points were
    // behind it, so it reads `TALENTS (2)` while any are waiting and the bare
    // word at zero. `?? 0` because `progress` is null for a real window on
    // connect and "(0)" would be a number stated confidently about nothing.
    unspent: progress?.unspent ?? 0,
    /**
     * v19 — WHETHER THERE IS A LIST TO GO BACK TO.
     *
     * `chosenCharacterId` IS THE HONEST TEST and it is deliberately not "am I
     * signed in". It is non-null only because a `welcome` said which character
     * this body is, and the server sends that field only for a body it has BOUND
     * to a file. So this is true exactly when there is a roster behind this
     * player and their evening is being written down — which is the question the
     * row is really asking.
     */
    canSwitchCharacter: chosenCharacterId !== null,
  };
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
  /**
   * The character sheet, or null when it is shut or the band is too small.
   *
   * CLAMPED INTO THE SAME BAND as the two dock panels, which is what keeps it off
   * the hotbar, the resource strip and the prose lines — see ui/charsheet.ts's
   * header for why a panel that could cover a control would be a different
   * feature (a modal) with a different cost (five people at the barrier).
   */
  readonly sheet: PanelRect | null;
  /**
   * The talent panel, or null when it is shut or the band is too small.
   *
   * FROM `panelBand` LIKE `sheet`, NOT FROM THE VIEWPORT LIKE `picker`, and that
   * one line is the whole panel-not-modal decision made mechanical: clamped into
   * the band it can never come to rest over the hotbar, the resource strip or
   * the prose lines, so every control stays visible and pressable underneath it
   * while a player reads. ui/talents.ts's header states the cost of the other
   * choice — five people at the barrier waiting on somebody reading a menu.
   *
   * It is anchored to the TOP of the band while the sheet is centred in it, so
   * the two miss each other on any band tall enough for both; where they do
   * collide, the paint order in `paintHud` and the hit-test order in `mousedown`
   * agree that this one is on top.
   */
  readonly talents: PanelRect | null;
  /**
   * The inventory panel, or null when it is shut, the band is too short, or the
   * viewport is too narrow for four item frames.
   *
   * FROM `panelBand` LIKE `sheet` AND `talents`, NOT FROM THE VIEWPORT LIKE
   * `picker`, and that one line is what makes it a PANEL rather than a modal:
   * clamped into the band it can never come to rest over the hotbar, the resource
   * strip or the prose lines, so every control stays visible and pressable
   * underneath it while a player decides whether to swap a coat. Deriving it from
   * the full viewport would be decision (g) reversed in one argument.
   *
   * It is anchored to the BOTTOM of the band while the sheet is centred in it and
   * the talent panel is pinned to the top — three independent toggles and three
   * different anchors, so on a band tall enough all three miss each other. Where
   * they do collide, the paint order in `paintHud` and the hit-test order in
   * `mousedown` agree that this one is on top: it is the newest decision the
   * player made, and a panel painted underneath the key that opened it looks like
   * the key did nothing.
   *
   * NULL FOR A THIRD REASON THE OTHER TWO DO NOT HAVE: a cell is the size of a
   * PNG, so `inventoryPanelRect` refuses a viewport too narrow for four columns
   * rather than degrading to three (ui/inventory.ts). Pressing `i` there appears
   * to do nothing, which is the honest outcome.
   */
  readonly inventory: PanelRect | null;
  /**
   * The escape menu, or null when it is shut or the band is too small.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * FROM `panelBand` LIKE `sheet`, `talents` AND `inventory`, AND *NOT* FROM THE
   * VIEWPORT LIKE `picker`. THAT ONE LINE IS THE WHOLE BARRIER ANSWER.
   * ═══════════════════════════════════════════════════════════════════════════
   * Clamped into the band it can never come to rest over the hotbar, the
   * resource strip or the prose lines — so every control stays visible and
   * pressable underneath it while a player reads, and the four talent keys still
   * work with the menu open. That is what makes this a PANEL: the server is
   * never told it is up, nothing parks a body, no standing order is set, and the
   * quorum counts the reader exactly as it counts everybody else. Deriving it
   * from the full viewport would be that decision reversed in one argument, and
   * the cost of the other choice is already recorded twice in this file — five
   * people waiting at a barrier on somebody who is reading a menu.
   *
   * IT IS CENTRED IN THE BAND, WHICH IS THE SHEET'S ANCHOR RATHER THAN A FOURTH.
   * There is no fourth left: the sheet centres, the talent panel pins to the top
   * and the inventory panel pins to the bottom. This panel is WIDER than all
   * three (it carries a name, two key columns and two controls on one row), so
   * no anchor could make it miss them on a short band anyway — which is why
   * ui/escapemenu.ts picks the anchor and this file does not. Where they collide
   * the paint order in `paintHud` and the hit-test order in `mousedown` agree
   * that this one is on top: it is the most recently opened surface, and a panel
   * painted underneath the key that opened it looks like the key did nothing.
   */
  readonly menu: PanelRect | null;
  /**
   * The class chooser, or null when no choice is owed.
   *
   * FROM THE FULL VIEWPORT, NOT `panelBand`, and it is the only member here that
   * is: a modal is allowed to cover the hotbar because nothing under it is
   * pressable while it is up. `classPickerRect` never answers null, so this is
   * null for exactly one reason — there is no choice to make.
   */
  readonly picker: PanelRect | null;
  /**
   * The select screen, or null when this client has a body.
   *
   * NON-NULL IS THE STRONGEST STATEMENT IN THIS TYPE: it means there is no
   * world behind the modal at all — no map, no token, nothing to move — because
   * the server sent a roster INSTEAD of the world rather than alongside it.
   */
  readonly roster: PanelRect | null;
};

/**
 * APPLY A PANEL'S DRAG OFFSET. The ONLY place one is applied, for every panel.
 *
 * ═══ IT TAKES THE *UNMOVED* RECT AND THE NULL DECISION IS MADE BEFORE IT ═══
 * `charSheetRect`, `talentPanelRect`, `inventoryPanelRect` and `escapeMenuRect`
 * each answer null when the band cannot hold them, and that refusal is computed
 * from where the panel WOULD have been — never from where it was dragged to. Two
 * things depend on that. `openMenu` and `onViewportChange` both ask
 * `hudLayout(...).menu === null` to decide whether an open menu is drawable, and
 * a panel that became undrawable because somebody dragged it would be closed out
 * from under them with a sentence about the window being too short. And the four
 * panel modules keep their own unit tests untouched, because none of them learns
 * about a drag at all.
 *
 * THE OFFSET IS APPLIED HERE RATHER THAN PUSHED DOWN INTO THE FOUR `*Rect`
 * HELPERS, which is decision D14's shape: `hudLayout` is already the single
 * producer of every rect on screen and is already rebuilt per call, so the clamp
 * runs against the CURRENT band every frame with nothing to invalidate. A drag
 * parameter threaded into four independently unit-tested surfaces would multiply
 * four suites and re-open the null-refusal question in four places.
 *
 * `moveIntoBand` clamps into `panelBand`, NOT the viewport. That is the
 * panel-not-modal promise made mechanical rather than an extra safeguard bolted
 * on: a viewport clamp would let a player park the escape menu over the hotbar
 * and make the four talent keys invisible while it was up — the promise broken by
 * a gesture rather than by a code change, which no review would catch because no
 * line of code would have changed to cause it.
 */
function movePanel(
  panel: DraggablePanel,
  rect: PanelRect | null,
  band: { readonly top: number; readonly bottom: number },
  width: number,
): PanelRect | null {
  return rect === null ? null : moveIntoBand(rect, panelOffsets[panel], band, width);
}

/**
 * WHERE A MOVABLE PANEL WOULD BE IF NOBODY HAD EVER DRAGGED IT, or null.
 *
 * ═══ ONE PRODUCER, TWO READERS, AND THAT IS THE ENTIRE REASON IT EXISTS ═══
 * `hudLayout` reads it to draw (through `movePanel`, which adds the offset and
 * clamps), and `endDrag` reads it to SETTLE — to turn the raw pointer delta a
 * gesture reached into the offset the clamp actually honoured. Those two have to
 * agree to the pixel about the unmoved rect or the settle records a position the
 * painter never drew, and the panel would jump a few pixels every time a player
 * let go of it. Written out once here so they cannot disagree, which is the same
 * rule `slotRect` established in ui/hotbar.ts and that `HudLayout` states above.
 *
 * THE VISIBILITY GATE IS PART OF THE ANSWER rather than the caller's business: a
 * panel that is shut has no rect, and `switch` over `DraggablePanel` means a
 * fifth movable panel is a compile error here rather than a panel whose offset
 * silently never settles.
 */
function unmovedPanelRect(
  panel: DraggablePanel,
  width: number,
  height: number,
  band: { readonly top: number; readonly bottom: number },
): PanelRect | null {
  const options = { width, height, top: band.top, bottom: band.bottom };
  switch (panel) {
    case DraggablePanel.Sheet:
      return sheetVisible ? charSheetRect(options) : null;
    case DraggablePanel.Talents:
      return talentsVisible ? talentPanelRect(options) : null;
    case DraggablePanel.Inventory:
      return invVisible ? inventoryPanelRect(options) : null;
    case DraggablePanel.Menu:
      // THE SCREEN GOES THROUGH HERE, not through a second call on the input
      // side: this resolver is what both the painter and the hit test read, so
      // a keys screen that grew for one and not the other is unreachable.
      return menuOpen ? escapeMenuRect({ ...options, screen: menuScreen }) : null;
  }
}

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
    // ═══ AND IT STANDS DOWN WHILE THE ESCAPE MENU IS OPEN ═══
    // Both rects are centred in the SAME band — the plate is 304x48 at
    // `top + (band-48)/3` and the panel is 360x252 at `top + (band-252)/2` — so
    // the plate always lands INSIDE the menu and never beside it. Worse, it is
    // painted after the menu AND hit-tested before it (step 3 of `mousedown`,
    // above step 3a), so a click on where CHARACTER SHEET, TALENTS or INVENTORY
    // is drawn used to fire `attemptRespawn()` instead; on the Keys screen the
    // same 48px strip hid four consecutive action rows and their controls, in
    // exactly the state — dead, everything else refused — where a player is most
    // likely to open the menu at all.
    //
    // SUPPRESSED RATHER THAN REORDERED, and nothing is lost: the plate's own key
    // (`respawn`, `f` by default) is let through by `onUi` with the menu open,
    // the notice line still says so, and this menu carries no respawn row for the
    // plate to be shadowing. The rule at `paintHud` and at `mousedown` step 4 —
    // HIT-TEST ORDER MIRRORS PAINT ORDER — is kept by removing the overlap
    // instead of adding a fifth exception to it.
    respawn:
      selfErased() && !menuOpen
        ? respawnPromptRect({ width, top: band.top, bottom: band.bottom })
        : null,
    // ═══ THE FOUR MOVABLE PANELS, EACH THROUGH `movePanel` AND THE SAME BAND ═══
    // The `*Rect` helper still decides the SHAPE and the null; `movePanel` only
    // slides the result by however far the player has dragged it and clamps that
    // back into the band. See `movePanel` for why the offset lands here and not
    // inside the four helpers, and why the null is computed before it.
    sheet: movePanel(
      DraggablePanel.Sheet,
      unmovedPanelRect(DraggablePanel.Sheet, width, height, band),
      band,
      width,
    ),
    talents: movePanel(
      DraggablePanel.Talents,
      unmovedPanelRect(DraggablePanel.Talents, width, height, band),
      band,
      width,
    ),
    // FROM THE BAND, exactly like the two above it and NOT like `picker`. See the
    // field's own note: that is the panel-not-modal decision made mechanical.
    inventory: movePanel(
      DraggablePanel.Inventory,
      unmovedPanelRect(DraggablePanel.Inventory, width, height, band),
      band,
      width,
    ),
    // FROM THE BAND, exactly like the three above it and NOT like `picker`. See
    // the field's own note: this is the panel-not-modal decision, and therefore
    // the barrier answer, made mechanical in one line.
    menu: movePanel(
      DraggablePanel.Menu,
      unmovedPanelRect(DraggablePanel.Menu, width, height, band),
      band,
      width,
    ),
    // NOT THROUGH `movePanel`, AND NEITHER ARE `pane`, `log` OR `respawn` ABOVE.
    // Each refusal has its own reason and they are recorded in full at
    // ui/drag.ts's `DraggablePanel`: the picker is a scrimmed full-viewport modal
    // whose rect is not band-derived at all, the pane and the log are two halves
    // of one `rightReserved` handshake that a free-floating panel would make
    // meaningless, and the plate is a plate — one sentence, one key, and already
    // suppressed under the menu.
    picker: classOptions === null ? null : classPickerRect(width, height),
    // THE SAME ARGUMENT AS `picker`, one step earlier in the evening: a scrimmed
    // full-viewport modal, not band-derived, and nothing under it is pressable.
    roster: roster === null ? null : rosterRect(width, height),
  };
}

/**
 * THE FOUR FRAMES THE CHARACTER SHEET IS BUILT FROM, joined in one place.
 *
 * `view` IS THE VIEWER'S OWN `inspected` ANSWER AND NOTHING ELSE. src/server/
 * view/inspect.ts splits three ways and only the self branch carries the stat
 * block and `className`; asking about a teammate comes back with exactly two rows
 * and no class, so a sheet built from anybody else's answer would be an
 * almost-empty panel with the wrong name at the top of it. The cache is read
 * rather than a separate hold, so the sheet and the hover card cannot disagree
 * about a number that is stamped with the same game turn.
 */
function charSheetView(): {
  view: InspectView | null;
  resource: ResourceView | null;
  loadout: readonly LoadoutTalent[];
  cooldowns: Readonly<Record<string, number>>;
  progress: ProgressMsg | null;
} {
  return {
    view: selfId === null ? null : (inspectCache.get(selfId)?.view ?? null),
    resource,
    loadout,
    cooldowns,
    // v9. The fifth frame: level, xp and the points in hand. It needs no join and
    // no cache — it is unicast, absolute and replaced wholesale on arrival.
    progress,
  };
}

/**
 * THE TWO FRAMES THE TALENT PANEL IS BUILT FROM.
 *
 * DELIBERATELY NOT `charSheetView()` MINUS THREE FIELDS. The sheet's view is
 * built around the `inspect` round trip and carries a cache read stamped with a
 * game turn; this panel needs neither, because both of its inputs are absolute
 * unicast frames that this file already holds. Sharing the accessor would tie a
 * panel that is always correct to one that has a "gathering…" state.
 */
function talentPanelView(): {
  loadout: readonly LoadoutTalent[];
  passives: readonly LoadoutTalent[];
  progress: ProgressMsg | null;
  unlockable: readonly UnlockableTree[];
  categories: number;
} {
  return {
    loadout,
    passives,
    progress,
    unlockable,
    /**
     * READ OFF `progress` RATHER THAN HELD SEPARATELY, because that frame is the
     * one the server re-sends whenever a purse moves — a second copy here would
     * be a number that went stale the moment a point was spent, on the one
     * screen whose job is telling a player what they can afford.
     *
     * ABSENT MEANS NONE: an older server never sends the field, and offering an
     * unlock that would be refused is worse than not offering one at all.
     */
    categories: progress?.unspentCategories ?? 0,
  };
}

function talentById(id: string | null): LoadoutTalent | null {
  if (id === null) return null;
  // BOTH LISTS. This resolves an id the PANEL armed, and the panel shows
  // passives — a lookup that missed them would arm a row and then find nothing.
  return (
    loadout.find((talent) => talent.id === id) ??
    passives.find((talent) => talent.id === id) ??
    null
  );
}

/**
 * Can this client see a reason the talent is unpayable?
 *
 * ADVISORY, and used only to grey a button. The server re-checks every budget on
 * arrival and answers `no_resource`; nothing here refuses to send.
 *
 * THE AP FRAME LANDED, AND THIS IS THE COMPARISON IT WAS WAITING FOR.
 *
 * This note used to end *"When an AP/MP frame lands, the two extra comparisons
 * go here and nothing else changes"*, and that turned out to be exactly right —
 * `ResourceView` now carries `ap`/`maxAp` and the AP half is below. It is still
 * ADVISORY: the server re-checks every budget on arrival and answers
 * `no_resource`, and nothing here refuses to send.
 *
 * MP IS STILL NOT CHECKED, deliberately. Only one talent in the game spends any
 * (Fog Step, 1), and a client that greyed a button on a budget the engine does
 * not yet gate would be lying in the other direction. It goes in beside the AP
 * line when a move costs MP — one comparison, same shape.
 *
 * `ap === undefined` MEANS "AN OLDER SERVER", not "no budget". The field is
 * optional so that no version bump was needed, which means a client can outlive
 * a server that never sends it; treating absent as zero would grey every button
 * on the bar.
 */
function affordable(talent: LoadoutTalent): boolean {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A TALENT NOBODY HAS LEARNED IS NOT AFFORDABLE AT ANY PRICE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A class used to be born knowing every talent it owned, so rank 0 was
   * unreachable and the bar could assume every button on it was a real one. A
   * class is now born with four of its eighteen — so most of what the panel
   * lists is owned, drawn, and not yet learned.
   *
   * ROUTED THROUGH `affordable` RATHER THAN A NEW SLOT FIELD, deliberately:
   * `isSlotDisabled` already greys on this, the tooltip already prints a
   * reason line for it, and the server's `canUseTalent` already answers
   * `not_learned` — so one predicate keeps the bar, the tip and the rule
   * saying the same thing. A parallel `known` flag would be a second place
   * for that agreement to break.
   */
  if (talent.level < 1) return false;
  if (resource === null) return true;
  if (resource.ap !== undefined && talent.cost.ap > resource.ap) return false;
  if (talent.cost.resource <= 0) return true;
  return resource.current >= talent.cost.resource;
}

/**
 * THE BAR: FOUR CLASS TALENTS ON KEYS 1-4, THEN FOUR MOUSE-ONLY ITEM SLOTS.
 *
 * ═══ THE ARRAY IS POSITIONAL AND `isItemSlotIndex` DEPENDS ON IT ═══
 * ui/hotbar.ts hard-codes that index 4 is the first item slot, so the item slots
 * are appended ONLY when the loadout is exactly `HOTBAR_TALENT_SLOTS` long. A
 * short loadout (which `_loadoutArityCheck` in src/server/content/classes.ts
 * makes impossible today, and which would still be a real state on a build that
 * broke it) draws the talents alone rather than sliding four item slots down into
 * indices the drop test would call talents. An EMPTY loadout draws nothing at
 * all, exactly as before the item slots existed: the bar has not arrived yet, and
 * four drop targets floating over a bar with no buttons on it would advertise a
 * feature before the frame that gives it meaning.
 *
 * ═══ AND EVERY ITEM SLOT'S CAPTION IS RECOMPUTED, NEVER REMEMBERED ═══
 * A binding stores an `itemId`, a name and an icon and nothing else;
 * `itemSlotAction` asks the last `inventory` frame whether that id is in the bag
 * (EQUIP), on the body (REMOVE) or in neither (GONE). That is
 * HotkeysIconsDisplay.lua:232-234's own rule — the bar asks the world, every
 * draw — and it is what makes an item equipped from the PANEL flip the caption on
 * the BAR one frame later with nothing wired between them.
 */
function hotbarView(): HotbarView {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BAR IS BUILT FROM THE BINDINGS AND RESOLVED AGAINST THE LOADOUT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This was `loadout.map(...)` — slot n was `loadout[n]`, full stop. Two
   * things it could not do, and both of them are the point of the change: a
   * player could not choose WHICH six, and a class could not own a seventh.
   *
   * A BINDING THAT NO LONGER RESOLVES DRAWS EMPTY, NOT STALE. An id can stop
   * being in `loadout` — a class swap, a character load, a talent this build
   * deleted — and the empty slot is the honest picture. Drawing the remembered
   * name of something the player cannot press is the same failure as an item
   * slot showing EQUIP for an item that is gone, which `itemSlotAction` already
   * refuses to do.
   */
  // THE ACTIVE PAGE'S SIX, and `slotUnder` measures the same six because it
  // reads `hotbarView().slots.length` — one number, both readers, which is the
  // rule hudwiring.test.ts pins after the item slots broke exactly this.
  const page = talentBindings.slice(
    talentPage * HOTBAR_TALENT_SLOTS,
    talentPage * HOTBAR_TALENT_SLOTS + HOTBAR_TALENT_SLOTS,
  );
  const talents: HotbarSlot[] = page.map((id) => {
    const talent = id === null ? undefined : loadout.find((entry) => entry.id === id);
    if (talent === undefined) return { kind: HotbarSlotKind.Empty };
    return {
      // v12: SPELLED OUT AT THE CONSTRUCTION SITE. `HotbarTalentSlot.kind` was
      // optional purely so this literal kept compiling while ui/hotbar.ts grew
      // two more members; now that the discriminant is written here it can stop
      // being a shim, and the `case undefined:` arms in that file are what will
      // say so.
      kind: HotbarSlotKind.Talent,
      talent,
      // Absent from `cooldowns` means READY — the server deletes the entry at
      // zero, mirroring ToME's `talents_cd[tid] = nil`.
      cooldown: cooldowns[talent.id] ?? 0,
      affordable: affordable(talent),
    };
  });

  const carried = inventory?.carried ?? [];
  const equipped = inventory?.equipped ?? {};
  const items: HotbarSlot[] = hotbarBindings.map((binding) =>
    binding === null
      ? { kind: HotbarSlotKind.Empty }
      : {
          kind: HotbarSlotKind.Item,
          itemId: binding.itemId,
          name: binding.name,
          icon: binding.icon,
          action: itemSlotAction(binding.itemId, carried, equipped),
        },
  );

  const armedId = targeting?.talent()?.id ?? null;
  return {
    slots: talents.length === HOTBAR_TALENT_SLOTS ? [...talents, ...items] : talents,
    hovered: hoveredSlot,
    /**
     * ═══════════════════════════════════════════════════════════════════════════
     * WHICH BOX IS LIT, AND THIS READ `loadout.findIndex` UNTIL JUST NOW.
     * ═══════════════════════════════════════════════════════════════════════════
     *
     * That was right for exactly as long as slot n was `loadout[n]`: the two
     * arrays were the same list, so an index into one was an index into the
     * other. The bar takes a binding now, so they are different lists — and the
     * armed ring would have been drawn on whichever box happened to sit at the
     * talent's position in the LOADOUT, which is a different button as soon as
     * anybody rearranges anything.
     *
     * A LIT BUTTON THAT IS NOT THE ONE YOU PRESSED is the worst kind of wrong:
     * it does not fail, it just quietly points at the wrong thing while an aim
     * is open. Resolved off `page` — the six being drawn — so the ring is on
     * the box the player is looking at, or nowhere at all when the armed talent
     * lives on the page they are not.
     */
    armed: armedId === null ? -1 : page.indexOf(armedId),
    // WHICH PAGE THESE SIX ARE, so the label strip can say so. A bar that
    // silently swapped its buttons would be indistinguishable from a bug.
    page: talentPage,
    // So an empty item slot takes the hover frame and reads BIND while something
    // droppable is being carried over the bar. Cosmetic only —
    // `hotbarDropTargetAt` decides what a release actually means.
    drag: liveDragSubject(),
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
 * WHAT TO CALL A KEY IN A SENTENCE THE PLAYER READS.
 *
 * ═══ EVERY MNEMONIC IN THIS FILE GOES THROUGH HERE, AND THAT IS v11's POINT ═══
 * "press g", "R — revive", "F — refile yourself": five hard-coded letters were
 * printed on the canvas and into the aria-live region, and every one of them
 * became a lie the moment the Keys screen let somebody rebind. A wrong
 * instruction is worse than none — it sends a player who is already stuck to
 * press a key that does nothing.
 *
 * IT NAMES EVERY BINDING THE ACTION ANSWERS TO, including the permanent floor,
 * because `labelFor` without a slot is the answer to "what does this respond
 * to". A player who rewrote one of the two keys still sees the other, which is
 * exactly the state that would otherwise be reported as the rebind having broken
 * the game.
 *
 * READ LIVE OFF `gameKeymap`, never off a copy: this is called from inside the
 * painter, so the sentence is rebuilt on the first frame after a `keybinds`
 * frame lands, with nothing to invalidate.
 */
function keyHint(actionId: string): string {
  return labelFor(actionId, gameKeymap.current);
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
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DRAG GHOST — 72 logical pixels, the same pitch as a cell and a slot.
 * ═══════════════════════════════════════════════════════════════════════════
 * Not a smaller thumbnail: every `item_*` icon is authored at 64x64 and every
 * frame at 72x72, and ui/inventory.ts's `blitCentred` REFUSES a sprite bigger
 * than its box rather than scaling or cropping it (a sprite that does not fit
 * the box it was cut for is a pipeline fault, and drawing a fraction of it would
 * hide that fault behind something that looks almost right). A 24px ghost would
 * therefore have silently drawn the letter fallback forever, on a machine that
 * has the art.
 */
const GHOST_PX = 72;

/**
 * WHAT THE POINTER IS CARRYING, resolved against the last `inventory` frame.
 *
 * NOT READ OFF THE DRAG. `DragSubject` carries an `itemId` or a `Slot` and
 * nothing else, on purpose (ui/drag.ts) — the verb and the identifier differ
 * between the two item kinds. The name and the icon are catalogue facts and the
 * frame is where they live, so a drag whose subject has left the bag mid-gesture
 * (dropped by a teammate's `state` resync, say) stops having a ghost rather than
 * drawing a remembered picture of something the player no longer owns.
 */
function draggedItem(): ItemBinding | null {
  const live = drag;
  if (live === null || !live.moved) return null;
  const subject = live.subject;
  switch (subject.kind) {
    // A TALENT'S GHOST IS DRAWN FROM THE LOADOUT, NOT FROM HERE. This function
    // resolves an ITEM out of the inventory frame; a talent has no entry there
    // and never will. `draggedTalent` below is its twin and reads `loadout`,
    // which is the frame a talent's name and icon actually live in.
    case DragKind.Talent:
      return null;
    case DragKind.Panel:
      // A panel drag needs no ghost: the PANEL is the ghost. `panelOffsets`
      // moves it under the pointer directly, which is the whole gesture.
      return null;
    case DragKind.Carried:
      return inventory?.carried.find((item) => item.itemId === subject.itemId) ?? null;
    case DragKind.Worn:
      return inventory?.equipped[subject.slot] ?? null;
  }
}

/**
 * Paint whatever is in the player's hand, centred on the pointer.
 *
 * THE COMMON FRAME FOR EVERY TIER, and that is deliberate rather than lazy. The
 * ghost is a CURSOR, not a statement about rarity: the cell it came from and the
 * cell it is heading for both draw the tier frame (ui/inventory.ts's exhaustive
 * `frameIdFor`), and a third copy of that switch in this file would be a second
 * authority on which frame a tier wears — the exact duplication `slotRect` and
 * `hudLayout` exist to prevent.
 *
 * `save`/`restore` around everything, because it sets `font`, `textAlign`,
 * `textBaseline` and `fillStyle` and the world painter re-sets none of them.
 */
function drawDragGhost(ctx: CanvasRenderingContext2D, spriteSource: SpriteSource): void {
  const live = drag;
  if (live === null || !live.moved || live.at === null) return;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A TALENT'S GHOST IS DRAWN THE SAME WAY, FROM A DIFFERENT FRAME.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `draggedItem` resolves out of the INVENTORY frame and a talent has no entry
   * there. Rather than a second renderer, the talent is turned into the same
   * `{ name, icon }` shape the plate below already draws — the gesture must look
   * identical on both halves of the bar, and two renderers would drift the first
   * time either was touched.
   *
   * NOT THE `itemId`: the ghost carries the talent's id in that field and
   * nothing reads it, because the ghost is a picture. `DragSubject` is what the
   * DROP consults, and it carries `talentId` for exactly this reason.
   */
  const subject = live.subject;
  const dragged =
    subject.kind === DragKind.Talent
      ? (() => {
          const talent = loadout.find((entry) => entry.id === subject.talentId);
          return talent === undefined
            ? null
            : { itemId: talent.id, name: talent.name, icon: talent.icon };
        })()
      : draggedItem();
  const item = dragged;
  if (item === null) return;

  const x = live.at.x - Math.floor(GHOST_PX / 2);
  const y = live.at.y - Math.floor(GHOST_PX / 2);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const frame = spriteSource.sprite('ui_item_frame_common');
  if (frame !== undefined && frame.w <= GHOST_PX && frame.h <= GHOST_PX) {
    ctx.drawImage(
      frame.image,
      x + Math.floor((GHOST_PX - frame.w) / 2),
      y + Math.floor((GHOST_PX - frame.h) / 2),
      frame.w,
      frame.h,
    );
  } else {
    // A BARE CLONE HAS NO ART AT ALL and must still be able to play: the plate
    // is drawn with primitives so the gesture is visible on a checkout with an
    // empty client/public/assets/. Same rule the panels keep.
    ctx.fillStyle = PALETTE.PANEL;
    ctx.fillRect(x, y, GHOST_PX, GHOST_PX);
    ctx.fillStyle = PALETTE.SLATE;
    ctx.fillRect(x, y, GHOST_PX, 1);
    ctx.fillRect(x, y + GHOST_PX - 1, GHOST_PX, 1);
    ctx.fillRect(x, y, 1, GHOST_PX);
    ctx.fillRect(x + GHOST_PX - 1, y, 1, GHOST_PX);
  }

  const icon = spriteSource.sprite(item.icon);
  if (icon !== undefined && icon.w <= GHOST_PX && icon.h <= GHOST_PX) {
    ctx.drawImage(
      icon.image,
      x + Math.floor((GHOST_PX - icon.w) / 2),
      y + Math.floor((GHOST_PX - icon.h) / 2),
      icon.w,
      icon.h,
    );
  } else {
    // THE INITIAL, exactly as the hotbar and the inventory panel fall back. An
    // unpromoted icon is a SUPPORTED state, not an error, so it draws a letter
    // rather than a missing-asset box.
    ctx.font = FONT_HUD;
    ctx.fillStyle = PALETTE.PARCHMENT;
    ctx.fillText(
      item.name.slice(0, 1).toUpperCase(),
      x + Math.floor(GHOST_PX / 2),
      y + Math.floor(GHOST_PX / 2),
    );
  }

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
  const layout = hudLayout(width, height);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *   THE SELECT SCREEN IS THE WHOLE HUD, OR IT IS NOT A SCREEN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * THIS USED TO BE THE LAST BLOCK IN THIS FUNCTION, drawn on top of everything
   * else and reasoned about as a panel: *"LAST, SO IT IS ON TOP OF EVERYTHING
   * INCLUDING THE CLASS PICKER"*. That ordering was right and the LAYER was
   * wrong. Reported with a screenshot: the character list over a lit moor with
   * the party card, the case log, the minimap and a full hotbar drawn around it.
   *
   * ═══ WHY CLEARING THE STATE WAS NOT ENOUGH ON ITS OWN ═══
   * `case 'roster'` now runs `forgetTheWorld` and empties the board, which does
   * silence the world pass (render/canvas.ts paints tiles, actors, loot, the
   * sky and the sweep only `if (level !== null)`) and the minimap with it,
   * since that reads this file's own `level`.
   *
   * IT DOES NOT SILENCE THE HUD. Every layer below is gated on its OWN
   * independent nullable — there is no screen state in this file, there are
   * nine unrelated variables — so the hotbar, the resource bar, the xp bar, the
   * turn bar and the prose lines would each have to be taught about the roster
   * separately. Twenty-two gates that must all agree is twenty-two chances for
   * the next one to be forgotten, and the failure is silent.
   *
   * ONE GATE INSTEAD. A roster means this client HAS NO BODY — every surface
   * below is a fact about a character that does not exist right now — so the
   * honest structure is that the menu replaces the HUD rather than covering it.
   * It also keeps this file's stated invariant *"HIT-TEST ORDER MIRRORS PAINT
   * ORDER"* trivially true, because the mirror is now a single gate on each side.
   */
  if (layout.roster !== null && roster !== null) {
    drawRoster({
      ctx,
      sprites,
      rect: layout.roster,
      characters: roster.characters,
      cases: roster.cases,
      canCreate: roster.canCreate,
      max: roster.max,
      selected: selectedCharacter,
      hovered: rosterHovered,
      armedDeleteId: rosterArmedDeleteId,
      nowMs: Date.now(),
    });
    return;
  }

  const view = turnView();
  // THE TOP HUD, IN TWO PIECES AND ONE MEASUREMENT. The banner is the sentence
  // and the playfield frame; the cards are the strip of faces under it, drawn
  // ONLY in combat. `turnHudHeight` is what both the dock and the combat banner
  // stack against, so nothing below can overlap the strip by carrying its own
  // copy of how tall it is.
  drawTurnBar({ ctx, view, width, height });
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

  // THE CHARACTER SHEET, WITH THE OTHER DOCK SURFACES AND BEFORE THE HOTBAR.
  //
  // It therefore loses to the hotbar, the resource strip, the prose lines, the
  // erased plate, the hover card, the combat banner and the token menu — every
  // one of which is drawn later — and that ordering IS the design. A sheet that
  // covered the hotbar would be a modal wearing a panel's clothes: the player
  // reading it could no longer see the four buttons they are reading it to
  // choose between, and every one of those buttons still works while it is open.
  //
  // `charSheetRows` IS CALLED EXACTLY ONCE PER FRAME and the result handed to the
  // drawer, which does not call it — ui/charsheet.ts asks for that split so the
  // join of four frames happens once rather than once per column pass.
  // HOISTED so the hover card below can read the SAME rows the painter drew
  // from, without breaking the once-per-frame rule above. A second
  // `charSheetRows(charSheetView())` would be a second join of four frames AND
  // a second opinion about which sections the short-panel ladder conceded — so
  // the card could describe a talent that is not on screen.
  const sheetRows = layout.sheet === null ? null : charSheetRows(charSheetView());
  if (layout.sheet !== null && sheetRows !== null) {
    drawCharSheet({
      ctx,
      sprites,
      rect: layout.sheet,
      rows: sheetRows,
      hoveredClose: sheetCloseHovered,
      hoveredTalents: sheetTalentsHovered,
      talentsOpen: talentsVisible,
      // v12 — THE COUNT ON THE CONTROL THAT ROUTES TO THE SPEND SCREEN: `[G·2]`
      // while points are waiting, plain `[G]` at zero. It is passed separately
      // from `rows` on purpose (ui/charsheet.ts says so at the field): `rows` is
      // the BODY and sheds whole sections on a short panel, and a header control
      // that went quiet on exactly the window where the sheet is hardest to read
      // would be the wrong half to drop.
      unspent: progress?.unspent ?? 0,
    });
  }

  // ═══ THE TALENT PANEL, IMMEDIATELY AFTER THE SHEET AND FOR THE SAME REASONS ═══
  //
  // AFTER the sheet because the two are the only surfaces here that are centred
  // horizontally, and where they overlap the newer decision has to be the
  // visible one — the player pressed `g` while `c` was already up, and a panel
  // painted underneath the one it was opened from would look like the key did
  // nothing. `mousedown`'s step 4 tests them in this same order, which is the
  // rule this file has enforced since the sheet learned to cover the party pane:
  // HIT-TEST ORDER MIRRORS PAINT ORDER, always.
  //
  // BEFORE the hotbar, the resource strip, the prose lines, the erased plate,
  // the hover card, the combat banner and the token menu — every one of which is
  // drawn later — and THAT ORDERING IS THE DESIGN, not an accident of where the
  // call landed. A panel that covered the hotbar would be a modal wearing a
  // panel's clothes: the player deciding which of four talents to improve could
  // no longer see the four buttons they are deciding between, and every one of
  // those buttons still works while this is open.
  //
  // `talentPanelRows` IS CALLED EXACTLY ONCE PER FRAME and the result handed to
  // the drawer, which does not call it — the same split ui/charsheet.ts asks for
  // and for the same reason.
  if (layout.talents !== null) {
    drawTalentPanel({
      ctx,
      sprites,
      rect: layout.talents,
      rows: talentPanelRows(talentPanelView()),
      hoveredClose: talentsCloseHovered,
      hovered: talentsHoveredRow,
      armedId: talentsArmedId,
      // v12 — THE SCREEN WHOSE ENTIRE SUBJECT IS LEVELLING NOW STATES THE LEVEL:
      // `TALENTS · Lv 3`. Null before the first `progress` frame, which falls
      // back to the bare word rather than printing a level nobody has said yet.
      level: progress?.level ?? null,
      // v19 — WHICH TALENT THE DESCRIPTION COLUMN IS ABOUT. See `talentFocusId`.
      focusId: talentFocusId,
      // v19 — THE ATTRIBUTE COLUMN. Composed values off `progress`, so the six
      // agree with the character sheet a key away rather than showing a class
      // base nothing else in the client reports.
      stats: progress?.stats ?? null,
      unspentStats: progress?.unspentStats ?? 0,
      armedStat: talentsArmedStat,
    });

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * AND THE HOVER CARD, ON TOP OF EVERYTHING THE PANEL DREW.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * The tree is fifteen icons and no prose; this is where the prose went, and
     * it was asked for in those words. Drawn AFTER the panel because it overlaps
     * it by design — a card that respected the panel's bounds would be clipped
     * by the thing it is explaining.
     *
     * `pointerPoint` is already in LOGICAL backbuffer pixels, which is the space
     * every rect in this file lives in; the card clamps itself to the viewport
     * rather than flipping sides, so it never moves while the pointer is still.
     */
    /**
     * ═══ ...AND ONLY ON A PANEL THAT HAS NO DESCRIPTION COLUMN ═══
     * On a wide window the pane on the right is already saying all of this, in
     * more room and without moving. A card floating over the icons repeating the
     * column beside them is the same sentence twice, and the copy that follows
     * the pointer is the one that covers the other icons.
     *
     * `talentPanelGeometry` OWNS THE ANSWER rather than a width test here: it is
     * what decides whether the column exists, and a second copy of that
     * threshold would disagree with it at exactly one window size.
     */
    const talentRows = talentPanelRows(talentPanelView());
    const hasDetailPane = talentPanelGeometry(layout.talents, talentRows).detail !== null;
    if (pointerPoint !== null && !hasDetailPane) {
      const card = talentTipAt(layout.talents, talentRows, pointerPoint.x, pointerPoint.y);
      if (card !== null) {
        drawHoverCard(ctx, sprites, card, pointerPoint.x, pointerPoint.y, width, height);
      }
    }
  }

  // ═══ THE INVENTORY PANEL, AFTER THE OTHER TWO AND FOR THEIR REASONS ═══
  //
  // AFTER the sheet and the talent panel because all three are centred
  // horizontally and, where they overlap, the newer decision has to be the
  // visible one — the player pressed `i` while `c` or `g` was already up, and a
  // panel painted underneath the one it was opened from would look like the key
  // did nothing. `mousedown`'s step 4 tests the three in the mirror of this
  // order, which is the rule this file has enforced since the sheet learned to
  // cover the party pane: HIT-TEST ORDER MIRRORS PAINT ORDER, always.
  //
  // BEFORE the hotbar, the resource strip, the prose lines, the erased plate, the
  // hover card, the combat banner and the token menu — every one of which is
  // drawn later — and THAT ORDERING IS THE DESIGN. A panel that covered the
  // hotbar would be a modal wearing a panel's clothes: the player weighing a coat
  // against the fight they are in could no longer see the four talents they are
  // weighing it against, and every one of those buttons still works while this is
  // open.
  //
  // `inventoryPanelRows` IS CALLED EXACTLY ONCE PER FRAME and the result handed
  // to the drawer, which does not call it — the same split ui/charsheet.ts and
  // ui/talents.ts both require, and it matters more here: the rows walk the
  // carried list and the whole doll, and a column pass that rebuilt them would do
  // that work per row.
  if (layout.inventory !== null) {
    drawInventoryPanel({
      ctx,
      sprites,
      rect: layout.inventory,
      rows: inventoryPanelRows(inventoryPanelView()),
      hoveredClose: invCloseHovered,
      // TWO RINGS, TWO MEANINGS. `focus` is sticky and survives the pointer
      // leaving a cell (it is what the strip and DROP are about); `hovered` is
      // transient and clears the moment the pointer moves off.
      focus: invFocus,
      hovered: invHovered,
      hoveredDrop: invDropHovered,
      // THE PURSE, off the same frame the bag came from — see `InventoryMsg.money`
      // for why they ride together. `null` is a client that has not been sent an
      // inventory yet, which draws the plain title rather than "0 GOLD".
      money: inventory?.money ?? 0,
      // THE ROOM'S SHELVES, when the room has any. The panel says the shop's
      // name and how much is on it; the tab that lets you spend is the next
      // step, and until it lands this is how a player learns a shop exists at
      // all rather than walking past it.
      shop: shop === null ? null : { name: shop.name, count: shop.stock.length },
    });
  }

  // ═══ THE ESCAPE MENU, AFTER ALL THREE AND FOR THEIR REASONS ═══
  //
  // AFTER the sheet, the talent panel and the inventory panel because all four
  // are centred horizontally and, where they overlap, the newer decision has to
  // be the visible one — the player pressed Escape while `c`, `g` or `i` was
  // already up. It overlaps them more than they overlap each other: this panel
  // is wider than all three, so no anchor could have kept it clear (see
  // `layout.menu`). `mousedown` tests the four in the mirror of this order,
  // which is the rule this file has enforced since the sheet learned to cover
  // the party pane: HIT-TEST ORDER MIRRORS PAINT ORDER, always.
  //
  // BEFORE the hotbar, the resource strip, the prose lines, the erased plate,
  // the hover card, the combat banner and the token menu — every one of which is
  // drawn later — and THAT ORDERING IS THE DESIGN, not an accident of where the
  // call landed. A menu that covered the hotbar would be a modal wearing a
  // panel's clothes, and the whole barrier answer for this surface is that it is
  // not one: the four talent keys still work while it is open, and they have to
  // still be VISIBLE for that to be true.
  //
  // `escapeMenuRows` IS CALLED EXACTLY ONCE PER FRAME and the result handed to
  // the drawer, which does not call it — the same split ui/charsheet.ts,
  // ui/talents.ts and ui/inventory.ts all require. It matters here for the
  // reason it matters for the inventory: the rows walk the whole action table
  // and format four strings per row, and the geometry pass would redo that.
  if (layout.menu !== null) {
    drawEscapeMenu({
      ctx,
      sprites,
      rect: layout.menu,
      screen: menuScreen,
      rows: escapeMenuRows(escapeMenuView()),
      hoveredClose: menuCloseHovered,
      hovered: menuHovered,
    });
  }

  drawHotbar({ ctx, sprites, view: hotbarView(), width, height });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE HOVER CARDS, LAST, OVER EVERYTHING THEY EXPLAIN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Asked for by name for the bag, the tree and the action bar. Drawn here
   * rather than inside each panel because a card that respected its panel's
   * bounds would be clipped by the thing it is describing — and because the
   * ORDER matters: the bar is at the foot of the screen and its card goes above
   * the pointer, so it lands on top of the board rather than under the bar.
   *
   * ONE CARD AT MOST. A pointer is in one place, so the first surface that
   * claims it wins, and the panels are asked in the order they are stacked.
   */
  if (pointerPoint !== null) {
    const card =
      (layout.inventory === null
        ? null
        : inventoryTipAt(
            layout.inventory,
            inventoryPanelRows(inventoryPanelView()),
            pointerPoint.x,
            pointerPoint.y,
          )) ??
      /**
       * THE PARTY PANE, AND IT IS ASKED BEFORE THE BAR FOR A REASON.
       *
       * In Portraits mode this card is not an extra — it is the ONLY place the
       * name, the hp numbers, the state word and the downed clock exist at all.
       * The pane paints three initials at 640 wide and says everything else in a
       * shade, which `ui/partypanel.ts`'s own note now records. The bar is at the
       * foot of the screen and the pane is down the left edge, so the two cannot
       * both claim a pointer anyway; the order is stated rather than left to
       * whichever rect happens to be tested first.
       */
      (layout.party === null || layout.pane === null
        ? null
        : partyPaneTipAt(layout.party, layout.pane, pointerPoint.x, pointerPoint.y)) ??
      /**
       * THE CHARACTER SHEET'S TALENT ROWS, whose description the sheet has
       * never had room to draw anywhere. Asked after the bag and the pane and
       * before the bar, which is the order the four are stacked on screen.
       */
      (layout.sheet === null || sheetRows === null
        ? null
        : charSheetTipAt(layout.sheet, sheetRows, pointerPoint.x, pointerPoint.y)) ??
      hotbarTipAt(hotbarView(), pointerPoint.x, pointerPoint.y, width, height);
    if (card !== null) {
      drawHoverCard(ctx, sprites, card, pointerPoint.x, pointerPoint.y, width, height);
    }
  }

  const resourceY = height - HOTBAR_TOTAL_H - RESOURCE_H;
  drawResource({ ctx, sprites, resource, x: 4, y: resourceY + 3, width: width - 8 });
  // ═══ v12 — `Lv 3` AND THE XP TRACK, SHARING THIS ONE 18-PIXEL STRIP ═══
  //
  // THE SAME x/y/width AS `drawResource` ABOVE, DELIBERATELY. The pips are
  // left-aligned (ui/resource.ts:70-74) and this widget right-aligns itself
  // inside the same box, so the two occupy the empty end of one strip rather
  // than costing a second row of the viewport — and neither has to know the
  // other's width.
  //
  // IT IS PERMANENT FURNITURE, WHICH IS THE WHOLE POINT. Level, xp and the
  // points in hand were drawn ONLY inside two panels the player has to open by
  // hand, so a banked point was invisible to anybody who did not already know to
  // press `g` and the entire talent tree was dead content for a party that never
  // did. This is the surface that is always on screen.
  //
  // IT DRAWS NOTHING WHILE `progress` IS NULL, and that is not an edge case: it
  // is a real window on connect, and it is exactly when the player is staring at
  // the screen. ui/xpbar.ts owns that refusal for ui/charsheet.ts:344-347's
  // reason — "a row reading Level: 0 in that window would be a wrong number
  // stated confidently".
  drawXpBar({ ctx, progress, x: 4, y: resourceY + 3, width: width - 8 });

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
    //
    // v11: THE KEY IS READ OFF THE LIVE KEYMAP. A hard-coded 'F' is a lie the
    // moment somebody rebinds, and it is the cruellest possible lie in this
    // exact state — the player it is written for is already stuck and pressing
    // keys that are all being refused.
    drawLine(
      ctx,
      `${keyHint('respawn')} — refile yourself and get back up`,
      PALETTE.GOLD,
      width,
      hintY,
    );
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
      // The live key, for the reason the respawn line above gives.
      drawLine(ctx, `${keyHint('revive')} — revive ${who}`, PALETTE.GOLD, width, hintY);
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

  // ═══ v12 — THE THING IN THE PLAYER'S HAND, UNDER THE POINTER ═══
  //
  // AFTER the hotbar and the strips, so it is visible OVER the row it is being
  // dragged to. That is the opposite of every panel above and it is the point: a
  // ghost drawn under the bar would vanish at the exact instant the player needs
  // to see which slot it is about to land in.
  //
  // ONLY FOR AN ITEM DRAG. A panel drag has no ghost because the PANEL is the
  // ghost — it follows the pointer directly through `panelOffsets`.
  drawDragGhost(ctx, sprites);

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
  // ═══ ...AND SUPPRESSED WHILE A GESTURE IS LIVE, FOR THE MENU'S OWN REASON ═══
  // The canvas `mousemove` handler short-circuits on its first line while a drag
  // is in flight, so `pointerPoint` and the hovered actor are FROZEN at whatever
  // they were when the button went down. This is painted after `drawDragGhost`,
  // so a card left over from before the press is drawn on top of the 72px item in
  // the player's hand, pinned at a position the pointer left — the thing being
  // carried vanishes under a description of a tile nobody is looking at.
  const tip = tooltipView();
  if (tip !== null && pointerPoint !== null && drag === null && tokenMenu?.visible() !== true) {
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE MAP, at whichever of its two sizes is called for.
   * ═══════════════════════════════════════════════════════════════════════════
   * Drawn HERE, above the dock surfaces and below the token menu, for the same
   * reason the combat banner is: it is an overlay a player reads, not a thing
   * they click through. The minimap sits top-right and is always on; the world
   * map is a deliberate act and takes the screen.
   *
   * The world map shows the OVERWORLD and only the overworld — from inside a
   * delve it draws the cached copy, with no "you are here" marker, because you
   * are not there. A marker showing your arena position on a region map would
   * be a confident lie.
   */
  if (worldMapOpen && overworldLevel !== null) {
    ctx.fillStyle = 'rgba(10, 8, 19, 0.92)';
    ctx.fillRect(0, 0, width, height);
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A FRAME AND A KEY, BECAUSE THIS IS A SCREEN AND NOT A PICTURE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Every other panel in this game is drawn on the 9-slice — the sheet, the
     * bag, the talents, the menu, the cards. This one was a raw rectangle on a
     * scrim with a line of text under it, which is what an unfinished screen
     * looks like next to eleven finished ones.
     *
     * THE KEY MATTERS MORE THAN THE FRAME. This map now encodes four separate
     * facts and explained none of them: the ROAD COLOUR is the safe network
     * (`isSafeGround` — nothing may lie in wait on it, a rule the server has
     * enforced since roamers existed), the DANGER WORD on each marker is the
     * grade of the room behind it, and the captions are the regions the Case Log
     * names as you cross into them. A player was left to infer all three.
     *
     * The road line is the one worth the space: it is a PROMISE, it is the only
     * safety guarantee the overworld makes, and a promise nobody can read is not
     * one anybody travels on.
     */
    const inset = 24;
    const legendH = 34;
    const onIt = realmKind === 'overworld' && selfId !== null;
    const me = onIt ? actors.get(selfId ?? '') : undefined;
    drawPanel(ctx, sprites, PanelSkin.CaseFile, {
      x: inset - 10,
      y: inset - 10,
      w: width - (inset - 10) * 2,
      h: height - (inset - 10) * 2,
    });
    paintMap({
      ctx,
      level: overworldLevel,
      regions: overworldRegions,
      rect: {
        x: inset,
        y: inset + 14,
        w: width - inset * 2,
        h: height - inset * 2 - 18 - legendH - 14,
      },
      sites: overworldSites,
      self: me === undefined ? undefined : { x: me.x, y: me.y },
      /**
       * ═════════════════════════════════════════════════════════════════════
       * AND EVERYBODY YOU ARE PLAYING WITH WHO IS ON THIS MAP.
       * ═════════════════════════════════════════════════════════════════════
       *
       * GATED ON `onIt`, exactly as `self` is, and for the identical reason:
       * this map is always the OVERWORLD's, and a body inside an instance
       * carries instance coordinates. Painting those here would put a friend's
       * delve position on the world map — wrong, and confidently so.
       *
       * READ OFF `actors` RATHER THAN `party_state`. The party frame carries who
       * you play with and their condition; it has never carried a position, and
       * it should not — `projectWorld` sends every body in the realm unfiltered,
       * so the client already holds the tile of anybody standing on this map.
       * The two are joined here: `party_state` says WHO, `actors` says WHERE.
       *
       * A MEMBER IN AN INSTANCE IS SIMPLY ABSENT, which is honest: they are not
       * on this map. The party pane already answers for them by name — *"(An
       * Index Breach)"* — and it is the surface that can, because it is the one
       * that knows about realms.
       */
      party: partyMarks(partyState?.members ?? [], actors, onIt),
      framed: false,
      // The overworld's own fog, whichever realm you are standing in — the map
      // shows what you have walked, not what you can currently reach.
      seen: explored.get(overworldRealmId ?? '') ?? new Set<string>(),
      // NAMES AND GRADES. See `MapPaint.labelled` — the minimap must not, this
      // must. It is the whole reason somebody presses M.
      labelled: true,
    });
    // ═══ THE TITLE, ON TOP, WHERE A DOCUMENT'S TITLE GOES ═══
    ctx.fillStyle = PALETTE.GOLD;
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    /**
     * THE NAME OF THE MAP THIS ACTUALLY IS, from the server, not a literal.
     *
     * `realm.name` is authored next to the map itself, so this caption cannot
     * name one place while the picture shows another — which is what the
     * hard-coded version did the moment a second overworld existed.
     */
    ctx.fillText(
      onIt
        ? (overworldName ?? 'THE REGION').toUpperCase()
        : `${(overworldName ?? 'THE REGION').toUpperCase()} — as you left it`,
      Math.floor(width / 2),
      inset - 2,
    );

    /**
     * THE KEY. Three rows, and each one is a rule the map is already obeying
     * silently. Drawn as SWATCHES rather than described in a sentence, because
     * the thing being explained is a colour.
     */
    const keyY = height - inset - legendH + 8;
    const swatch = (x: number, colour: string, label: string): number => {
      ctx.fillStyle = colour;
      ctx.fillRect(x, keyY - 4, 9, 9);
      ctx.strokeStyle = 'rgba(10, 8, 19, 0.8)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, keyY - 3.5, 8, 8);
      ctx.fillStyle = PALETTE.SILVER;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + 14, keyY + 1);
      return x + 14 + ctx.measureText(label).width + 18;
    };

    ctx.font = '10px ui-monospace, monospace';
    // Read straight off `miniFill`, so the key cannot drift from the picture.
    let kx = inset + 4;
    kx = swatch(kx, '#8a8070', 'made ground — nothing waits here');
    kx = swatch(kx, '#4e5a44', 'open country');
    kx = swatch(kx, '#141d33', 'water');
    // THE FOURTH ROW, AND IT IS NOT A TERRAIN. The other three read straight off
    // `miniFill`; this one is a MARKER colour, and it earns the space because a
    // way off the map is the only thing on this screen a player cannot work out
    // by looking at it. See `CROSSING_INK`.
    swatch(kx, CROSSING_INK, 'a way off this map');

    ctx.fillStyle = PALETTE.SILVER;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      'a marker names the room, how bad it is, and whether you closed it · M to close',
      width - inset - 4,
      keyY + 1,
    );
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  } else if (level !== null && currentRealmId !== null) {
    const me = selfId === null ? undefined : actors.get(selfId);
    // REVEAL FIRST, THEN PAINT. The cell you are standing on has to be part of
    // what you have seen by the time the same frame draws it, or the player is
    // permanently at the edge of their own fog.
    const seen =
      me === undefined
        ? new Set<string>()
        : revealAround(currentRealmId, level, { x: me.x, y: me.y });
    paintMap({
      ctx,
      level,
      rect: minimapRect(width),
      sites,
      self: me === undefined ? undefined : { x: me.x, y: me.y },
      framed: true,
      seen,
      windowRadius: MINIMAP_RADIUS,
    });
  }

  combatBanner?.draw({ ctx, width, top: hudTop });

  // ...EXCEPT THE TOKEN MENU, which is drawn after even the banner. It is the
  // only surface here the player opened deliberately and is about to click, and
  // a menu underneath a three-second announcement is a menu whose rows cannot be
  // read at the moment they are being aimed at.
  tokenMenu?.draw({ ctx, sprites });

  // ═══ ...AND THE CLASS CHOOSER AFTER EVEN THAT. IT IS LAST, AND IT IS MODAL ═══
  //
  // Above the combat banner, above the token menu, above everything. Not because
  // it is the most urgent thing on the screen but because it is the PRECONDITION
  // for the screen: a player who owes a choice has no class, no talents and no
  // business acting, so nothing painted behind it is actionable and a banner
  // announcing a fight they cannot join would be drawn over the one control that
  // gets them out of this state.
  //
  // `ctx` HERE IS THE BACKBUFFER, which is what `drawClassPicker` requires: it
  // sizes its own scrim from `ctx.canvas.width/height`, and the backbuffer's size
  // is exactly the logical viewport (render/canvas.ts) — the device-pixel canvas
  // would scrim a fraction of the screen and leave the map showing round the edge.
  if (layout.picker !== null && classOptions !== null) {
    drawClassPicker({
      ctx,
      sprites,
      rect: layout.picker,
      options: classOptions,
      selected: selectedClass,
      hovered: pickerHovered,
    });
  }
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
    sites,
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
    // WHAT IS ON THE FLOOR, grouped into one mark per TILE on the way out. The
    // renderer holds no game state and must not learn what a pile is
    // (render/canvas.ts's `LootMarker`), so the join happens here — once, in
    // `lootMarkers`, which is also what the right-click menu's row reads through
    // `lootAt`. An empty array and an absent one mean the same thing to the
    // painter, so a floor being cleared needs nothing reset here.
    loot: lootMarkers(),
    // PASSED STRAIGHT THROUGH, with no guard and no mapping. The list is already
    // exactly what the painter wants — a tile per orb — and an empty array and
    // an absent one mean the same thing to render/canvas.ts, so the sky clearing
    // itself needs nothing reset here.
    projectiles,
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
      /**
       * ═══════════════════════════════════════════════════════════════════
       * A BARE "too close" IS THE FAILURE content/classes.ts WARNS ABOUT BY
       * NAME.
       * ═══════════════════════════════════════════════════════════════════
       * With a talent pending this already says the whole lesson —
       * "too close — Sniper's Mark needs 3 tiles". Without one it used to say
       * two words, and the case where there is no talent pending is exactly
       * the case that matters most: an Inspector who WALKED INTO a husk.
       *
       * `minRange: 3` is on the Inspector's combat SHEET as well as on its
       * talents, so a basic bump-attack from inside the hole is refused —
       * deliberately, because "the Inspector cannot shoot adjacent" is the
       * class. game-design.md § 2 is quoted in classes.ts on the danger:
       * *"if the dead zone is invisible the class reads as broken."* Two
       * words, on a screen where the player just walked into a monster and
       * watched nothing happen, IS invisible. It reads as the attack being
       * bugged rather than as the one rule the class is built around.
       *
       * Driving a first session is what surfaced it: a scripted Inspector
       * bump-attacking the opening ambush stalled 3 runs in 12, doing
       * nothing, forever — which is precisely what a new player does.
       */
      return talent === null
        ? 'too close to shoot — back off a step and fire, or use a talent'
        : `too close — ${name} needs ${talent.minRange} tiles`;
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
    case ErrorCode.Refused:
      /**
       * A GAME RULE, AND THE SERVER ALREADY WROTE THE SENTENCE.
       *
       * The opposite case from every arm above: those turn a CATEGORY into
       * prose this file is better placed to write, because only this file knows
       * which talent is pending and what its range is. For a party or respawn
       * refusal the server holds the whole fact — including the numbers, as in
       * *"that party is full (6)"* — and `partyRefusalText` has already put it
       * in a sentence. Rewriting it here would be a second copy that drifts.
       */
      return fallback;
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
    //
    // `Refused` IS IN THIS GROUP AND NOT WITH `illegal_move` ABOVE: a party or
    // respawn refusal that lands mid-stride says nothing whatsoever about the
    // route, and "the way was refused" would blame the floor for a rule about
    // the party pane — the same mistake this function was written to stop
    // `rate_limited` making.
    case ErrorCode.TooClose:
    case ErrorCode.OutOfRange:
    case ErrorCode.NoLos:
    case ErrorCode.OnCooldown:
    case ErrorCode.NoResource:
    case ErrorCode.Refused:
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
      //
      // ═══════════════════════════════════════════════════════════════════════
      // TRAVEL INTERRUPT (5), MOVED HERE: A SWING AT YOU IS THE SIGNAL, LANDED
      // OR NOT.
      // ═══════════════════════════════════════════════════════════════════════
      //
      // It used to hang off the `damage` frame alone, which was sound while
      // every swing landed — the producer hard-coded `hit: true` because nothing
      // upstream of it could miss. Now `hitToWire` emits the `attack` frame
      // ALONE on a miss, so the interrupt became probabilistic: a husk swinging
      // at a Watchman (atk 19 vs def 4, ~88%) misses about one swing in eight,
      // and on those the auto-walk took another step deeper into the encounter.
      // travel.ts's own comment names the damage frame as the acknowledged last
      // line of defence — its 'newly visible hostile' arm cannot fire for a
      // monster that was already inside the radius, and arm 1 has no crossing to
      // detect when `inCombat` is already true.
      //
      // `targetId`, not `id`: `id` is the ATTACKER on this frame. Somebody
      // ELSE's swing is not your business; one aimed at you is.
      if (event.targetId === selfId) cancelTravel('you were swung at — travel stopped');
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
      //
      // KEPT ALONGSIDE the `attack` arm above rather than replaced by it: a
      // source that produces no swing at all — a trap, a projector, an
      // over-time tick — still has to stop the walk. A HEAL is the one thing on
      // this frame that must NOT (see `DamageEvent.healed`): being patched up by
      // the Alchemist is the opposite of a reason to stop walking, and reporting
      // it as "you were hit" would be a lie in the status line.
      if (event.id === selfId && (event.healed ?? 0) === 0) {
        cancelTravel('you were hit — travel stopped');
      }
      break;
    }
    case 'death': {
      // THE BODY STAYS ON THE MAP. protocol.ts is explicit: a corpse stops
      // acting and stops blocking, but absence is never the death signal —
      // deleting it here would make a kill look identical to an actor walking
      // out of view, and would delete a Downed player in M4.
      //
      // ═══ AND THE CORPSE IS STILL NOT IMMORTAL — `left` IS WHAT REMOVES IT ═══
      // A dead MONSTER really does leave the map, one frame later: the server
      // reaps it after the Case Log has narrated the kill and before the next
      // resync, and broadcasts `{t:'left'}` for it (see the reap window in
      // src/server/net/gateway.ts). That case is a few hundred lines below and
      // is one line — `actors.delete`.
      //
      // The two frames are not redundant and neither can do the other's job.
      // `death` is what HAPPENED, and it is what flips the flag on a body that
      // has to stay: a downed or erased PLAYER is never reaped, because
      // engine/downed.ts depends on the body being there for an ally to walk to.
      // `left` is presence-removal STATED — which is the exact exception the
      // paragraph above allows, since it forbids inferring death from absence,
      // not an explicit frame that says the body is gone.
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
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * TWO GROUPS. THE WORLD, THEN THE SESSION.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `parts` is what is happening in the game — where you are, what the rules
     * are right now, who you are, what you have to spend. `session` is what is
     * happening to the CONNECTION: whether the socket is up, how many bodies
     * the client is tracking, who else is in the Activity, the zoom. That
     * second group is diagnostic. It mattered enough to keep and never enough
     * to read first, and it used to open the bar.
     */
    const parts: string[] = [];
    const session: string[] = [connection];
    // WHERE YOU ARE, FIRST AFTER THE PHASE, and only once the server has said.
    // This is the aria-live region, so it is the ONLY way a player using a
    // screen reader learns they have changed place at all — the canvas can show
    // a new map, but a map is not something the live region can announce.
    //
    // Null until a `realm` frame arrives. Nothing is pushed in that case rather
    // than guessing 'Alderbrook': `welcome` carries no realm, and a confidently
    // wrong location is worse than an absent one.
    if (realmName !== null) {
      // A town or the city is stated as safe, because that is the RULE and not
      // just the scenery: no hostiles means nothing ever makes you wait, and a
      // player needs to know that changed without waiting to be attacked.
      parts.push(realmKind === 'inner' ? realmName : `${realmName} — safe`);
    }
    // THE CRIMSON FRAME'S ACCESSIBLE TWIN, and it is a persistent state rather
    // than an event on purpose. `#log` is the aria-live region, and it is
    // announced only when the whole string changes — so this line says itself
    // once, at the crossing, and then stays true for anyone who asks again.
    // The canvas has the banner and the border; this is the heard copy, and it
    // names the RULE CHANGE rather than just the fact, because "combat" does
    // not tell a new player that their next step now costs a turn.
    /**
     * THE RULE IN FORCE — and it used to be said twice.
     *
     * `turnPhase()` already answers "free movement" out of combat, and this
     * line then pushed "clear — free movement" beside it, so the bar read
     * "…free movement · The Alderbrook Moor — safe · clear — free movement · …".
     * Reported from play, and it is exactly the kind of thing that only shows
     * up in a screenshot.
     *
     * IN COMBAT THEY ARE NOT THE SAME and both are kept: `turnPhase()` says
     * whose turn it is ("YOUR TURN", "waiting on 2"), which changes every few
     * seconds; this says the RULE CHANGE, which is the thing a new player needs
     * spelled out — "combat" does not tell anybody that their next step now
     * costs a turn.
     */
    if (turn !== null) {
      parts.push(turn.inCombat ? 'CONTACT — turn by turn' : 'clear — free movement');
      if (turn.inCombat) parts.push(turnPhase());
    } else {
      parts.push(turnPhase());
    }
    if (me !== undefined) parts.push(`${me.name} @ ${me.x},${me.y}`);
    session.push(`${actors.size} actor(s)`);
    session.push(`${renderer.metrics().scale}x`);
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
      //
      // v11: CALLED rather than read off the frozen `RESPAWN_PROMPT_SPEECH`
      // constant. That constant is the SHIPPED-DEFAULT spelling by construction
      // — a string cannot follow a rebind — so leaving it here would have made
      // the heard copy the one surface that still named the old key.
      parts.push(respawnPromptSpeech());
    } else {
      const reachable = adjacentDowned();
      const firstDown = reachable[0];
      if (firstDown !== undefined) {
        // The live key, exactly as the canvas prompt draws it — the seen and the
        // heard copy must not disagree about which key rescues somebody.
        const key = keyHint('revive');
        parts.push(
          reachable.length === 1
            ? `${key}: revive ${firstDown.name}`
            : `${key}: revive (${reachable.length} down)`,
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
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * POINTS IN HAND — THE ONE ALWAYS-VISIBLE PLACE THEY APPEAR.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * Level, xp and unspent points were drawn ONLY inside two panels the player
     * has to open by hand: the character sheet behind `c` and the talent tree
     * behind `g`. Nothing on the permanent furniture carried any of the three,
     * so a banked point was invisible to anybody who did not already know to go
     * looking for it — and the whole talent tree is dead content for a party
     * that never presses `g`.
     *
     * PERSISTENT, NOT AN EVENT, and that is the difference between this and the
     * notice `case 'progress'` shows. The notice fires once at the crossing and
     * clears itself after NOTICE_MS; a player who was reading the map at that
     * moment has missed it forever. This line stays true for as long as the
     * point is unspent, and it disappears the moment it is spent because
     * `progress` is re-sent after every successful spend.
     *
     * IT IS ALSO THE HEARD COPY. `#log` is the aria-live region, so a screen
     * reader announces "2 talent points — press g" once, at the change, exactly
     * as it does for the revive affordance three blocks up. A canvas-only badge
     * would have been silent for the players it matters most to.
     */
    if (progress !== null && progress.unspent > 0) {
      // v11: `press g` was written out three times in this file and every one of
      // them went through `keyHint` — the talent panel's key is rebindable, and
      // this is the line that teaches a player the panel exists at all.
      parts.push(
        `${progress.unspent} talent ${progress.unspent === 1 ? 'point' : 'points'} — press ${keyHint('show_talents')}`,
      );
    }
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * SOMETHING IN THE BAG FOR A SLOT THAT IS BARE — AND THE KEY THAT OPENS IT.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * The block above says a banked talent point *"was invisible to anybody who
     * did not already know to go looking for it"*, and that the tree is *"dead
     * content for a party that never presses `g`"*. Both sentences are true of
     * the bag and they bite sooner: the first thing that drops in a first
     * session is the first gear that player has ever owned.
     *
     * MEASURED across the client: `show_talents` is named to the player twice,
     * `revive` and `respawn` once each — and `show_inventory` is named
     * NOWHERE. `pickup` already nudges (*"Nothing on your back yet."*, unicast,
     * in the Margin) and that nudge is deliberately an observation rather than a
     * tutorial — but it is the only one of the four whose key the player is
     * never told, so it is the one that can be followed and not acted on.
     *
     * PERSISTENT, LIKE THE POINTS AND UNLIKE THE NOTICE. The Margin line fires
     * once, at the pickup, and a player who was reading the map has missed it;
     * this stays true while the coat is in the bag and the slot is bare, and
     * disappears the moment either changes because `inventory` is re-sent after
     * every loot verb.
     *
     * IT IS ALSO THE HEARD COPY, for the same reason: `#log` is the aria-live
     * region, so this is announced rather than only drawn.
     *
     * ONE LINE HOWEVER MANY ITEMS. The count is not the decision — opening the
     * bag is — and "3 things to put on" would be a number nobody acts on
     * differently from 1.
     */
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * SOMETHING AT YOUR FEET — THE CORE REWARD LOOP, AND ITS KEY WAS UNNAMED.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * Third instance of the measurement this file records, and the worst of the
     * three, because it is the loop a roguelike runs on: you win a fight, the
     * Record lane says *"2 things are still on the floor."*, you walk onto the
     * pile — and nothing anywhere tells you which key lifts it.
     *
     * MEASURED: the pickup key was named ZERO times anywhere in the client. The
     * had exactly one affordance, `lootAt` feeding the right-click menu
     * (ui/verbs.ts), which only helps a player who already thinks to right-click
     * the tile they are standing on. This file's own note says "press g" was one
     * of five hard-coded letters routed through `keyHint` when the Keys screen
     * made rebinding possible — and that one did not come back.
     *
     * UNDERFOOT, NOT NEARBY, so it is the same actionable shape as the two lines
     * below: it appears when there is something to lift and goes quiet the
     * moment it is lifted, rather than standing on the surface as furniture.
     */
    const standing = selfTile();
    if (standing !== null && lootAt(standing) === TileLoot.Underfoot) {
      parts.push(`something at your feet — press ${keyHint('pickup')}`);
    }
    if (inventory !== null && hasSomethingToWear(inventory.carried, inventory.equipped)) {
      parts.push(`something to put on — press ${keyHint('show_inventory')}`);
    }
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * AND THE SHELF, WHICH IS BEHIND THE SAME KEY AND WAS NAMED NOWHERE.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * The block above fixed the bag after measuring that `show_inventory` was
     * named to the player NOWHERE. The shop lives in a TAB of that same panel
     * and was left in exactly the state the bag had been in: you walk into
     * Threadneedle Row, the game says *"somebody behind every counter who will
     * take your gold"*, and nothing ever tells you which key opens the counter.
     *
     * AFFORDABILITY RATHER THAN PRESENCE — see `hasSomethingToBuy`. "You are in
     * a shop" stays true for as long as you stand in the town, and a line that
     * is always there becomes furniture. This one answers a question the player
     * can act on and then goes quiet.
     */
    if (shop !== null && inventory !== null && hasSomethingToBuy(shop.stock, inventory.money)) {
      parts.push(`something you can afford — press ${keyHint('show_inventory')}`);
    }
    /**
     * AND WHAT THE PLACE BESIDE YOU IS — see `doorwayAt` for why the board is
     * where this belongs and why every existing answer is somewhere else.
     */
    const door = doorwayAt(sites, standing);
    if (door !== undefined) parts.push(doorwayLine(door));
    const invite = liveInvites()[0];
    if (invite !== undefined) {
      parts.push(`${invite.fromName} invites you to a party`);
    }
    if (participants.length > 0) session.push(`${participants.length} in the activity`);
    if (notice !== null) parts.push(notice);
    // The sign-in failure OUTLIVES every other line here on purpose: it is the
    // one condition that does not fix itself, and a player who missed the
    // notice needs to still be able to read why nobody knows their name.
    if (authError !== null) parts.push(`sign-in failed: ${authError}`);
    if (lastError !== null) parts.push(`! ${lastError}`);

    // THE MEMO SPANS BOTH GROUPS. `lastStatus` suppresses a repeat announcement,
    // and a key built from only the left half would go silent on a reconnect —
    // the one change in the right-hand group that a player most needs told.
    const next = [...parts, ...session].join('  ·  ');
    if (next === lastStatus) return;
    lastStatus = next;
    setStatusParts(parts, session);
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
  // THE SAME FUNCTION UNDER A NAME THAT DOES NOT ACCUSE THE PLAYER. See
  // `onGoodNews` — one mechanism, two call-site vocabularies.
  onGoodNews = showNotice;

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
   * ASK THE SERVER ABOUT YOURSELF, FOR THE SHEET.
   *
   * Fired twice: when `c` opens the panel, and from the game-turn edge that
   * clears the cache. Both go through here so there is one copy of the two rules
   * below.
   *
   * IT ASKS ABOUT `selfId` AND NEVER ABOUT ANYBODY ELSE. inspect.ts answers a
   * teammate with two rows and no class name, so a sheet built from that would be
   * an almost-empty panel with somebody else's name on it.
   *
   * A CACHE HIT FOR THIS TURN SENDS NOTHING, the same rule `requestInspect`
   * follows and for the same reason — the hover card may already have asked about
   * this body, and opening a panel is not a reason to spend a token re-asking a
   * question that has a fresh answer sitting in the map.
   *
   * IT DELIBERATELY DOES NOT CLAIM `inspectInFlight`. That slot belongs to the
   * pointer, and a panel taking it would make the next hover think its own
   * question was already out. The answer lands in `inspectCache` either way —
   * `case 'inspected'` caches unconditionally — which is the only thing the sheet
   * reads.
   */
  function requestSelfSheet(): void {
    const id = selfId;
    if (!sheetVisible || id === null) return;
    const known = inspectCache.get(id);
    if (known !== undefined && known.gameTurn === (turn?.gameTurn ?? -1)) {
      requestDraw();
      return;
    }
    socket.send({ v: PROTOCOL_VERSION, t: 'inspect', targetId: id });
  }
  refreshSelfSheet = requestSelfSheet;

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
    // ═══════════════════════════════════════════════════════════════════════
    // AND THE MENU'S OWN REFUSAL IS RE-APPLIED, BECAUSE THIS IS THE OTHER
    // MOMENT ITS RECT CAN DISAPPEAR.
    // ═══════════════════════════════════════════════════════════════════════
    // `openMenu` refuses to open a menu the band cannot hold, and says why at
    // length: this surface ROUTES THE ARROWS AND ENTER while it is open, so an
    // open-but-undrawable one is an invisible thing swallowing the movement
    // keys. Nothing re-asked that question after the window MOVED. `hudLayout`
    // simply answers `menu: null` on a band that has become too short, so the
    // panel stopped being painted and stopped being hit-tested while every
    // keyboard gate kept firing — arrows walking an invisible list, and one
    // Enter away from LEAVE PARTY at the bottom of it, with nothing on screen.
    //
    // THE SAME SENTENCE `openMenu` USES, for the same reason it uses one:
    // "nothing happened" is indistinguishable from a dropped input, and here the
    // player did not even press a key — they dragged a window edge.
    if (menuOpen) {
      const { logicalW, logicalH } = renderer.metrics();
      if (hudLayout(logicalW, logicalH).menu === null) {
        closeMenu();
        showNotice('no room for the menu — make the window taller');
      }
    }
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
    /**
     * READ FRESH ON EVERY `hello`, INCLUDING EVERY RECONNECT. That is why it is
     * a callback: the answer is null at the select screen, "make me a new one"
     * for exactly one handshake, and a concrete id from the moment `welcome`
     * says which id that was. A value captured here at construction would still
     * be asking for a new character an hour later.
     */
    characterChoice: () => {
      if (chosenCharacterId !== null) return { characterId: chosenCharacterId };
      if (wantsNewCharacter) return { newCharacter: true };
      return null;
    },
    onStatus: (status, detail) => {
      connection = status === SocketStatus.Open ? 'connected' : `${status}: ${detail}`;
      if (status === SocketStatus.Open) lastError = null;
      updateStatus();
    },
    onMessage: (msg) => {
      applyServerMessage(msg);
      // THE ECHO, APPLIED. `case 'settings'` records what the server holds and
      // this puts it on the board — including the first one, at `hello`, which
      // is how a returning player gets the tile size they chose last time.
      // Cleared as it is consumed so a later frame about something else does not
      // re-apply a stale preference over a zoom the player has since changed.
      if (storedZoom !== null) {
        renderer.setZoom(storedZoom);
        storedZoom = null;
      }
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SHOW PAGE 2 WHILE SHIFT IS DOWN, BEFORE ANY DIGIT IS PRESSED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Without this the second page is a page you can only see by committing to a
   * press, which is a page nobody uses: the player has to remember what is on
   * it, and the whole reason to have one is that six is not enough to remember.
   *
   * IT REDRAWS ONLY ON A CHANGE. `keydown` repeats while a modifier is held —
   * dozens of events a second — and this client is a dirty-flag renderer, so an
   * unconditional `requestDraw` here would turn holding Shift into a 60fps
   * loop. The same rule every hover in this file follows.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SEND THE ARRANGEMENT. Called by every path that changes one, and no other.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A bar a player arranged and lost on refresh is a feature that reads as
   * broken, and `localStorage` is not the answer: this game runs inside a
   * Discord Activity iframe, where storage is partitioned or blocked outright.
   * That is the stated ground for keybinds being server-side and it applies
   * here unchanged.
   *
   * ═══ THE WHOLE ARRAY, EVERY TIME ═══
   * Not a delta. The frame's contract is that the server holds what the player
   * arranged, absolutely — a per-slot message would need an ordering guarantee
   * between two writes that a socket does not give, and the array is twelve
   * short strings.
   *
   * ═══ FIRE AND FORGET, AND THE ECHO IS NOT APPLIED OPTIMISTICALLY ═══
   * The bar is already showing the change — the local store was written before
   * this was called — so the echo that comes back is a confirmation rather than
   * a correction. `case 'hotbar'` deliberately does NOT re-apply an echo that
   * matches, because doing so on every drag would be a round trip in the middle
   * of a gesture.
   */
  function sendHotbar(): void {
    if (!socket.send({ v: PROTOCOL_VERSION, t: 'set_hotbar', slots: [...talentBindings] })) {
      // SAID OUT LOUD, the rule every send in this file keeps. An arrangement
      // that vanished into a closed socket looks exactly like one that was
      // saved, and the player finds out on their next session.
      showNotice('not connected — that change to your bar was not saved');
    }
  }

  function setTalentPage(page: number): void {
    if (talentPage === page) return;
    talentPage = page;
    requestDraw();
  }

  function activateSlot(index: number): void {
    // ═══════════════════════════════════════════════════════════════════════
    // v12 — SLOTS 4-7 ARE ITEMS, AND THE VERB IS EQUIP/UNEQUIP, NOT USE.
    // ═══════════════════════════════════════════════════════════════════════
    // A DEVIATION FROM PlayerHotkeys.lua:173-181, which routes an object hotkey
    // to `playerUseItem`. There is no `use` intent on this wire and there must
    // not be one yet: `Wielder` is `{ stats?, mods? }` only
    // (src/server/content/items.ts:231-234), all 22 authored items are passive,
    // and a verb shipped with nothing to invoke is the dead control this whole
    // pass was told to avoid. Upstream agrees a wearable on a hotkey is not a
    // use — Object.lua:169-173's `canUseObject` answers "This object has no
    // usable power." Equip/remove is a real act with a visible effect on the
    // paper doll and the character sheet.
    //
    // THE INDEX DECIDES, NOT THE CONTENTS. `isItemSlotIndex` is ui/hotbar.ts's
    // own answer, so this file cannot drift about where the talents stop.
    if (isItemSlotIndex(index)) {
      pressItemSlot(index);
      return;
    }

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

  // --- the four item slots on the bar ---------------------------------------

  /**
   * Press one of the four mouse-only slots. Three outcomes and none is silence.
   *
   * THE ACTION IS ASKED FOR AGAIN HERE rather than read off the drawn view,
   * because between the paint and the click a frame can land — a teammate's
   * `state` resync, this player's own `equip` from the panel — and pressing what
   * the LAST frame said would send `equip` for something already worn. The server
   * would refuse it correctly and the player would read a sentence about an item
   * they can see on their own doll.
   *
   * GONE CLEARS THE BINDING AND SAYS SO, which is upstream's own dangling case:
   * PlayerHotkeys.lua:176-177 prints "You do not have any <name>." rather than
   * leaving a button that does nothing. It is why `ItemBinding` caches the NAME —
   * an id in neither collection has no frame left to read one off.
   */
  function pressItemSlot(index: number): void {
    const binding = hotbarBindings[index - HOTBAR_TALENT_SLOTS] ?? null;
    if (binding === null) {
      showNotice(`slot ${String(index + 1)} is empty — drag an item onto it`);
      return;
    }
    clearNotice();
    const carried = inventory?.carried ?? [];
    const equipped = inventory?.equipped ?? {};
    switch (itemSlotAction(binding.itemId, carried, equipped)) {
      case ItemSlotAction.Equip:
        sendEquip(binding.itemId);
        return;
      case ItemSlotAction.Unequip: {
        // `unequip` NAMES A SLOT, NOT AN ITEM (protocol.ts:1938-1942), so the
        // binding's id has to be resolved back to the doll cell wearing it.
        // `wornSlotOf` is ui/hotbar.ts's own walk of `SLOT_ORDER`, shared with
        // the caption, so the button and the frame cannot disagree.
        const slot = wornSlotOf(binding.itemId, equipped);
        if (slot === null) {
          // Unreachable while the two collections are the ones `itemSlotAction`
          // just read — and answered rather than thrown, because a desync here
          // would otherwise be a dead button with no sentence.
          showNotice(`${binding.name} is not on you any more`);
          return;
        }
        sendUnequip(slot);
        return;
      }
      case ItemSlotAction.Gone:
        hotbarBindings[index - HOTBAR_TALENT_SLOTS] = null;
        showNotice(`you no longer have ${binding.name}`);
        requestDraw();
        return;
    }
  }

  /**
   * Put something on an item slot. The ONE place a binding is written.
   *
   * IT TAKES A `DragSubject` AND RESOLVES IT AGAINST THE FRAME, because the two
   * item drags name their subject differently on purpose (ui/drag.ts): a bag item
   * by `itemId`, a worn item by the `Slot` it came off. Both end up as the same
   * binding — what is bound is the ITEM, and whether it is currently on the body
   * is recomputed every frame by `itemSlotAction`.
   *
   * A SUBJECT THAT NO LONGER RESOLVES IS REFUSED IN WORDS. The gesture takes a
   * human moment and a `state` resync can land inside it.
   */
  /**
   * Put a talent on one of the six keyed slots.
   *
   * ═══ IT SWAPS RATHER THAN OVERWRITING ═══
   * If the talent is already on another slot, the two slots trade. Overwriting
   * would silently REMOVE it from wherever it was, so dragging Crude Blow from
   * key 1 to key 3 would leave key 1 empty and the player would have to go and
   * find it again — and every player who has ever arranged a bar in another
   * game expects the trade. It is four lines and it is the difference between a
   * feature and a chore.
   */
  /**
   * A SLOT ON THE BAR YOU CAN SEE -> ITS CELL IN THE TWELVE-LONG STORE.
   *
   * Every caller below takes an index from the POINTER or from a KEY, and both
   * of those name a box on the visible bar. The store is both pages end to end,
   * so every one of them has to be offset by the page — and doing it in one
   * named function rather than at five call sites is the difference between a
   * page feature and a bug where the mouse edits page 1 while the keyboard
   * presses page 2.
   */
  function cellOfSlot(index: number): number {
    return talentPage * HOTBAR_TALENT_SLOTS + index;
  }

  function bindTalentSlot(index: number, talentId: string): void {
    const talent = loadout.find((entry) => entry.id === talentId);
    if (talent === undefined) {
      showNotice('you do not have that talent any more');
      return;
    }
    const cell = cellOfSlot(index);
    // `indexOf` SEARCHES BOTH PAGES, deliberately. A talent already on page 2
    // that is dragged onto page 1 must MOVE rather than appear twice — a bar
    // where the same button exists in two places is a bar the player has to
    // check before pressing.
    const from = talentBindings.indexOf(talentId);
    const displaced = talentBindings[cell] ?? null;
    talentBindings[cell] = talentId;
    // THE TRADE. Only when it came from another slot — a talent dragged in from
    // the panel displaces whatever was there, which is what the player just
    // asked for.
    if (from >= 0 && from !== cell) talentBindings[from] = displaced;
    sendHotbar();
    showNotice(
      hotbarPersists
        ? `slot ${String(index + 1)}: ${talent.name}`
        : `slot ${String(index + 1)}: ${talent.name} — this bar will not be remembered`,
    );
    requestDraw();
  }

  function bindItemSlot(index: number, subject: DragSubject): void {
    const item =
      subject.kind === DragKind.Carried
        ? (inventory?.carried.find((entry) => entry.itemId === subject.itemId) ?? null)
        : subject.kind === DragKind.Worn
          ? (inventory?.equipped[subject.slot] ?? null)
          : null;
    if (item === null) {
      showNotice('that is not in your hands any more');
      return;
    }
    hotbarBindings[index - HOTBAR_TALENT_SLOTS] = {
      itemId: item.itemId,
      name: item.name,
      icon: item.icon,
    };
    // NOTHING IS SENT. A binding is a fact about this browser and this session —
    // see `hotbarBindings`. The server has no field for it and is not being asked
    // to grow one for a cosmetic shortcut.
    showNotice(`slot ${String(index + 1)}: ${item.name}`);
    requestDraw();
  }

  /**
   * Take something off an item slot. Right-click, and nothing else does it.
   *
   * Silent when the slot was already empty: a right-click on a slot with nothing
   * in it is not a mistake worth a sentence, and printing one would put a line in
   * front of a player every time they missed the slot they meant.
   */
  function unbindItemSlot(index: number): void {
    const at = index - HOTBAR_TALENT_SLOTS;
    const binding = hotbarBindings[at] ?? null;
    if (binding === null) return;
    hotbarBindings[at] = null;
    showNotice(`slot ${String(index + 1)} cleared`);
    requestDraw();
  }

  /**
   * Take a talent off one of the six keyed slots. Right-click, like an item.
   *
   * THE SAME GESTURE ON BOTH HALVES OF THE BAR, deliberately. A player who has
   * learned that right-click clears slot 8 will try it on slot 2, and a bar
   * where the same press means "clear" on four buttons and nothing on six is a
   * bar with two rules in it.
   *
   * AN EMPTY SLOT IS NOT AN ERROR and says nothing — the early return. A notice
   * reading "slot 2 cleared" over a slot that was already empty is noise that
   * makes the real one harder to trust.
   */
  function unbindTalentSlot(index: number): void {
    const cell = cellOfSlot(index);
    if (talentBindings[cell] === null || talentBindings[cell] === undefined) return;
    talentBindings[cell] = null;
    sendHotbar();
    showNotice(`slot ${String(index + 1)} cleared`);
    requestDraw();
  }

  // --- the talent panel ----------------------------------------------------

  /**
   * Open or put away the talent panel.
   *
   * THE ARM GOES WITH IT, always. `talentsArmedId` only means anything while the
   * sentence explaining it is on screen — "press + again to spend, there is no
   * refund" is drawn by the panel — so an arm that survived a close would be one
   * press away from spending a point on a screen the player is not looking at.
   *
   * IT SENDS NOTHING. There is no "the panel is open" frame and there must not
   * be one: the server is never told, which is the whole difference between this
   * and the class chooser (ui/talents.ts's header, decision (g)).
   */
  function toggleTalentPanel(open?: boolean): void {
    talentsVisible = open ?? !talentsVisible;
    if (!talentsVisible) {
      talentsCloseHovered = false;
      talentsHoveredRow = null;
      // THE DESCRIPTION COLUMN FORGETS ON CLOSE, and only on close. It keeps the
      // last talent while the panel is open precisely so it does not empty under
      // a pointer that has stopped moving in order to READ it.
      talentFocusId = null;
    }
    talentsArmedId = null;
    talentsArmedStat = null;
    requestDraw();
  }

  /**
   * A press on a row's `+`. The ONLY place a `spend_point` frame is constructed.
   *
   * ═══ THE FIRST PRESS ARMS, THE SECOND SPENDS. THIS IS A DEVIATION ═══
   * ui/talents.ts's header labels it as one and says why ToME's own approach —
   * spend live against a cloned actor, commit at the Escape prompt
   * (LevelupDialog.lua:38-53, :121-147, :161-164) — has no cheap server-side
   * analogue here. The rule itself is `pressSpend`, which is pure and tested; all
   * this function does is hold the variable and put the frame on the wire.
   *
   * ═══ IT DOES NOT CLOSE THE PANEL AND IT DOES NOT PATCH ANYTHING LOCALLY ═══
   * The same rule `confirmClass` follows for the same reason. The server is
   * authoritative and may refuse (`bad_message` for a capped talent or an empty
   * hand, `not_your_turn` for a downed or erased body — and in that second case
   * the POINT SURVIVES, so it is "not now" rather than "never"). The
   * acknowledgement is the arrival of a fresh `loadout` and a fresh `progress`,
   * which are the frames that could only exist because the spend landed.
   *
   * `{ v, t, talentId }` AND NOTHING ELSE. `SpendPointSchema` is a `strictObject`
   * — an actorId smuggled alongside is REJECTED rather than stripped, which
   * matters more here than almost anywhere, because a sanitised frame would
   * permanently spend a stranger's point.
   */
  /**
   * PRESS AN ATTRIBUTE'S `+`. Arm, then confirm.
   *
   * `pressSpend` VERBATIM, the same machine the grid uses — it is keyed on a
   * string id and does not care whether that id names a talent or a stat, so the
   * "there is no refund, press again" rule has ONE implementation. A second copy
   * would be a second chance to get the confirm step wrong on the currency that
   * has no way back.
   *
   * THE TWO ARMINGS ARE SEPARATE VARIABLES on purpose. One would mean arming a
   * talent and then pressing an attribute confirms the attribute — a point spent
   * on something the player never armed.
   */
  function pressStatPlus(stat: string): void {
    const next = pressSpend(talentsArmedStat, stat);
    talentsArmedStat = next.armed;
    if (next.spend === null) {
      requestDraw();
      return;
    }
    if (
      !socket.send({
        v: PROTOCOL_VERSION,
        t: 'spend_stat',
        stat: next.spend as 'str' | 'dex' | 'con' | 'mag' | 'wil' | 'cun',
      })
    ) {
      showNotice('not connected — that did not go out');
    }
    requestDraw();
  }

  function pressTalentPlus(talentId: string): void {
    const next = pressSpend(talentsArmedId, talentId);
    talentsArmedId = next.armed;
    if (next.spend === null) {
      requestDraw();
      return;
    }

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A PRESS INSIDE A LOCKED DISCIPLINE BUYS THE DISCIPLINE, NOT THE TALENT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The panel draws a locked tree as an ordinary strip of icons so a player
     * can read what they would be buying, and the icons are pressable for the
     * same reason. What a press MEANS is different: a category point on the
     * whole tree rather than a talent point on the one icon.
     *
     * THE TWO-PRESS ARM IS SHARED AND THAT IS DELIBERATE. `pressSpend` owns
     * "press once to arm, again to commit" and there is no refund for either
     * currency — so the scarcer one gets the same confirmation the commoner one
     * does, through the same code, rather than a second rule to keep in step.
     *
     * THE CELL CARRIES THE TREE ID, so this cannot get the wrong one: it is
     * read off the row that was pressed rather than inferred from the talent,
     * which would need the client to hold a copy of the tree table.
     */
    const cell = talentCellById(next.spend);
    const tree = cell?.unlocks ?? null;
    // SENT FROM THE BRANCH RATHER THAN THROUGH A SHARED VARIABLE: the two
    // frames are different members of a closed union, and widening them into
    // one object loses the literal `v` the protocol pins.
    const sent =
      tree === null
        ? socket.send({ v: PROTOCOL_VERSION, t: 'spend_point', talentId: next.spend })
        : socket.send({ v: PROTOCOL_VERSION, t: 'unlock_tree', treeId: tree });
    if (!sent) {
      showNotice('not connected — that did not go out');
    }
    requestDraw();
  }

  /**
   * The panel cell for a talent id, or null.
   *
   * WALKS THE ROWS THE PANEL IS ACTUALLY DRAWING rather than the frames behind
   * them, because `TalentCell.unlocks` is a fact the ROW BUILDER decides — a
   * talent id alone cannot say whether it arrived in an owned tree or a locked
   * one, and asking the wire again would be a second answer to that.
   */
  function talentCellById(talentId: string): TalentCell | null {
    for (const row of talentPanelRows(talentPanelView())) {
      if (row.kind !== TalentRowKind.Category) continue;
      const found = row.talents.find((cell) => cell.id === talentId);
      if (found !== undefined) return found;
    }
    return null;
  }

  // --- the inventory panel --------------------------------------------------

  /**
   * Open or put away the inventory panel.
   *
   * IT SENDS NOTHING, AND NOT BECAUSE THERE IS NOTHING TO SEND. There is no "the
   * panel is open" frame and there must not be one: the server is never told,
   * which is the whole difference between this and the class chooser (decision
   * (g), ui/inventory.ts's header). It also asks for nothing on the way open —
   * unlike the character sheet, whose fourth input is an `inspect` round trip.
   * The `inventory` frame is absolute, unicast and re-sent by the server whenever
   * either id list moves, so the panel is correct the instant it appears.
   *
   * THE THREE HOVER FLAGS AND THE FOCUS GO WITH IT. Otherwise the × comes back
   * highlighted next time the panel opens under a pointer that has since moved,
   * and the comparison strip reopens describing an item the player stopped
   * looking at some minutes ago. THE TAB DOES NOT: which half you were reading is
   * a preference, and re-selecting it on every open would be the panel forgetting
   * something the player told it.
   */
  function toggleInventoryPanel(open?: boolean): void {
    invVisible = open ?? !invVisible;
    if (!invVisible) {
      invCloseHovered = false;
      invHovered = null;
      invDropHovered = false;
      invFocus = null;
    }
    requestDraw();
  }

  /**
   * THE FOUR LOOT VERBS. The ONLY place any of them is constructed.
   *
   * ALL FOUR ARE ORDINARY PUMPING INTENTS, exactly like a `move`, and that is
   * decision (g)'s other half: a FREE pickup would let a player loot a whole room
   * mid-fight while the monsters stood still, which is the mirror of the argument
   * gateway-progression.test.ts makes for keeping `spend_point` non-pumping. So
   * nothing here is special-cased against the barrier, and each verb runs
   * `unparkOnCommand` on the server for free.
   *
   * EVERY FRAME NAMES AN OBJECT AND NEVER A SUBJECT. `pickup` carries nothing at
   * all; `equip` and `drop` carry an item id resolved against the SENDER'S OWN
   * bag; `unequip` carries a slot. There is no actor id on any of them and no
   * field for one — protocol.ts:16-24 is explicit that an id on the wire is a
   * request rather than an identity, and all four schemas are `strictObject`, so
   * a smuggled `actorId` is REJECTED rather than quietly stripped.
   *
   * A SEND THAT DID NOT GO OUT IS SAID OUT LOUD, the same rule `sendParty` keeps.
   * A pickup that vanished into a closed socket is indistinguishable from a
   * pickup somebody else won by a tenth of a second, and the second of those is a
   * thing this design deliberately allows.
   */
  function sendPickup(): void {
    if (!socket.send({ v: PROTOCOL_VERSION, t: 'pickup' })) {
      showNotice('not connected — that did not go out');
    }
  }
  function sendEquip(itemId: string): void {
    if (!socket.send({ v: PROTOCOL_VERSION, t: 'equip', itemId })) {
      showNotice('not connected — that did not go out');
    }
  }
  /** Drink it. See `UseSchema` — the server reads what it does off the catalogue. */
  function sendUse(itemId: string): void {
    if (!socket.send({ v: PROTOCOL_VERSION, t: 'use', itemId })) {
      showNotice('not connected — that did not go out');
    }
  }
  function sendUnequip(slot: Slot): void {
    if (!socket.send({ v: PROTOCOL_VERSION, t: 'unequip', slot })) {
      showNotice('not connected — that did not go out');
    }
  }
  function sendDrop(itemId: string): void {
    if (!socket.send({ v: PROTOCOL_VERSION, t: 'drop', itemId })) {
      showNotice('not connected — that did not go out');
    }
  }

  /**
   * DO WHAT A PRESS ON THE INVENTORY PANEL MEANS. Five outcomes and no sixth.
   *
   * ═══ WHY IT IS A FUNCTION AND NOT A SWITCH INSIDE `mousedown` — v12 ═══
   * It has TWO callers now and they are the same act reached two ways: a plain
   * click, and the DEFERRED click of a press that turned out not to be a drag
   * (see `beginDrag`). A press on a filled cell can no longer act on `mousedown`
   * — the same press might be the beginning of a drag onto the hotbar — so the
   * act has to be a value that can be held for the length of the gesture. Two
   * copies of this switch would be two answers to "what does pressing a cell do",
   * and the one that drifted would be the one behind the drag.
   *
   * Exhaustive over `InventoryHitKind` with no `default`, under
   * `switch-exhaustiveness-check`, so a sixth control breaks the build rather
   * than becoming something that is drawn, hit-tested and then ignored.
   *
   * `null` IS A REAL ARGUMENT and means "on the panel, but not on anything" — the
   * press is still swallowed, which is what the `overPanel` check at the foot of
   * `mousedown` already does for the same case.
   */
  function runInventoryHit(hit: InventoryHit | null): void {
    if (hit === null) return;
    switch (hit.kind) {
      case InventoryHitKind.Close:
        toggleInventoryPanel(false);
        return;
      case InventoryHitKind.Tab:
        // CLIENT-LOCAL AND NOTHING IS SENT. The frame already carries both
        // halves — one `inventory` message is the doll AND the bag — so
        // switching tabs is a question about which of two things already in
        // hand is on screen.
        if (invTab !== hit.tab) {
          invTab = hit.tab;
          requestDraw();
        }
        return;
      case InventoryHitKind.Item:
        // THE FOCUS IS SET FROM THE SAME FUNCTION THE HOVER USES, so a click
        // that arrives without a preceding hover (a touch, a panel that moved
        // under a still pointer) leaves the strip describing what was pressed.
        invFocus = focusForHit(hit);
        // `worn` DECIDES THE VERB AND NOTHING ELSE DOES. On the doll it is
        // `unequip { slot }` — a slot rather than the item, because a client
        // one frame behind would otherwise ask to remove something already
        // gone, while emptying the slot the player is looking at is what they
        // meant (protocol.ts's `UnequipSchema`). In the bag it is
        // `equip { itemId }`, and the destination slot is authored content the
        // server reads off the catalogue.
        /**
         * THREE VERBS ON ONE CLICK, AND THE SLOT DECIDES WHICH. A thing with no
         * slot cannot be worn (`Item.slot`), so the absence IS the affordance —
         * there is no second flag on the wire that could disagree with it, and a
         * draught in the bag simply has nowhere for "equip" to mean anything.
         */
        /**
         * ═══════════════════════════════════════════════════════════════════
         * A ROW ON THE SHELF IS SOMETHING TO READ, NOT SOMETHING TO PRESS.
         * ═══════════════════════════════════════════════════════════════════
         *
         * Clicking a shop row used to fall straight through to `equip` for an
         * item the player does not own, and the server answered *"you are not
         * carrying that"* — which is not a silent no-op: `case 'error'` puts a
         * large refusal banner on the canvas, cancels any aim that was up and
         * interrupts a walk in progress. So browsing a shelf punished you for
         * looking at it.
         *
         * BUYING HAS ITS OWN CONTROL. The strip's BUY button is the verb, it
         * knows the price and whether the purse covers it, and it is the only
         * thing on this panel that should ever send `shop_buy`. A grid click
         * sets the focus so the strip describes what was pressed, which is
         * exactly what it does on every other tab.
         *
         * THIS ALSO REMOVES A LIE THAT HAD BECOME LOAD-BEARING. `shopCells`
         * stamps `slot: 'body'` on every row and calls it *"a placeholder the
         * grid never shows"* — true when `worn` alone chose the verb, and no
         * longer true now that the ABSENCE of a slot means "drink this". A
         * shelved draught carrying a borrowed `body` would have taken the equip
         * branch for the same doomed reason.
         */
        if (invTab === InventoryTab.Shop && shop !== null) {
          requestDraw();
          return;
        }
        if (hit.worn && hit.slot !== undefined) sendUnequip(hit.slot);
        else if (hit.slot === undefined) sendUse(hit.itemId);
        else sendEquip(hit.itemId);
        requestDraw();
        return;
      case InventoryHitKind.EmptySlot:
        // SWALLOWED, NEVER A FALL-THROUGH. There is nothing to send — you
        // cannot put on a slot — but the focus makes the strip say which slot
        // it is, which is the only place the seven slot names are ever
        // written down for the player.
        invFocus = focusForHit(hit);
        requestDraw();
        return;
      case InventoryHitKind.Drop:
        // ONE PRESS, NO CONFIRMATION, argued at the control itself
        // (ui/inventory.ts): the item lands on the tile you are standing on
        // and `pickup` takes it straight back for the price of a turn. The
        // irreversible act near here is walking away from it, and no button
        // can warn about that.
        sendDrop(hit.itemId);
        return;
      case InventoryHitKind.Buy:
        // A DISABLED CONTROL STILL ANSWERS, and says why. A press that does
        // nothing at all is the one outcome a player reads as the game being
        // broken; "you cannot afford that" is a sentence.
        if (!hit.enabled) {
          showNotice('you cannot afford that');
          return;
        }
        socket.send({ v: PROTOCOL_VERSION, t: 'shop_buy', itemId: hit.itemId });
        return;
      case InventoryHitKind.Sell:
        // NO CONFIRMATION, on the same argument DROP makes and one more: the
        // shop keeps what you sold it until its next restock, so a mis-sale is
        // buyable back — for the spread, which is the cost of not thinking.
        socket.send({ v: PROTOCOL_VERSION, t: 'shop_sell', itemId: hit.itemId });
        return;
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
  // ...AND THE PLACEHOLDER FOR THE SAME REASON, ONE STEP FURTHER. The markup
  // named THREE keys in a string no TypeScript could see, and one of them is
  // rebindable — so a player who moved `say` off `t` was left reading an
  // instruction that did not work, in the row that exists to teach them the
  // feature. See `syncCommandLinePlaceholder`; `case 'keybinds'` re-runs it.
  syncCommandLinePlaceholder();

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
      //
      // v11: through the shared `inParty()`, because the escape menu's LEAVE
      // PARTY row asks the identical question to decide whether to draw itself
      // greyed. Two copies of the comparison would grey a row for a state the
      // command line still accepted, on the same screen, in the same second.
      inParty: inParty(),
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
      case 'keys':
        // ═══ `/keys` — DECISION (c)'S POINTER-ONLY RECOVERY HATCH ═══
        //
        // The one route into the rebinding screen that needs no game key to
        // work: the player CLICKS the chat row — which is permanently visible
        // and says what it is for — and types. From here RESET ALL is two more
        // clicks and no keypress was required to reach either, which is what
        // makes this the hatch that survives a keyboard the player has genuinely
        // broken (or a binding to a key their layout cannot produce).
        //
        // IT OPENS ON THE KEYS SCREEN AND NOT ON THE ROOT. Somebody who typed
        // the name of the screen has already said which one they want, and the
        // extra click would be one more thing between a stuck player and the
        // button that unsticks them.
        //
        // NOTHING IS SENT. Like every other outcome here it is parsed and
        // resolved locally; `input/commands.ts` deliberately carries no payload
        // on this one.
        openMenu(MenuScreen.Keys);
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
   * "Take me to them." The client half of `handleFollow`.
   *
   * NAMES A TARGET AND NOTHING ELSE. Who is asking comes from the socket's own
   * session, as it does for every other verb — see protocol.ts on `follow`.
   */
  function sendFollow(targetId: string): void {
    const sent = socket.send({ v: PROTOCOL_VERSION, t: 'follow', targetId });
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
    //
    // `loot` IS `walkable`'S SIBLING AND JOINS ON THE SAME TERMS: one classified
    // answer, decided here, never re-derived by the menu (ui/verbs.ts's header
    // says so from the other end). It is OPTIONAL on `VerbTarget` and absent
    // means "this caller cannot say" — until this line existed the Pick up row
    // did not exist at all and `,` was the only way to take anything, which is
    // exactly the state W6 left behind and named.
    return {
      kind: 'tile',
      tile,
      walkable: level !== null && travelTargetAllowed(level, tile),
      loot: lootAt(tile),
    };
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
      case MapVerb.Pickup:
        // ═══ `targetTile` IS DELIBERATELY NOT PUT ON THE FRAME, AND THAT IS THE
        //     WHOLE SECURITY ARGUMENT ═══
        // `pickup` carries NO ARGUMENTS AT ALL: the server reads the sender's own
        // live x/y and takes index 0 of that tile (protocol.ts's `PickupSchema`).
        // That is strictly stronger than range-checking a supplied coordinate,
        // because there is no coordinate to forge — and `PickupSchema` is a
        // `strictObject`, so a tile smuggled alongside is REJECTED rather than
        // sanitised into a legal frame.
        //
        // The row is only ENABLED when `lootAt` answered `Underfoot`, so a click
        // that gets here is already about the tile the player is standing on. A
        // disabled row still closes the menu and does nothing else (step 1 of
        // `mousedown`), so this cannot be reached from the greyed form.
        sendPickup();
        return;
      case MapVerb.Talk:
        /**
         * ═══════════════════════════════════════════════════════════════════
         * A TARGET ID, NOT A TILE — see `TalkSchema` in protocol.ts.
         * ═══════════════════════════════════════════════════════════════════
         *
         * `point` names a tile because a player is pointing at ground. Talking
         * names a PERSON: if she steps aside between the click and the frame,
         * the honest answer is "there is nobody there" rather than a
         * conversation with whoever moved into the square.
         *
         * The row is only enabled when `ctx.adjacent`, and the server re-checks
         * range, line of sight and faction anyway — the grey is a courtesy, the
         * server is the rule.
         */
        if (targetId === null) return;
        socket.send({ v: PROTOCOL_VERSION, t: 'talk', targetId });
        return;
      case MapVerb.Ask:
        /**
         * THE SAME FRAME, WITH A SUBJECT. `talk` carries an optional `topic`
         * from the closed `TopicId` set — a vocabulary rather than a question
         * string, so a client cannot make a shopkeeper say something nobody
         * wrote. The server falls back to a greeting for a topic this person has
         * no answer to, which is also what a person does.
         */
        if (targetId === null) return;
        socket.send({
          v: PROTOCOL_VERSION,
          t: 'talk',
          targetId,
          ...(item.topic === undefined ? {} : { topic: item.topic }),
        });
        return;
    }
  }

  // --- the class chooser ----------------------------------------------------
  // The one genuinely modal surface in this client, and the only one that
  // swallows the keyboard.
  //
  // ═══ WHY THAT IS SAFE, AND WHAT IT IS *NOT* SAFE BECAUSE OF ═══
  // This used to argue: "a player seeing this screen has just connected and is a
  // party of ONE (engine/party.ts), so the barrier's quorum, its commit count
  // and the Bell are all scoped to them alone and nobody is waiting on them."
  // THE QUORUM HALF IS TRUE AND THE CONCLUSION WAS FALSE. Parties scope the
  // BARRIER; they do not scope the WORLD CLOCK. One player who owes a decision
  // parks the level's tick loop, and every monster on the floor stops acting for
  // everybody — thirty tiles away, in somebody else's fight, for two minutes at
  // a time.
  //
  // What makes the swallow safe is a SERVER-SIDE fact, not a client-side one:
  // src/server/net/gateway.ts parks a body that owes a class choice on a
  // standing hold (`parkForClassChoice`), which is the field the barrier already
  // reads to mean "this actor never blocks". A player reading three class
  // descriptions costs nobody a turn. Nothing in this file may be relied on for
  // that — a modal that swallowed the keyboard on the strength of a comment in
  // the browser would be exactly one hostile client away from freezing a floor.

  /** The cards, in the SERVER'S ORDER, from the geometry the pointer also hits. */
  function pickerCards(): readonly PanelRect[] {
    if (classOptions === null) return [];
    const { logicalW, logicalH } = renderer.metrics();
    return classPickerCards(classOptions, classPickerRect(logicalW, logicalH));
  }

  /**
   * Pick card `index`, if there is one there.
   *
   * BOUNDED BY THE LAID-OUT CARDS rather than by `classOptions.length`, so the
   * keyboard can never select something the pointer cannot reach: on a viewport
   * with no room for the row at all `classPickerCards` answers with an empty list,
   * and a keyboard selection into that would let somebody confirm a class that was
   * never drawn. It also redraws only on a genuine change, like every other hover
   * and selection in this file.
   */
  // --- the select screen ----------------------------------------------------
  // Three verbs and no decisions. `ui/roster.ts` owns the geometry, the hit test
  // and the paint; what is here is wiring, and the one rule it enforces is the
  // one the file cannot: that entering the world is a HANDSHAKE, not a frame.

  function selectCharacter(index: number): void {
    if (roster === null) return;
    if (index < 0 || index >= roster.characters.length) return;
    if (selectedCharacter === index) return;
    selectedCharacter = index;
    requestDraw();
  }

  /**
   * ENTER THE WORLD AS THE SELECTED CHARACTER.
   *
   * A NEW HANDSHAKE AND NOT A FRAME, and this is the design rather than a
   * shortcut: there is no body on this socket, so there is nothing for a game
   * verb to act with. `rehandshake` drops the connection and the reconnect loop
   * says `hello` again — this time carrying the id, through `characterChoice`.
   *
   * AN UNPLAYABLE ROW IS REFUSED HERE AS WELL AS DRAWN GREY. The button is drawn
   * dim for exactly this state and the honest behaviour is that pressing it does
   * nothing; sending the id anyway would get the roster straight back, which
   * looks to a player like the screen flickered and forgot them.
   */
  function playSelectedCharacter(): void {
    if (roster === null || selectedCharacter === null) return;
    const row = roster.characters[selectedCharacter];
    if (row === undefined || !row.playable) return;
    chosenCharacterId = row.id;
    wantsNewCharacter = false;
    socket.rehandshake();
  }

  /**
   * MAKE A NEW ONE. The server allocates the id — see `hello.newCharacter` — and
   * says which it was in `welcome`, which is what stops a dropped socket
   * creating a second stranger five minutes later.
   */
  function createCharacter(): void {
    if (roster === null || !roster.canCreate) return;
    chosenCharacterId = null;
    wantsNewCharacter = true;
    socket.rehandshake();
  }

  /**
   * PUT THIS CHARACTER DOWN AND GO BACK TO THE LIST.
   *
   * THE SAVE IS THE SERVER'S JOB AND IT ALREADY DOES IT: dropping the socket is
   * a disconnect, and a disconnect is one of `SaveReason`'s critical events —
   * written immediately, not on the debounce. There is deliberately no "save
   * now" frame here, because a client that had to ask would be a client that
   * could forget to.
   *
   * THE CHOICE IS CLEARED FIRST, so the `hello` that follows names nothing and
   * the server answers with the roster. Leaving it set would walk straight back
   * into the character the player just put down.
   */
  function leaveCharacter(): void {
    chosenCharacterId = null;
    wantsNewCharacter = false;
    socket.rehandshake();
  }

  /**
   * Move the selection with a direction key. CLAMPS RATHER THAN WRAPS, the same
   * ToME dialog convention `movePickerSelection` ports and cites — a list that
   * wraps from the last row to the first is a list somebody plays the wrong
   * character from after one key too many.
   *
   * A NULL SELECTION STARTS AT THE TOP, which is the newest-played character:
   * the server sorts by `updatedAt` descending, so the first press of an arrow
   * lands on the one a returning player almost certainly wants.
   */
  function moveRosterSelection(dir: Dir): void {
    if (roster === null) return;
    const count = roster.characters.length;
    if (count === 0) return;
    const step =
      dir === 'n' || dir === 'nw' || dir === 'ne'
        ? -1
        : dir === 's' || dir === 'sw' || dir === 'se'
          ? 1
          : 0;
    if (step === 0) return;
    const from = selectedCharacter ?? (step > 0 ? -1 : count);
    selectCharacter(Math.max(0, Math.min(count - 1, from + step)));
  }

  function selectCard(index: number): void {
    if (index < 0 || index >= pickerCards().length) return;
    if (selectedClass === index) return;
    selectedClass = index;
    requestDraw();
  }

  /**
   * Move the selection with a direction key. ToME's dialog convention, PORTED.
   *
   * `dialogs/elements/TalentTrees.lua:148-151` binds MOVE_UP / MOVE_DOWN /
   * MOVE_LEFT / MOVE_RIGHT to `moveSel` (inside the `addBinds` opened at :146,
   * whose first entry at :147 is ACCEPT), and `moveSel` CLAMPS rather than
   * wraps: `util.bound(self.sel_i + i, 1, #self.tree)` at :207. Both
   * halves are ported. The clamp matters more than it looks — a wrap on a
   * three-item choice that is written to a file and never offered again is how
   * somebody ends up on card 1 while pressing away from card 3.
   *
   * WHICH WAY A DIAGONAL COUNTS COMES FROM `step`, never from a hand-rolled dx/dy
   * table — the same rule `adjacentDowned` and the Attack verb follow, because
   * the eight-way geometry exists once in src/shared/coords.ts. The cards are a
   * ROW, so the horizontal component decides and a pure north/south key falls
   * back to the vertical one: a player pressing down a list of three things means
   * "next", and answering with nothing at all reads as a dead key.
   */
  function movePickerSelection(dir: Dir): void {
    const cards = pickerCards();
    if (cards.length === 0) return;
    const delta = step({ x: 0, y: 0 }, dir);
    const move = delta.x !== 0 ? delta.x : delta.y;
    if (selectedClass === null) {
      // Nothing picked yet: enter the row from the end the key came from.
      selectCard(move > 0 ? 0 : cards.length - 1);
      return;
    }
    selectCard(Math.min(cards.length - 1, Math.max(0, selectedClass + move)));
  }

  /**
   * Send the choice. The ONLY place a `choose_class` frame is constructed.
   *
   * ═══ THE PICKER DOES NOT CLOSE HERE, AND THAT IS THE WHOLE RULE ═══
   * The server is authoritative and may refuse this: an id this build does not
   * have comes back `bad_message`, a second choice comes back `not_your_turn`. A
   * modal torn down on the click would leave that player wearing the provisional
   * rotation class, on a map they can play, with no way back to the one screen
   * that changes it. The acknowledgement is the arrival of the new `loadout` —
   * the frame that could only exist because the choice landed — and that is where
   * the modal goes away. See `case 'loadout'`.
   *
   * `{ v, t, classId }` AND NOTHING ELSE. `ChooseClassSchema` is a `strictObject`,
   * so an actorId or a slot index smuggled alongside is REJECTED rather than
   * stripped; identity is taken from the session on the server's side and this
   * wire has no field for it at all.
   */
  function confirmClass(): void {
    if (classOptions === null || selectedClass === null) return;
    // Nothing picked, or a selection that outlived its frame. The button is drawn
    // grey in that state and the honest behaviour is that pressing it does
    // nothing — ui/classpicker.ts states the same rule from its own side, which
    // is why it answers the hit test regardless of the selection.
    const option = classOptions[selectedClass];
    if (option === undefined) return;
    if (!socket.send({ v: PROTOCOL_VERSION, t: 'choose_class', classId: option.id })) {
      showNotice('not connected — that did not go out');
    }
  }

  // --- the escape menu ------------------------------------------------------
  // v11. Six root entries, a nested Keys screen, and not one line of decision:
  // ui/escapemenu.ts owns the rows, the capture rule, the geometry and the hit
  // test, and every one of them is pure and tested with nothing drawn. What is
  // here is what this file is allowed to be — wiring.

  /**
   * DO ONE UI VERB. Extracted from `onUi` so the MENU ROW AND THE KEY ARE ONE
   * CODE PATH.
   *
   * ═══ THIS IS THE PORT, AND IT IS THE PORT'S WHOLE POINT ═══
   * `tome/class/Game.lua:2307-2308` does not open a second inventory from its
   * escape menu: it calls `key:triggerVirtual("SHOW_INVENTORY")` — the entry
   * fires the ordinary keybinding. A row that reimplemented `toggleInventoryPanel`
   * would be a second copy of a toggle, and the first thing to drift would be the
   * hover flags it clears on the way shut.
   *
   * Exhaustive, no `default`: an eighth verb breaks here at lint time rather than
   * becoming a key AND a menu row that both quietly do nothing.
   */
  function runUiCommand(command: UiCommand): void {
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
      case UiCommand.ShowSheet:
        // A TOGGLE, and the `inspect` goes out on the way OPEN only. The panel
        // is built from four frames and three of them (`loadout`, `cooldowns`,
        // `resource`) are already held here; the fourth is the viewer's own
        // `inspected` answer, which is cached per game turn — so opening the
        // sheet either draws from a fresh cache entry immediately or asks once
        // and fills in a frame later, and ui/charsheet.ts draws "gathering…"
        // rather than an empty box in that window.
        sheetVisible = !sheetVisible;
        // The hover state goes with it, or the × would come back highlighted
        // next time the panel opens under a pointer that has since moved.
        if (!sheetVisible) {
          sheetCloseHovered = false;
          sheetTalentsHovered = false;
        }
        requestSelfSheet();
        requestDraw();
        return;
      case UiCommand.ShowTalents:
        // A TOGGLE, AND IT ASKS THE SERVER FOR NOTHING. Unlike the sheet, both
        // frames this panel is built from — `loadout` and `progress` — are
        // already held here, absolute and unicast, and both are re-sent by the
        // server whenever they change. There is no round trip to start, no
        // cache to warm and no "gathering…" window: the panel is correct the
        // instant it appears.
        toggleTalentPanel();
        return;
      case UiCommand.ShowWorldMap:
        // Nothing to fetch: the overworld was cached the last time this client
        // stood on it. Refusing in words when it has not is better than opening
        // an empty black screen and letting the player wonder what broke.
        if (overworldLevel === null) {
          showNotice('the region map is not known yet');
          return;
        }
        worldMapOpen = !worldMapOpen;
        requestDraw();
        return;
      case UiCommand.ZoomOut:
      case UiCommand.ZoomIn: {
        const want = renderer.zoom() + (command === UiCommand.ZoomIn ? 1 : -1);
        // `setZoom` clamps and returns what it settled on, so "already as far
        // as it goes" is a fact this can state rather than a silent no-op —
        // a key that appears to do nothing is indistinguishable from one that
        // is not bound.
        const got = applyZoom(want);
        if (got !== want) {
          showNotice(command === UiCommand.ZoomIn ? 'already closest' : 'already widest');
        }
        requestDraw();
        return;
      }
      case UiCommand.ShowInventory:
        // A TOGGLE, AND IT ASKS THE SERVER FOR NOTHING — the talent panel's
        // shape exactly, and for its reason: the one frame this panel is built
        // from is absolute, unicast, and re-sent whenever the viewer's bag or
        // doll changes. There is no round trip to start, no cache to warm and
        // no "gathering…" window.
        //
        // AND THE SERVER IS NOT TOLD IT IS OPEN. No standing hold, no park, no
        // barrier interaction of any kind — see `invVisible` for the whole of
        // decision (g). This case is also NOT mirrored in `onCancel`: no dock
        // surface is in the Escape chain, and that block explains why adding one
        // would make the key's behaviour depend on which panel happened to be
        // open.
        //
        // `i` IS PORTED AS A DIALOG-LOCAL MNEMONIC, not as a shipped binding.
        // The default keybind tables are absent from this sparse clone of
        // t-engine4 (keys.ts records the same fact for M and G), but
        // dialogs/CharacterSheet.lua:95-98 draws a "Manage [I]nventory" button
        // and :286-287 handles `c == 'i' or c == 'I'` — the same evidentiary
        // class this repo already accepted for the sheet's `[G]` control.
        toggleInventoryPanel();
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
  }

  /** The rows, as the painter builds them. One call, one answer, no cache. */
  function menuRows(): readonly MenuRow[] {
    return escapeMenuRows(escapeMenuView());
  }

  /**
   * Open the menu, on `Root` unless somebody asked for a screen by name.
   *
   * TWO CALLERS AND THEY ARE NOT THE SAME GESTURE. Escape at the tail of the
   * cancel chain opens the root; `/keys` typed into the command line opens the
   * Keys screen directly, because a player who typed the name of the screen has
   * already told us which one they want — and that path is decision (c)'s
   * pointer-only recovery hatch, the one that survives a keyboard the player has
   * genuinely broken.
   */
  function openMenu(screen: MenuScreen = MenuScreen.Root): void {
    // ═══════════════════════════════════════════════════════════════════════
    // A MENU WITH NOWHERE TO GO IS REFUSED OUT LOUD, AND NEVER OPENED BLIND.
    // ═══════════════════════════════════════════════════════════════════════
    // `escapeMenuRect` answers null when the band between the top HUD and the
    // bottom strips cannot hold a panel — the same refusal `inventoryPanelRect`
    // makes on a viewport too narrow for four item frames. But this surface
    // ROUTES THE ARROWS AND ENTER while it is open, so an open-but-undrawable
    // menu would be an invisible thing swallowing the movement keys, and the
    // player would report that walking had stopped working.
    //
    // A SENTENCE RATHER THAN SILENCE, because "nothing happened" is
    // indistinguishable from a dropped input (this file's header, at length) —
    // and unlike the inventory panel's case, the player did not press a key that
    // obviously names a panel: they pressed Escape.
    //
    // THE FLAG IS SET AND ROLLED BACK RATHER THAN THE RECT BEING RECOMPUTED
    // HERE, because `hudLayout` answers null for a menu that is SHUT — one
    // function owns that arithmetic and every hit test reads it, which is the
    // rule `slotRect` established in ui/hotbar.ts. A second copy of the band sums
    // in this function is how a panel ends up drawn in one place and clicked in
    // another.
    //
    // A WINDOW SHRUNK *WHILE* THE MENU IS OPEN IS NOT COVERED HERE and does not
    // need to be: the three head links in `onCancel` do not consult the rect, so
    // Escape still closes it, and Escape is frozen against rebinding.
    menuOpen = true;
    const { logicalW, logicalH } = renderer.metrics();
    if (hudLayout(logicalW, logicalH).menu === null) {
      menuOpen = false;
      showNotice('no room for the menu — make the window taller');
      return;
    }
    menuScreen = screen;
    menuPage = 0;
    menuArmed = null;
    menuMessage = null;
    menuHovered = null;
    menuCloseHovered = false;
    // THE CHAT ROW GOES OUT OF REACH WHILE THIS IS UP. Tab is a legitimate key
    // to bind and `#cmd` is the only tabbable element on the page — see
    // `syncCommandLineReach`, which recomputes rather than asserting.
    syncCommandLineReach();
    requestDraw();
  }

  /**
   * Put the menu away. EVERY piece of its state goes with it.
   *
   * The arm most of all: it is the one thing in this client that takes a key
   * away from the keymap, and an arm that outlived the screen explaining it
   * would swallow the next keypress on a map with nothing on it to say why.
   * `menuMessage` goes for the smaller version of the same reason — a refusal
   * that survived a close would reappear, stale, on the next open.
   */
  function closeMenu(): void {
    if (!menuOpen) return;
    // ONE COPY OF THE RESET, shared with `case 'class_options'` — see
    // `resetMenuState`. A second spelling of "every piece of its state goes with
    // it" is how the arm survives one of the two exits.
    resetMenuState();
    syncCommandLineReach();
    requestDraw();
  }

  /** Swap screens inside the one surface. Not a way out — see `onCancel`. */
  function showMenuScreen(screen: MenuScreen): void {
    menuScreen = screen;
    menuPage = 0;
    menuArmed = null;
    menuMessage = null;
    menuHovered = null;
    requestDraw();
  }

  /**
   * THE WIRE WANTS MUTABLE ARRAYS AND THE KEYMAP HANDS OUT READONLY ONES.
   *
   * A copy rather than a cast: `KeyRemap`'s arrays are `readonly` precisely
   * because nothing outside keymap.ts may write through them, and casting that
   * away to satisfy `z.infer` would hand the serialiser a live reference to the
   * table the dispatcher is compiled from.
   */
  function wireBinds(remap: KeyRemap): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [actionId, keys] of Object.entries(remap)) out[actionId] = [...keys];
    return out;
  }

  /**
   * ADOPT A NEW OVERLAY, LOCALLY AND ON THE WIRE. The ONLY place a
   * `set_keybinds` frame is constructed.
   *
   * ═══ ONE FRAME PER ACCEPTED CHANGE, AND DELIBERATELY NOT ONE PER CLOSE ═══
   * ToME saves only when the binder dialog is dismissed (`KeyBinder.lua:64-70`
   * calls `KeyBind:saveRemap()` from its `unload`), and a crash or a quit while
   * that dialog is open silently discards the lot. That is a bad trade here and
   * a worse one: the connection can drop at any moment, and a player who
   * reconnects does not necessarily come back on the same socket — so a batch
   * held until close is a batch that can vanish with nothing on screen ever
   * having said it might.
   *
   * `setKeymap` FIRST, so the change is live on the very next keypress rather
   * than after a round trip. It MUTATES THE BOX and never re-registers the
   * handler: keys.ts forbids dispose-then-rebind outright, because re-registering
   * moves `bindGameKeys` after the travel-cancel listener below and inverts an
   * Escape precedence two files independently call load-bearing.
   *
   * ...AND THE SCREEN STILL RENDERS THE ECHO. `case 'keybinds'` calls `setKeymap`
   * again with whatever the SERVER stored, so a map the server trimmed or
   * bounced corrects itself here rather than leaving the panel drawing this
   * client's optimism (protocol.ts's `KeybindsMsg`: "the echo is the point").
   */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * CHANGE THE ZOOM AND TELL THE SERVER, WHICH IS WHAT MAKES IT OUTLIVE THE TAB.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `-`/`=` and the mouse wheel both used to call `renderer.setZoom` directly,
   * which is exactly two places that would have to remember to persist. One
   * function so the clamp, the wire and the notice are stated once —
   * `commitRemap`'s shape for the same reason.
   *
   * ONLY A REAL CHANGE GOES ON THE WIRE. `setZoom` is authoritative about the
   * clamp and returns what it settled on, so a player holding the wheel at the
   * end of the range sends nothing rather than a frame a second. The server
   * dedupes as well — it has to, since it cannot trust a client — but not
   * sending is better than being ignored.
   *
   * A FAILED SEND IS SAID OUT LOUD, the rule every send in this file keeps: a
   * zoom that vanished into a closed socket looks exactly like one that was
   * saved, and the player finds out next session when the tiles are small again.
   */
  function applyZoom(next: number): number {
    const before = renderer.zoom();
    const got = renderer.setZoom(next);
    if (got !== before) {
      if (!socket.send({ v: PROTOCOL_VERSION, t: 'set_zoom', zoom: got })) {
        showNotice('not connected — that zoom was not saved');
      } else if (!zoomPersisted) {
        // THE OTHER WAY IT SILENTLY DOES NOT STICK, and it is the one a player
        // could never work out: an anonymous socket has no character file, so
        // the server holds the value for as long as the body lives and no
        // longer. `SettingsMsg.persisted` exists to make that sayable rather
        // than leaving somebody to find a working feature looks broken.
        showNotice('not signed in — that zoom will not be saved');
      }
    }
    return got;
  }

  function commitRemap(remap: KeyRemap): void {
    // The arm belonged to the slot that has just changed. Every capture outcome
    // clears it too; this is the button path's copy of the same rule.
    menuArmed = null;
    setKeymap(remap);
    if (!socket.send({ v: PROTOCOL_VERSION, t: 'set_keybinds', binds: wireBinds(remap) })) {
      // SAID OUT LOUD, the rule every send in this file keeps. A rebind that
      // vanished into a closed socket looks exactly like one that was saved, and
      // the player finds out on their next session.
      showNotice('not connected — that keybinding was not saved');
    }
    requestDraw();
  }

  /**
   * Turn the Keys screen's pages. CLAMPED HERE AS WELL AS BY THE GEOMETRY.
   *
   * The geometry clamps what it DRAWS; without a clamp on the variable a player
   * leaning on NEXT would walk `page` up to a number that takes as many presses
   * to come back from, on a screen that stopped moving several presses ago.
   */
  function pageMenu(delta: number): void {
    const { logicalW, logicalH } = renderer.metrics();
    const rect = hudLayout(logicalW, logicalH).menu;
    if (rect === null) return;
    const paging = escapeMenuPaging(rect, menuRows());
    const next = Math.min(Math.max(0, menuPage + delta), Math.max(0, paging.pageCount - 1));
    if (next === menuPage) return;
    menuPage = next;
    requestDraw();
  }

  /** The root entries a keypress may land on, in reading order. */
  function enabledEntryIndices(rows: readonly MenuRow[]): readonly number[] {
    const out: number[] = [];
    for (const row of rows) {
      if (row.kind === MenuRowKind.Entry && row.enabled) out.push(row.index);
    }
    return out;
  }

  /**
   * Move the lit entry with a direction key. ToME's dialog convention, and the
   * same CLAMP `movePickerSelection` ports from `TalentTrees.lua:207`
   * (`util.bound`, which does not wrap).
   *
   * THE ROWS ARE A COLUMN, so the vertical component decides and a pure east or
   * west key falls back to it — the mirror of the picker, whose cards are a ROW.
   * A player pressing along a list of six things means "next", and answering
   * with nothing at all reads as a dead key.
   *
   * ON THE KEYS SCREEN IT PAGES INSTEAD, and that is not a fudge: that screen
   * has no selectable row to move — every control on it is a per-row button and
   * ui/escapemenu.ts deliberately offers no keyboard selection for them — so the
   * only honest thing a direction key can mean there is the thing PREV and NEXT
   * already mean. A key that did nothing on one of the two screens would be the
   * dead entry this whole feature was told to avoid, one level down.
   */
  function moveMenuSelection(dir: Dir): void {
    if (menuScreen === MenuScreen.Keys) {
      const delta = step({ x: 0, y: 0 }, dir);
      pageMenu((delta.y !== 0 ? delta.y : delta.x) > 0 ? 1 : -1);
      return;
    }
    const order = enabledEntryIndices(menuRows());
    if (order.length === 0) return;
    const delta = step({ x: 0, y: 0 }, dir);
    const move = delta.y !== 0 ? delta.y : delta.x;
    const at = menuHovered === null ? -1 : order.indexOf(menuHovered);
    // Nothing lit yet: enter the list from the end the key came from.
    const next =
      at < 0
        ? move > 0
          ? 0
          : order.length - 1
        : Math.min(order.length - 1, Math.max(0, at + move));
    const chosen = order[next];
    if (chosen === undefined || chosen === menuHovered) return;
    menuHovered = chosen;
    requestDraw();
  }

  /**
   * Do whatever a menu row says. The ONE place a menu entry becomes an act.
   *
   * A `switch` over the effect union with no `default`, so a fifth kind of entry
   * breaks here at lint time rather than becoming a row that quietly does
   * nothing — which is precisely `GameMenu.lua:125-133`'s failure, where a name
   * the table cannot resolve is silently dropped and upstream ships a dead
   * "highscores" row as a result.
   */
  function runMenuEffect(effect: MenuEffect): void {
    switch (effect.kind) {
      case 'resume':
        closeMenu();
        return;
      case 'keys':
        showMenuScreen(MenuScreen.Keys);
        return;
      case 'leave-character':
        // ═══ THE MENU GOES AWAY FIRST, THEN THE VERB — the same port the `ui`
        // case cites below, and the same reason applies more strongly: this one
        // takes the world away, and a menu still painted over an empty screen
        // while the handshake is in flight would look like a hang.
        closeMenu();
        leaveCharacter();
        return;
      case 'ui':
        // ═══ THE MENU GOES AWAY FIRST, AND THEN THE VERB FIRES. PORTED ═══
        // `tome/class/Game.lua:2307-2308` is literally
        // `function() self:unregisterDialog(menu) self.key:triggerVirtual(
        // "SHOW_CHARACTER_SHEET") end` — close, then trigger — and the order is
        // not decoration.
        //
        // THE LINE NUMBERS ARE :2308 FOR THE SHEET AND :2307 FOR THE INVENTORY,
        // which is what ui/escapemenu.ts:54-56 has always cited. This comment
        // said :2306-2307, and :2306 is the bare string `"highscores"` — the dead
        // entry ui/escapemenu.ts holds up as its demonstration, not a function at
        // all. Two files disagreeing about three lines of the file they are
        // porting from is exactly the kind of citation CLAUDE.md forbids.
        //
        // This panel is painted LAST and is WIDER than the sheet,
        // the talent panel and the inventory panel, so a row that opened one of
        // them and stayed up would draw itself straight over the thing the player
        // just asked for. The row would look broken while working perfectly.
        closeMenu();
        // THE EXISTING TOGGLE, not a second copy of it. See `runUiCommand`.
        runUiCommand(effect.command);
        return;
      case 'party':
        // Closed first for the reason above and one of its own: after this the
        // row is greyed ("you are a party of one"), and a button that answers by
        // disabling itself under the pointer is a button nobody trusts.
        closeMenu();
        // `null` TARGET, ALWAYS. You leave a party, you do not leave a PERSON —
        // a `leave` naming a target is refused as `bad_message` — and Leave is
        // the only party verb this menu offers, because it is the only one that
        // needs no name typed at it.
        sendParty(effect.action, null);
        return;
    }
  }

  /**
   * Fire the lit entry, if there is one. The keyboard's copy of a click.
   *
   * ═══ IT REPORTS, AND THE BOOLEAN IS LOAD-BEARING AT ITS ONE CALL SITE ═══
   * `onCommand` only swallows Enter when this answers true. A row can be lit and
   * then go disabled underneath the selection — LEAVE PARTY greys the moment you
   * are a party of one, and that can happen while the pointer is resting on it —
   * so a void return here would put a silent no-op back in front of the one key
   * that ends a turn. False means "nothing was activated", and the caller lets
   * the press through to the commit it would otherwise have been.
   */
  function pressMenuSelection(): boolean {
    if (menuHovered === null) return false;
    for (const row of menuRows()) {
      if (row.kind === MenuRowKind.Entry && row.index === menuHovered && row.enabled) {
        runMenuEffect(row.effect);
        return true;
      }
    }
    return false;
  }

  /**
   * Do what a hit says. The mouse's whole vocabulary on this surface.
   *
   * Exhaustive over `MenuHitKind` with no `default`, for `runMenuItem`'s reason:
   * a ninth control must break the build rather than becoming a button that is
   * drawn, hit-tested and then ignored.
   *
   * ═══ EVERY CONTROL HERE IS POINTER-REACHABLE, WHICH IS THE RECOVERY STORY ═══
   * decision (c) names four hatches out of a keymap somebody regrets, and this
   * function is two of them: RESET ALL and the per-row `[D]`. They must never
   * acquire a keyboard-only path or a confirmation step that needs one — the
   * player who needs them may have no working key at all.
   */
  function runMenuHit(hit: MenuHit): void {
    switch (hit.kind) {
      case MenuHitKind.Close:
        closeMenu();
        return;
      case MenuHitKind.Entry:
        runMenuEffect(hit.effect);
        return;
      case MenuHitKind.Rebind:
        // ARM, AND SWALLOW NOTHING YET. The capture is exactly one keypress wide
        // and it begins on the NEXT key — ui/talents.ts's `pressSpend` shape.
        menuArmed = { actionId: hit.actionId, slot: hit.slot };
        menuMessage = null;
        requestDraw();
        return;
      case MenuHitKind.Clear: {
        // `[X]` CLEARS BOTH SLOTS. The per-slot clear is Backspace during a
        // capture; this is the whole-action one, and it is `clearBinding` rather
        // than `resetOne` because they mean opposite things — cleared is
        // "deliberately empty, do not fall back", reset is "forget I touched it".
        let next = gameKeymap.current.remap;
        for (let slot = 0; slot < SLOTS_PER_ACTION; slot += 1) {
          next = clearBinding(next, hit.actionId, slot);
        }
        menuMessage = null;
        commitRemap(next);
        return;
      }
      case MenuHitKind.Reset:
        menuMessage = null;
        commitRemap(resetOne(gameKeymap.current.remap, hit.actionId));
        return;
      case MenuHitKind.ResetAll:
        // `{}` IS A REAL VALUE AND NOT A MISSING FIELD (protocol.ts). It is the
        // whole overlay gone, which is exactly what the button says.
        //
        // NO CONFIRMATION STEP. The talent panel's `+` has one because a spent
        // point is irreversible; this is the opposite — it is the button that
        // UNDOES things, and putting a second press in front of the recovery
        // hatch is how a player with a broken keymap fails to reach it.
        menuMessage = 'every key is back to its default';
        commitRemap(resetAll());
        return;
      case MenuHitKind.Back:
        // BACK IS NOT THE WAY OUT OF THE MENU, it is the way out of the SCREEN.
        // Escape does both, one level per press — see `onCancel`.
        showMenuScreen(MenuScreen.Root);
        return;
      case MenuHitKind.Page:
        pageMenu(hit.delta);
        return;
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE KEY CAPTURE. ONE `window` LISTENER, CAPTURE PHASE, GATED ON THE ARM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ═══ IT CANNOT BE A `KeyHandlers` MEMBER, AND THAT IS PROVABLE ═══
   * `bindGameKeys` dispatches only keys it has a meaning for: its terminal
   * `if (command === undefined) return;` drops an unmapped key on the floor, and
   * test/client/input/keys.test.ts asserts exactly that. Tab, F1, q and every
   * other unbound key never reach a handler — so a capture field riding the
   * keymap could only ever capture keys that were already bound, which is not a
   * capture field.
   *
   * ═══ CAPTURE PHASE, WHICH IS THE ONLY PLACEMENT THAT WORKS ═══
   * It runs before BOTH bubble-phase listeners on this target without changing
   * their relative order — and that order is load-bearing (see the travel-cancel
   * listener below: registered first it would stop a walk AND let the same press
   * cancel an aim). `stopImmediatePropagation` then reaches Tab, F1, q, Enter and
   * Escape and stops the keymap AND the travel cancel together, so a captured key
   * cannot end somebody's walk as a side effect of being bound.
   *
   * IT IS ALSO REGISTERED FIRST, which the phase makes redundant in a browser and
   * is worth having anyway: `EventTarget` outside the DOM — Node's, which is what
   * the tests run on — has no propagation path and honours registration order
   * alone. Belt and braces, and it costs one line's placement.
   *
   * ═══ AND IT IS COMPLETELY INERT WHILE NOTHING IS ARMED ═══
   * One comparison on the first line, then a return. It is registered once, for
   * the life of the page, and never disposed — for keys.ts's reason: a listener
   * that comes and goes is a listener whose ORDER comes and goes with it.
   *
   * `applyCapture` takes a plain record and a real `KeyboardEvent` is
   * structurally assignable to it, so the event goes straight in — which is what
   * keeps the whole rule testable in node with no DOM.
   */
  window.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (menuArmed === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      const outcome = applyCapture(menuArmed, event, gameKeymap.current);
      switch (outcome.kind) {
        case CaptureKind.Ignored:
          // A BARE MODIFIER. The capture stays armed, which is
          // `KeyBinder.lua:88-93` verbatim: the player is still reaching for the
          // key they actually meant, and closing on the Shift they pressed on
          // the way to it would be a binder nobody can use.
          return;
        case CaptureKind.Disarmed:
          // Escape. Binds nothing. `KeyBinder.lua:98` compares the RAW sym for
          // this and it is the single reason upstream's binder is not
          // self-bricking.
          menuArmed = null;
          menuMessage = null;
          requestDraw();
          return;
        case CaptureKind.Cleared:
        case CaptureKind.Bound:
          menuMessage = outcome.message;
          commitRemap(outcome.remap);
          return;
        case CaptureKind.Conflict:
        case CaptureKind.Refused:
          // THE ROW IS UNCHANGED AND THE HOLDER IS NAMED. Not a swap (a second
          // edit nobody asked for) and not a silent shadow (upstream's hash-order
          // lottery, KeyBind.lua:227-232). Nothing is sent: nothing changed.
          menuArmed = null;
          menuMessage = outcome.message;
          requestDraw();
          return;
      }
    },
    { capture: true },
  );

  // --- input ---------------------------------------------------------------
  // Every key skips the sweep beat first. A player who has already decided must
  // never be made to watch a flourish finish, and settling is idempotent.
  //
  // ═══ ...AFTER THE CHOOSER'S GATE, WHICH IS THE FIRST LINE OF ALL SIX ═══
  // The gate is an early return HERE and deliberately not a call to
  // `bindGameKeys`'s disposer: keys.ts explains at length that dispose-then-rebind
  // re-registers this handler AFTER the travel-cancel listener below and inverts
  // an order that file and this one both document as load-bearing. The keys still
  // arrive and still mean what keys.ts says they mean; what changes is what this
  // caller does with them, exactly as targeting mode already does.
  bindGameKeys(window, {
    onMove: (dir) => {
      // ═══ THE SELECT SCREEN IS ABOVE THE PICKER IN ALL SIX HANDLERS ═══
      // Both are screens that cannot be dismissed, and this one is the earlier:
      // there is no BODY on this socket, so every key below here is an intent
      // about a token that does not exist. The `return` is unconditional for
      // that reason and not because the roster wants the key.
      if (roster !== null) {
        moveRosterSelection(dir);
        return;
      }
      if (classOptions !== null) {
        movePickerSelection(dir);
        return;
      }
      // ═══ THE MENU IS SECOND, AND IT IS TARGETING MODE'S SHAPE, NOT A MODAL'S ═══
      //
      // BELOW THE PICKER IN ALL SIX HANDLERS, always: that is a screen which
      // cannot be dismissed, and this is one that can — one press of a key that
      // is frozen against rebinding.
      //
      // A MODE ROUTES THE KEY, EXACTLY AS AN OPEN AIM ALREADY DOES three lines
      // below. Targeting has steered the arrows for an unbounded time since M3
      // and nobody calls that a barrier problem, for the reason that applies
      // here word for word: the player can leave at any moment with one press,
      // the server is never told the mode is open, no body is parked and no
      // standing order is set, so the Warrant Clock auto-passes a reader exactly
      // as it auto-passes anybody who has walked away from the keyboard.
      //
      // ═══ ...EXCEPT WHEN A REVIVE IS WAITING FOR ITS DIRECTION ═══
      // `onUi` lets `Revive` through with this panel open ON PURPOSE — "revive
      // and respawn are ordinary play, and this is a panel". But a revive with
      // more than one downed ally adjacent is a TWO-STAGE verb: `attemptRevive`
      // arms and the notice says "press a direction". Swallowing that direction
      // here made the menu advertise a verb and then deliver half of it, during
      // the one countdown in the game where a wasted turn costs somebody their
      // body. So the arm outranks the selection, and the key falls through to
      // the `reviveArmed` branch below — which is still UNDER targeting, so an
      // open aim keeps the precedence it has had since M3.
      if (menuOpen && !reviveArmed) {
        moveMenuSelection(dir);
        return;
      }
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
      if (roster !== null) {
        // ENTER PLAYS THE SELECTED CHARACTER, and Hold does nothing — the same
        // split the class chooser makes, for the same reason: there is no verb
        // that means "pass on choosing who I am".
        if (command === TurnCommand.Commit) playSelectedCharacter();
        return;
      }
      if (classOptions !== null) {
        // ENTER/SPACE CONFIRMS, and Hold ('.') does nothing at all. ToME's
        // dialogs bind ACCEPT the same way (engine/ui/Dialog.lua:102 adds an
        // ACCEPT bind beside the EXIT one at :101 on its list popup). There is
        // no analogue for Hold on a dialog and inventing one — "pass on choosing
        // a class" — would be a verb with nowhere to go: the screen cannot be
        // left unanswered.
        if (command === TurnCommand.Commit) confirmClass();
        return;
      }
      // ═══════════════════════════════════════════════════════════════════════
      // THE MENU TAKES ENTER *ONLY WHEN A ROW IS LIT*. IT TAKES NOTHING ELSE.
      // ═══════════════════════════════════════════════════════════════════════
      //
      // THE MISFIRE THIS GATE IS FOR is narrow and it is the whole of it: a
      // player who has arrowed down to a row and presses Enter means "do the lit
      // row", and an ungated press would go out as `{t:'commit'}` and END THEIR
      // TURN invisibly, from behind a panel, in a phase-locked game.
      //
      // ═══ AND IT USED TO SWALLOW COMMIT, HOLD *AND* PICKUP UNCONDITIONALLY,
      //     WHICH IS THE CLASS-PICKER CRITICAL WEARING A PANEL'S CLOTHES ═══
      // With all three eaten, a player with this surface open genuinely COULD
      // NOT ACT: `surveyQuorum` counts a live, connected body with no pending
      // intent and no standing order as BLOCKING, and nothing about a menu is
      // ever told to the server. One reader was survivable — `bell()` arms only
      // when `committed >= total - 1`, so the Warrant Clock can bound exactly ONE
      // straggler. TWO readers and the Bell never arms at all: `tickLevel`
      // returns `parked`, shared/energy.ts stops every monster on the level, and
      // the world clock stops with no timer that ends it. That is the class
      // picker's CRITICAL reproduced with two players and no backstop, and
      // `panelBand` does not answer it — keeping the hotbar VISIBLE says nothing
      // about the two handlers that were gated.
      //
      // SO THE THREE VERBS GO THROUGH. Hold and Pickup are never swallowed here
      // at all; Commit is swallowed only when there is genuinely a lit row for it
      // to mean, and `pressMenuSelection` REPORTS whether it fired so that a row
      // which went disabled between the hover and the press falls through to the
      // commit rather than becoming the silent no-op this file's header calls the
      // worst failure mode there is.
      //
      // On the Keys screen `menuHovered` is null by construction — every control
      // there is a per-row button and ui/escapemenu.ts offers no keyboard
      // selection for them — so Enter commits the turn from that screen, which is
      // exactly what a player watching the turn bar go gold above the panel means
      // by it.
      if (menuOpen && command === TurnCommand.Commit && menuHovered !== null) {
        if (pressMenuSelection()) return;
      }
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
        case TurnCommand.Pickup:
          // ═══ `,` — AND IT GOES OUT LIKE A MOVE, NOT LIKE AN `inspect` ═══
          // It PUMPS, which is why keys.ts files it under `TurnCommand` rather
          // than beside the panel toggles: it is an intent the server rules on,
          // it moves the world's clock, and pressing it out of turn earns exactly
          // the `not_your_turn` refusal `commit` does — with a sentence, through
          // `case 'error'`, like every other refusal in this client.
          //
          // NOTHING IS CHECKED LOCALLY FIRST. This file knows what `lootAt` says
          // about the tile and deliberately does not consult it: the M3 rule at
          // the top of this file forbids swallowing an input on this client's own
          // arithmetic, and "there is nothing here" is a sentence the server
          // writes better than a guess made from a frame that may be one pump old.
          //
          // `,` IS CONVENTIONAL AND NOT A PORT. ToME's own mnemonic is `g`
          // (PICKUP_FLOOR, tome/class/Game.lua:2169), and `g` has belonged to our
          // talent panel since v9; keys.ts says so at the binding rather than
          // inventing a citation for the comma.
          sendPickup();
          return;
      }
    },
    onSlot: (slot, shifted) => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * SHIFT PICKS THE PAGE, AND IT IS SET HERE RATHER THAN READ IN THE VIEW.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `talentPage` is a MODE the whole bar reads — the drawing, the hit test,
       * the bind and the unbind all resolve through `cellOfSlot`. Setting it
       * from the press means the key and the picture cannot disagree about
       * which page is live, which is the one bug a paged bar reliably has.
       *
       * THE ROSTER AND THE CLASS CHOOSER BELOW ARE NOT PAGED, and Shift means
       * nothing to either — they read `slot` alone, exactly as they did. A
       * modal that suddenly picked a different card because a modifier was down
       * would be a modal nobody could use with two hands.
       */
      setTalentPage(shifted ? 1 : 0);
      if (roster !== null) {
        // 1-8 PICK A ROW OUTRIGHT, the digits drawn on the cards. `slot` is
        // zero-based, so a digit past the end of the list finds nothing and does
        // nothing — which is the same answer the class chooser gives.
        selectCharacter(slot);
        return;
      }
      if (classOptions !== null) {
        // 1/2/3 PICK A CARD OUTRIGHT. CONVENTIONAL, not ported — ToME's birther
        // has no digit shortcut — and it is advertised on the card itself as
        // `[1]`, the grammar ToME uses for `[L]evelup` (CharacterSheet.lua:99),
        // because a modal that swallows the keyboard owes the player a list of
        // the keys it kept. `slot` is zero-based, so key 4 asks for a fourth card,
        // finds none, and does nothing.
        selectCard(slot);
        return;
      }
      // ═══════════════════════════════════════════════════════════════════════
      // THE DIGITS ARE NEVER REFUSED HERE. THE MENU GETS OUT OF THEIR WAY.
      // ═══════════════════════════════════════════════════════════════════════
      // `layout.menu` comes from `panelBand`, which is what keeps this surface
      // off the hotbar — and the stated reason for that is precisely so that the
      // four talent keys still work while somebody is reading the menu. A GATE
      // here would take them back and leave the geometry arguing for a property
      // the keyboard no longer had, which is the difference between a panel and
      // a modal wearing a panel's clothes. So there is no gate, and there must
      // never be one.
      //
      // ═══ BUT "UNGATED" WAS NOT THE SAME AS "WORKS", AND FOR THREE TALENTS IN
      //     FOUR IT WAS NOT EVEN CLOSE ═══
      // `activateSlot` sends immediately only for `TalentShape.Self`. Everything
      // else opens an AIM — and an aim under an open menu was unreachable from
      // the keyboard in every direction at once: `onMove`'s menu gate sits above
      // `targeting.moveCursor`, `onCommand`'s sits above `targeting.confirm()`
      // and `targeting.cancel()`, and the three menu head links in `onCancel`
      // consume Escape before it can reach the ring either. The player was left
      // with a live targeting cursor, half of it behind the panel, that the
      // keyboard could neither steer, fire nor put away — while the hint line
      // below the panel cheerfully told them to use the arrows and Enter.
      //
      // SO THE MENU CLOSES FIRST AND THEN THE VERB FIRES, which is not a new
      // rule: it is `runMenuEffect`'s `'ui'` case, ported from
      // tome/class/Game.lua:2307-2308's `self:unregisterDialog(menu)` followed by
      // `self.key:triggerVirtual(...)`. The menu's own rows already act this way,
      // so the digit and the row it sits beside now behave identically.
      //
      // UNCONDITIONALLY, AND NOT ONLY FOR A TARGETED SHAPE. Reading
      // `TalentShape` here would put a second copy of `activateSlot`'s branch in
      // front of `activateSlot`, and a key whose effect on the menu depended on
      // which talent happened to be in the slot is a key nobody can predict.
      //
      // NOR COULD THE DIGITS MEAN ANYTHING ELSE HERE. The root screen has SIX
      // entries and `onSlot` only ever reports four, so digits-pick-a-row would
      // reach two thirds of a list — and the rows carry no `[1]` label to
      // advertise it with, unlike the class chooser's cards, because
      // ui/hotbar.ts is already painting those digits on four buttons that mean
      // something else.
      //
      // test/client/keybindwiring.test.ts asserts BOTH halves — that the digit is
      // never refused, and that the close happens before the act — so a later
      // pass cannot undo either without reading this paragraph.
      if (menuOpen) closeMenu();
      sweep?.settle();
      activateSlot(slot);
    },
    onCancel: () => {
      // ═══════════════════════════════════════════════════════════════════════
      // v12 — A LIVE DRAG IS THE FIRST LINK, ABOVE EVEN THE CHOOSER'S SWALLOW.
      // ═══════════════════════════════════════════════════════════════════════
      // Everything else in this handler is a SURFACE; this is the pointer itself.
      // While a gesture is live the canvas `mousemove` handler short-circuits
      // every hover in the client and `overPanel` answers true for the whole
      // screen, so a drag that could not be abandoned would be a state in which
      // the mouse has stopped working and nothing on screen says why. It ends on
      // `window` mouseup and on `window` blur as well — three exits, because
      // there must be no state in which the pointer is captured and input is
      // stuck.
      //
      // ABOVE the picker swallow rather than below it. That swallow exists so a
      // REQUIRED SCREEN cannot be dismissed, and cancelling a gesture dismisses
      // nothing — it puts a panel back where it was. The state is not reachable
      // today (mousedown step 0 consumes every press while the chooser is up, so
      // no grab can be recorded), and ordering it first means it stays unreachable
      // as a matter of this chain rather than of that one.
      if (cancelDrag()) return;
      // ═══ THE CHOOSER SWALLOWS ESCAPE OUTRIGHT, ABOVE THE CHAIN ═══
      //
      // A REQUIRED SCREEN MUST NOT BE DISMISSIBLE. There is no second copy of the
      // `class_options` frame — it is sent once, in the `hello` block — so a
      // player who escaped out of it would be left on a map with a provisional
      // class, no chooser, and nothing on screen saying what happened.
      //
      // AND IT IS ABOVE THE CHAIN RATHER THAN A SEVENTH LINK IN IT. Appending it
      // would mean one press first closed a menu or cleared a notice and only a
      // later press reached the swallow, which is a Escape that sometimes appears
      // to do something on a screen where it must always do nothing.
      if (classOptions !== null) return;
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE WORLD MAP CLOSES ON ESCAPE, AND IT IS HIGH IN THE CHAIN BECAUSE IT
       * COVERS THE WHOLE SCREEN.
       * ═══════════════════════════════════════════════════════════════════════
       * It was reachable only by its own key, which is one exit — and a
       * full-screen overlay with one exit is a trap the moment that key is
       * rebound, conflicts, or is simply forgotten. Reported from play as a map
       * that "won't close".
       *
       * ABOVE the escape menu's links and the token menu, mirroring paint
       * order: this is drawn over all of them, so a press that closed something
       * underneath while a full-screen sheet stayed up would be an Escape that
       * appears to do nothing.
       */
      if (worldMapOpen) {
        worldMapOpen = false;
        requestDraw();
        return;
      }
      sweep?.settle();
      // ═══════════════════════════════════════════════════════════════════════
      // THE ESCAPE MENU'S THREE HEAD LINKS, INNERMOST FIRST — v11.
      // ═══════════════════════════════════════════════════════════════════════
      //
      // BELOW THE PICKER SWALLOW, because a required screen must stay
      // undismissible (see the block above). ABOVE the token menu on the
      // IDENTICAL argument the token menu already makes for itself two
      // paragraphs down: the most recently opened, most modal-feeling surface
      // goes first. Nothing between here and the notice moves by one line.
      //
      // THREE LINKS AND NOT ONE, because the surface genuinely has three depths
      // and the contract is one press per depth. ToME pops exactly one dialog
      // per Escape too — its KeyBinder is pushed OVER GameMenu and
      // `GameMenu.lua:41-43`'s EXIT is a single `unregisterDialog(self)` — so
      // this is upstream's shape as well as ours.
      //
      // THE ARM IS INNERMOST AND IT BINDS NOTHING ON THE WAY OUT. This is the
      // only path that reaches it: while a capture is armed the capture-phase
      // listener consumes every key including this one, so an Escape pressed
      // while armed never arrives here at all — it is answered by `applyCapture`
      // as `Disarmed` (`KeyBinder.lua:98`'s raw-sym compare). The line below is
      // the belt to that listener's braces, and it is what makes "an armed
      // capture cannot outlive one press" true no matter which of the two paths
      // the press took.
      if (menuArmed !== null) {
        menuArmed = null;
        menuMessage = null;
        requestDraw();
        return;
      }
      if (menuOpen && menuScreen === MenuScreen.Keys) {
        // BACK TO THE ROOT, not out of the menu. One press, one level — the same
        // rule the two links below it keep.
        showMenuScreen(MenuScreen.Root);
        return;
      }
      if (menuOpen) {
        closeMenu();
        return;
      }
      // Escape backs out of ONE thing, in the order they were opened, so a
      // single key never does two things at once: an armed key capture, the Keys
      // screen, the escape menu, the token menu, then a walk in progress, then
      // the targeting ring, then the armed revive, then a scrolled-back log,
      // then the notice — and, when every one of those is empty, the menu opens.
      //
      // THE TOKEN MENU IS FIRST OF THE OLDER LINKS because it is the most
      // recently opened of them and the most modal-feeling: it sits over the map
      // with the pointer already on it.
      //
      // ═══ AND THE CHARACTER SHEET IS NOT IN THIS CHAIN AT ALL ═══
      // Deliberately, and for consistency over fidelity. ToME's sheet IS closed
      // by Escape, but ToME's sheet is a registered modal dialog and ours is a
      // panel; porting the dismissal without the modality is the half-port. Here
      // the Case Log and the party pane both cover the map and neither answers to
      // Escape, so adding only the sheet would make this key's behaviour depend on
      // which panel happened to be open — and the contract below is that ONE
      // press backs out of exactly ONE thing, in a fixed order. `c` toggles the
      // sheet, symmetrically with `m` and `p`, and the × on its header is the
      // mouse's copy of that key.
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
      if (record || margin) return;
      // ═══════════════════════════════════════════════════════════════════════
      // THE TAIL LINK: WITH THE CHAIN GENUINELY EMPTY, ESCAPE OPENS THE MENU.
      // ═══════════════════════════════════════════════════════════════════════
      //
      // ═══ AND `clearNotice()` HAD TO BECOME AN EXPLICIT TEST TO GET HERE ═══
      // This used to read `if (!record && !margin) clearNotice();`, and simply
      // appending `openMenu()` after it would have BROKEN the one-thing-per-press
      // contract this whole chain exists to keep — `clearNotice` EARLY-RETURNS
      // when `notice === null`, so it reports nothing about whether it did
      // anything, and one press would have both wiped a refusal off the screen
      // and opened a menu over the map. The test is spelled out here instead;
      // `notice` is module scope and is the same variable `showNotice` writes.
      //
      // THIS IS RECOVERY HATCH (i), AND IT IS A GUARANTEE RATHER THAN A DEFAULT.
      // `cancel` is `rebindable: false` in keymap.ts and its key is compiled in
      // from the permanent floor, so no remap — and no hand-edited character
      // file — can take this route away. That is what lets every other part of
      // this feature assume the menu is always exactly one press from the map.
      if (notice !== null) {
        clearNotice();
        return;
      }
      openMenu();
    },
    onUi: (command) => {
      // ═══ EVERY UI VERB IS SWALLOWED WHILE THE CHOOSER IS UP, AND `t` IS WHY ═══
      //
      // The others would merely be untimely — toggling a panel behind a scrim, or
      // a revive attempt from a body with no class. `Say` is different in kind:
      // `openCommandLine` focuses a REAL DOM `<input>`, so an ungated `t` would
      // move focus outside the canvas with the modal still painted over it. From
      // there keys.ts's `isTextEntry` correctly drops every subsequent keypress,
      // which means the arrows, the digits and Enter all stop reaching the picker
      // — a player looking at a screen they cannot dismiss, typing into a field
      // they cannot see, on the one screen with no way around it.
      if (classOptions !== null) return;
      // ═══ THE MENU TAKES `Say` AND NOTHING ELSE, AND THAT IS NOT ASYMMETRY ═══
      //
      // `#cmd` IS OUT OF REACH WHILE THE MENU IS OPEN (`syncCommandLineReach`),
      // so `openCommandLine` would call `focus()` on a disabled input and the
      // key would do exactly nothing — the silent no-op this file's header calls
      // the worst failure mode there is, arriving through the one verb that
      // reaches outside the canvas.
      //
      // EVERY OTHER UI VERB IS LET THROUGH ON PURPOSE. `c`, `g` and `i` toggle
      // their panels while the menu is open — they are the same act the menu's
      // own rows perform, so swallowing them would make three keys dead in front
      // of a screen advertising exactly those three things. `m`, `p`, revive and
      // respawn are ordinary play, and this is a panel: play does not stop
      // because somebody opened it.
      if (menuOpen && command === UiCommand.Say) {
        showNotice('close the menu first — Escape');
        return;
      }
      sweep?.settle();
      // ONE COPY OF THE SEVEN VERBS, shared with the menu's rows. See
      // `runUiCommand`: a row that reimplemented a toggle is `Game.lua:2307`'s
      // own mistake, and upstream does not make it either.
      runUiCommand(command);
    },
    onScroll: (steps, alternate) => {
      // Swallowed with the rest of the keyboard: the Case Log is behind the
      // scrim, and scrolling a transcript nobody can read is a key that appears
      // to do nothing, which is the same failure as a key that does nothing.
      if (classOptions !== null) return;
      // ═══ THE KEYS SCREEN TAKES THE SCROLL KEYS AS ITS PAGER ═══
      //
      // It is the only surface in this client with more rows than fit, and PREV
      // and NEXT are drawn on its footer — so the keys that mean "further back"
      // and "further forward" everywhere else mean the same thing here, and the
      // mouse and the keyboard reach one pager rather than two.
      //
      // ROOT IS DELIBERATELY NOT GATED: six entries always fit, there is no
      // footer and therefore nothing to page, so the Case Log keeps the keys and
      // a player can still scroll the transcript with the root menu up. A gate
      // there would be a key that visibly did nothing, which is what the
      // chooser's own gate three lines above exists to prevent.
      //
      // THE SIGN IS FLIPPED ON PURPOSE. `+1` from keymap.ts is BACK IN TIME —
      // Page Up — and back in a paged list is the EARLIER page, so the key that
      // scrolls a transcript upwards moves this screen upwards too. Reading the
      // number straight through would have made Page Up mean "later", which is
      // the one thing no Page Up has ever meant.
      if (menuOpen && menuScreen === MenuScreen.Keys) {
        pageMenu(steps > 0 ? -1 : 1);
        return;
      }
      // SHIFT PICKS THE MARGIN. That mapping lives here and not in keys.ts,
      // because which lane a modifier selects is a fact about a panel and keys.ts
      // deliberately knows nothing about panels.
      caseLog?.scroll(alternate ? LogLane.Margin : LogLane.Record, steps * SCROLL_STEP);
    },
  });

  // ═══ TRAVEL INTERRUPT (2): ANY KEY AT ALL STOPS THE WALK ═══
  //
  // AND IT IS NOT A `KeyHandlers` MEMBER, WHICH LOOKS LIKE AN OVERSIGHT AND IS
  // NOT. `bindGameKeys` dispatches only keys it has a meaning for: its terminal
  // `if (command === undefined) return;` drops an unmapped key on the floor, and
  // its `isTextEntry(event.target)` guard drops EVERY key while a text entry has
  // focus. So a rule phrased as "any keyboard input cancels travel" is
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
    //
    // ═══ EXCEPT THE BAR'S PAGE, WHICH IS NOT AN OPINION ABOUT THE KEY ═══
    // `setTalentPage` reads a MODIFIER, never a key: it does not consume the
    // event, does not preventDefault, and does not care which key arrived. The
    // keymap owns what `Shift+2` DOES; this owns what the player can SEE while
    // Shift is down, which is the difference between a second page and a second
    // page nobody can find.
    setTalentPage(event.shiftKey ? 1 : 0);
    cancelTravel();
  });

  /**
   * AND THE PAGE FALLS BACK THE MOMENT SHIFT IS RELEASED.
   *
   * ON `window`, AND ALSO ON `blur`. A keyup that arrives while the tab is
   * unfocused never arrives at all — alt-tabbing with Shift held is the
   * ordinary way to get a modifier stuck — and a bar frozen on page 2 with no
   * way back is a bar where the player's reliable attack has vanished. Three
   * exits for a state that must not stick, which is the same rule the drag
   * gesture keeps two hundred lines up.
   */
  window.addEventListener('keyup', (event: KeyboardEvent) => {
    setTalentPage(event.shiftKey ? 1 : 0);
  });
  window.addEventListener('blur', () => {
    setTalentPage(0);
  });

  // --- the mouse -----------------------------------------------------------
  // Hover moves the cursor, left click confirms, right click cancels. The
  // keyboard remains the primary input — this is for the player who reaches for
  // the mouse to point at a tile across the room, which is what people in a
  // voice channel actually do.

  /**
   * Which hotbar slot a pointer event is over, or -1.
   *
   * ═══ THE COUNT IS `hotbarView().slots.length`, AND IT USED TO BE FOUR ═══
   * `hotbarSlotAt` centres the row on the count it is GIVEN, exactly as
   * `drawHotbar` centres it on the slots it is given. `loadout.length` was
   * correct only while the view returned four slots; the moment it returned eight
   * the painter centred a 604-pixel row and this centred a 300-pixel one, so
   * every hover and every click landed on the wrong box or on nothing — at every
   * viewport, with no line of ui/hotbar.ts having changed. Asking the VIEW is
   * what makes that class of bug unreachable rather than merely fixed: there is
   * one number and both readers take it from the same place.
   *
   * Rebuilding the view per pointer move is eight small objects and a `find`,
   * which is nothing beside `inventoryPanelRows` — already rebuilt on the same
   * events — and much less than a second copy of "how many slots are there".
   */
  function slotUnder(event: MouseEvent): number {
    const point = renderer.backbufferPoint(event.clientX, event.clientY);
    if (point === null) return -1;
    const { logicalW, logicalH } = renderer.metrics();
    return hotbarSlotAt(point.x, point.y, hotbarView().slots.length, logicalW, logicalH);
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
    // ═══ v12 — A LIVE DRAG ANSWERS TRUE FOR THE WHOLE SCREEN, LETTERBOX AND ALL ═══
    // The same shape the class picker takes four lines below, for the same
    // reason: while a gesture owns the pointer there is no tile underneath worth
    // reaching. Without it a release over bare map falls through the swallow at
    // the foot of `mousedown` into the travel branch, and the party walks across
    // the room at the end of every drag — an interaction the player will read as
    // "dragging a window makes everybody run".
    //
    // ABOVE the `point === null` guard, deliberately: "not on the backbuffer" is
    // not a reason to let a gesture through while one is in flight.
    if (drag !== null) return true;
    const { logicalW, logicalH } = renderer.metrics();
    const layout = hudLayout(logicalW, logicalH);
    // ═══ THE CHOOSER ANSWERS TRUE FOR THE WHOLE SCREEN, LETTERBOX INCLUDED ═══
    // Above the `point === null` guard on purpose: "not on the backbuffer" is not
    // a reason to let a gesture through while a modal is up, and this is the one
    // surface for which there is no tile underneath worth reaching.
    if (layout.picker !== null) return true;
    const point = renderer.backbufferPoint(clientX, clientY);
    if (point === null) return false;
    if (point.y < layout.hudTop) return true;
    if (tokenMenu?.contains(point.x, point.y) === true) return true;
    if (respawnPromptHit(layout.respawn, point.x, point.y)) return true;
    // THE CHARACTER SHEET IS A PANEL LIKE THE OTHER TWO, and it has to be listed
    // here or hovering it drags the targeting cursor across whatever tiles are
    // underneath — and worse, sends an `inspect` per settle for each body it
    // passes over, spending the socket's token bucket on a panel the pointer is
    // resting on. See HOVER_SETTLE_MS: an exhausted bucket answers `error`, which
    // cancels the player's aim.
    // THE TALENT PANEL IS LISTED FOR THE SHEET'S OWN REASONS AND ONE MORE. Left
    // out, hovering it would drag the targeting cursor across whatever tiles are
    // underneath and send an `inspect` per settle for each body it passed over —
    // and an exhausted token bucket answers `error`, which cancels the player's
    // aim (see HOVER_SETTLE_MS). The extra reason is that this panel HAS a
    // control: an unswallowed click beside the `+` would walk the party across
    // the room while somebody was deciding where to put a point.
    // AND THE INVENTORY PANEL IS THE THIRD, FOR BOTH OF THOSE REASONS AT ONCE.
    // Omitting it would drag the targeting cursor across whatever tiles are under
    // a solid panel and fire an `inspect` per hover-settle for every body it
    // passed over — and an exhausted token bucket answers `error`, which cancels
    // the player's aim (the reason given verbatim above, and at HOVER_SETTLE_MS).
    // It also has MORE controls than either sibling — two tabs, up to twelve
    // cells, a DROP button — so an unswallowed click beside one of them would
    // walk the party across the room while somebody was choosing a coat.
    // ...AND THE ESCAPE MENU IS THE FOURTH, FOR ALL OF THOSE REASONS AT ONCE AND
    // MORE OF THEM. Omitting it would drag the targeting cursor across whatever
    // tiles are under a solid panel and fire an `inspect` per hover-settle for
    // every body it passed over — and an exhausted token bucket answers `error`,
    // which cancels the player's aim (the reason given verbatim above, and at
    // HOVER_SETTLE_MS). It also carries MORE controls than any sibling: a close
    // ×, six entries, two key columns and two buttons on every one of
    // twenty-six rows, RESET ALL, BACK and a pager. An unswallowed click beside
    // any of them would walk the party across the room while somebody was
    // fixing their keyboard.
    return (
      inRect(layout.pane?.rect ?? null, point.x, point.y) ||
      inRect(layout.log, point.x, point.y) ||
      inRect(layout.sheet, point.x, point.y) ||
      inRect(layout.talents, point.x, point.y) ||
      inRect(layout.inventory, point.x, point.y) ||
      inRect(layout.menu, point.x, point.y)
    );
  }

  canvas.addEventListener('mousemove', (event) => {
    // ═══════════════════════════════════════════════════════════════════════
    // v12 — A LIVE DRAG SHORT-CIRCUITS THIS ENTIRE HANDLER, ON THE FIRST LINE.
    // ═══════════════════════════════════════════════════════════════════════
    // The offset (or the ghost's position) is updated by the WINDOW listener —
    // see `onDragMove` and the note there about why move and release cannot live
    // on the canvas — and everything below is suppressed while one is in flight.
    //
    // IT IS NOT A TIDY-UP. Every line under here does real work per pointer
    // event: `slotUnder` rebuilds the hotbar view, `inventoryPanelRows` rebuilds
    // the whole doll AND the bag, `escapeMenuRows` builds twenty-six rows with
    // four formatted strings each, and `noteHoveredActor` drives a settle-gated
    // `inspect` ON THE WIRE. A drag is the one gesture in this client that fires
    // mousemove continuously for a second or more, so leaving it unsuppressed
    // would spend the socket's 20-frame bucket on hovering — and `overPanel`'s
    // own note says what an exhausted bucket costs: the server answers `error`,
    // and this client turns that into a refusal AND cancels the player's aim.
    // Somebody dragging the inventory panel would cancel a teammate's shot.
    if (drag !== null) return;

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
      const layout = hudLayout(logicalW, logicalH);
      const over = respawnPromptHit(layout.respawn, point.x, point.y);
      if (over !== respawnHovered) {
        respawnHovered = over;
        requestDraw();
      }
      // THE THIRD HOVER THAT MEANS "THIS IS PRESSABLE": the sheet's × . Same
      // shape as the plate above and for the same reason — it reports whether
      // anything CHANGED, so a pointer crossing the panel cannot queue a draw per
      // pixel and turn this client's dirty-flag renderer into a 60 fps one.
      const sheetHit =
        layout.sheet === null ? null : charSheetHitAt(layout.sheet, point.x, point.y);
      const overClose = sheetHit === 'close';
      if (overClose !== sheetCloseHovered) {
        sheetCloseHovered = overClose;
        requestDraw();
      }
      // ...AND THE `[G]` CONTROL BESIDE IT, the sheet's ported route to the
      // talent panel (ui/charsheet.ts, CharacterSheet.lua:99).
      const overTalentsBtn = sheetHit === 'talents';
      if (overTalentsBtn !== sheetTalentsHovered) {
        sheetTalentsHovered = overTalentsBtn;
        requestDraw();
      }
      // THE TALENT PANEL'S OWN TWO HOVERS: its × and whichever row the pointer is
      // on. Same shape as every hover above and for the same reason — each
      // reports whether anything CHANGED, so a pointer crossing the panel cannot
      // queue a draw per pixel and turn this client's dirty-flag renderer into a
      // 60 fps one. The row hover is what draws the 1px ring, which is the only
      // thing on the panel that says a row is a thing you can press.
      const talentHit =
        layout.talents === null
          ? null
          : talentPanelHitAt(layout.talents, talentPanelRows(talentPanelView()), point.x, point.y);
      const overTalentClose = talentHit?.kind === TalentHitKind.Close;
      if (overTalentClose !== talentsCloseHovered) {
        talentsCloseHovered = overTalentClose;
        requestDraw();
      }
      // THE GRID'S HOVER, AND ONLY THE GRID'S. The × and the attribute column
      // are on this panel too and neither carries a row index — an attribute is
      // named, not numbered, because `spend_stat` names one of six.
      const overTalentRow =
        talentHit !== null &&
        talentHit.kind !== TalentHitKind.Close &&
        talentHit.kind !== TalentHitKind.Stat
          ? talentHit.index
          : null;
      if (overTalentRow !== talentsHoveredRow) {
        talentsHoveredRow = overTalentRow;
        requestDraw();
      }
      /**
       * ═══ AND THE DESCRIPTION COLUMN FOLLOWS THE POINTER ═══
       * `talentTipAt` resolves the CELL under the pointer, which the hit test
       * cannot: an index alone does not name a talent once there are categories,
       * because index 0 means something different in every one of them. Reusing
       * it here is also what keeps the pane and the card describing the same
       * icon on the window sizes where both could exist.
       *
       * A POINTER OVER NOTHING LEAVES THE PANE ALONE. See `talentFocusId`.
       */
      if (layout.talents !== null) {
        const focused = talentIdAt(
          layout.talents,
          talentPanelRows(talentPanelView()),
          point.x,
          point.y,
        );
        if (focused !== null && focused !== talentFocusId) {
          talentFocusId = focused;
          requestDraw();
        }
      }
      // ═══ THE INVENTORY PANEL'S FOUR HOVERS, IN THE BLOCK ABOVE'S SHAPE ═══
      // Its ×, its DROP control, the cell under the pointer, and the sticky focus
      // the comparison strip is about. Every one of them compares against the
      // stored value and redraws ONLY on a change, for the reason every hover in
      // this handler does: an unconditional `requestDraw` per mousemove turns this
      // client's dirty-flag renderer into a 60 fps one, which the header at the
      // top of this file forbids at length — and this panel is the biggest target
      // on the screen, so a pointer crossing it is the worst case.
      //
      // ONE HIT TEST FEEDS ALL FOUR. `inventoryPanelRows` walks the doll and the
      // bag, so asking four times per pointer move would do that work four times.
      const invHit =
        layout.inventory === null
          ? null
          : inventoryPanelHitAt(
              layout.inventory,
              inventoryPanelRows(inventoryPanelView()),
              point.x,
              point.y,
            );
      const overInvClose = invHit?.kind === InventoryHitKind.Close;
      if (overInvClose !== invCloseHovered) {
        invCloseHovered = overInvClose;
        requestDraw();
      }
      const overInvDrop = invHit?.kind === InventoryHitKind.Drop;
      if (overInvDrop !== invDropHovered) {
        invDropHovered = overInvDrop;
        requestDraw();
      }
      // THE TRANSIENT RING — what is under the pointer right now. It clears when
      // the pointer leaves a cell, which is the whole difference between it and
      // the focus below.
      const overInvCell = focusForHit(invHit);
      if (!sameInvFocus(overInvCell, invHovered)) {
        invHovered = overInvCell;
        requestDraw();
      }
      // ═══ ...AND THE STICKY ONE, WHICH IS ONLY EVER *SET*, NEVER CLEARED ═══
      // `if (overInvCell !== null)` is the entire mechanism and it is load-bearing:
      // the DROP control lives INSIDE the comparison strip, so the pointer has to
      // leave the cell to reach it. A focus that followed the pointer off the cell
      // would empty the strip on the way there and make DROP unreachable by
      // construction. ui/inventory.ts's `InventoryFocus` states the same rule from
      // the other end, and `focusForHit` is imported rather than reimplemented so
      // that hover and click cannot disagree about what the strip is about.
      if (overInvCell !== null && !sameInvFocus(overInvCell, invFocus)) {
        invFocus = overInvCell;
        requestDraw();
      }
      // ═══ THE ESCAPE MENU'S TWO HOVERS, IN THE HOUSE SHAPE ═══
      // Its × and whichever ROOT ENTRY the pointer is on. ONE hit test feeds
      // both — `escapeMenuRows` walks the whole action table and formats four
      // strings per row, so asking twice per pointer move would do that work
      // twice — and each compares against the stored value and redraws ONLY on a
      // change, for the reason every hover in this handler does: an
      // unconditional `requestDraw` per mousemove turns this client's dirty-flag
      // renderer into a 60 fps one, which the header at the top of this file
      // forbids at length.
      //
      // `menuHovered` IS ALSO THE ARROW KEYS' SELECTION (see its declaration),
      // so this line is what makes a mouse that moves take the keyboard's
      // selection with it — which is the behaviour of every menu that answers to
      // both, and the alternative is two lit rows and no way to tell which one
      // Enter is about.
      // THE HIT TEST IS SKIPPED ENTIRELY WHEN THE POINTER IS NOT ON THE PANEL,
      // and that is two things at once. It is the cheap half — a pointer crossing
      // the map must not rebuild twenty-six rows per event — and it is what stops
      // a mouse that merely twitched somewhere else from wiping out a selection
      // the ARROW KEYS made. Inside the panel the pointer owns the highlight;
      // outside it, it leaves it alone.
      const overMenu = inRect(layout.menu, point.x, point.y);
      const menuHit =
        layout.menu === null || !overMenu
          ? null
          : escapeMenuHitAt(layout.menu, menuRows(), point.x, point.y);
      const overMenuClose = menuHit?.kind === MenuHitKind.Close;
      if (overMenuClose !== menuCloseHovered) {
        menuCloseHovered = overMenuClose;
        requestDraw();
      }
      if (overMenu) {
        const overMenuEntry = menuHit?.kind === MenuHitKind.Entry ? menuHit.index : null;
        if (overMenuEntry !== menuHovered) {
          menuHovered = overMenuEntry;
          requestDraw();
        }
      }
      // AND THE CARD UNDER THE POINTER, while the chooser is up. `null` when it
      // is down, so nothing is left highlighted behind a modal that has closed.
      const card =
        layout.picker === null || classOptions === null
          ? null
          : classPickerHitAt(classOptions, layout.picker, point.x, point.y);
      const hoveredCard =
        card !== null && card.kind === ClassPickerHitKind.Card ? card.index : null;
      if (hoveredCard !== pickerHovered) {
        pickerHovered = hoveredCard;
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
      // ═══ THE MOUSE'S COPY OF `onScroll`, AND IT OBEYS THE SAME TWO RULES ═══
      // The keyboard's scroll is gated on the chooser because "scrolling a
      // transcript nobody can read is a key that appears to do nothing"; the
      // wheel is the same act with a different input device and was left
      // ungated, so rolling it over the log's rect scrolled the Case Log behind
      // the scrim. The sheet is the second rule and the same one step 4 of
      // `mousedown` enforces: it is painted OVER the log and the two rects
      // overlap on ordinary windows, so the wheel must not reach through it.
      //
      // ═══ THE TALENT PANEL IS IN THIS GUARD, AND IT IS NOT A WHEEL GATE ═══
      // It consumes nothing: the panel has no scroll position, no scrollbar and
      // no hit test for one (ui/talents.ts, "NO SCROLLING"), and rolling the
      // wheel over it does nothing at all. What this line stops is the wheel
      // reaching a DIFFERENT panel drawn UNDERNEATH it, which is exactly the rule
      // the sheet is here for and the two rects overlap on ordinary windows for
      // exactly the same reason: both are centred on the assumption that the two
      // docks own the sides, and neither consults the log's rect.
      if (classOptions !== null) return;
      const point = renderer.backbufferPoint(event.clientX, event.clientY);
      // On the letterbox bars there is no world under the pointer and no panel
      // either, so there is nothing to zoom TOWARD. Leave it alone.
      if (point === null) return;

      const { logicalW, logicalH } = renderer.metrics();
      const wheelLayout = hudLayout(logicalW, logicalH);
      // ═══ THE ESCAPE MENU FIRST, MIRRORING THE PAINT ORDER, AND IT IS AN
      //     OCCLUSION GUARD RATHER THAN A SCROLL GATE ═══
      // The same distinction the two paragraphs above draw for the talent and
      // inventory panels. It consumes NO wheel: the Keys screen pages with its
      // own PREV/NEXT buttons and with the scroll KEYS, and a wheel that also
      // paged would be a third way to move one list — the kind of duplication
      // that ends with two of the three disagreeing about the clamp. What this
      // line stops is the wheel reaching a DIFFERENT panel drawn UNDERNEATH it,
      // and the overlap is not exotic: this panel is centred like the other
      // three and is WIDER than all of them.
      //
      // NO `preventDefault` HERE, deliberately, because nothing is consumed —
      // the call below is reached only when the wheel lands on a log lane, and
      // that is the branch that owns the suppression. If paging is ever wheeled,
      // this line must gain one, or the activity iframe scrolls and drags the
      // canvas out of view.
      if (inRect(wheelLayout.menu, point.x, point.y)) return;
      if (inRect(wheelLayout.sheet, point.x, point.y)) return;
      if (inRect(wheelLayout.talents, point.x, point.y)) return;
      // AND THE INVENTORY PANEL, WHICH IS AN OCCLUSION GUARD AND NOT A SCROLL
      // GATE — the same distinction the paragraph above draws for the talent
      // panel. This panel consumes nothing: it has no scroll position, no
      // scrollbar and no hit test for one (ui/inventory.ts, "NO SCROLLING", which
      // is honest because the server caps a bag at twelve and twelve fits on one
      // page). What this line stops is the wheel reaching a DIFFERENT panel drawn
      // UNDERNEATH it, and the overlap is not exotic: this one is centred
      // horizontally like the other two, on the same assumption that the docks own
      // the sides.
      if (inRect(wheelLayout.inventory, point.x, point.y)) return;
      /**
       * `?.` RATHER THAN AN EARLY BAIL ON A MISSING LOG, and the difference is
       * an ordering bug a test caught before this shipped.
       *
       * The first version returned early when `caseLog` was null — ABOVE the
       * panel guards — so before the log existed a wheel rolled over the escape
       * menu would have zoomed the map underneath it. No log simply means no
       * lane can claim the wheel, which is what the fall-through below already
       * handles; it is not a reason to skip the occlusion guards.
       */
      const lane = caseLog?.laneAt(point.x, point.y) ?? null;
      if (lane === null) {
        /**
         * ═══════════════════════════════════════════════════════════════════
         * NOTHING CLAIMED THE WHEEL, SO IT ZOOMS. THE POSITION OF THIS LINE IS
         * THE WHOLE FEATURE.
         * ═══════════════════════════════════════════════════════════════════
         * Every `return` above is a surface saying "this wheel is mine, or I am
         * drawn over something whose it would be" — the chooser, the escape
         * menu, the sheet, the talent panel, the inventory, and a Case Log lane
         * just above. Reaching here means the pointer is over the WORLD, and
         * over the world a wheel means zoom.
         *
         * Written as a fall-through rather than as its own hit test on purpose.
         * A test of the form "is the pointer NOT over any panel" would be a
         * second copy of that list, and the copy would be the one that went
         * stale the next time a panel was added — silently, because the symptom
         * is a wheel that zooms the map while it looks like it is scrolling a
         * transcript. Here a new panel gets its guard in one place and this
         * inherits it.
         *
         * UP IS IN, which is what every map in every application does. The
         * `-`/`=` keys and this share `setZoom`, so the clamp is stated once.
         */
        event.preventDefault();
        applyZoom(renderer.zoom() + (event.deltaY < 0 ? 1 : -1));
        requestDraw();
        return;
      }
      event.preventDefault();
      // Wheel up (negative deltaY) goes BACK in time, which is what every
      // document and every chat client does.
      // A lane can only be non-null if the log exists, but the compiler cannot
      // see that across the branch above.
      caseLog?.scroll(lane, event.deltaY < 0 ? SCROLL_STEP : -SCROLL_STEP);
    },
    { passive: false },
  );

  canvas.addEventListener('mouseleave', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // v12 — THIS DELIBERATELY DOES *NOT* TOUCH `drag`, AND THAT IS LOAD-BEARING.
    // ═══════════════════════════════════════════════════════════════════════
    // The canvas is one row of a flex column: `#cmdrow` and `#log` sit directly
    // under it, so a pointer dragged towards the bottom of the screen crosses off
    // the canvas WITH THE BUTTON STILL DOWN and fires this. Clearing the gesture
    // here would abandon a drag the player is still making, halfway through, and
    // the panel would snap back for no stated reason. The drag ends on `window`
    // mouseup, on `window` blur, and on Escape — three exits, none of them a
    // pointer crossing an element boundary.
    //
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

  // -------------------------------------------------------------------------
  // v12 — THE DRAG. Four functions, three `window` listeners, and no capture.
  // -------------------------------------------------------------------------

  /**
   * Start a gesture. Records the grab; starts nothing until the sixth pixel.
   *
   * `click` IS WHAT THE PRESS MEANT IF THE POINTER NEVER TRAVELS. A press on an
   * inventory cell cannot equip on `mousedown`, because that same press may turn
   * out to be the beginning of a drag onto the hotbar — so the act is deferred
   * here and run by `endDrag` only when the threshold was not passed. A press on
   * a panel HEADER passes null: a header has never done anything on click, so a
   * sub-threshold release correctly does nothing at all.
   */
  function beginDrag(
    subject: DragSubject,
    grabX: number,
    grabY: number,
    click: (() => void) | null,
  ): void {
    drag = {
      subject,
      grabX,
      grabY,
      offsetAtGrab: subject.kind === DragKind.Panel ? panelOffsets[subject.panel] : NO_OFFSET,
      click,
      moved: false,
      at: { x: grabX, y: grabY },
    };
  }

  /**
   * The pointer moved while a gesture is live. Called from the WINDOW listener.
   *
   * ═══ IT REDRAWS ON A *CHANGE* AND NOT PER EVENT ═══
   * The comparison against `at` is the same rule every hover in the canvas
   * `mousemove` handler keeps: an unconditional `requestDraw` per pointer event
   * turns this client's dirty-flag renderer into a 60fps one, which the header at
   * the top of this file forbids at length. A drag is the worst case for it,
   * because it is the one gesture that fires continuously for a second or more.
   *
   * `backbufferPoint` ANSWERS NULL OFF THE BACKBUFFER — the letterbox, or the
   * chat row below the canvas — and that clears the ghost rather than freezing it
   * at the edge. The GESTURE survives: the player is still holding the button and
   * is on their way somewhere, and a drag that gave up because the pointer
   * clipped a letterbox would be a drag that fails on small windows only.
   */
  function onDragMove(clientX: number, clientY: number): void {
    const live = drag;
    if (live === null) return;
    const point = renderer.backbufferPoint(clientX, clientY);
    if (point === null) {
      if (live.at === null) return;
      live.at = null;
      requestDraw();
      return;
    }
    if (live.at !== null && live.at.x === point.x && live.at.y === point.y) return;
    live.at = point;
    if (!live.moved) {
      // BELOW THE THRESHOLD THE PANEL DOES NOT MOVE AT ALL. `passesThreshold` is
      // Mouse.lua:177 verbatim — Chebyshev, strictly greater than 6 — so a firm
      // click on a header with an unsteady hand is still a click.
      if (!passesThreshold(live.grabX, live.grabY, point.x, point.y)) return;
      live.moved = true;
    }
    const subject = live.subject;
    if (subject.kind === DragKind.Panel) {
      panelOffsets[subject.panel] = nextOffset(
        live.offsetAtGrab,
        live.grabX,
        live.grabY,
        point.x,
        point.y,
      );
    } else {
      springInventoryTab(point);
    }
    requestDraw();
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOLDING AN ITEM OVER THE OTHER TAB TURNS THE PANEL OVER. Mid-gesture.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ═══ WITHOUT THIS, THE PAPER DOLL IS A DROP TARGET NOBODY CAN REACH ═══
   * The doll and the bag are on MUTUALLY EXCLUSIVE tabs (`inventoryPanelRows`
   * pushes a `Doll` row on Equipped and `Cells` rows on Carried, never both), so
   * a carried item picked up on the Carried tab is being dragged across a panel
   * that is not showing a single doll cell, and a worn item picked up on the
   * Equipped tab is being dragged across a panel showing no bag. Both drop
   * branches in `resolveDrop` were therefore unreachable, and so was the
   * `ui_inventory_cell_hover` plate the doll paints on a valid target: three
   * pieces of working code with no route to them, which is trap 2 of the brief
   * (a control that does nothing) hiding as trap 3 (an invisible prerequisite).
   *
   * SPRING-LOADED RATHER THAN A SECOND COPY OF THE BAG ON THE DOLL TAB, because
   * the doll's height budget is spoken for to the pixel: ui/inventory.ts:273-298
   * shows three rows of cells fitting into 250 logical pixels with twelve to
   * spare on the smallest viewport this client renders at, so there is no room
   * for a carried strip beside it and a fourth row is already refused. Hovering a
   * folder to open it is the oldest gesture in this shape and it costs no pixels
   * at all.
   *
   * IT ONLY EVER SWITCHES TO THE TAB THE DRAG IS *GOING* TO, and that falls out
   * of the geometry rather than needing a rule: a carried item can only have been
   * picked up on Carried, so the one tab it can spring to is Equipped, and a worn
   * item's only spring is back to Carried. The `hit.tab === invTab` comparison is
   * what makes it idempotent while the pointer sits on the tab.
   *
   * THE COST IS PAID ONLY OVER THE PANEL. `inventoryPanelRows` walks the whole
   * doll and the whole bag, which is exactly the work the canvas `mousemove`
   * short-circuit exists to keep out of a gesture, so the rect test comes first
   * and a drag anywhere else on the screen does nothing here. Nothing is sent —
   * a tab is client-local, as `runInventoryHit`'s Tab case says.
   */
  function springInventoryTab(point: TileXY): void {
    const { logicalW, logicalH } = renderer.metrics();
    const layout = hudLayout(logicalW, logicalH);
    if (!inRect(layout.inventory, point.x, point.y) || layout.inventory === null) return;
    const hit = inventoryPanelHitAt(
      layout.inventory,
      inventoryPanelRows(inventoryPanelView()),
      point.x,
      point.y,
    );
    if (hit === null || hit.kind !== InventoryHitKind.Tab || hit.tab === invTab) return;
    invTab = hit.tab;
  }

  /**
   * WHERE AN ITEM RELEASED HERE LANDS. Three targets, and a miss is a miss.
   *
   * THE HOTBAR IS ASKED FIRST because it is painted last and is the only surface
   * a release can be aimed at from outside a panel. `hotbarDropTargetAt` answers
   * `Talent` rather than `Miss` for slots 1-4 precisely so that this function has
   * to REFUSE IN WORDS: a coat dragged onto slot 2 that silently snapped back
   * would be the "control that does nothing" trap with the control being the
   * whole left half of the bar.
   *
   * THEN THE INVENTORY PANEL, THROUGH ITS ORDINARY HIT TEST. There is no
   * release-only outcome and deliberately none was added (ui/inventory.ts):
   * `EmptySlot { slot }` and `Item { slot, worn }` are already everything a drop
   * needs, and the item's identity comes from the DRAG rather than from the
   * target. A second code path for "the pointer was down when it got here" would
   * be a second copy of the panel's geometry.
   *
   * THE DESTINATION SLOT IS NOT CHECKED HERE, and that is the same rule the
   * panel's own click keeps: `equip` names an ITEM and the server reads the
   * destination off the authored catalogue (protocol.ts's `EquipSchema`). A
   * browser deciding that a coat may not be dropped on the HEAD cell would be a
   * second copy of the catalogue, and it would be the copy that went stale.
   */
  function resolveDrop(live: LiveDrag, point: TileXY | null): void {
    const subject = live.subject;
    // A PANEL DRAG HAS NOTHING TO RESOLVE. Its whole effect is the offset, which
    // `onDragMove` has already applied, `hudLayout` has already clamped and
    // `settlePanel` is about to bank.
    if (subject.kind === DragKind.Panel || point === null) return;

    const { logicalW, logicalH } = renderer.metrics();
    const drop = hotbarDropTargetAt(
      point.x,
      point.y,
      hotbarView().slots.length,
      logicalW,
      logicalH,
    );
    switch (drop.kind) {
      case HotbarDropKind.Bind:
        bindItemSlot(drop.index, subject);
        return;
      case HotbarDropKind.Talent:
        /**
         * A TALENT LANDS; AN ITEM IS STILL REFUSED IN WORDS.
         *
         * The refusal used to be unconditional — "slot n is a class talent" —
         * because a talent slot was `loadout[n]` and nothing could be put on
         * it. Half of that is now wrong and half is still exactly right, and
         * the sentence has to tell them apart: an item on a talent slot is a
         * mistake worth naming, and the naming is what stops a player
         * concluding the bar is broken.
         */
        if (subject.kind === DragKind.Talent) {
          bindTalentSlot(drop.index, subject.talentId);
        } else {
          showNotice(
            `slot ${String(drop.index + 1)} takes a talent — items go on slots ${String(HOTBAR_TALENT_SLOTS + 1)}-${String(HOTBAR_SLOTS)}`,
          );
        }
        return;
      case HotbarDropKind.Miss:
        break;
    }

    const layout = hudLayout(logicalW, logicalH);
    if (layout.inventory === null) return;
    const hit = inventoryPanelHitAt(
      layout.inventory,
      inventoryPanelRows(inventoryPanelView()),
      point.x,
      point.y,
    );
    if (hit === null) return;
    // A BAG ITEM ONTO A DOLL CELL — filled or empty — IS `equip`. That is the
    // gesture the paper doll exists to invite, and it is the same frame the
    // panel's own click already sends.
    if (
      subject.kind === DragKind.Carried &&
      (hit.kind === InventoryHitKind.EmptySlot || (hit.kind === InventoryHitKind.Item && hit.worn))
    ) {
      sendEquip(subject.itemId);
      return;
    }
    // ...AND A WORN ITEM ONTO THE BAG IS `unequip`, THE SAME GESTURE BACKWARDS.
    // `unequip` names a SLOT rather than an item (protocol.ts:1938-1942), and the
    // drag has carried that slot since the grab.
    if (subject.kind === DragKind.Worn && hit.kind === InventoryHitKind.Item && !hit.worn) {
      sendUnequip(subject.slot);
      return;
    }
    // ═══ RELEASED BACK ON THE CELL IT CAME FROM: THAT IS THE CLICK, NOT A DROP ═══
    // The 6px threshold turns a shaky press into a gesture, and before this branch
    // existed the shaky press was SWALLOWED — `beginDrag` deferred the equip, the
    // release found no target, and the item did not move, the strip did not
    // update and nothing was said. "Clicking the item sometimes doesn't work" is
    // how that reads from the chair, and a seven-pixel tremor on a click is
    // ordinary. A release over the SAME cell is unambiguous: the player pressed a
    // thing and let go of it in the same place, which is a click in every
    // interface anybody has used, so the deferred act runs.
    //
    // THE SAME CELL AND NOT MERELY THE SAME PANEL. Dragging a worn coat across
    // the panel and letting go somewhere else still means "never mind" — running
    // the click there would take the coat OFF as the price of an abandoned drag.
    if (hit.kind === InventoryHitKind.Item && sameSubject(subject, hit)) {
      live.click?.();
      return;
    }
    // ANYTHING ELSE PUTS IT BACK, SILENTLY. A drag released over nothing in
    // particular means "never mind" in every interface anybody has used, and a
    // sentence for it would fire on the most common way a player abandons a
    // gesture they started by accident.
  }

  /**
   * Is this hit the very cell the drag was picked up from?
   *
   * ONE COMPARISON PER KIND, and each uses the identifier that kind is NAMED by —
   * a carried item by its `itemId`, a worn item by its `Slot` — for the reason
   * ui/drag.ts's `DragSubject` gives: those are the two identifiers the verbs
   * take, and comparing a worn item by id would be comparing a field the unequip
   * frame does not carry.
   */
  function sameSubject(
    subject: DragSubject,
    // `slot` OPTIONAL because a draught has none — and a Worn drag can never
    // match one, which the `hit.worn` term already decides.
    hit: { readonly itemId: string; readonly slot?: Slot; readonly worn: boolean },
  ): boolean {
    if (subject.kind === DragKind.Carried) return !hit.worn && hit.itemId === subject.itemId;
    if (subject.kind === DragKind.Worn) return hit.worn && hit.slot === subject.slot;
    return false;
  }

  /**
   * The button came up. THE ONLY PLACE A GESTURE TURNS INTO AN ACT.
   *
   * REGISTERED ON `window`, NOT ON THE CANVAS, and that is not a style choice: a
   * mouseup released outside the canvas — over `#cmdrow`, over the status line,
   * over the desktop — never arrives at a canvas listener at all, and the panel
   * would stay stuck to the cursor with the button already up.
   */
  function endDrag(clientX: number, clientY: number): void {
    const live = drag;
    if (live === null) return;
    drag = null;
    if (!live.moved) {
      // NEVER TRAVELLED: this was a CLICK. Run what the press meant.
      //
      // AND THE HOVER STATE IS *NOT* CLEARED HERE, deliberately. Nothing went
      // stale: the pointer never passed the threshold, so what it was over when
      // the button went down is what it is over now, and clearing would blank the
      // ring under the cell the player just clicked until they jiggled the mouse.
      live.click?.();
      requestDraw();
      return;
    }
    resolveDrop(live, renderer.backbufferPoint(clientX, clientY));
    settlePanel(live.subject);
    clearHoverState();
    requestDraw();
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * BANK THE POSITION THE PLAYER CAN SEE, NOT THE ONE THE POINTER REACHED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `onDragMove` stores a RAW offset — `offsetAtGrab` plus the total pointer
   * travel — and `hudLayout` clamps it on the way out through `moveIntoBand`. For
   * the duration of the gesture that is exactly right, and ui/drag.ts's
   * `nextOffset` argues why. The moment the button comes up it stops being right,
   * because the NEXT `beginDrag` re-bases on the stored offset while `grabX/grabY`
   * come from the CLAMPED position under the pointer — so an overshoot is banked
   * forever and has to be paid back pixel for pixel before the panel moves again.
   *
   * THAT IS NOT A ROUNDING NICETY, IT IS A DEAD HANDLE. The character sheet on a
   * 1248x480 backbuffer rests at y=46 and clamps at y=75: 29 pixels of legal
   * travel against a 480-pixel canvas. One sweep to the bottom of the window banks
   * dy≈423, and the next FOUR full-height upward drags then move the panel zero
   * pixels each — a title bar the player can see, grab and pull with no effect and
   * no explanation. Sideways is worse (SHEET_W 328 against 1248 banks ~320 in one
   * stroke) and the offsets are session state, so the panel stays welded to the
   * edge until the page is reloaded.
   *
   * SETTLED ON RELEASE RATHER THAN CLAMPED ON WRITE, and the difference is only
   * bookkeeping — the drawn result mid-gesture is identical either way, because
   * every read already clamps. Doing it here keeps `moveIntoBand` the one clamp
   * and keeps the raw value available for the whole gesture, which is what lets a
   * pointer that has swept past the edge pick the panel back up the instant it
   * comes back into range.
   *
   * ONLY A PANEL DRAG HAS AN OFFSET. An item drag's whole effect is `resolveDrop`.
   */
  function settlePanel(subject: DragSubject): void {
    if (subject.kind !== DragKind.Panel) return;
    const { logicalW, logicalH } = renderer.metrics();
    const band = panelBand(logicalH, turnHudHeight(turnView()));
    const unmoved = unmovedPanelRect(subject.panel, logicalW, logicalH, band);
    // NULL MEANS THE PANEL IS NOT DRAWABLE — shut, or a band too short to hold it.
    // There is no position to settle to, and the raw offset is left alone so that
    // a window which grows back restores what the player chose.
    if (unmoved === null) return;
    panelOffsets[subject.panel] = settleOffset(
      unmoved,
      panelOffsets[subject.panel],
      band,
      logicalW,
    );
  }

  /**
   * FORGET WHAT THE POINTER WAS OVER BEFORE THE GESTURE. Run at every exit.
   *
   * The canvas `mousemove` handler short-circuits on its first line while a drag
   * is live, deliberately (see the note there — it is the difference between a
   * drag that costs nothing and one that spends the socket's token bucket on
   * hovering). The cost is that every hover flag it maintains is FROZEN at the
   * pre-press value for the whole gesture and stays stale afterwards until the
   * pointer next moves — and the pointer has usually finished moving by then,
   * because the player just released the button.
   *
   * Two visible bugs, both reported from play: a hover card left over from before
   * the press stayed pinned at the old `pointerPoint` and was painted OVER the
   * thing in the player's hand, and the inventory panel's × stayed lit after the
   * panel was dragged out from under it. Clearing is the honest fix rather than
   * re-running the hover resolution here: a release is not a move, the pointer may
   * well be over something else entirely by the next frame, and the very next
   * `mousemove` repopulates all of it.
   */
  function clearHoverState(): void {
    pointerPoint = null;
    hoveredSlot = -1;
    invHovered = null;
    invCloseHovered = false;
    invDropHovered = false;
    sheetCloseHovered = false;
    sheetTalentsHovered = false;
    talentsCloseHovered = false;
    talentsHoveredRow = null;
    menuCloseHovered = false;
    // `menuHovered` IS DELIBERATELY LEFT ALONE. It is not a hover: it doubles as
    // the escape menu's KEYBOARD CURSOR (`onUi`'s arrow handling reads it as the
    // position to move from), so clearing it here would send a player who dragged
    // the menu by its title bar back to the top of the list on their next
    // arrow-down. The × beside it is a hover and is cleared.
    respawnHovered = false;
    noteHoveredActor(null);
  }

  /**
   * ABANDON the gesture: Escape, and losing the window.
   *
   * A GENUINE CANCEL, so a panel goes back where it was. The offset is applied
   * live as the pointer moves, so "ending" a panel drag without restoring
   * `offsetAtGrab` would leave the panel wherever the pointer happened to be when
   * the alt-tab landed — which is the one outcome a player pressing Escape is
   * explicitly asking not to have.
   *
   * The deferred `click` is NOT run. Escape means "not that", and a cancel that
   * equipped something on the way out would be the worst possible reading of it.
   */
  function cancelDrag(): boolean {
    const live = drag;
    if (live === null) return false;
    drag = null;
    if (live.moved) {
      if (live.subject.kind === DragKind.Panel) {
        // `offsetAtGrab` IS ALWAYS A SETTLED VALUE, which is what makes restoring
        // it safe: every gesture that ends normally runs `settlePanel`, and a
        // fresh store is `NO_OFFSET`. So a cancel can never reinstate an
        // overshoot that `settlePanel` would have to undo later.
        panelOffsets[live.subject.panel] = live.offsetAtGrab;
      }
      // Same rule as `endDrag`: only a gesture that actually TRAVELLED left the
      // hover state frozen, because only then was the canvas `mousemove` handler
      // short-circuiting anything that mattered.
      clearHoverState();
    }
    requestDraw();
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // THREE `window` LISTENERS, REGISTERED ONCE FOR THE LIFE OF THE PAGE.
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // ON `window` AND NEVER ON THE CANVAS, for two independent reasons and either
  // one alone would be enough. The canvas `mouseleave` handler clears the pointer
  // state, so a canvas-driven drag would freeze the instant the pointer crossed
  // onto `#cmdrow` — which is directly under the canvas and is exactly where a
  // pointer goes when somebody drags a panel towards the bottom of the screen.
  // And a release outside the canvas never fires a canvas listener at all, so the
  // panel would stay stuck to a cursor with no button held.
  //
  // NEVER DISPOSED, which is keys.ts's precedent restated: a listener that comes
  // and goes is a listener whose ORDER comes and goes with it. All three are
  // completely inert while `drag` is null — one comparison and a return.
  //
  // BLUR IS NOT OPTIONAL. Alt-tab, a Discord overlay taking focus, the activity
  // iframe losing it: the browser stops delivering mouse events and the mouseup
  // that would have ended the gesture is never seen. Without this the player
  // comes back to a panel welded to the pointer and a `mousemove` handler that
  // short-circuits every hover in the client.
  window.addEventListener('mousemove', (event: MouseEvent) => {
    onDragMove(event.clientX, event.clientY);
  });
  window.addEventListener('mouseup', (event: MouseEvent) => {
    endDrag(event.clientX, event.clientY);
  });
  window.addEventListener('blur', () => {
    cancelDrag();
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
    /**
     * ═══ TRAVEL INTERRUPT (1b) — AND IT IS THE OTHER HALF OF THE TAB BUG ═══
     *
     * A press on the canvas means "I am playing the map now", and the browser
     * would normally act on that by moving focus off whatever had it. IT CANNOT
     * HERE: almost every branch below `preventDefault`s — for the reasons each
     * one gives — and `preventDefault` on mousedown suppresses the browser's own
     * focus change. That is not a new discovery in this file; `setCommandLineReachable`
     * records the same mechanism trapping a player behind the class chooser.
     *
     * So a player who clicked the chat row — which invites exactly that, it reads
     * "T or / to talk" — and then clicked back on the map to carry on playing had
     * a dead keyboard and no way to mend it with the mouse. `isTextEntry` drops
     * every key while `#cmd` holds focus, and clicking the map could not take it
     * back. Same dead game as the unbound Tab (input/keys.ts), reached by the
     * mouse instead of the keyboard, so it is fixed beside the same interrupt.
     *
     * ONLY THE CANVAS. This listener is on `canvas`, so a press on the chat row
     * itself is a different element's event and still focuses the field — the
     * deliberate route in is untouched.
     */
    if (cmdEl !== null && document.activeElement === cmdEl) cmdEl.blur();
    // ═══ v12 — A SECOND PRESS WHILE A GESTURE IS LIVE ABANDONS IT ═══
    // Reachable with a right-click during a left drag, and with a mouse whose
    // button state the browser has lost track of after an alt-tab. Abandoning is
    // the honest answer: there is one `drag`, so the alternative is a press that
    // silently replaces a gesture the player is still making, and the offset
    // would jump by the distance between the two grab points. Below the two
    // interrupts above it, which fire for every press whatever else happens.
    if (cancelDrag()) {
      event.preventDefault();
      return;
    }
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE WORLD MAP IS A SCREEN, AND A SCREEN SWALLOWS THE PRESS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * It painted itself over the game at 92% opacity and then let every click
     * fall straight through to the board underneath. Press M to look at the
     * region, click a town to ask what it is, and your detective silently began
     * a multi-turn walk toward whatever LOCAL tile happened to sit under that
     * screen point — path preview drawn under an opaque panel, destination
     * chosen by coincidence. Right-click opened the verb menu for a tile you
     * could not see; a click on a party member's dot pinged a position that was
     * not theirs.
     *
     * ABOVE THE TILE MATH AND BELOW THE TWO INTERRUPTS, which is exactly right:
     * `cancelTravel()` and `cancelDrag()` have already run, so pressing anywhere
     * on the map still stops a walk in progress — the player reached for the
     * mouse and meant something by it — and nothing after this line can act on
     * a coordinate the player never saw.
     *
     * IT DOES NOT CLOSE THE MAP. M closes it, Escape closes it (see the key
     * handler); a stray click while reading a map should not dismiss the thing
     * being read. That is the same rule the token menu already follows.
     */
    if (worldMapOpen) {
      event.preventDefault();
      return;
    }
    const point = renderer.backbufferPoint(event.clientX, event.clientY);
    const { logicalW, logicalH } = renderer.metrics();
    const layout = hudLayout(logicalW, logicalH);

    // ═══ -1. THE SELECT SCREEN TAKES EVERY CLICK BEFORE ANYTHING ELSE ═══
    //
    // FIRST OF ALL, ABOVE EVEN THE CLASS CHOOSER, because it is the one modal
    // with NO WORLD BEHIND IT. Everything below this line — the token menu, the
    // panels, the map — is reasoning about a body this client does not have.
    // There is no tile to click, no token to walk, and no party pane row to open
    // a verb menu on; every one of those handlers would be operating on the
    // stale remains of a session that ended, or on nothing at all.
    //
    // A CLICK ON NO CONTROL IS STILL SWALLOWED, same rule as the chooser: null
    // from the hit test means "on the modal, not on a control" and never falls
    // through to a map that is not there.
    if (layout.roster !== null && roster !== null) {
      event.preventDefault();
      const hit =
        point === null
          ? null
          : rosterHitAt(
              roster.characters.length,
              layout.roster,
              roster.canCreate,
              point.x,
              point.y,
            );
      if (hit === null) return;
      switch (hit.kind) {
        case RosterHitKind.Row:
          // SELECT, NEVER PLAY. The same two-act rule the class chooser uses,
          // and for a smaller version of the same reason: a single click that
          // committed would make a mis-click a whole evening spent as the wrong
          // character before anybody noticed.
          selectCharacter(hit.index);
          return;
        case RosterHitKind.Delete: {
          /**
           * ═══════════════════════════════════════════════════════════════
           * TWO PRESSES. THE FIRST ONE ONLY CHANGES A WORD.
           * ═══════════════════════════════════════════════════════════════
           *
           * Arm-then-act, the same gesture the talent panel’s `+` uses, and
           * for a sharper version of the same reason: the second press reaches
           * a file. There is no undo in this product and the server holds the
           * only copy — it does keep the bytes, renaming rather than deleting,
           * but that is a maintainer’s recovery path and not something a
           * player can reach on a Friday night.
           *
           * ARMING A DIFFERENT ROW MOVES THE ARM rather than firing anything,
           * so a mis-click on the wrong row costs one more click and never a
           * character.
           */
          const target = roster.characters[hit.index];
          if (target === undefined) return;
          if (rosterArmedDeleteId !== target.id) {
            rosterArmedDeleteId = target.id;
            requestDraw();
            return;
          }
          /**
           * NOTHING IS PATCHED LOCALLY. The server answers with the roster —
           * for every outcome, including the refusals — and `case 'roster'`
           * already replaces the list wholesale, re-anchors the selection by
           * id, recomputes the cap and disarms this. A client that also
           * removed the row would be a second opinion about what is on disk.
           */
          if (
            !socket.send({ v: PROTOCOL_VERSION, t: 'delete_character', characterId: target.id })
          ) {
            // THE ARM STAYS UP when the frame did not go out. Disarming here would
            // tell the player it happened; leaving it armed means the next press
            // tries again, which is what they meant.
            showNotice('not connected — that did not go out');
            return;
          }
          return;
        }
        case RosterHitKind.Play:
          playSelectedCharacter();
          return;
        case RosterHitKind.Create:
          createCharacter();
          return;
      }
    }

    // ═══ 0. THE CLASS CHOOSER TAKES EVERY CLICK, BOTH BUTTONS, FIRST ═══
    //
    // ABOVE THE RIGHT-CLICK BRANCH AND THAT IS THE POINT. Below it, a right-click
    // inside the modal would cancel an aim or open a verb menu on whatever tile
    // is behind the scrim — a menu the player can see, drawn under a screen they
    // cannot dismiss, about a body they have not met. `preventDefault` on both
    // buttons; the `contextmenu` listener at the foot of this function suppresses
    // the browser's own menu unconditionally, so it needs no separate guard.
    //
    // A CLICK THAT LANDS ON NO CONTROL IS STILL SWALLOWED. `classPickerHitAt`
    // answering null means "on the modal, not on a control" and is never a
    // fall-through — ui/classpicker.ts says the same from its side.
    if (layout.picker !== null && classOptions !== null) {
      event.preventDefault();
      const hit =
        point === null ? null : classPickerHitAt(classOptions, layout.picker, point.x, point.y);
      if (hit === null) return;
      switch (hit.kind) {
        case ClassPickerHitKind.Card:
          // SELECT, NEVER CONFIRM. One click is not enough for a decision that is
          // written to a file and never offered again; CONFIRM is the second act,
          // and the modal says so in its own hint line.
          selectCard(hit.index);
          return;
        case ClassPickerHitKind.Confirm:
          confirmClass();
          return;
      }
    }

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

      // ═══════════════════════════════════════════════════════════════════════
      // v12 — RIGHT-CLICK ON AN ITEM SLOT UNBINDS IT. THE ONLY WAY TO CLEAR ONE.
      // ═══════════════════════════════════════════════════════════════════════
      // BELOW the aim cancel above, not beside it. That cancel is documented as
      // unconditional and load-bearing — without it the targeting ring could no
      // longer be dismissed with the mouse at all, and the bug would present as
      // "the ring is stuck", miles from anything anyone would look at. So while
      // an aim is open the first right-click still closes it and the second
      // unbinds, which costs one press in a state that lasts a moment.
      //
      // `isItemSlotIndex` GUARDS IT, so a right-click on a TALENT slot is
      // untouched and falls through to `clearNotice()` exactly as it always has.
      // The class loadout is not bindable and there is nothing there to clear.
      /**
       * ═══ AND IT CLEARS A TALENT SLOT NOW, WHICH THE NOTE ABOVE DENIES ═══
       * That note ends "the class loadout is not bindable and there is nothing
       * there to clear", and it was true: slot n WAS `loadout[n]` for the
       * session. The six keyed slots hold a binding now (`talentBindings`), so
       * there is something to clear and the same gesture clears it.
       */
      const rightSlot = slotUnder(event);
      if (isItemSlotIndex(rightSlot)) {
        unbindItemSlot(rightSlot);
        return;
      }
      if (rightSlot >= 0) {
        unbindTalentSlot(rightSlot);
        return;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // NO TOKEN MENU WHILE THE ESCAPE MENU IS UP, AND THAT IS THE CANCEL
      // CHAIN'S ORDER DEFENDED FROM THE OTHER END.
      // ═══════════════════════════════════════════════════════════════════════
      // `onCancel` puts the three escape-menu head links ABOVE `tokenMenu.close()`
      // on the rule that the most recently opened, most modal-feeling surface
      // answers first. That rule was not invariant: the occlusion guard below
      // only refuses a right-click landing INSIDE `layout.menu`, so a right-click
      // on bare map still opened a token menu OVER the escape menu — painted
      // last of everything — and Escape then closed the big panel underneath the
      // little one the player was actually looking at.
      //
      // REFUSED HERE RATHER THAN REORDERED THERE, because the chain's order is
      // right and the reachable state is what was wrong: two stacked menus is
      // one more surface than this client has ever had, and the escape menu
      // already offers every verb a right-click could mean on your own token.
      // The right-click still does its OLDEST job — `clearNotice()` below — so
      // the button is not dead, it just does not stack a second menu.
      if (point !== null && !menuOpen) {
        // A row in the party pane offers the same menu as the token does. It is
        // the only way to reach somebody who is off screen — which is most of
        // the party, most of the time.
        //
        // ═══ ...UNLESS THE CHARACTER SHEET IS DRAWN OVER THAT ROW ═══
        // `paintHud` paints pane -> log -> SHEET, so wherever the two rects
        // overlap the sheet is the thing the player can actually see, and a hit
        // test that ignored it would open a verb menu on a party member through
        // a solid panel. They DO overlap on ordinary windows: `charSheetRect`
        // centres the sheet on the assumption that the two docks own the sides,
        // but it never tests `pane.rect` — hide the Case Log on a 640-wide
        // viewport and `partyPaneLayout` widens into Rows mode straight under it.
        //
        // OCCLUSION, NOT A HIT TEST. The sheet's only control is its × and step 5
        // owns that; here the sheet merely has to STOP the pane from claiming a
        // click aimed at something drawn on top of it, and the `clearNotice()`
        // fall-through below is the right answer for a right-click on a panel.
        // ...AND THE TALENT PANEL IS THE SAME OCCLUSION, for the same reason and
        // over the same rows: it is centred like the sheet, it is painted after
        // it, and a verb menu opened on a party member through two solid panels
        // is the same bug twice.
        // ...AND THE INVENTORY PANEL MAKES IT A THREE-WAY OVERLAP ON A SHORT
        // BAND. All three are centred horizontally on the assumption that the two
        // docks own the sides, none of them consults `pane.rect`, and this one is
        // painted last of the three. Leaving it out of this guard reproduces the
        // exact shipped bug recorded in step 4 below — "a click on the character
        // sheet declined a party invite the player never saw" — with a different
        // panel on top.
        // ...AND THE ESCAPE MENU IS THE FOURTH AND THE WIDEST. It is painted last
        // of the four and it is wider than all of them, so it covers MORE of the
        // pane than any of its siblings can. Same treatment, same reason: pure
        // occlusion, no right-click branch of its own — there is no verb this
        // panel offers that a right-click could mean.
        const overSheet =
          inRect(layout.sheet, point.x, point.y) ||
          inRect(layout.talents, point.x, point.y) ||
          inRect(layout.inventory, point.x, point.y) ||
          inRect(layout.menu, point.x, point.y);
        const paneHit =
          overSheet || layout.pane === null || layout.party === null
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

    // ═══ 3a. THE ESCAPE MENU — TESTED BEFORE ALL THREE PANELS, BECAUSE IT IS
    //         DRAWN OVER ALL THREE ═══
    //
    // HIT-TEST ORDER MIRRORS PAINT ORDER, the rule step 4 below states in full.
    // `paintHud` paints the sheet, the talent panel, the inventory panel and
    // then this, so this gets first refusal on any click inside its rect — and
    // it overlaps them more than they overlap each other, because it is wider
    // than all three and centred like all three.
    //
    // BELOW THE ERASED PLATE AND THE HOTBAR, which is the same order the paint
    // pass uses in reverse and is deliberate on both counts. The plate is the
    // one click that has to work while everything else is being refused, and the
    // hotbar is the thing this panel's whole geometry exists to stay off — a
    // menu that ate a talent key by hit test after `panelBand` had carefully
    // kept it out of the way would be the panel promise broken in the one place
    // nobody would look.
    //
    // EVERY OUTCOME SWALLOWS THE CLICK, and a null hit — "on the menu, but not
    // on a control" — falls through to the `overPanel` swallow at the foot of
    // this handler, which already includes this rect. `escapeMenuHitAt` answers
    // null for a greyed entry and for a locked key row as well, so a row drawn
    // as unpressable is unpressable by construction rather than by a check
    // somebody has to remember to write here.
    //
    // `escapeMenuRows` IS CALLED ONCE and handed to the hit test, which is the
    // same split the painter uses.
    //
    // ═══ ...AND THE HEADER STRIP IS THE HANDLE, ASKED BEFORE THE ROWS ═══
    // `escapeMenuDragAt` takes NO rows and refuses the close control outright, so
    // asking it first costs nothing (it is two rect tests against the panel rect
    // alone) and cannot shadow the ×: pressing × and twitching two pixels must
    // close the menu, not move it. On this panel in particular the × is the way
    // out for a player who has just made a mess of their keyboard, so it is the
    // last control that may be ambiguous. Below it, `escapeMenuHitAt` is reached
    // only for a press that was NOT on the handle, which is what keeps
    // twenty-six rows from being rebuilt every time somebody grabs the title bar.
    if (point !== null && layout.menu !== null) {
      if (escapeMenuDragAt(layout.menu, point.x, point.y) !== null) {
        event.preventDefault();
        beginDrag({ kind: DragKind.Panel, panel: DraggablePanel.Menu }, point.x, point.y, null);
        return;
      }
      const hit = escapeMenuHitAt(layout.menu, menuRows(), point.x, point.y);
      if (hit !== null) {
        event.preventDefault();
        runMenuHit(hit);
        return;
      }
    }

    // ═══ 4. THE CHARACTER SHEET — TESTED BEFORE THE PANE, BECAUSE IT IS DRAWN
    //        OVER IT ═══
    //
    // HIT-TEST ORDER MIRRORS PAINT ORDER, AND THAT IS THE WHOLE RULE. `paintHud`
    // paints the party pane, then the log, then the SHEET, so the sheet is the
    // topmost of the three and must get first refusal on any click inside its
    // rect. Tested after the pane — which is where this block used to sit — the
    // pane won every click in the overlap, and the overlap is not exotic:
    // `charSheetRect` centres the panel on the assumption that the two docks own
    // the sides but never consults `pane.rect`, so pressing `m` to hide the Case
    // Log on a small window drops `rightReserved` to 0, `partyPaneLayout` picks
    // Rows mode, and the two collide. A left-click there opened the token menu
    // for whichever member happened to be under the sheet — and with an invite
    // pending, DECLINE sat entirely inside the overlap, so a click on the
    // character sheet declined a party invite the player never saw.
    //
    // THE × IS THE ONLY CONTROL. `charSheetHitAt` answers null everywhere else
    // on the panel, and those clicks are then eaten by the `overPanel` swallow
    // below — which already includes the sheet's rect, so the button has to be
    // tested above it either way.
    // ═══ 4a. THE TALENT PANEL — TESTED BEFORE THE SHEET, BECAUSE IT IS DRAWN
    //         OVER IT ═══
    //
    // HIT-TEST ORDER MIRRORS PAINT ORDER, the rule step 4 below states in full.
    // `paintHud` paints the sheet and then this, so this gets first refusal on
    // any click inside its rect. The two DO overlap: both are centred
    // horizontally on the assumption that the docks own the sides, and on a
    // short band the sheet's vertical centring brings it up into this panel's
    // top-anchored rect.
    //
    // THREE OUTCOMES AND NO FOURTH. The × closes. A `+` goes through
    // `pressTalentPlus`, which arms on the first press and spends on the second.
    // Anything else on the panel — a row, the badge, bare panel — is SWALLOWED by
    // the `overPanel` check further down, which already includes this rect. There
    // is deliberately no right-click branch anywhere for this panel: there is no
    // refund verb this pass, and a gesture that appeared to unlearn and did
    // nothing would be worse than no gesture (ui/talents.ts's header).
    // ═══ 4b. THE INVENTORY PANEL — TESTED BEFORE BOTH, BECAUSE IT IS DRAWN OVER
    //         BOTH ═══
    //
    // HIT-TEST ORDER MIRRORS PAINT ORDER, the rule step 4 below states in full.
    // `paintHud` paints the sheet, then the talent panel, then this — so this
    // gets first refusal on any click inside its rect. All three DO overlap: every
    // one of them is centred horizontally on the assumption that the docks own the
    // sides, and on a short band the sheet's vertical centring and this panel's
    // bottom anchor bring them together.
    //
    // FIVE OUTCOMES AND NO SIXTH, and every one of them swallows the click:
    //   × closes. A TAB switches, client-side, sending nothing. A FILLED CELL is
    //   `equip` or `unequip` and `hit.worn` is the only thing that decides which —
    //   the panel answers it so the caller never has to remember which tab it was
    //   looking at. An EMPTY SLOT does nothing but take the focus, so the strip
    //   names the slot (which is where a player learns `offhand` and `trinket`
    //   exist). DROP sends `drop`.
    // Anything else inside the rect — bare panel, a note line, the header — falls
    // through to the `overPanel` swallow further down, which already includes this
    // rect. There is deliberately no right-click branch: the right-click block
    // above treats this panel as pure occlusion, exactly as it does the other two.
    //
    // ═══ ...AND IT IS SKIPPED UNDER THE ESCAPE MENU, WHICH IS NEW AND IS THE
    //     SAME BUG AS THE ONE RECORDED THREE BLOCKS DOWN ═══
    // This block used to need no guard because nothing was drawn over it. The
    // menu is, and it is wider than this panel — so without this line a click on
    // BARE MENU would reach a cell, a tab or the DROP control underneath it, and
    // DROP puts a coat on the floor of a room the player is about to leave.
    //
    // ═══ ...AND v12 ADDS THE PRESS, WHICH IS NOT A CLICK WITH AN EXTRA CASE ═══
    // `inventoryPanelDragAt` is a SECOND reader over the SAME
    // `inventoryPanelGeometry` (ui/inventory.ts explains why it is not a sixth
    // member of `InventoryHit`: this switch is under
    // `switch-exhaustiveness-check`, and a Header variant would be a compile
    // error here for an outcome the click path has nothing to do with). It
    // answers the header handle, or the item under the pointer, and it refuses
    // both the close control and an EMPTY doll cell — there is nothing in an
    // empty cell to pick up, though it remains a perfectly good drop TARGET.
    //
    // A PRESS ON A FILLED CELL DOES NOT ACT YET, AND THAT IS THE WHOLE CHANGE.
    // The same press may turn out to be the start of a drag onto the hotbar, so
    // the equip/unequip is handed to `beginDrag` as the deferred `click` and run
    // by the release only if the pointer never travelled six pixels. Acting on
    // `mousedown` as this block used to would mean every drag off the doll also
    // took the item off the body on its way out.
    if (point !== null && layout.inventory !== null && !inRect(layout.menu, point.x, point.y)) {
      // ONE `inventoryPanelRows` FOR BOTH READERS. The rows walk the whole doll
      // and the whole bag, and building them twice per press would do that work
      // twice for one pointer event.
      const rows = inventoryPanelRows(inventoryPanelView());
      const grab = inventoryPanelDragAt(layout.inventory, rows, point.x, point.y);
      if (grab !== null) {
        event.preventDefault();
        if (grab.kind === InventoryHitKind.Header) {
          beginDrag(
            { kind: DragKind.Panel, panel: DraggablePanel.Inventory },
            point.x,
            point.y,
            null,
          );
          return;
        }
        const pressed = inventoryPanelHitAt(layout.inventory, rows, point.x, point.y);
        beginDrag(grab.subject, point.x, point.y, () => {
          runInventoryHit(pressed);
        });
        return;
      }
      const hit = inventoryPanelHitAt(layout.inventory, rows, point.x, point.y);
      if (hit !== null) {
        event.preventDefault();
        runInventoryHit(hit);
        return;
      }
    }

    // ═══ ...AND BOTH BLOCKS BELOW ARE SKIPPED UNDER IT, WHICH IS THE OTHER HALF
    //     OF THE SAME RULE ═══
    // A null hit above means "on the inventory panel, but not on a control", and
    // the instruction for that case is to fall through to the `overPanel` swallow
    // — NOT to the two hit tests in between. Without these guards a click on bare
    // inventory panel would reach a `+` or a × drawn UNDERNEATH it, which is
    // step 5's own bug ("a control the player cannot see must not be pressable")
    // with two panels instead of one, and the `+` version of it spends an
    // irreversible talent point.
    //
    // THE ESCAPE MENU IS THE FOURTH TWIN ON EVERY ONE OF THESE GUARDS, and it is
    // the one most likely to reproduce the bug: it is painted over all three and
    // is wider than all three, so "bare menu" covers more `+` controls than bare
    // inventory panel ever did.
    if (
      point !== null &&
      layout.talents !== null &&
      !inRect(layout.inventory, point.x, point.y) &&
      !inRect(layout.menu, point.x, point.y)
    ) {
      // ═══ v12 — THE HEADER STRIP IS THE HANDLE, ASKED BEFORE THE ROWS ═══
      // `talentPanelDragAt` takes NO rows — the handle and the × both depend on
      // the panel rect alone — so a press on the title bar never rebuilds four
      // talent rows. It refuses the close control outright, so pressing × and
      // twitching two pixels still closes the panel rather than moving it.
      if (talentPanelDragAt(layout.talents, point.x, point.y) !== null) {
        event.preventDefault();
        beginDrag({ kind: DragKind.Panel, panel: DraggablePanel.Talents }, point.x, point.y, null);
        return;
      }
      const hit = talentPanelHitAt(
        layout.talents,
        talentPanelRows(talentPanelView()),
        point.x,
        point.y,
      );
      if (hit !== null && hit.kind === TalentHitKind.Close) {
        event.preventDefault();
        toggleTalentPanel(false);
        return;
      }
      if (hit !== null && hit.kind === TalentHitKind.Spend) {
        event.preventDefault();
        pressTalentPlus(hit.talentId);
        return;
      }
      // AN ATTRIBUTE'S `+`, ABOVE THE ROW BRANCH BELOW for the reason the grid's
      // Spend branch is above it: a press that buys must never also be read as a
      // press that merely points at something.
      if (hit !== null && hit.kind === TalentHitKind.Stat) {
        event.preventDefault();
        pressStatPlus(hit.stat);
        return;
      }
      /**
       * ═══ A PRESS ALSO PINS THE DESCRIPTION COLUMN ═══
       * Hover already moves it, and on a mouse that is enough. This is for the
       * pointer that is not a mouse: a touch has no hover at all, so without
       * this the pane would be permanently empty on a tablet — the one input
       * where the hover card was never an answer either.
       *
       * AFTER the Spend branch, so pinning cannot swallow the press that buys —
       * `pressSpend` owns the two-press rule and this must not become a third.
       * The two branches above return, so a hit reaching here is a Row and the
       * compiler knows it; testing the kind again would be a comparison it can
       * already prove is always true.
       */
      if (hit !== null) {
        const pressed = talentIdAt(
          layout.talents,
          talentPanelRows(talentPanelView()),
          point.x,
          point.y,
        );
        /**
         * ═══════════════════════════════════════════════════════════════════
         * AND THE PRESS BECOMES A DRAG — THE ONLY WAY A TALENT REACHES THE BAR.
         * ═══════════════════════════════════════════════════════════════════
         *
         * The bar's six keyed slots take a binding now (`talentBindings`), and
         * this panel is where the talents are. Without a drag out of here the
         * feature exists and is unreachable, which is the "control that does
         * nothing" trap one indirection deep.
         *
         * ═══ THE PIN IS THE CLICK, WHICH IS WHY IT IS PASSED AS ONE ═══
         * `beginDrag`'s fourth argument runs only if the pointer never MOVED —
         * so a press that stays put still pins the description column exactly as
         * it did before this existed, and a press that travels binds. One
         * gesture, two meanings, decided by whether the player dragged; the same
         * rule the inventory has used since items became draggable.
         *
         * ═══ ONLY A TALENT THIS CHARACTER CAN PRESS ═══
         * A passive has no button and an unlearned talent cannot be used, so
         * neither may be bound: a bar slot that refuses every press is worse
         * than an empty one. `loadout` holds exactly the actives — passives
         * travel in their own array — and a rank-0 entry is filtered by the
         * `level` check, which is the same rule `affordable` applies to grey
         * the slot out.
         */
        const bindable =
          pressed === null ? undefined : loadout.find((entry) => entry.id === pressed);
        if (bindable !== undefined && bindable.level >= 1) {
          event.preventDefault();
          beginDrag({ kind: DragKind.Talent, talentId: bindable.id }, point.x, point.y, () => {
            if (bindable.id !== talentFocusId) {
              talentFocusId = bindable.id;
              requestDraw();
            }
          });
          return;
        }
        if (pressed !== null && pressed !== talentFocusId) {
          talentFocusId = pressed;
          requestDraw();
        }
      }
    }

    if (
      point !== null &&
      layout.sheet !== null &&
      // ═══ THE TALENT PANEL IS THE THIRD TERM, AND IT WAS MISSING ═══
      // Step 4a above is drawn OVER this one and returns for only two of its
      // outcomes — Close and Spend — so a press on a talent ROW, on the badge or
      // on bare talent panel fell straight through to here. That was harmless
      // while `charSheetHitAt` answered only 'close' and 'talents'; with the drag
      // handle it answers 'header' for the whole title strip, and on an ordinary
      // 1248x480 backbuffer the sheet's header sits BEHIND the talent panel's
      // first content row. So a press aimed at a talent row began dragging a
      // character sheet the player could not see, and banked an offset into it.
      // Same rule as the other three terms: a control the player cannot see must
      // not be pressable.
      !inRect(layout.talents, point.x, point.y) &&
      !inRect(layout.inventory, point.x, point.y) &&
      !inRect(layout.menu, point.x, point.y)
    ) {
      const hit = charSheetHitAt(layout.sheet, point.x, point.y);
      if (hit === 'close') {
        event.preventDefault();
        sheetVisible = false;
        sheetCloseHovered = false;
        sheetTalentsHovered = false;
        requestDraw();
        return;
      }
      // THE PORTED ROUTE TO THE TALENT PANEL. ToME puts a "[L]evelup" button on
      // its character sheet (CharacterSheet.lua:99) and that button is how a
      // player who has learned one key discovers the other. It TOGGLES, so the
      // control and the key mean the same thing, and the sheet stays open behind
      // it — two dock panels at once is a supported state, not an accident.
      if (hit === 'talents') {
        event.preventDefault();
        toggleTalentPanel();
        return;
      }
      // ═══ v12 — THE THIRD OUTCOME: THE HEADER STRIP IS THE HANDLE ═══
      // One hit test answers all three, so the sheet needs no second reader the
      // way the talent panel, the inventory panel and the escape menu do — this
      // one returns a plain string union that main.ts compares with `===`, so
      // widening it broke nothing (ui/charsheet.ts's own note). It is tested LAST
      // of the three because the `[G]` control and the × both sit INSIDE the
      // header strip, and `charSheetHitAt` already offers them first for exactly
      // that reason.
      if (hit === 'header') {
        event.preventDefault();
        beginDrag({ kind: DragKind.Panel, panel: DraggablePanel.Sheet }, point.x, point.y, null);
        return;
      }
    }

    // ═══ 5. THE PARTY PANE'S OWN CONTROLS ═══
    // ACCEPT and DECLINE, and a row that opens the token menu. Hit-tested
    // through `partyPaneHitAt`, which reads the same geometry the painter drew
    // with, so a button can never be one row off where it appears.
    //
    // SKIPPED ENTIRELY UNDER THE SHEET, for the reason spelled out in step 4 and
    // in the right-click branch above: a control the player cannot see must not
    // be pressable. The click falls through to the `overPanel` swallow, which is
    // the correct outcome for a click on a panel with nothing under the pointer.
    if (
      point !== null &&
      layout.pane !== null &&
      layout.party !== null &&
      !inRect(layout.sheet, point.x, point.y) &&
      !inRect(layout.talents, point.x, point.y) &&
      // THE THIRD PANEL, AND THE SAME RULE: a control the player cannot see must
      // not be pressable. With an invite pending, DECLINE sits inside the overlap
      // on ordinary windows — that is the bug this guard was written for, and a
      // third centred panel is a third way to reproduce it.
      !inRect(layout.inventory, point.x, point.y) &&
      // AND THE FOURTH, WHICH COVERS MORE OF THE PANE THAN ANY OF THE OTHER
      // THREE — it is the widest surface in this client. Same rule, same bug:
      // DECLINE inside the overlap is a party invite refused by a click the
      // player thought was landing on a key row.
      !inRect(layout.menu, point.x, point.y)
    ) {
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
          case 'follow':
            // THE WAY INTO A ROOM THAT IS ALREADY YOURS. An instance is keyed
            // by party, so a member in a breach is in a breach the party owns —
            // there was simply no door, because the roamer that made one was
            // consumed by their crossing.
            sendFollow(hit.id);
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

    // ═══ 6. AN OPEN AIM STILL TAKES THE PLAIN CLICK ═══
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

    // ═══ 7. THE PLAIN LEFT-CLICK: HIT THAT, OR WALK THERE ═══
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

  // THE CLASS CHOOSER NEEDS NO GUARD OF ITS OWN HERE, and that is worth stating
  // rather than leaving to be re-derived: this listener suppresses the menu on
  // the whole canvas unconditionally, and the modal is drawn on that canvas — so
  // a right-click inside it is already silent, and mousedown step 0 above has
  // already swallowed the press itself.
  //
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   PUT THE WORLD DOWN. EVERY SURFACE THAT DESCRIBES A BOARD THIS CLIENT IS
 *   NO LONGER LOOKING AT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS WAS THE TAIL OF `case 'welcome'` AND IT IS LIFTED OUT UNCHANGED,
 * because a second caller appeared and copying it would have been the exact
 * shape that has cost this codebase six bugs: ONE RULE WRITTEN AS A
 * HAND-WRITTEN LIST, and the copy missing the entry that mattered. There are
 * twenty-odd surfaces here, each with its own paragraph of reasoning, and the
 * next one somebody adds must land in both places by construction rather than
 * by being remembered.
 *
 * ═══ THE TWO CALLERS ═══
 * `welcome` — the board is being REPLACED, and everything below describes the
 * one being replaced. It runs AFTER `level`/`selfId`/`replaceActors` because
 * nothing in here touches those three.
 *
 * `roster` — the board is being TAKEN AWAY. A roster means this client has no
 * body at all, which is a stronger statement than a welcome makes, so it also
 * empties the three this does not: see the note there.
 */
function forgetTheWorld(): void {
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
  // The armed `+` belonged to a session that has just been replaced. The
  // panel may stay open across a reconnect — it is local state and nothing
  // about it is wrong — but an arm is one press from an irreversible spend
  // and it must not survive a frame that says "here is the world again".
  // `progress` itself is NOT cleared: the server re-sends it in this same
  // `hello` block, and blanking the level for one frame would flicker the
  // sheet's identity block on every reconnect.
  talentsArmedId = null;
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
  // ...and the sky is emptied with them. An orb carried across a welcome is
  // aimed at a tile on a map that no longer exists and was fired by an id
  // that may now belong to somebody else — and unlike a stale badge, a stale
  // orb is a thing the player will get up and RUN from. The server unicasts
  // a fresh `projectiles` frame on the welcome path when something really is
  // in the air, so nothing true is lost by dropping this.
  projectiles = clearProjectiles();
  // ═══ AND THE FLOOR AND THE BAG WITH IT, ON THE SKY'S OWN ARGUMENT ═══
  //
  // A welcome replaces the board wholesale, so every pile in this list is a
  // fact about a map that no longer exists — and unlike a stale badge, a stale
  // pile is a thing a player will WALK ACROSS THE MAP FOR, conclude was taken
  // by a friend, and say so out loud. `inventory` goes for the narrower
  // reason: a resume builds a fresh session whose bag memo is seeded EMPTY, so
  // whatever the body actually owns is re-sent a few frames later.
  //
  // THIS IS SAFE ONLY BECAUSE THE `hello` PATH RESTATES BOTH. It does:
  // `sendGroundIfAny(session.socket)` and `sendInventoryIfChanged(session)`
  // both run in the welcome block (src/server/net/gateway.ts), unicast and
  // outside the on-change rule, precisely because this socket has seen
  // nothing. The ground unicast does NOT touch the broadcast memo, so nothing
  // suppresses it.
  //
  // ═══ AND THAT IS WHY `case 'state'` DELIBERATELY DOES *NOT* DO THIS ═══
  // The sky is cleared there because all three `state` broadcast sites call
  // `sendProjectilesIfAny` immediately afterwards. NONE of them carries the
  // ground, and none needs to — a resync is about `ActorView` and a pile is
  // not an actor. Clearing there would delete a real pile from every screen
  // and `broadcastGroundIfChanged`'s memo would then actively suppress the
  // correction, because the floor itself had not changed.
  ground = [];
  inventory = null;
  shop = null;
  reviveArmed = false;
  caseLog?.clear();
  setMarginText(undefined, '');
}

function applyServerMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case 'welcome':
      /**
       * ═══ THE SELECT SCREEN IS OVER, AND THE ID IS PINNED ═══
       *
       * `welcome` IS THE ONLY THING THAT CLEARS THE ROSTER. Not the click that
       * chose — the round trip takes as long as it takes, and a modal torn down
       * on the click leaves an empty screen while it is in flight, and a
       * PERMANENTLY empty one if the server answers with the roster again (which
       * it does, deliberately, for a character it will not open).
       *
       * AND `wantsNewCharacter` IS CLEARED HERE BECAUSE THIS IS WHERE THE ID IS.
       * The server allocated it; until this frame the client had nothing to ask
       * for but "a new one" again. Every reconnect from here on names this id.
       */
      roster = null;
      selectedCharacter = null;
      rosterHovered = null;
      // AN ARM MUST NOT OUTLIVE THE SCREEN THAT EXPLAINED IT.
      rosterArmedDeleteId = null;
      if (msg.characterId !== undefined) chosenCharacterId = msg.characterId;
      wantsNewCharacter = false;
      selfId = msg.selfId;
      level = msg.level;
      replaceActors(msg.actors);
      lastError = null;
      // A welcome is also the reconnect path, and it replaces the board
      // wholesale. Anything mid-flight is about to be about the wrong world:
      // drop the beat and forget the Bell until the server states it again.
      forgetTheWorld();
      break;
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * YOU WALKED THROUGH A DOOR. A NEW MAP, AND ONLY WHAT THE MAP OWNS RESET.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * This arm is deliberately NOT a second `welcome`, and the list of what it
     * does NOT clear is the entire design. `welcome` is the reconnect path: it
     * empties the case log, the party pane, the invites and the bag, and it is
     * entitled to, because a resume genuinely starts a new session and `seq`
     * restarts with it.
     *
     * Stepping into the office is not a new session. The rule applied below is
     * one question per piece of state — IS THIS A FACT ABOUT THE MAP?
     *
     *   CLEARED, because it describes a map that is no longer under you: the
     *   route, the pings, the orbs in flight, the floor, the hover cards, the
     *   targeting ring, the armed talent, the turn strip and the Bell. Each is
     *   the same argument `welcome` makes — a stale orb is a thing a player
     *   gets up and RUNS from; a stale pile is one they walk across the map for
     *   and then say out loud that a friend took it.
     *
     *   KEPT, because a door does not change any of it: the case log (the
     *   conversation continues), the party and its invites (membership is a
     *   social fact that outlives every map, and is the very thing that decided
     *   which instance you are standing in), the bag (it came with you), and
     *   progress (you are the same character).
     *
     * `effects` IS THE ONE JUDGEMENT CALL. The badges are still true — the same
     * body carries the same statuses through a door — but they are keyed by
     * actor id and most of those actors are not here any more. Cleared, and the
     * next pump restates them: one frame of a missing badge beats a badge
     * attached to somebody standing on another map.
     */
    case 'realm':
      selfId = msg.selfId;
      level = msg.level;
      replaceActors(msg.actors);
      realmKind = msg.kind;
      realmName = msg.name;
      sites = msg.sites;
      currentRealmId = msg.realmId;
      if (msg.kind === 'overworld') {
        overworldLevel = msg.level;
        overworldSites = msg.sites;
        overworldRealmId = msg.realmId;
        overworldName = msg.name;
        // `??` AND NOT AN `if`: a server that stopped sending the table should
        // clear the captions rather than leave the last ones floating over a map
        // it no longer describes.
        overworldRegions = msg.regions ?? [];
      }
      /**
       * SEEDED FROM THE SERVER'S COPY, which is the one that persists.
       *
       * The client keeps revealing locally at the same radius so neither side
       * sends anything per step — but the authority is the save, and this is
       * where the two meet. Merged into whatever this session had rather than
       * replacing it: a frame that arrived after some walking must not un-see
       * ground the player just crossed.
       */
      if (msg.explored !== undefined) {
        const seen = explored.get(msg.realmId) ?? new Set<string>();
        for (let y = 0; y < msg.level.h; y += 1) {
          for (let x = 0; x < msg.level.w; x += 1) {
            const bit = y * msg.level.w + x;
            if (fogBitSet(msg.explored, bit)) seen.add(`${x},${y}`);
          }
        }
        explored.set(msg.realmId, seen);
      }
      lastError = null;

      // Mid-flight and about to be about the wrong world — the same four
      // `welcome` settles, for the same reason.
      sweep?.settle();
      turn = null;
      bellEndsAt = null;
      combatBanner?.reset();

      // Aimed at, drawn on, or routed across a map that is no longer under us.
      targeting?.cancel();
      pendingTalentId = null;
      talentsArmedId = null;
      tokenMenu?.close();
      cancelTravel();
      forgetInspections();
      pings = [];
      projectiles = clearProjectiles();
      ground = [];
      effects = new Map();
      reviveArmed = false;
      // The landmarks came WITH the frame, so they are replaced rather than
      // cleared -- an inner-world has none and says so with an empty list.

      // NOT cleared, and each one is load-bearing: caseLog, party, partyState,
      // inviteDeadlines, inventory, progress. See the block above.
      setMarginText(undefined, `You are in ${msg.name}.`);
      break;
    /**
     * THE MARKERS MOVED, AND NOTHING ELSE DID. See `SitesMsg`: the roamers
     * wander every few turns while the level under them never changes, and
     * re-sending `realm` to say so would ship 17,000 tiles to describe one
     * marker stepping a cell.
     *
     * Absolute, like `ground` and `projectiles`: the table is REPLACED.
     */
    case 'sites':
      if (msg.realmId === currentRealmId) {
        sites = msg.sites;
        if (realmKind === 'overworld') overworldSites = msg.sites;
      }
      break;
    case 'state':
      // The dumb recovery path: a full list replaces everything known.
      replaceActors(msg.actors);
      // TRAVEL INTERRUPT (7), the other half. A resync means this client and the
      // server had drifted, so every tile of the route was computed from a board
      // that was wrong. Silently, for the same reason as `welcome`.
      cancelTravel();
      forgetInspections();
      // THE SAME EMPTYING AS `welcome`, and for the same half of the reason: a
      // resync means this client and the server had drifted, so every orb in
      // this list was drawn from a board that was wrong.
      //
      // THIS IS ONLY SAFE BECAUSE EVERY `state` SITE RESTATES THE SKY. All three
      // of them do — the survival resync, the rename in `hello`, and the
      // respawn — each calling `sendProjectilesIfAny` immediately after the
      // broadcast (src/server/net/gateway.ts). The `projectiles` frame is
      // complete and absolute (protocol.ts), so clearing here can only ever
      // remove an orb that was already a lie. A fourth `state` site that forgot
      // to carry the sky would silently delete a live orb from this screen and
      // the server's own memo would suppress the correction, so the rule lives
      // in a comment on both sides of the wire.
      projectiles = clearProjectiles();
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
        // AND THE OPEN CHARACTER SHEET IS RE-ASKED ON THE SAME EDGE, for exactly
        // the same reason the pin is: the sheet draws from that cache, so without
        // this it goes blank one turn after it was opened and stays blank —
        // nothing else re-asks about a body the pointer is not resting on. One
        // frame per game turn while the panel is open; see `refreshSelfSheet`.
        refreshSelfSheet();
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
      /**
       * AND THE BAR IS PUT IN ORDER AGAINST IT.
       *
       * IMMEDIATELY AFTER THE ASSIGNMENT, before anything else in this arm
       * reads `loadout`: `reseatTalentBindings` resolves ids against it, so a
       * call above the assignment would arrange the bar around the PREVIOUS
       * class. That is the whole failure mode of a class swap, and it would
       * look like the bar keeping one talent from the character you stopped
       * being.
       *
       * It leaves an arranged bar alone and fills only what is empty or dead —
       * see the function, which is where the three rules are written down.
       */
      reseatTalentBindings();
      // ABSENT MEANS NONE — an older server sends no such field, and a class
      // without passives sends no empty array either.
      passives = msg.passives ?? [];
      // ABSENT MEANS NONE LEFT TO BUY — a character who has spent all three
      // points, and every build where nothing is locked.
      unlockable = msg.unlockable ?? [];
      // ═══ AND THIS FRAME IS THE CLASS CHOOSER'S ONLY ACKNOWLEDGEMENT ═══
      //
      // There deliberately is no "you are a Watchman now" frame. On a successful
      // `choose_class` the server sends `loadout`, `cooldowns` and `resource` on
      // this socket and then broadcasts `state` — and a NEW loadout is the frame
      // that could only exist because the choice landed, which is what
      // protocol.ts's `ClassOptionsMsg` asks the picker to wait for.
      //
      // NOTHING CLOSES IT OPTIMISTICALLY. A refusal (`bad_message` for an id this
      // build does not have, `not_your_turn` for a second choice) leaves the modal
      // exactly where it was, which is correct: the body is still wearing the
      // provisional class and this screen is the only thing that changes that.
      //
      // The ordering in `hello` is what makes this safe on a first connection:
      // the gateway sends `loadout` BEFORE `class_options`, so a fresh player's
      // picker is put up after this line has already run with nothing to clear.
      classOptions = null;
      selectedClass = null;
      pickerHovered = null;
      // THE CHAT ROW COMES BACK HERE AND NOWHERE ELSE. This is the frame that
      // could only exist because the choice landed, so it is the one place that
      // knows the modal is genuinely gone — a refusal leaves the picker up, and
      // handing the keyboard's only escape route back at that moment would undo
      // the gate while the screen it protects is still on top. See
      // `setCommandLineReachable`.
      //
      // v11: A RECOMPUTE, NOT AN ASSERTION OF `true`. There is a second surface
      // that needs this row out of reach now (the escape menu, so Tab can be
      // bound), and a `true` here would hand the keyboard's only escape route
      // back while that surface was still up. `syncCommandLineReach` evaluates
      // both reasons; adding a third means editing one function rather than
      // finding every call site.
      syncCommandLineReach();
      // Whatever was being aimed may not be in the new loadout, and its range
      // ring certainly is not — this frame is RE-SENT on every spend precisely
      // because `range`, `desc` and `descNext` are stale the instant a rank
      // moves (protocol.ts's `LoadoutTalent`), and Fog Step's ring genuinely
      // grows a tile per rank. That mid-session re-send is what this cancel is
      // for; the sentence here used to say it was a thing M6 would one day make
      // true, and v9 made it true.
      targeting?.cancel();
      // ═══ AND IT IS THE TALENT PANEL'S ONLY ACKNOWLEDGEMENT OF A SPEND ═══
      // Exactly the shape the class chooser uses two paragraphs above: there is
      // no "the point landed" frame, and a fresh `loadout` is the frame that
      // could only exist because it did. Disarming here rather than on the click
      // means a REFUSED spend leaves the row armed — which is correct, because
      // the point is still in hand and the panel is still explaining itself.
      talentsArmedId = null;
      break;
    case 'progress':
      // ═══ v9 — THE VIEWER'S OWN LEDGER. UNICAST, ABSOLUTE, REPLACED WHOLESALE ═══
      //
      // A `ViewerMsg`, so it arrives only for this socket and there is nothing to
      // filter — protocol.ts makes broadcasting it a compile error server-side,
      // because `unspent` is INTENT and a party panel showing everyone's banked
      // points would turn a private judgement into a queue of people telling each
      // other what to buy.
      //
      // It arrives at `welcome`, again whenever any of its four numbers changes
      // during a pump, and again after every successful spend — so this client
      // never has to ask for one and never computes one. Nothing here arms a
      // timer or sends anything; the redraw is `onMessage`'s, which calls
      // `requestDraw()` after every applied frame.
      //
      // ═══ AND IT IS THE ONLY PLACE THIS CLIENT CAN NOTICE A LEVEL-UP ═══
      // The old body was this one assignment. Because the frame is ABSOLUTE and
      // replaced wholesale, a level-up looked exactly like every other progress
      // frame: nothing on screen changed except two numbers inside two panels
      // the player has to open by hand. Three friends could cross levels 2, 3
      // and 4 in the first fight and finish the evening with every talent at
      // rank 1 and three unspent points each, because nothing ever suggested
      // pressing `g`.
      //
      // COMPARED AGAINST THE HELD FRAME, BEFORE THE ASSIGNMENT, which is the
      // only moment the previous values still exist. `unspent` is checked as
      // well as `level` and not instead of it, because the two do not always
      // move together: a REFUND (a talent id that vanished from the loadout —
      // the load path hands its points back) raises `unspent` with the level
      // standing still, and that is a point in hand the player is equally
      // entitled to be told about. The `>` is deliberate: a SPEND lowers
      // `unspent` and must say nothing, because the player just watched
      // themselves do it.
      //
      // A NOTICE RATHER THAN A SOUND OR A MODAL. A modal in a phase-locked game
      // is the class picker's problem all over again — the barrier has no notion
      // of "is reading a menu" — and this client has no audio. The shared half of
      // the news is already in the Case Log where the whole party can read it.
      //
      // ═══════════════════════════════════════════════════════════════════════
      // v12: IT NO LONGER GOES THROUGH `onRefusal`, AND IT IS ONE SENTENCE.
      // ═══════════════════════════════════════════════════════════════════════
      // TWO THINGS WERE WRONG WITH THE OLD SHAPE. The hook is spelled `onRefusal`
      // and everything else that reaches it is a REFUSAL — "too close", "not your
      // turn", "not connected" — so the single best piece of news in the game
      // arrived in the complaints channel, in the same orange, in the same slot,
      // for the same four and a half seconds. `showNotice` is the same timer and
      // the same line under a name that does not claim the player did something
      // wrong; the binding is `onGoodNews`, and the split costs one variable.
      //
      // And it was an `else if`, which made CROSSING A LEVEL AND GAINING A POINT
      // — the common case, and precisely the moment the tree wants opening —
      // print only the level and never the count. `src/shared/progression.ts`
      // grants a point on every level, so the two move together on nearly every
      // frame this branch fires on. One merged sentence names both.
      //
      // The two facts are still checked SEPARATELY and the `>` on each is still
      // deliberate: a REFUND (a talent id that vanished from the loadout — the
      // load path hands its points back) raises `unspent` with the level standing
      // still, and a SPEND lowers it and must say nothing, because the player
      // just watched themselves do it.
      {
        const before = progress;
        progress = msg;
        // THE KEY IS READ OFF THE LIVE KEYMAP, like every other mnemonic in this
        // file since v11 — see `keyHint`. This notice is one of the two places a
        // player ever learns the talent panel exists, so naming a key they have
        // rebound away would make the whole tree dead content for exactly the
        // player who took the trouble to rebind.
        const talentKey = keyHint('show_talents');
        const levelled = before !== null && msg.level > before.level;
        const gained = before !== null && msg.unspent > before.unspent;
        if (levelled || gained) {
          const points = `${String(msg.unspent)} talent ${msg.unspent === 1 ? 'point' : 'points'}`;
          onGoodNews(
            levelled
              ? `level ${String(msg.level)} — ${points} in hand, press ${talentKey}`
              : `${points} in hand — press ${talentKey}`,
          );
        }
      }
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

    case 'roster':
      /**
       * ═══ v19 — "WHO ARE YOU TONIGHT", AND IT MEANS THIS CLIENT HAS NO BODY ═══
       *
       * SENT INSTEAD OF THE WORLD, NEVER ALONGSIDE IT. There is no `welcome`, no
       * `realm`, no `state` and no token in any field — the server has not added
       * one. That is what makes it safe to sit here reading.
       *
       * ═══ "THERE IS NOTHING BEHIND IT" WAS ONLY TRUE THE FIRST TIME ═══
       * This paragraph used to end by saying the modal cannot be dismissed
       * because there is nothing behind it, and that was a claim about the
       * SERVER being read as a claim about the CLIENT. The server really does
       * send no world — but a player changing character has been playing one,
       * and every surface below was still holding the board they just left.
       *
       * Reported with a screenshot: the select screen sitting over a lit moor,
       * with the party card, the case log and a full hotbar all still drawn
       * around it. The scrim is `globalAlpha = 0.7`, so it dims the world it is
       * covering rather than replacing it, and the menu read as a panel that had
       * been dropped on top of a game still in progress.
       *
       * So the claim is made TRUE rather than merely restated. `forgetTheWorld`
       * is the same teardown `welcome` runs, and the three surfaces it does not
       * touch are cleared here because a roster is the STRONGER statement:
       * `welcome` says "here is a different board", this says "you do not have
       * one".
       *
       * ARRIVING TWICE IS NORMAL AND IS NOT AN ERROR. It is the server's answer
       * for "that character cannot be opened" and for "you are at the cap", so
       * this replaces wholesale and re-derives the selection rather than
       * assuming the list is the same list.
       *
       * THE SELECTION IS RE-ANCHORED BY ID, not by index. A roster that came
       * back one row shorter would otherwise leave the highlight on whichever
       * character slid into that slot — and the next Enter would play them.
       */
      roster = msg;
      forgetTheWorld();
      /**
       * ═══ AND THE BOARD ITSELF, WHICH `forgetTheWorld` DELIBERATELY LEAVES ═══
       * Its other caller is replacing these three in the same breath, so it has
       * no business writing them. Here there is nothing to replace them WITH.
       * A null level is not a special case the renderer needs teaching: it is
       * the state every client is in before its first `welcome`, which is
       * exactly the state a player at the select screen is in.
       */
      level = null;
      selfId = null;
      replaceActors([]);
      /**
       * A REQUIRED SCREEN ARRIVING MUST DISMISS THE ONE IT IS COVERING —
       * `case 'class_options'` makes this argument in full and the roster has
       * the same shape: it cannot be cancelled, it is painted last, and an
       * escape menu left open underneath it would have no keyboard route out
       * and no pointer route out either.
       */
      resetMenuState();
      /**
       * AND A NEW LIST DISARMS. Every roster is an answer to something that
       * just happened, so a `SURE?` still showing from before it arrived is a
       * button whose question has already been settled — and the row under it
       * may not even be the same character.
       */
      rosterArmedDeleteId = null;
      selectedCharacter =
        chosenCharacterId === null
          ? null
          : (() => {
              const at = msg.characters.findIndex((row) => row.id === chosenCharacterId);
              return at < 0 ? null : at;
            })();
      rosterHovered = null;
      break;
    case 'class_options':
      // ═══ v8 — "PICK ONE", AND IT IS THE ONLY FRAME THAT PUTS UP A MODAL ═══
      //
      // A `ViewerMsg`, so it arrives unicast and only ever for the socket that
      // owes a choice — there is nothing here to filter and no "is this for me?"
      // test to build on top of it (protocol.ts makes broadcasting it a compile
      // error server-side, which is where that guarantee is enforced).
      //
      // STORED WHOLESALE, IN THE SERVER'S ORDER, NEVER SORTED. protocol.ts asks
      // for that order to be respected because "a card that moves between two
      // frames is a card somebody misclicks, and this one is irreversible".
      //
      // The redraw is the caller's: `onMessage` calls `requestDraw()` after every
      // applied frame, and the dirty flag folds this into that one callback.
      // Nothing here arms a timer or sends anything — the picker is a screen, not
      // a negotiation.
      classOptions = msg.options;
      // ═══ AND THE OPTIONAL SCREEN UNDERNEATH IS TORN DOWN ═══
      // A required screen arriving must dismiss the one it is covering.
      // `onCancel` returns unconditionally while `classOptions !== null` and the
      // picker is painted last of everything with `overPanel` answering true for
      // the whole viewport — so an escape menu that was open when this frame
      // landed (a reconnect re-sends `class_options` in the `hello` block) had no
      // keyboard route out and no pointer route out either. It sat behind the
      // chooser until a class was picked and then reappeared over the map,
      // unannounced, with whatever was armed on it still armed.
      resetMenuState();
      // AND THE KEYBOARD IS GENUINELY TAKEN, NOT MERELY GATED. `onUi`'s early
      // return stops the `t` KEY from focusing the command line; it cannot stop
      // Tab or a mouse click on a row that is still sitting in the page. See
      // `setCommandLineReachable` for the full route map — this is the edge that
      // closes it, and `case 'loadout'` is the edge that opens it again.
      //
      // v11: through the recompute, like every other site. `classOptions` has
      // just been set above, so this reads the fact rather than restating it.
      syncCommandLineReach();
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
    case 'projectiles': {
      // ═══ v7 — WHAT IS IN THE AIR. COMPLETE, AND REPLACED RATHER THAN MERGED ═══
      //
      // The identical rule to `effects` above, applied to an object with a much
      // shorter fuse. protocol.ts:634-646 states the cost of the alternative in
      // general terms; here it is specific and worse. A patch stream leaves a
      // PHANTOM ORB on the map forever after one dropped frame, and a phantom
      // orb does not merely look wrong — it teaches the counterplay backwards.
      // The player learns to step off a tile nothing is coming to, and having
      // learnt that the picture lies, stands still for the one that is.
      //
      // AN EMPTY ARRAY IS A REAL AND COMMON ANSWER: the sky is clear. And the
      // absence of an id from this frame is the ONLY spelling of "it landed" —
      // there is no landed event, and `applyTurnEvent` is deliberately untouched
      // by this feature. The impact arrives as the ordinary `attack` step the
      // sweep already carries, attributed to the shooter.
      projectiles = applyProjectilesFrame(msg);

      // ═══ AND ONE SENTENCE, WHEN IT IS AIMED AT THE TILE YOU ARE ON ═══
      //
      // The orb does not re-aim (decision (c)): it flies to the tile its victim
      // stood on at the instant of firing, so stepping off that tile is the
      // whole of the counterplay. The dot on the map is the picture of that; this
      // is the words, in the slot the eye is already on, and it is the only copy
      // a player who is watching their hotbar will read.
      //
      // ONLY INTO AN EMPTY SLOT. `notice` is the REFUSAL line, and this file's
      // header calls a refusal that never reaches the player the worst failure
      // mode in a turn-based game. A `projectiles` frame arrives at the tail of
      // every pump, so raising this unconditionally would silently wipe the
      // "too close — Sniper's Mark needs 3 tiles" the server unicast half a pump
      // earlier — every turn, for as long as anything was in the air. The
      // refusal is the rarer and more urgent fact and it wins; the orb re-offers
      // its sentence on the next pump, because it is still coming.
      if (notice === null) {
        const incoming = orbsAimedAt(projectiles, selfTile());
        if (incoming === 1) {
          onRefusal('an orb is aimed at this tile — move, or break line of sight');
        } else if (incoming > 1) {
          onRefusal(`${incoming} orbs are aimed at this tile — move`);
        }
      }
      break;
    }
    case 'ground':
      // ═══ v10 — WHAT IS ON THE FLOOR. COMPLETE, AND REPLACED RATHER THAN
      //     MERGED ═══
      //
      // The identical rule `effects` and `projectiles` follow, applied to an
      // object with a much LONGER fuse — which makes it worse rather than milder.
      // An orb is a three-turn thing; a coat on the floor lasts the rest of the
      // delve. protocol.ts's `GroundMsg` states the cost of a patch stream in this
      // feature's own terms: a phantom pile sends somebody walking the length of
      // the map, through a fight, to a tile with nothing on it — and because the
      // pile is UNOWNED and first pickup wins, what they will conclude is that a
      // friend took it. The one failure mode this design can least afford is the
      // one that makes the party argue.
      //
      // AN EMPTY ARRAY IS A REAL AND COMMON ANSWER: the floor is clear. It is the
      // ONLY spelling of "somebody took the last thing" — there is no taken event
      // and there must not be one, for the reason `GroundMsg` gives: a drop is a
      // standing fact about a tile, and the events lane is for instants.
      //
      // NOTHING IS DERIVED HERE. The grouping into one mark per tile happens in
      // `lootMarkers`, once per frame, because the same join answers the menu's
      // Pick up row through `lootAt`. The redraw is `onMessage`'s, which calls
      // `requestDraw()` after every applied frame.
      ground = msg.items;
      break;
    case 'inventory':
      // ═══ v10 — YOUR BAG AND YOUR DOLL. UNICAST, ABSOLUTE, BOTH HALVES AT ONCE ═══
      //
      // A `ViewerMsg`, so it arrives only for this socket and there is nothing to
      // filter — protocol.ts makes broadcasting it a compile error server-side.
      // That is not only privacy: `CarriedItemView.compare` is a delta against the
      // RECIPIENT'S own paper doll, so a shared copy would be arithmetically wrong
      // for everybody but its author, and wrong in the direction that promises a
      // player armour they will not get.
      //
      // REPLACED WHOLESALE, NEVER MERGED, and both halves together — one frame for
      // the doll and the bag is the port (tome/class/Game.lua:2192 makes
      // `SHOW_EQUIPMENT` an alias of `SHOW_INVENTORY`), and two frames could land
      // a pump apart and draw a comparison against a slot whose contents had
      // already changed.
      //
      // THE COMPARISON ROWS ARE DRAWN, NEVER COMPUTED. They arrive pre-formatted
      // (`{label:'Armour', value:'+3'}`), and eslint blocks src/client/** from
      // importing shared/checkhit, shared/scale and shared/energy so this file
      // could not work them out — nor should it try: `rescaleCombatStats` FLOORS,
      // so even the subtraction that looks safe is wrong.
      //
      // A BARE DETECTIVE NEVER RECEIVES THIS FRAME AT ALL. The server sends it on
      // a memo seeded empty, which is what keeps the pre-loot frame set
      // byte-identical — so `null` is the ordinary opening state and ui/inventory.ts
      // draws it as "nothing worn, nothing carried" rather than as a failure.
      inventory = msg;
      // ═══════════════════════════════════════════════════════════════════════
      // AND THE CHARACTER SHEET IS RE-ASKED HERE, BECAUSE A LOADOUT CHANGE IS NOT
      // RELIABLY A GAME-TURN EDGE.
      // ═══════════════════════════════════════════════════════════════════════
      //
      // `inspectCache` is invalidated in exactly one other place — `case 'turn'`,
      // under `msg.gameTurn !== turn?.gameTurn` — and that was a complete rule for
      // as long as every number on the sheet was a consequence of somebody taking
      // a turn. Equipment is the first thing that moves `actor.combat` without
      // that being guaranteed.
      //
      // ═══ THE CASE THAT IS STILL LIVE, AND IT IS AN ORDINARY PARTY ═══
      // A loot verb DOES spend the sender's turn server-side (gateway.ts's
      // `spendLootTurn`), so most of the time the clock does advance and the
      // `turn` frame arrives and clears the cache anyway. But `tickLevel` returns
      // `parked` WITHOUT advancing anything while ANY player still owes a
      // decision — so a player who gets dressed while a teammate is thinking has
      // their submitted turn sit pending, the clock stand still, and `gameTurn`
      // come back identical. `broadcastTurnIfChanged` then correctly suppresses
      // the frame as a duplicate, and nothing else would clear this cache.
      // Without these lines the sheet goes on printing Armour 6 for a body the
      // server has already recomposed to Armour 10, and it does so until somebody
      // else moves — closing and re-opening the panel does not help, because
      // `requestSelfSheet` returns early on a cache entry stamped with this same
      // game turn. That is Trap 1 exactly as a player meets it: equip, look at
      // the sheet, and the sheet says the item did nothing.
      //
      // Hanging it on THE STATE CHANGE rather than on THE CLOCK is also simply
      // the more honest edge: what invalidates a character sheet is the sheet
      // changing, and this frame is sent exactly when it did.
      //
      // THE DELETE COMES FIRST AND THAT ORDER IS THE WHOLE FIX. `refreshSelfSheet`
      // is `requestSelfSheet`, whose first act is that same-turn early return, so
      // calling it against a live entry sends nothing at all.
      //
      // THIS FRAME IS THE RIGHT EDGE TO HANG IT ON: it is unicast, absolute, and
      // sent by `refreshViewers` only when this viewer's own loadout actually
      // changed — once per real change, and never for anybody else's.
      if (selfId !== null) {
        inspectCache.delete(selfId);
        // THE PIN TAKES THE SAME TREATMENT AS ON THE TURN EDGE, and for the same
        // reason: `tooltipView()` reads the pin BEFORE the cache, so clearing the
        // cache alone leaves a card pinned to your own body quoting the armour
        // you had before you got dressed.
        if (pinnedInspectId === selfId) refreshPinnedInspect();
      }
      refreshSelfSheet();
      break;
    case 'shop':
      // A WHOLE-LIST REPLACEMENT, like the floor and the party: a client that
      // dropped a frame is corrected by the next one rather than showing a coat
      // somebody else bought twenty minutes ago.
      shop = msg;
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

    case 'hotbar': {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE BAR THE SERVER IS HOLDING FOR THIS CHARACTER. UNICAST AND ABSOLUTE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * A `ViewerMsg`, so it arrives only for this socket, and it is an ECHO
       * rather than an acknowledgement — the same shape as `keybinds` below it,
       * for the same reason: what the screen renders must be what the SERVER
       * holds, or the two drift and only one of them survives a refresh.
       *
       * ═══ AN EMPTY LIST IS "NEVER ARRANGED", NOT "EMPTY BAR" ═══
       * The distinction is the whole reason the wire carries an array rather
       * than a sparse map. Never-arranged is answered by leaving the store
       * alone, so `reseatTalentBindings` seeds from the loadout exactly as it
       * does for a brand-new character. An array of NULLS is a player who
       * cleared every slot on purpose, and it is applied verbatim — a client
       * that refilled it would overwrite a decision.
       *
       * ═══ THE LENGTH IS THE CLIENT'S, NOT THE FILE'S ═══
       * A saved bar from a build with one page, or with three, must not resize
       * the store — every index in it is a key a player presses. Copied
       * position by position into a store of the CURRENT size: a shorter file
       * leaves the tail seeded from the loadout, a longer one has its extra
       * slots dropped, and neither can produce a bar with the wrong number of
       * buttons.
       */
      if (msg.slots.length > 0) {
        for (let i = 0; i < talentBindings.length; i += 1) {
          talentBindings[i] = msg.slots[i] ?? null;
        }
        // AND RESEATED AGAINST THE LOADOUT, which drops ids this character can
        // no longer press and fills anything the saved bar left empty. Without
        // it a file older than the class's current talents would come back with
        // dead slots that look like the bar failed to load.
        reseatTalentBindings();
      }
      /**
       * NOT PERSISTED IS SAID OUT LOUD, ONCE. `persisted` is false for an
       * anonymous socket and for a build with no save layer, and a bar that
       * quietly forgets itself every session is the failure this whole frame
       * exists to prevent — the player would conclude the feature is broken
       * rather than that they are not signed in.
       */
      if (!msg.persisted) hotbarPersists = false;
      // THE REDRAW IS THE CALLER'S — `onMessage` calls it after every frame, so
      // one here would be the second of two and the first to go stale.
      return;
    }
    case 'keybinds':
      // ═══════════════════════════════════════════════════════════════════════
      // v11 — THE KEYS THE SERVER IS HOLDING FOR THIS PLAYER. UNICAST, ABSOLUTE,
      // AND IT IS AN ECHO RATHER THAN AN ACKNOWLEDGEMENT.
      // ═══════════════════════════════════════════════════════════════════════
      //
      // A `ViewerMsg`, so it arrives only for this socket — protocol.ts makes
      // `broadcast(keybindsMsg)` a compile error server-side, because there is
      // no version of this frame that is correct for two recipients.
      //
      // ═══ THE SCREEN RENDERS *THIS*, NEVER WHAT THIS CLIENT HOPED IT SENT ═══
      // `commitRemap` calls `setKeymap` for the instant local effect and puts the
      // map on the wire; this line calls it AGAIN with whatever the server
      // actually stored. A map that was trimmed, bounced or never received
      // corrects itself here — which is the whole reason the frame exists
      // (protocol.ts: "the echo is the point"). The server is authoritative
      // about preferences too.
      //
      // `setKeymap` MUTATES THE LIVE BOX and re-registers nothing: keys.ts
      // forbids dispose-then-rebind outright, because it would move
      // `bindGameKeys` after the travel-cancel listener and invert an Escape
      // precedence two files call load-bearing. The very next keydown uses the
      // new tables.
      //
      // AN ACTION ID THIS BUILD NO LONGER BINDS IS DROPPED *HERE*, silently and
      // on purpose — `compileKeymap` walks `ACTIONS`, so an id that matches
      // nothing simply never lands in a table. THE CLIENT OWNS THAT DROP: neither
      // the wire nor the disk has an action table to check against, both keep it
      // verbatim so a renamed-then-restored action comes back, and this is
      // exactly what `createTalentSheet` does with a talent id the class no
      // longer has.
      /**
       * MIGRATED FIRST. A save written before the world map existed still says
       * `toggle_log: ['key:m']`, and `m` is now the world map's default — both
       * would land in the same table and the later action would win, so the
       * returning player presses M and gets the Case Log. See
       * `migrateStoredKeymap`, which drops only a stored key that some OTHER
       * action now defaults to.
       */
      setKeymap(migrateStoredKeymap(ACTIONS, msg.binds));
      keybindsPersisted = msg.persisted;
      // ...AND THE CHAT ROW'S PLACEHOLDER, because `say` is rebindable and that
      // string names its key. See `syncCommandLinePlaceholder`.
      syncCommandLinePlaceholder();
      // The redraw is the caller's: `onMessage` calls `requestDraw()` after every
      // applied frame and the dirty flag folds this into that one callback. Every
      // sentence this frame can change — the Keys screen's rows, the hint lines,
      // the aria-live copies — is rebuilt from `gameKeymap` when it is next
      // drawn, so there is nothing to invalidate here.
      break;

    case 'settings':
      // ═══════════════════════════════════════════════════════════════════════
      // HOW BIG THIS PLAYER WANTS THEIR TILES, AS THE SERVER HOLDS IT.
      // ═══════════════════════════════════════════════════════════════════════
      //
      // `keybinds` above, in miniature and for the same reasons: a `ViewerMsg`,
      // absolute, and an ECHO rather than an acknowledgement — `setZoom` has
      // already run locally for the instant effect, and this line runs it again
      // with whatever the server actually stored, so a value the server clamped
      // corrects itself here instead of leaving the board drawing this client's
      // optimism.
      //
      // A player asked for tiles the size of Tales of Maj'Eyal's. Half of that
      // was the viewport; this is the half where the answer they gave stopped
      // dying with the tab. Discord partitions iframe storage, so the server is
      // the only place a preference can live.
      // THE VALUE IS RECORDED HERE AND APPLIED IN `boot`. `applyServerMessage`
      // is module scope by construction — every case in this switch writes state
      // the draw reads, and none of them reaches into the renderer, which lives
      // in the boot closure. `onMessage` is the wrapper that can see both.
      storedZoom = msg.zoom;
      zoomPersisted = msg.persisted;
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
      // THE ARMED `+` IS DISARMED BY ANY REFUSAL AT ALL, and deliberately not
      // only by a refused spend: nothing on this wire says which frame an
      // `error` is about, and a row left armed under a refusal banner is one
      // press from spending an irreversible point while the player is reading
      // about something else entirely. Re-arming costs one click.
      talentsArmedId = null;
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
