/**
 * Protocol and content version constants.
 *
 * This file lives in src/shared/, which is PURE by construction: tsconfig.shared.json
 * sets `"types": []` and `"lib": ["ES2024"]`, so `process`, `fs`, `console`, `window`
 * and `setTimeout` do not resolve here. `Date.now()` and `Math.random()` are ES
 * built-ins that the compiler cannot remove, so ESLint bans them separately.
 *
 * The reason is determinism: given a seed and an action log, the engine must
 * reproduce a world state exactly. Anything that reads the clock, the filesystem
 * or an entropy source breaks that, and the failure is silent until a replay
 * diverges weeks later.
 */

/**
 * Bumped whenever the WebSocket envelope changes shape in a way an older client
 * cannot parse. The server refuses a mismatched client rather than letting it
 * fail confusingly three screens later.
 *
 * 1 -> 2 (M2, the Warrant Clock). The envelope gained `commit`/`hold` inbound
 * and `turn`/`sweep`/`attacked`/`damaged`/`died` outbound, and — the change that
 * really forces the bump — `left` NARROWED: a disconnect no longer removes the
 * body, so an M1 client would delete a token that is still standing on the map
 * and then never draw it again. A silently-misinterpreted frame is worse than a
 * refused connection.
 *
 * 2 -> 3 (M3, talents and the hotbar). The envelope gained `talent` inbound and
 * `loadout`/`cooldowns`/`resource`/`used` outbound. Additions alone would not
 * force a bump — an old client ignores a frame it does not know — but two things
 * here do, and both are silent rather than loud:
 *
 *   `TurnEvent` GREW A VARIANT. A v2 client's `applyTurnEvent` switch has no
 *   `talent` case, so a talent inside a batched `sweep` is dropped on the floor:
 *   monsters visibly take damage from nothing, and an AoE that killed three of
 *   them looks like the server desyncing.
 *
 *   `ErrorCode` GREW FIVE MEMBERS (out_of_range / too_close / on_cooldown /
 *   no_resource / no_los). A v2 client renders an unknown code as raw text, so
 *   the Inspector's dead zone — the number game-design.md § 2 calls the single
 *   most important one in the class — surfaces as the literal string
 *   `too_close: ...` instead of the ring's hole lighting up.
 *
 * Both are a client that keeps running while quietly showing the wrong game,
 * which is exactly what this constant exists to prevent.
 *
 * 3 -> 4 (M4, the party). The envelope gained `say`/`point`/`revive` inbound and
 * `log`/`effects`/`party`/`pinged` outbound. As at 2 -> 3, the additions alone
 * would not force a bump — an old client ignores a frame it cannot name. Two
 * things here do, and both are the same silent failure as last time: a v3 client
 * that keeps running while showing a game that is no longer true.
 *
 *   `TurnEvent` GREW FIVE VARIANTS (effect_applied / effect_expired / downed /
 *   revived / erased). A v3 client's `applyTurnEvent` switch has no case for any
 *   of them, and they arrive INSIDE a batched `sweep`, so they are dropped on the
 *   floor: badges never appear, and — the one that matters — a player who goes
 *   Downed inside a monster sweep is rendered as a healthy body standing up.
 *   game-design.md § 9 hangs the entire co-op tension on the five-turn Downed
 *   timer, and a client that cannot see it shows a party with nothing wrong.
 *
 *   `alive === false` NO LONGER MEANS DEAD. A Downed detective carries the same
 *   `alive: false` and `hp: 0` a corpse does — the flag is what stops the
 *   scheduler ticking them and what stops them blocking the tile an ally has to
 *   step onto (engine/downed.ts) — and the difference now lives in `party`, in
 *   the `_downed_s` sprite and in the `downed` event, none of which a v3 client
 *   can read. So it draws a corpse and nobody runs to it, which is the exact
 *   failure the five-turn timer exists to create tension around. That is a
 *   NARROWING of an existing field's meaning, the same class of change as
 *   1 -> 2's `left`, and it is why a refused connection beats a confusing one.
 *
 * 4 -> 5 (M5, the turn tracker). `TurnMsg` gained `engagement`, `inCombat` and
 * `actors`, and `turn` became per-recipient. No new frame, no new event variant
 * — and the bump is still forced, for the same reason every previous one was:
 * what a v4 client does is not "less UI", it is CONFIDENTLY WRONG UI.
 *
 *   A v4 CLIENT CANNOT SEE COMBAT AND DOES NOT KNOW IT CANNOT. It has no
 *   `inCombat`, so it infers the fight from `whoseTurn` being non-empty — the
 *   only signal it has — and that inference has no transition in it. Monsters
 *   engage, the barrier arms, and the screen says the same thing it said a
 *   moment earlier. This is not hypothetical: it is the bug report from the
 *   first real session, where players did not know combat had started and could
 *   not tell the game had become turn-based. A turn tracker that silently omits
 *   combat state is worse than no turn tracker, because a missing HUD sends
 *   somebody to ask and a lying one does not.
 *
 *   `turn` IS NO LONGER SAFE TO SHOW TO SOMEBODY ELSE. `TurnActor.isSelf` is
 *   true for exactly one recipient. A v4 client has no concept of the field, so
 *   nothing breaks in it directly — but a v4 SERVER and a v5 client, which is
 *   the shape of a half-finished deploy, gives every card `isSelf: undefined`
 *   and highlights nobody. The version check is what makes that combination
 *   refuse to connect instead of producing a HUD where the game is waiting on
 *   nobody in particular.
 *
 * 5 -> 6 (EXPLICIT PARTIES). The envelope gained `party` inbound and
 * `party_state` outbound. As at every bump since 2 -> 3, the additions alone
 * would not force this: an inbound verb a v5 client never sends costs it
 * nothing, and an outbound frame it cannot name is one it ignores. What forces
 * it is that AN EXISTING FRAME NARROWED — the same class of change as 1 -> 2's
 * `left` and 4 -> 5's `alive === false`, and the same silent failure.
 *
 *   `TurnMsg` STOPPED BEING ABOUT THE LEVEL AND STARTED BEING ABOUT YOUR PARTY.
 *   `whoseTurn`, `committed`, `standingBy` and `actors` used to hold every
 *   player on the floor, because the barrier was level-wide and that was the
 *   truth. From v6 the barrier is per-party (src/server/engine/party.ts): they
 *   hold the recipient's party and nobody else. A v5 client keeps rendering the
 *   strip with total confidence and is wrong in the one way that matters — it
 *   believes the strip is everyone it can see. Two people are visibly fighting
 *   ten tiles away, no card for either of them appears, no `left` was ever sent
 *   to explain it, and the HUD whose entire job is answering "is the game
 *   waiting on me?" now also has to answer "where did those two go?" and cannot.
 *
 *   AND IT CANNOT ASK TO JOIN THEM. `party` is the only way into a party and a
 *   v5 client has no way to send one, so the state it is misreading is also a
 *   state it can never leave. A player on a v5 client would be permanently solo
 *   with no explanation on screen — which is worse than the level-wide barrier
 *   this release exists to fix, because at least that one was visible.
 *
 * `PartyMsg` (`t: 'party'`) DELIBERATELY DID NOT NARROW and is not part of the
 * reason for this bump. It is still the whole floor's roster: it drives the
 * downed markers and the revive prompt, and reviving a stranger is legal and
 * always was.
 *
 * 6 -> 7 (THE TRAVELLING PROJECTILE). The envelope gained exactly one frame:
 * `projectiles` outbound, a complete-and-absolute snapshot of every orb in the
 * air. Nothing inbound changed, no `TurnEvent` variant was added, no `ErrorCode`
 * was added, and no existing field narrowed — which is normally the shape of an
 * addition a bump does NOT force. It forces one anyway, for the reason this file
 * has used since 2 -> 3: what a v6 client does is not "less UI", it is
 * CONFIDENTLY WRONG UI, and here it is wrong about the only thing the feature
 * exists to teach.
 *
 *   A v6 CLIENT CANNOT NAME THE FRAME, SO IT DRAWS NO ORB — AND THE DAMAGE
 *   STILL LANDS. A wraith's shot now takes up to three game turns to cross the
 *   room, and the whole point of the travel time is that the player can SEE it
 *   coming and step out of the line or put a wall between. Drop the frame and
 *   what is left is a monster that appears to do nothing for two turns and then
 *   deals damage out of thin air, from a source that is by then usually dead or
 *   somewhere else entirely. The counterplay does not merely go unrendered — it
 *   DOES NOT EXIST on that client, because the information it depends on never
 *   arrives. That is strictly worse than the instantaneous attack it replaced,
 *   and a player on a v6 client would correctly report the game as broken.
 *
 *   AND THE IMPACT IS NARRATED AS AN ORDINARY ATTACK. The blow arrives as the
 *   same `attack`/`damage`/`death` events every melee hit uses, attributed to
 *   the shooter — so there is no second signal a v6 client could fall back on
 *   and no way for it to infer that anything was ever in flight. It renders a
 *   complete, plausible, entirely wrong account of the fight.
 *
 * 7 -> 8 (CHOOSING WHO YOU ARE). The envelope gained `choose_class` inbound and
 * `class_options` outbound, and `InspectView` gained an optional `className` for
 * the character sheet's header. NEITHER HALF WOULD FORCE THIS BUMP ON ITS OWN,
 * and it is worth writing down why, because the reason it happens anyway is a
 * shape this file has not recorded before.
 *
 *   THE INBOUND VERB WOULD NOT FORCE ONE. `respawn` set the precedent at v5: a
 *   frame that travels client -> server is one an old client simply never sends,
 *   and every frame it RECEIVES still means exactly what it always did. What a
 *   v7 client would lose is a key, not the meaning of anything on the wire.
 *
 *   THE CHARACTER SHEET WOULD NOT FORCE ONE EITHER. Everything it needs beyond
 *   what is already on the wire arrives as extra `InspectRow`s, and an
 *   `InspectRow` is a label/value pair that a client either renders or drops —
 *   the type's own contract says a narrow viewport may drop rows. `className` is
 *   optional, so an old client and a monster both ignore it. That is textbook
 *   "an addition it can ignore", which by this file's rule since 2 -> 3 is
 *   precisely what does NOT force a bump.
 *
 * THE FORCING ARGUMENT IS THAT THE ROTATION IS A WRITE.
 *
 *   A v7 client cannot name `class_options`, so it draws no picker and sends no
 *   `choose_class`. The server must still give that body a class to stand up in,
 *   and today's fallback is the join-order rotation over the three CLASSES. Then
 *   the character file is written: `fileFor` persists `snapshot.classId ??
 *   binding.classId` (src/server/persist/saves.ts:1189) and the gateway calls
 *   `saveNow('join')` on every genuinely new character (net/gateway.ts:2662).
 *
 *   FROM THAT MOMENT THE FILE RESOLVES, SO THE CHOOSER NEVER APPEARS AGAIN. The
 *   player is not merely missing a screen this session — a single connection on
 *   a stale bundle silently and PERMANENTLY locks them out of the feature, on
 *   every future connection, from any client, with no signal anywhere on screen
 *   to infer it from. They were assigned a class they never agreed to and there
 *   is no path back to the question. That is a one-way door, and it is the same
 *   CONFIDENTLY WRONG UI shape this file used at 2 -> 3 and 6 -> 7: not "less
 *   UI", but a client that keeps running while quietly committing the player to
 *   something they were never asked about.
 *
 *   THE GATE IS WHAT TURNS IT INTO AN HONEST REFUSAL. `net/gateway.ts:6357-6366`
 *   answers `version_mismatch` and closes the socket before any frame is
 *   dispatched, so a stale bundle gets "update and reconnect" instead of a class
 *   written to disk behind the player's back. A refused connection beats a
 *   confusing one; here it also beats an irreversible one.
 *
 * NO `ErrorCode` MEMBER WAS ADDED, DELIBERATELY. A `choose_class` naming an
 * unknown id is `bad_message` and one from a player who already has a class is
 * `not_your_turn` — the same code `respawn` uses to refuse a body with nothing
 * to file. Both are already rendered by every shipped client, and this file
 * records at 2 -> 3 that a new `ErrorCode` independently forces a bump; reusing
 * two existing ones keeps the bump argument down to the single reason above.
 *
 * 8 -> 9 (LEVELS, AND THE PANEL THAT SPENDS THEM). The envelope gained
 * `spend_point` inbound and `progress` outbound, and `LoadoutTalent` grew
 * `level`, `maxLevel`, `desc` and `descNext`. NEITHER ADDITION FORCES THIS BUMP,
 * and it is worth saying so first: by the rule this file has used since 2 -> 3,
 * an inbound verb an old client never sends costs it nothing (`respawn` set that
 * precedent at v5 without moving the number) and an outbound frame it cannot
 * name is one it ignores. `LoadoutMsg` also stopped being a once-at-welcome
 * frame and became re-sendable mid-session, which forces nothing either — its
 * own docblock has always specified wholesale replacement and every shipped
 * client already implements it that way.
 *
 * THE FORCING SHAPE IS AN EXISTING FIELD NARROWING. The same shape as 1 -> 2's
 * `left`, 4 -> 5's `alive === false` and 5 -> 6's `TurnMsg` roster, and the same
 * silent failure all four times: not a client with less UI, a client that keeps
 * running while confidently drawing a game that is no longer true.
 *
 *   `LoadoutTalent.range` STOPPED BEING A CONSTANT OF THE CLASS AND BECAME A
 *   FACT ABOUT ONE ACTOR. It used to be `talent.targeting.range` — one authored
 *   number, identical on every Inspector's wire, and a v8 client is entitled to
 *   cache it forever because it never changed. From v9 it is
 *   `effectiveTalentRange(targeting, talentLevel)`, and Fog Step is the talent
 *   that breaks the old reading: its ONLY number is its range, and it scales
 *   3/4/5/6/7 across its five ranks on its own cited upstream curve
 *   (`combatTalentLimit(t, 10, 3, 7)`, mobility.lua:40-62). A v8 client that
 *   read the field once at `welcome` draws a THREE-tile ring around a talent
 *   that now reaches six, and its targeting mode refuses the tiles the player
 *   bought — so three spent points do visibly nothing, and the failure is on
 *   the client, in a game whose server has already agreed to the longer step.
 *   The ring is documented as a convenience and never a gate; this is the ring
 *   being convenient in the wrong direction.
 *
 *   AND THE HOTBAR HAS NO FIELD IN WHICH TO SHOW A RANK. That half is a missing
 *   ADDITION rather than a narrowing, so on its own it would not force this —
 *   but it is what turns the narrowing above from a rendering bug into a lie
 *   about the whole feature. A v8 client draws a level-4 talent exactly as it
 *   draws a level-1 one: no `n/max` under the icon, no current -> next diff, no
 *   panel. A player on a stale bundle spends eleven points into a screen that
 *   never changes, which is precisely the trap this milestone exists to avoid —
 *   a talent level that changes nothing is worse than no talent level at all.
 *
 * TWO SHAPES WERE DELIBERATELY AVOIDED, and naming them is how this entry keeps
 * its argument down to the one reason above — the same discipline 7 -> 8 used.
 *
 *   NO NEW `TurnEvent` VARIANT. A level-up narrates as an ordinary Record `log`
 *   line, not as a fourteenth member of the event union. This file records at
 *   2 -> 3 and 3 -> 4 that a new variant independently forces a bump, because
 *   events arrive INSIDE a batched `sweep` and an old client drops the ones it
 *   cannot name — and a level-up is exactly the kind of thing that would be
 *   dropped on the floor mid-monster-turn. A `log` line is a frame every client
 *   since v4 already renders, so the narration survives.
 *
 *   NO NEW `ErrorCode` MEMBER. A `spend_point` naming a talent that is unknown,
 *   not learned, or already at its cap is `bad_message`, and one from a player
 *   with no points in hand is `bad_message` too; where the existing turn gate
 *   applies, it is `not_your_turn`. Both codes are already rendered by every
 *   shipped client. A `no_points` member would have been clearer to read in a
 *   log and would have forced this bump a second time over for a refusal the
 *   panel already prevents by greying the `+`, which is the same trade v8 made.
 *
 * `SCHEMA_VERSION` DOES NOT MOVE WITH THIS, and the two were considered
 * separately rather than bumped together out of habit. The persisted character
 * gains OPTIONAL fields only — level, xp and the RAW per-talent points — and
 * docs/data-schemas.md:48-49 says an optional field needs no bump. Bumping it
 * would make an older build QUARANTINE a friend's character rather than merely
 * drop a level from it, and this game has no permadeath.
 *
 * 9 -> 10 (LOOT, EQUIPMENT, AND THE FLOOR IT LIES ON). The envelope gained four
 * inbound verbs — `pickup`, `equip`, `unequip`, `drop` — and two outbound frames:
 * `ground` (broadcast) and `inventory` (per-recipient).
 *
 * MOST OF THAT DOES NOT FORCE THIS BUMP, and saying so first is how this entry
 * keeps its argument down to one reason — the discipline 7 -> 8 and 8 -> 9 both
 * used.
 *
 *   THE FOUR INBOUND VERBS FORCE NOTHING. `respawn` set that precedent at v5 and
 *   it has held at every bump since: a frame that travels client -> server is one
 *   an old client simply never sends, and every frame it RECEIVES still means
 *   exactly what it always did. What a v9 client loses is four keys, not the
 *   meaning of anything on the wire.
 *
 *   `inventory` WOULD NOT FORCE ONE EITHER. An outbound frame an old client
 *   cannot name is one it ignores — this file's rule since 2 -> 3 — and what it
 *   would be ignoring is a panel it has no screen for. Nothing it already draws
 *   becomes wrong.
 *
 *   NO NEW `TurnEvent` VARIANT. A drop, a pickup and a death's spilled items all
 *   narrate as ordinary Record `log` lines, and the floor itself arrives as the
 *   `ground` SNAPSHOT rather than as a fourteenth member of the event union. This
 *   file records at 2 -> 3 and 3 -> 4 that a new variant independently forces a
 *   bump, because events travel INSIDE a batched `sweep` and an old client drops
 *   the ones it cannot name — so a monster dying mid-sweep would spill its coat
 *   into a client that never heard about it. A snapshot has no such failure mode:
 *   it is complete every time or it is not sent.
 *
 *   NO NEW `ErrorCode` MEMBER. Nothing on this tile, an item that is not in your
 *   bag, an empty slot, an item you already own — all `bad_message`. A body that
 *   may not act on the world at all is `illegal_move`. Both are already rendered
 *   by every shipped client. This file records at 2 -> 3 that a new code forces a
 *   bump on its own, and :192-197 and :250-256 are two earlier passes declining
 *   for exactly this reason; a `no_such_item` member would have forced this bump
 *   a second time over for a refusal the panel already prevents by only drawing
 *   buttons for things the player is holding.
 *
 * THE FORCING ARGUMENT IS THE PERMANENTLY-STUCK SHAPE, THE SAME ONE 5 -> 6 USED.
 *
 *   A v9 CLIENT CANNOT NAME `ground`, SO IT DRAWS NO FLOOR ITEM — AND IT HAS NO
 *   VERB WITH WHICH TO TAKE ONE. That is 6 -> 7's sentence with one noun changed
 *   ("A v6 CLIENT CANNOT NAME THE FRAME, SO IT DRAWS NO ORB — AND THE DAMAGE
 *   STILL LANDS"), and here BOTH halves fail at once rather than one. The orb at
 *   least announced itself by hitting you; a coat on the floor announces itself to
 *   nobody, and there is no second signal a v9 client could fall back on: the
 *   drop is a `log` line it renders as prose it cannot act on, in a party that is
 *   dividing loot around it in a voice channel. So the player is told, in words,
 *   about an object their client will never draw and their keyboard can never
 *   reach — the permanently-stuck shape 5 -> 6 refused for the party invite ("the
 *   state it is misreading is also a state it can never leave"). Every item that
 *   drops for that party is gone for the evening, silently, with the screen
 *   looking entirely normal.
 *
 * AND INDEPENDENTLY, TWO EXISTING FIELDS NARROWED — the shape 8 -> 9 used for
 * `LoadoutTalent.range`, and 1 -> 2, 4 -> 5 and 5 -> 6 before it.
 *
 *   `ActorView.maxHp` AND `InspectView.rows` STOPPED BEING FACTS ABOUT A CLASS
 *   AND BECAME FACTS ABOUT A CLASS PLUS ITS GEAR. Until v9 every Watchman on the
 *   wire had the same sheet: the numbers came from the authored `ClassDef` and
 *   from levels, and a client was entitled to treat them as a property of the
 *   class the way it once treated Fog Step's range. From v10 a worn coat is
 *   folded onto the combat sheet before it is projected
 *   (`recomposeCombat`, src/server/engine/effects.ts), so two detectives of the
 *   same class and level legitimately show different armour, defence and damage —
 *   and a client that cached, compared against, or explained those numbers by
 *   class would be confidently wrong about why one of them is dying faster. It is
 *   the same narrowing `LoadoutTalent.range` took at v9, in the frames every
 *   player looks at rather than in one talent's ring.
 *
 * `SCHEMA_VERSION` STAYS 1, and the two were considered separately again rather
 * than moved together out of habit — as the 8 -> 9 entry above did, for the same
 * reasons and with the same trade. The persisted character gains OPTIONAL fields
 * only — `carried` and `equipped` — and docs/data-schemas.md:48-49 reads verbatim:
 * "Adding an *optional* field needs no bump; the bump is for renames, semantic
 * changes, and new required fields." `migrateDoc` compares nothing but this
 * integer, so a v1 file with neither key loads untouched. The rollback trade is
 * even more lopsided here than it was at v9: not bumping means an older build
 * drops an inventory and costs an evening's loot, while bumping would QUARANTINE
 * the character outright and cost a friend the evening. Ground items are not
 * persisted at all, so there is no second file and no second migration chain to
 * version.
 *
 * AFTER v10: REBINDABLE KEYS, AND THE NUMBER DOES NOT MOVE.
 *
 *   C -> S  `set_keybinds` — "these are my keys." The Keys screen's only verb.
 *   S -> C  `keybinds`     — what the SERVER has stored, plus whether it will
 *                            outlive the session. Per-recipient.
 *
 * This is the second entry in this file for a change that did NOT force a bump —
 * `respawn` at v5 was the first — and it is written down for the same reason
 * that one was: the argument for standing still has to be as legible as the six
 * arguments for moving, or the next reader bumps out of caution and quarantines
 * a friend's character over a keyboard preference.
 *
 * THE RULE, restated from protocol.ts:127-128: a bump is forced by what an OLD
 * CLIENT would silently get WRONG, never by an addition it can ignore. Both
 * halves here are additions it can ignore, and this is the first change since
 * v5 where BOTH halves are.
 *
 *   THE INBOUND VERB IS `respawn`'S PRECEDENT EXACTLY. A frame that travels
 *   client -> server is one an old client simply never sends, and every frame it
 *   RECEIVES still means what it always did. What a v10 client loses is a
 *   screen, not the meaning of anything on the wire.
 *
 *   THE OUTBOUND FRAME IS ONE AN OLD CLIENT DROPS ON THE FLOOR, AND DROPPING IT
 *   COSTS IT NOTHING PERMANENT. `applyServerMessage` in src/client/main.ts has
 *   NO `default:` arm — deliberately, so that adding a `ServerMsg` member breaks
 *   every switch at lint time — so an unnameable frame falls through and does
 *   nothing at all. Compare 6 -> 7 and 9 -> 10, where an unnameable frame was
 *   exactly what forced the bump: there the client could not draw an orb that
 *   still hit it, or a coat it was being told about in prose and could never
 *   reach. Here the frame carries the player's own preferences, the client that
 *   cannot read them keeps its compiled defaults, and every key on that keyboard
 *   goes on doing what it did yesterday. Nothing it draws becomes wrong.
 *
 * AND THE FOUR SHAPES THAT WOULD HAVE FORCED ONE ANYWAY ARE ALL ABSENT. Naming
 * them is how this entry keeps its argument honest, the discipline 7 -> 8, 8 -> 9
 * and 9 -> 10 each used.
 *
 *   NO EXISTING FIELD NARROWED. Not `left`, not `alive === false`, not
 *   `TurnMsg`'s roster, not `LoadoutTalent.range`, not `ActorView.maxHp` — the
 *   five narrowings this file has bumped for. `keybinds` is a new frame carrying
 *   a new fact and no frame already on the wire means anything different because
 *   of it.
 *
 *   NO NEW `TurnEvent` VARIANT. A rebind is not an instant inside a batched
 *   sweep — it is not an instant in the WORLD at all — so there is nothing for
 *   an old client to drop mid-monster-turn. This file records at 2 -> 3 and
 *   3 -> 4 that a new variant independently forces a bump.
 *
 *   NO NEW `ErrorCode` MEMBER. :36-44 records that a new code forces a bump ON
 *   ITS OWN, because a v2 client renders an unknown code as raw text. A
 *   malformed keymap, an over-cap one, an unknown action id and a socket that
 *   never said `hello` are refused with `bad_message` and `not_authenticated`,
 *   both of which every shipped client already renders — exactly as v10 refused
 *   every loot failure and v9 every spend failure. A `bad_keybind` member would
 *   have been clearer in a log and would have forced this bump on its own, for a
 *   refusal the capture field already prevents by only offering keys the
 *   dispatcher can deliver. Three earlier passes made this trade; this is the
 *   fourth.
 *
 *   AND THE LOAD-BEARING ONE: NOTHING WRITES A KEYBIND MAP ON BEHALF OF A CLIENT
 *   THAT DID NOT SEND ONE. This is the v8 one-way door restated (:167-190), and
 *   it is a CONDITION rather than an observation — the no-bump answer depends on
 *   it and would be wrong without it. v8 had to bump because a v7 client drew no
 *   picker, the server assigned a class by rotation ANYWAY, and the join save
 *   wrote it — after which the chooser never appeared again, from any client,
 *   with nothing on screen to infer it from. The mirror here would be joining
 *   writing a default map: a single connection from a stale bundle would stamp
 *   the compiled defaults permanently over a returning player's binds. So the
 *   server never invents one. `handleSetKeybinds` is the only writer, an absent
 *   field is carried forward AS an absence all the way to the disk
 *   (`snapshot.keybinds ?? binding.keybinds`), and a v10 client that never sends
 *   the verb keeps whatever it had. There is no door to be locked out of.
 *
 * `SCHEMA_VERSION` STAYS 1, considered separately rather than moved along out of
 * habit — as the 8 -> 9 and 9 -> 10 entries above both did. The persisted
 * character gains ONE OPTIONAL field, `keybinds`, and docs/data-schemas.md:48-49
 * reads verbatim: "Adding an *optional* field needs no bump; the bump is for
 * renames, semantic changes, and new required fields." `migrateDoc` compares
 * nothing but this integer, so a v1 file with no `keybinds` key loads untouched.
 * The rollback trade is the most lopsided of the three: not bumping costs a
 * player their rebinds if somebody rolls back a build, while bumping would
 * QUARANTINE the character file in every older build and cost a friend the
 * evening. Two prior passes reached this decision and wrote the argument down; a
 * third must not undo it out of tidiness.
 *
 * ═══════════════════════════════════════════════════════════════════════════


 * CONSIDERED AND NOT BUMPED (WHAT HIT YOU, AND HOW HARD). `DamageEvent` gains
 * OPTIONAL `type` and `crit`, and PROTOCOL_VERSION STAYS 19.
 *
 * The change: the Case Log could not say what a blow was or whether it landed
 * hard, so a critical hit from a Redacted's darkness read character-for-
 * character like a graze off a husk — "7 damage. Dalt 41/58." Upstream logs
 * "%d %s" and bolds a crit at the projector, for every source of damage in the
 * game (damage_types.lua:496-501). Neither field is new information: `combat.ts`
 * has computed both since M3, `Blow` dropped `type`, and `hitToWire` then
 * dropped `crit` — a field-by-field mapper losing one field at each of two hops.
 *
 * ═══ WHY THIS DOES NOT FORCE A BUMP, BY THE RULE THIS FILE ALREADY APPLIES ═══
 * Every bump above argues that an old client would draw a LIE (6 -> 7, 9 -> 10,
 * 11, 17), or draw NOTHING (18 -> 19), or show something indistinguishable from
 * a bug (15 -> 16). A v19 client meeting a `damage` frame with two unknown keys
 * ignores them — there is no `safeParse` on the outbound side, and unknown keys
 * on a JS object are simply not read — and prints the exact line it printed
 * yesterday. Nothing on screen becomes false, nothing goes missing, and no room
 * behaves differently for two people standing in it.
 *
 * The nearest precedent is 15 -> 16, which bumped for a weaker reason than the
 * others: a silently goldless purse "is indistinguishable from a broken drop
 * table". This is not that. `money` was REQUIRED and its absence made a real
 * number wrong; these are optional and their absence makes a true line shorter.
 * A v19 client showing no damage types is a client that has never shown damage
 * types, which is not a symptom anybody would report as a bug.
 *
 * ═══ AND THE COST OF BUMPING IS NOT ZERO ═══
 * The gate is a hard refusal. This is a Discord Activity played in a voice
 * channel, deployed live after every commit, so the clients a bump actually
 * catches are the ones ALREADY IN A SESSION — friends mid-delve, told their
 * client is out of date because the log gained an adjective. The gate exists to
 * convert catastrophe into an honest refusal; spending it on an additive field
 * teaches everyone to expect a refusal for no reason.
 *
 * If a later pass makes either field REQUIRED, or renders one in a way an
 * absent value cannot fall back from, that pass bumps and this paragraph is the
 * argument it has to answer.
 *
 * `SCHEMA_VERSION` STAYS 1. Damage types have always been written into
 * `content/` JSON as these same lowercase strings, and no saved character has
 * ever held a damage event.
 *
 * ═══════════════════════════════════════════════════════════════════════════


 * 18 -> 19 (WHO ARE YOU TONIGHT). `RosterMsg` is a new outbound frame,
 * `hello` gains `characterId` and `newCharacter`, and an account may now own
 * more than one character.
 *
 * THIS ONE IS NOT THE USUAL NEW-FRAME CASE, AND THE BUMP IS NOT OPTIONAL.
 * The rule since 2 -> 3 is that a new outbound frame alone does not force a
 * bump, because an old client cannot name the frame and ignores it. That rule
 * assumes ignoring it is harmless. Here it is the opposite of harmless: a
 * verified socket that names no character is now sent a `roster` AND NO BODY —
 * no `welcome`, no `realm`, no `state`, nothing added to the world. A v18 client
 * would drop the frame it cannot name and then sit on a black screen forever,
 * with a healthy server, waiting for a world that is deliberately not coming.
 *
 * That is the exact failure the gate exists to convert into an honest "your
 * client is out of date", and it is the first bump in this file where the OLD
 * client's correct behaviour — ignore what you do not understand — is what
 * breaks it.
 *
 * `SCHEMA_VERSION` STAYS 1, and this one was argued rather than assumed. No
 * persisted field changed SHAPE: a character file is what it always was, and
 * the only new thing is that a directory may hold more than one of them, which
 * is what `data/characters/<ownerId>/` has been laid out for since the first
 * save landed (`SOLO_CHARACTER_ID`). An older build meeting a directory with
 * four files in it opens `chr_main` and ignores the rest — it loads the right
 * character and simply cannot see the others, which is a lost FEATURE and not a
 * lost save. Bumping would instead quarantine every one of those files in every
 * older build, which is the lopsided trade the keybinds paragraph above refuses
 * for the same reason.
 *
 * ═══════════════════════════════════════════════════════════════════════════


 * 17 -> 18 (SOMEWHERE TO SPEND IT). `ShopMsg` is a new outbound frame and
 * `shop_buy` / `shop_sell` are two new inbound verbs.
 *
 * BY THE RULE THIS FILE HAS APPLIED SINCE 2 -> 3, A NEW OUTBOUND FRAME ALONE
 * WOULD NOT FORCE A BUMP: an old client cannot name `shop`, so it falls through
 * its dispatch and ignores it, and ignoring it is harmless here in a way it was
 * NOT at 11 — a v17 client that never draws a shop tab is a client with no
 * shop, which is exactly what it had yesterday. Nothing on its screen is a lie.
 *
 * IT BUMPS FOR THE INBOUND HALF. `shop_buy` and `shop_sell` are verbs the
 * SERVER must be able to assume it will never receive from a client that has
 * not been told what a shop is — and more sharply, a v17 client would be
 * standing in a room where other people are visibly buying things it cannot
 * see, with its own gold counter moving for reasons it cannot explain. That is
 * not a missing line; it is a room that behaves differently for two people
 * standing in it.
 *
 * `SCHEMA_VERSION` STAYS 1, for the fourth release running. A shop's shelves
 * and its restock epoch are process state on a `Realm`, not character state:
 * the shelf is a pure function of (world seed, shop, epoch), so a restart
 * rebuilds it rather than reading it. What a restart loses is what was bought
 * and sold today, which is the honest cost of not persisting realms at all yet.
 *
 * 16 -> 17 (THEY ARE STILL IN YOUR PARTY). `PartyStateMember` gains a REQUIRED
 * `away`, and the client gains a `follow` verb.
 *
 * THIS ONE IS A BUG FIX AND THE BUMP IS NOT THE INTERESTING PART. Reported from
 * play: "i am unable to join a party member in combat (there is no way to enter
 * the encounter space). it also seems to remove them from party when the combat
 * starts."
 *
 * The party table was never touched. `projectPartyState` walked ONE WORLD and
 * skipped any member it could not find there, so the instant somebody crossed
 * into an instance their row vanished from everyone else's pane — which from
 * the chair is indistinguishable from being thrown out of the party. Two
 * projections were per-realm for a social fact that is not.
 *
 * `follow` is the other half: an instance is opened keyed by PARTY, so the room
 * already belonged to everybody — but the roamer that pulled the first player
 * in is consumed by the crossing, so the tile that was the door is gone.
 *
 * THE BUMP IS FORCED BY `away` BEING REQUIRED, and it is the strong form of the
 * rule this file has applied since 2 -> 3: a v16 client would not merely miss a
 * line, it would keep drawing the pane it drew before, which is the pane that
 * loses the row. It would render a LIE about who is in your party — the same
 * shape as 6 -> 7, 9 -> 10 and 11, and the reason the gate exists.
 *
 * `SCHEMA_VERSION` STAYS 1. Nothing about a saved character changed shape:
 * party membership is process-local (engine/party.ts) and has never been
 * persisted.
 *
 * 15 -> 16 (A PURSE). `InventoryMsg` gains a REQUIRED `money`.
 *
 * REQUIRED, which is what forces this. The rule this file has applied since v5
 * is that an addition an old client can ignore does not force a bump -- and a
 * v15 client WOULD ignore this one, parse the rest of the frame, and draw an
 * inventory with no gold on it. That is not the permanently-stuck shape of
 * 6 -> 7, 9 -> 10 or 11: nothing on screen would be a lie.
 *
 * IT BUMPS ANYWAY, for the reason 14 -> 15 did. Gold is now a thing a player
 * spends, and a client that cannot show a purse is a client whose owner cannot
 * tell whether picking up a coin pile did anything. A silently goldless
 * inventory is indistinguishable from a broken drop table, which is exactly the
 * class of report that costs an evening to chase.
 *
 * `SCHEMA_VERSION` STAYS 1, considered rather than carried along, for the third
 * release running. `CharacterFile.money` is OPTIONAL and
 * docs/data-schemas.md:48-49 reads verbatim: adding an optional field needs no
 * bump. A v1 file without the key loads as a character holding the birth purse,
 * and a rollback costs a player what they had earned rather than quarantining
 * the character.
 *
 * 14 -> 15 (THE MAP YOU EARNED). `RealmMsg` gains an optional `explored`.
 *
 * AN ADDITION AN OLD CLIENT IGNORES, AND HERE THAT IS GENUINELY HARMLESS --
 * unlike `sites` at 12 -> 13, whose absence FROZE a moving thing on screen. A
 * v14 client drops this and starts each session with an empty map, revealing as
 * it walks exactly as it did before. It loses persistence, not correctness, and
 * nothing it draws is a lie.
 *
 * So this bump is for the SERVER's benefit rather than the client's: the field
 * is on the wire and in the save file from here, and a build that sent it to a
 * client which silently discarded it would be indistinguishable from one where
 * persistence was broken. A version that tells those apart is worth more than
 * the compatibility it costs on a project whose players all update together.
 *
 * `SCHEMA_VERSION` STAYS 1, and this is the fourth pass to take that decision.
 * `CharacterFile` gains `explored` as an OPTIONAL field, and
 * docs/data-schemas.md:48-49 is verbatim: "Adding an *optional* field needs no
 * bump; the bump is for renames, semantic changes, and new required fields."
 * The rollback trade is the one `keybinds` already argued: not bumping costs a
 * player some re-walked country if a build is rolled back, while bumping
 * QUARANTINES the character file in every older build and costs them the
 * evening.
 *
 * 13 -> 14 (SETTLEMENTS). Six terrain codes: VILLAGE_ROOF, TOWN_ROOF,
 * CITY_ROOF, TOWN_WALL, YARD, FIELD.
 *
 * The same shape as 11 -> 12 and the same reason: a v13 client meets codes
 * 22-27, `tileAt` fails them closed to WALL, and every settlement on the map
 * becomes a solid block with its yard, its gate and its fields all impassable.
 * Fail-closed is right and it still renders thirteen towns as rubble.
 *
 * TERRACE and CIVIC are untouched and still mean what they meant -- a street
 * seen from inside a town. These are the same buildings seen from four screens
 * away, which is a different picture and therefore a different code.
 *
 * `SCHEMA_VERSION` STAYS 1. Nothing persisted changed shape.
 *
 * 12 -> 13 (MARKERS WITHOUT THE MAP). `ServerMsg` gains `SitesMsg`.
 *
 * An ADDITION an old client ignores, which by the rule this file has applied
 * since v5 would not force a bump on its own -- and it does here, because of
 * what the addition is FOR. The roamers wander every few turns; a v12 client
 * cannot name `sites`, so it drops every one and keeps drawing the markers it
 * received in its last `realm` frame. The overworld would then show visible
 * danger standing still on tiles it has already left, and a player would route
 * around a threat that is not there and walk into one that is. A frame that is
 * merely missing is survivable; one whose absence FREEZES a moving thing on
 * screen is the permanently-wrong shape that forced 6 -> 7 and 9 -> 10.
 *
 * The region also grew to ToME'''s 170x100, which needs no bump of its own --
 * `LevelView` carries its own dimensions and always has.
 *
 * `SCHEMA_VERSION` STAYS 1. Nothing persisted changed shape.
 *
 * 11 -> 12 (THE WILDERNESS). Six terrain codes: PLAINS, HILLS, HEATH,
 * MOUNTAIN, CRAG, DEEPWATER.
 *
 * The overworld stopped being Alderbrook-the-city and became the country around
 * it, so the ground the client is asked to draw is new. An old client would
 * meet codes 15-20 and `tileAt` fails them closed to WALL (shared/level.ts) --
 * so the region would render as solid rock, entirely unwalkable, with the
 * player's own token apparently embedded in it. Fail-closed is the RIGHT
 * behaviour and it is still catastrophic to look at, which is exactly the case
 * the version gate converts into an honest "your client is out of date".
 *
 * `SCHEMA_VERSION` STAYS 1. No persisted field changed shape; a body's realm
 * and position are still decided by the join path rather than read from disk.
 *
 * 10 -> 11 (THE OVERWORLD). A SECOND MAP CAN ARRIVE MID-SESSION: `realm`
 * ═══════════════════════════════════════════════════════════════════════════
 * `ServerMsg` gains `RealmMsg`, and it is the first frame other than `welcome`
 * that carries a `LevelView`. That is the bump: for the whole of v1-v10 a
 * client could assume the map it was given at `hello` was the map for the
 * lifetime of the connection, and every one of them is entitled to that
 * assumption because it was true.
 *
 * A v10 client handed a `realm` frame would ignore it — an unknown `t` falls
 * through its dispatch — and would then keep rendering Alderbrook while the
 * server moved its body into an instance. It would draw its own token standing
 * in a canal, its friends teleporting through terraces, and every step refused
 * by a server reading a different grid. Silently, with no error on either end.
 * That is precisely the failure the version gate exists to convert into an
 * honest "your client is out of date".
 *
 * `SCHEMA_VERSION` STAYS 1, considered rather than carried along. Nothing about
 * a saved character changed shape in this pass: a body's realm is not persisted
 * at all yet, and where a returning player is placed is decided by the join
 * path rather than read from disk. When that changes it will be an OPTIONAL
 * field and docs/data-schemas.md:48-49 applies unchanged.
 */
