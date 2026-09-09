# Inner Datum

**A co-op turn-based roguelike that runs inside a Discord voice channel.**

Mechanically a partial source port of *Tales of Maj'Eyal* / T-Engine4, Lua to TypeScript,
fitted onto an original setting: a rain-soaked clerical city, a records system that
overwrites people, and four friends in a voice call deciding what to do about it.

[![Code: GPL-3.0-or-later](https://img.shields.io/badge/code-GPL--3.0--or--later-blue)](LICENSE)
[![Art: All Rights Reserved](https://img.shields.io/badge/art-All%20Rights%20Reserved-lightgrey)](ASSETS-LICENSE.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2024.12-brightgreen)](package.json)
[![Ported from T-Engine4](https://img.shields.io/badge/ported%20from-T--Engine4-8a63d2)](https://te4.org/license)

> **Status: pre-alpha.** It is playable, and fewer than ten allowlisted people play it. There
> are no tags, no releases and no hosted instance, and `version` is `0.0.0` — but you can
> [run it locally](#running-it) in a few minutes. This repository is public because it
> contains GPL-licensed code, not because it is asking for users.

---

## An evening of this

Your friends are already in the voice call. Somebody starts the Activity, everyone else
clicks in, and a rain-soaked clerical city appears on a board you are all looking at.

Then the turn stops. It stops for **all** of you.

Inner Datum resolves a turn only once every player who owes a decision has made one. So
the second before a door opens is not four people mashing keys — it is a conversation.
*Don't open it yet. I'm at four resolve and I want the doorway.* Nobody watches a spinner
while somebody else's animation plays. **The pause is the game.**

And then it goes wrong. Somebody drops to 0 HP. They are not dead and they are not
removed — they are **Downed**, prone on the tile they fell on, with a five-turn countdown
everybody can see. It turns *"I died"* into *"get to me"*. Any ally who reaches them
spends their whole turn standing them back up at a quarter health. If the countdown runs
out they are **Erased**: still on the map, no longer revivable. When the last of you goes
down the floor resets and you run it again — there is no permadeath in the shipped build.

It is not fast. The skill is tactical positioning and cooldown sequencing, not reflexes.
It is built for one specific situation: friends already sitting in the same voice channel,
one evening at a time.

---

## The turn waits for you

ToME is single-player. One `game.player`, one global `paused` flag, and a scheduler that
stops whenever that one actor owes a decision. Put four humans on it naively and three of
them watch a spinner while one reads a tooltip. Almost everything distinctive here follows
from refusing that.

**One predicate.** The whole co-op turn problem reduces to `isBlocking` — nine lines asking
whether a conscious, connected, non-Standing-By player still owes a decision
([`barrier.ts`](src/server/engine/barrier.ts)). Combat, exploration, AFK players, splitting
up and a laptop lid closing mid-fight all fall out of that plus a timer.

**Combat is level-wide; exploration is free.** While anything is engaged, every player in
the party owes a decision each turn — including the one thirty tiles away, who would
otherwise walk fifty free tiles while a friend tanks. When nothing is engaged nobody ever
blocks and movement feels like ordinary grid movement. Towns and the overworld can never
contain a hostile — an assertion in code, not a convention — so they are shared, and
anywhere with combat in it is instanced per party.

**Your whole round costs exactly one turn.** Inside it you have a budget: 6 action points,
3 movement points (4 for the Inspector), at most three actions. It buys a combo within
your own turn, never an
extra turn between everyone else's. Players are pinned to speed 1.0 in the literal type
system — `globalSpeed` has the type `1` — so breaking the pin is a compile error rather
than a code-review note. Monsters keep ToME's full variable-speed model, so speed stays
something you play around. You just cannot buy it for yourself.

Then there is everything that actually happens on a Friday night.

| The awkward reality | What the game does |
|---|---|
| Somebody takes forever | **The Bell**: 20 seconds, armed only once everyone *else* has committed |
| A boss floor | The Bell tightens to 12 seconds |
| You are playing alone | The Bell stretches to 120 seconds |
| Somebody wanders off | Two auto-passes and they go **Standing By** — out of the quorum, so the party runs at full speed |
| A laptop lid closes | Presence drops instantly; the body stays standing for a ten-minute reconnect grace |
| They opened a second tab | Two tabs are one player. The new socket takes the body |
| There are six of you | One shared clock holds four. The rest play in their own party on the same floor |
| Your click went stale | Legality is checked at resolution, not submission. It costs zero and re-prompts |
| "There, behind the pillar" | Pointing at a tile is a real verb, costs nothing, expires on its own |

Standing By ends on any keypress at all — deliberately any keypress, not any *legal*
command, because presence is the only thing it measures.

That downed state is one existing boolean, incidentally. Setting `alive = false`
simultaneously drops you from the quorum, stops monsters targeting you, stops your body
blocking its tile so a rescuer can stand on top of you in a doorway, freezes your
cooldowns, and makes you undamageable — because a body that can be corpse-camped makes the
countdown a lie. Six rules, no second predicate to keep in sync.

Identity is settled once, server-side, by a single `GET /users/@me`. The wire protocol has
no user-id field at all, so a client that says "I am somebody else" is not disbelieved —
it is unable to say it.

---

## The setting: Alderbrook

The mechanics are ToME's. The setting is not, and it is deliberately not swords and
sorcery. You are in **Alderbrook**, a wet clerical city on a moor, and the antagonist is
**the Index**: a records system that overwrites people. ToME's races become filing
statuses — **Cityborn, Indexed, Archived, Unfiled, Footnoted** — carrying ToME's stat
spreads, life ratings and experience penalties number for number under new names.

| Class | | Resource |
|---|---|---|
| **The Watchman** | *A serving constable on a long beat. Walks into the swarm so the people behind him do not have to.* | Resolve |
| **The Inspector** | *A disgraced detective who treats Alderbrook itself as the case eating his mind. Lethal at range, helpless in a doorway.* | Focus |
| **The Alchemist** | *Trained on the Row, where the apothecaries mix something different every week. Carries eight vials and counts them.* | Reagents |
| **The Redactor** | *Keeps the file, and decides what is in it. Marks things so they are less true, and is paid in ink every time a mark takes.* | Ink |

Four economies, not one recoloured four ways: Resolve and Focus are continuous 0–100 pools
with fractional regeneration, Reagents is a countable stock of eight refilling in whole
vials (a verbatim port of ToME's `regenAmmo`), and Ink fills by landing marks. "Helpless in
a doorway" is mechanical: the Inspector cannot shoot anything standing next to him, and the
refusal is its own message rather than a miss — because an invisible dead zone just reads
as a broken class.

Around that: **23 talent trees**, hand-written one talent to a file across **103** of them,
capped at rank 5 against a character cap of 50. Nine monsters, 22 statuses, 34 items across
12 slots, and 30 egos that compose onto them — so what drops is a *Case-Hardened Bailiff's
Hook of Plain Reading* rather than anything with a flame on it. Two shops, ten townsfolk
whose directions are real routing rather than ambience, and five lore notes read where they
lie. Content and talents together come to 31,821 lines.

Every place says one sentence, once, to whoever walks in:

> *A quiet town with too many headstones for its size. Nobody mentions it.*
>
> *Somebody built a weir in a wood with no river. It is still holding something back.*

Three sites are on no map and no marker — each placed as far from any drawn marker as the
map allows, each rewarding a different instinct. And there is a second overworld: **the
Redaction**, the same moor with a sixth of it erased, keeping the same place names on
purpose, so the sentence at the threshold is the only thing telling you which Underworks
you just walked into.

---

## The port, and how it is audited

Actors act on a 1000-energy scheduler. Combat resolves through tier-rescaled
accuracy-versus-defence rolls. Statuses land or fail against typed saves — keyed by the
*effect's* own type, not the damage that delivered it — with duration scaled by how badly
you failed. Damage runs a nine-stage pipeline in which the order is the balance.

**The port is auditable.** ToME is fifteen years of tuning that lives in constants nobody
wrote down and orderings that look arbitrary until you move one. So this does not say
"inspired by": 146 of 221 source files declare a port and carry a full attribution header,
across them sit **2,361 `file.lua:line` citations**, and a gate opens a reference clone
pinned at one commit and checks every one of them.

```
$ node tools/check-citations.mjs

port citations
  ok    2361 citation(s) resolve to a file in reference/t-engine4
  ok    every cited .lua exists in the reference tree
  ok    every t-engine4 path that names a file names a .lua
  ok    every qualified citation names the directory the file is in
  ok    every cited line is inside the file it names
  ok    no citation is ambiguous between the engine and the module
```

That gate needs the reference clone, which is gitignored and not distributed here — from a
bare clone it detects the absence and skips. Most ports say "based on"; this one fails its
gate when a citation drifts.

That last line was paid for. Sight radius shipped at 20 for three commits because a
citation read `Actor.lua:47` — the *engine's* default — while ToME is a module on that
engine and sets 10 first, so the engine default never fires. The ambiguity counter is now
pinned at zero and a bare `Actor.lua:47` is refused outright. A second checker reads what
is *at* the cited line, indexing every `newTalent{` block in the referenced Lua and failing
if the range you cited does not describe the talent you named.

Some of what that bought:

- **Two clocks per actor**, which is the number-one port mistake. `energy` is speed-scaled
  and spent by acting; `energyBase` is a flat grant that is never multiplied. Cooldowns,
  regeneration and status durations tick only on the second. Conflate them and haste
  silently becomes a way to buy cooldowns — nothing crashes, no test fails, and balance
  feels off three weekends later.
- **Two hit functions, both live.** The linear `ceil(50 + 2.5 × (accuracy − defence))`
  resolves attacks, which is why a ToME character sheet is legible. The older logistic
  curve still resolves every status save.
- **Saves are not binary.** Failing narrowly gives a shorter stun, including the stochastic
  rounding that turns "1 turn" into "1 turn, and 5.6% of the time 2".
- **A negative finding about loot:** an item has no say in how many egos it gets. A
  depth-banded table rolls a category and the category forces the count. Quality belongs to
  *where you are*, not to the sword.

**What is not ported is documented as loudly as what is.** Equipment composition carries a
`DELIBERATELY NOT A PORT` header quoting the upstream mechanism it replaces. Downed/rescue
is original co-op work. Party experience sharing is *forbidden* from ever carrying a port
header, because ToME has no party experience rule at all. And there is no talent scripting
language, which was measured rather than assumed: of 1,209 `newTalent{}` blocks in the
reference clone, roughly two-thirds carry a bespoke `action` closure. An interpreter able to
run those would be a compiler project wearing a content-pipeline costume.

---

## The codebase

221 TypeScript files, 152,811 lines, five runtime dependencies.

- **No build step for server code.** Node type-strips `src/**/*.ts` and runs it, so
  `npm start` is literally `node src/server/main.ts`; Vite builds only the client. The
  constraint is load-bearing: `erasableSyntaxOnly` makes `enum`, runtime `namespace`,
  parameter properties and decorators compile errors. There are zero enums in 152,811 lines.
- **Determinism by arithmetic, not discipline.** `src/shared/` is compiled by all three
  tsconfigs, so its usable API is their intersection. With `types: []`, `process`, `fs`,
  `window`, `fetch` and `setTimeout` do not merely violate a rule there — they do not
  exist. All randomness comes from a seeded PCG32.
- **The mutex is a lint rule.** `await`, async functions and `Promise.*` are syntax errors
  inside the turn engine, because synchronous resolution is *what stops two WebSocket
  frames interleaving mid-turn*.
- **235 test files, ~4,750 tests, 111,463 lines** — a suite about three-quarters the size of
  the code it checks. Vitest runs with `requireAssertions: true`, aimed squarely at
  AI-assisted authoring, where a plausible test body arrives with the `expect` simply
  missing and passes silently forever.
- **`.npmrc` is committed as a supply-chain control**, not a preference: `min-release-age=7`
  refuses to *resolve* anything published in the last week, `save-exact` forbids caret
  ranges, `engine-strict` refuses the wrong Node.

There are no `TODO`, `FIXME` or `HACK` markers anywhere in `src/`. Everything deferred is
deferred in prose, with the reason.

### `npm run check` is twelve gates

Typecheck across three tsconfig projects, lint, format, tests — then eight bespoke
checkers, running to about 2,000 lines, most of it prose recording the exact bug that
caused the tool.

| Gate | What it refuses |
|---|---|
| `check:secrets` | Any `.env` value in the built bundle, or a secret-shaped string anywhere tracked |
| `check:assets` | **Any** tracked media file. And the mirror rule: art the game addresses but lacks must be a written commission |
| `check:attribution` | A file that declares a port without its full SPDX / copyright / upstream header |
| `check:citations` | A citation that does not resolve to a real file and a real line in the pinned clone |
| `check:citation-names` | A citation whose cited lines describe a *different* talent than the one it names |
| `check:constants` | English that has gone stale. A comment saying `` `FOO` is 12 `` must match the declaration — and tense is the tell: *is* is a claim and is checked, *was* is history and is exempt |
| `check:inert` | A dead export with no written reason — and an allowlisted entry that *stops* being dead also fails |
| `check:effects` | An authored status that nothing in the game ever actually applies |

`inert` exists because this project repeatedly shipped systems that were written, correct,
tested and called by nobody — including a passive every character carries that had never
healed a single point.

---

## Running it

**There is no hosted instance and there will not be one.** No server you can join, no
download. Every instance is self-hosted by one person for one group of friends, gated by an
allowlist of Discord accounts that whoever runs it supplies.

You *can* run it locally, and you do not need Discord to do that: with no credentials
configured the server admits anonymous play in a plain browser tab — a path that exists
exactly where there is no identity system to bypass, and vanishes the moment real
credentials are present.

```bash
npm ci                  # Node >= 24.12, enforced at install time by .npmrc
cp .env.example .env    # required: the server is started with --env-file
npm run build:client    # required: the server only serves a client that exists
npm run assets          # optional: generates part of the placeholder art (Python 3 + Pillow)
npm run dev             # then open the printed URL in a browser
```

You will be standing in a town, in a mix of generated placeholder art and the violet
missing-asset boxes described below. That is the whole setup.

Running it as an actual Discord Activity additionally needs a Discord application with
Activities enabled, and a public HTTPS origin with a publicly trusted certificate pointing
at the machine running the server — Discord proxies activity traffic, and self-signed will
not load. [`deploy/`](deploy) carries a Caddyfile example and a host-setup script.

**The art is not in this repository**, and a clone with no art at all still boots and plays
— the game is designed for that state rather than merely tolerating it. A missing manifest
is treated as the ordinary state of a fresh clone: the client logs one line naming the cure
and boots. Missing sprites draw as a loud violet box on the map, so a missing monster is
*visible* rather than invisible; UI panels deliberately do the opposite and fall back to
drawn letters, because twelve identical violet squares would make an inventory unreadable.
Art the game addresses but does not yet have is written down in
[`ASSETS-REQUIRED.md`](ASSETS-REQUIRED.md) — and a gate refuses to let an id be added
without its brief.

### The other commands

```bash
npm test                # vitest
npm run check           # the full twelve-step gate
npm run smoke           # boots the real server; asserts /healthz is exactly {ok, uptime, version}
npm run verify          # live probes that boot real servers and walk into real fights
```

`npm run verify` is deliberately kept out of `check`, because a gate slow enough to skip is
a gate that gets skipped — and each probe exits 0 when it proved its thing *or* could not
reach the question, so only a red line is ever a fault.

Two of the gates want the T-Engine4 reference tree, which is not distributed here. Both
detect its absence and skip, because a check that cannot reach its question has not failed
— it has abstained. Everything else runs on a bare clone.

### Layout

```
src/shared/           pure, deterministic, no I/O — compiled by all three tsconfigs
src/server/engine/    the turn engine: barrier, scheduler, damage, effects, downed, parties
src/server/content/   classes, origins, monsters, items, egos, places, lore, townsfolk
src/server/talents/   103 files, hand-written TypeScript
src/server/net/       Fastify + WebSocket gateway, per-viewer fog projection
src/client/           canvas renderer for the Discord iframe
test/                 235 test files mirroring src/ — never colocated, because the server
                      runs src/**/*.ts directly and a stray test would ship to the host
tools/                48 files: 8 gate checkers, live probes, the Python art pipeline
deploy/               Caddyfile.example, host setup script
reference/            read-only ToME clone, for citation checking — gitignored
```

The design and planning documents are not published. This repository is the code.

---

## Licence

This repository is deliberately **split**, and the split is not decorative.

| | Licence |
|---|---|
| **All code** — `src/`, `test/`, `tools/`, config | **GPL-3.0-or-later** |
| **Values transcribed from ToME** — stat spreads, formulas, balance tables | **GPL-3.0-or-later**. Derivative of a GPL work, and not claimed otherwise |
| **The art, and the setting** — pixels, names, fiction, prose | **All Rights Reserved** © 2026 Dalton Barraclough. Not under the GPL, and **not distributed here** |

The code is GPL because it contains logic ported from **T-Engine4 / Tales of Maj'Eyal**
(© Nicolas Casalini "DarkGod" and contributors, <https://te4.org/license>), which is
GPL-3.0-or-later. Translations and ports are derivative works, so this project inherits that
licence and passes it on. That is not merely asserted: 146 files declare a port, and
`check:attribution` fails the build if any one of them is missing a line of its header.

The `-or-later` is not a guess either. [`NOTICE`](NOTICE) records how many of the reference
clone's `.lua` files carry the "or (at your option) any later version" grant, names the
exceptions by path, and explains why that makes `GPL-3.0-or-later` the honest identifier —
established by counting the tree rather than sampling it, because declaring `-only` would
silently strip a right the upstream author deliberately granted.

**No media file of any kind is tracked here** — no image, font, sound or music — and that is
enforced by a gate rather than trusted to a `.gitignore`, because a leaked PNG cannot be
rotated the way a secret can. No ToME artwork, audio or music appears in any form; those
assets are licensed for use with Tales of Maj'Eyal only. The reference clone used to verify
citations is read-only, gitignored, pinned to a single upstream commit, and never fetches
ToME's media directories. Nothing from it is redistributed.

One build setting is licence compliance in disguise: `assetsInlineLimit: 0` in
`vite.config.ts`, because Vite's default would base64-inline art into the same JS chunk as
ported GPL logic — one file under two incompatible licences, and the harm there runs
*upstream*, against DarkGod's code.

**The setting is not ToME's.** Every place description, class blurb, monster description,
lore note and NPC line is authored for this game. The mechanics are ported; the writing is
original — and unlike the mechanics it is not offered under the GPL. See
[`ASSETS-LICENSE.md`](ASSETS-LICENSE.md) § 2.

For the precise terms: [`LICENSE`](LICENSE), [`COPYING`](COPYING), [`NOTICE`](NOTICE),
[`ASSETS-LICENSE.md`](ASSETS-LICENSE.md) and [`THIRD_PARTY.md`](THIRD_PARTY.md).

*"Tales of Maj'Eyal", "T-Engine" and "ToME" belong to their owner; Inner Datum is not
affiliated with, endorsed by, or a product of te4.org. "Discord" is a trademark of Discord
Inc.; this is an unofficial third-party Activity, not affiliated with or endorsed by
Discord.*

---

## Contributing

Realistically: don't. This is a personal game for a specific group of friends, not a project
seeking contributors or users. Issues and small fixes are welcome but may sit untouched for
a long time, and large pull requests are unlikely to be merged.

If you do open one, read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — the licence split above
means contributions carry conditions, particularly around assets. The rule there is not "no
unlicensed assets", it is *none at all*, because a per-file judgement call is the thing that
erodes.
