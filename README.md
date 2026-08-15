# Inner Datum

A co-op turn-based roguelike played inside a Discord voice channel, as a Discord
Activity.

It is mechanically a partial source port of **Tales of Maj'Eyal**: actors act on
a 1000-energy scheduler, combat resolves through tier-rescaled accuracy-versus-
defence rolls, statuses land or fail against typed saves with their duration
scaled by how badly you failed, and talents sit on turn-counted cooldowns
drawing from a per-class resource. The skill is tactical positioning and
cooldown sequencing, not reflexes.

It is built for a specific situation: three to six friends already sitting in
the same voice channel, one evening at a time.

> **Status: pre-alpha.** The engine is being built. This repository is public
> because it contains GPL-licensed code, not because it is ready for anyone else
> to run.

---

## The one design decision worth knowing

ToME is single-player. Naive turn order with four humans means three people
watch a spinner while one person thinks.

So **player actions always cost exactly one full turn.** Action points are an
intra-turn budget you spend across several talents within your own turn, not a
way to buy extra turns. The party therefore stays phase-locked, and the
scheduler stops once per round with everyone present rather than six times per
two rounds with one person present.

The cost is real and deliberate: player-side haste grants more AP, never extra
actions between everyone else's. Monsters keep the full variable-speed model, so
speed remains something you play around — you just cannot buy it yourself.

---

## Licence — read this before forking

This repository is deliberately **split**, and the split is not decorative.

| | Licence |
|---|---|
| **All code** (`src/`, `tools/`, config) | **GPL-3.0-or-later** |
| **The pixel art** | **All rights reserved** — © the author, *not* under the GPL, and **not distributed here** |

The code is GPL because it contains logic ported from **T-Engine4 / Tales of
Maj'Eyal** (© DarkGod and contributors, <https://te4.org/license>), which is
GPL-3.0-or-later. Ports and translations are derivative works, so this project
inherits that licence and passes it on.

**The artwork is not in this repository.** `client/public/assets/` is excluded
from version control in its entirety. This is not an oversight and not a
build step you are missing — a clone is expected to bring its own art, and
[the next section](#running-it) is how.

No image, font, sound or music file is tracked here at all. The only
third-party material you receive by cloning is the npm dependencies. In
particular, no ToME artwork, audio or music appears in any form: those assets
are licensed for use with Tales of Maj'Eyal only.

See [`LICENSE`](LICENSE), [`COPYING`](COPYING), [`NOTICE`](NOTICE),
[`ASSETS-LICENSE.md`](ASSETS-LICENSE.md) and
[`THIRD_PARTY.md`](THIRD_PARTY.md) for the precise terms.

---

## Running it

There is no hosted instance and there will not be one. Inner Datum is designed
to be self-hosted on a single machine for a single group of friends.

You will need:

- **Node.js 24.19+** — the server runs TypeScript directly via native type
  stripping, so there is no build step for server code
- A **Discord application** with Activities enabled, created in the
  [Developer Portal](https://discord.com/developers/applications)
- A **public HTTPS origin** pointing at the machine running the server. Discord
  proxies activity traffic and accepts only ports 80 and 443, with a publicly
  trusted certificate — self-signed will not load
- **Python 3 with Pillow**, to generate the placeholder art

```bash
npm ci
npm run assets     # generates the art the repo does not ship — see below
npm run check      # typecheck + lint + format + tests
npm run dev
```

### The art step

The artwork is not distributed with this repository. `npm run assets` generates
**64 of the 111 sprites** the game addresses — panels, pips, cursors, markers,
status and turn icons, props, placeholder branding — plus the manifest, which is
the only table the client reads. None of that needs any source art.

The other **47** are characters, enemies, item icons and branding, and they are
yours to draw. [`ASSETS-REQUIRED.md`](ASSETS-REQUIRED.md) lists every one with
its exact dimensions and the conventions to match.

Anything you have not supplied draws as a violet fallback box rather than
vanishing, so what is missing is visible on screen instead of showing up as an
invisible monster. You can also skip the art step entirely: the client logs one
line and boots into all-placeholder rendering. A missing asset can never stop
the game from starting.

---

## Repository layout

```
src/shared/    pure, deterministic, no I/O — shared by client and server
src/server/    Fastify + WebSocket, the turn engine, JSON persistence
src/client/    canvas renderer for the Discord iframe
tools/         asset pipeline (Python), smoke test, secret scanner
client/public/ where generated art lands — untracked, see ASSETS-REQUIRED.md
```

The design and planning documents are not published. This repository is the
code.

---

## Contributing

Realistically: don't. This is a personal game for a specific group of friends,
not a project seeking contributors or users. Issues and small fixes are welcome
but may sit untouched for a long time, and large pull requests are unlikely to
be merged.

If you do open one, see [`CONTRIBUTING.md`](CONTRIBUTING.md) — the licence split
above means contributions carry conditions, particularly around assets.