export const PROTOCOL_VERSION = 19;

/**
 * Bumped whenever a persisted save file's shape changes. Every bump needs a
 * migration and a fixture proving an old file still loads.
 *
 * Declared `as const` (not a plain `number`) so a save written with a literal
 * type cannot silently widen and skip a migration.
 */
export const SCHEMA_VERSION = 1 as const;

/** Tile size in pixels. The atlas grid, prop metadata and camera all assume this. */
export const TILE_PX = 32;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW FAR THE PLAYER MAY MOVE THE INTEGER SCALE. ONE STEP EACH WAY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `scale` is a whole number — that is what keeps every pixel of hand-drawn art
 * landing on a whole screen pixel — so zoom biases it by whole STEPS rather than
 * multiplying it. At the size this runs in a Discord iframe the natural scale is
 * 2 or 3, so one step each way is a real range and no setting is useless.
 *
 * ═══ IN `shared/` BECAUSE TWO PLACES NEED THE SAME NUMBER ═══
 * The renderer clamps to it and the wire schema validates against it, and a
 * bound written out twice is the shape this codebase keeps getting bitten by —
 * most recently `HAUNTS`, which learned two tile codes while a duplicate did
 * not. `src/shared/` is the only module both a client renderer and a zod schema
 * may import.
 */
export const ZOOM_MIN = -1;
export const ZOOM_MAX = 1;

/**
 * Energy required before an actor may act, and the energy granted per game tick.
 *
 * Ported from T-Engine4's energy scheduler. Players always spend exactly
 * ENERGY_TO_ACT — action points are an intra-turn budget, never a way to buy
 * extra turns — which is what keeps a co-op party phase-locked instead of
 * drifting until three people are waiting on one.
 *
 * Monsters keep the full variable-speed model: their cost is
 * ENERGY_TO_ACT * speedFactor.
 */
export const ENERGY_TO_ACT = 1000;
export const ENERGY_PER_TICK = 100;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW FAST A SOCKET MAY TALK. PART OF THE WIRE CONTRACT, NOT AN INTERNAL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A token bucket in `net/gateway.ts` drops any command past this and tells the
 * sender AT MOST ONCE A SECOND (`RATE_NOTICE_INTERVAL_MS`) — so a client going
 * too fast sees one error and silently loses everything after it. The burst
 * equals the rate: a client may spend a second's worth at once, which is what a
 * reconnect replay does, and then refills.
 *
 * ═══ IT LIVES HERE BECAUSE THE SENDERS HAVE TO KNOW IT AND COULD NOT ═══
 * These were module-private in the gateway, so every scripted client in
 * `tools/` picked its own interval by feel and several picked one too fast.
 * `killer-named.test.ts` fired a move every 22 milliseconds — FORTY-FIVE a
 * second — lost a third of them, and then walked a route measured from a tile
 * nobody was standing on. It stopped 27 tiles short of the room it names and
 * passed for months by dying to something it met on the way.
 *
 * Nothing about that is visible: one error line, and an end state that still
 * satisfies every assertion, about a fight the probe did not choose.
 */
export const COMMAND_RATE_PER_SEC = 20;
export const COMMAND_BURST = 20;

/**
 * The smallest gap a well-behaved client leaves between two commands.
 *
 * ROUNDED UP AND THEN GIVEN HEADROOM. The arithmetic floor is fifty
 * milliseconds, which is exactly the limit and therefore fails on any jitter in
 * either direction — a scheduler hiccup on the sender, a slow read on the
 * server, and a burst that was "exactly twenty" is twenty-one. Sixty is the same
 * number with somewhere to go wrong.
 */
export const COMMAND_GAP_MS = Math.ceil(1000 / COMMAND_RATE_PER_SEC) + 10;
