# Contributing to Inner Datum

Thanks for looking. Read this first — it is short, and it will save you from spending an evening on
something I can't merge.

---

## What this project is

Inner Datum is a co-op roguelike built so that about six friends could play something together in a
voice channel. It is a hobby project with an audience of roughly ten people, published because there
is no reason not to publish it and because the T-Engine4 port work may be useful to someone else.

**It is not a product, a platform, or a community project.** There is no roadmap I am obliged to, no
release cadence, and no public server — every instance is self-hosted by whoever runs it.

So, concretely:

| | |
|---|---|
| **Issues** | **Very welcome.** Bug reports, "your ToME formula is wrong and here is the line that proves it", broken docs, wrong citations. Especially the port: if I mistranslated a Lua function, I want to know |
| **Small PRs** | Welcome. Bug fixes, test cases, typo and doc fixes, a corrected formula with a `file:line` citation |
| **Large PRs** | **Unlikely to be merged, and I would rather you didn't start one.** Not because they'd be bad — because this codebase is deliberately, aggressively small, and every feature is a thing I have to understand and maintain for as long as my friends keep playing |
| **New dependencies** | Almost certainly no. See the design notes → Deliberately absent. The whole server is Fastify + zod and it stays that way |
| **Anything in the design notes Non-goals** | No. Matchmaking, a database, PvP, WebRTC, client-side prediction, animation, monetisation. These are decided, not open |
| **Forks** | Encouraged, genuinely. If you want the game to be something else, that is what forking is for — subject to the licensing below |

If you are unsure whether something is wanted, open an issue before writing code. I will answer
honestly and quickly, including "no".

---

## Licensing — the part you must actually read

This repository contains **two kinds of material under two different licences**, and the split is not
decorative.

### Code — GPL-3.0-or-later

The engine contains logic ported from **T-Engine4 / Tales of Maj'Eyal** (© 2009–2018 Nicolas Casalini
"DarkGod"), which is GPL-3.0-or-later. Translating Lua to TypeScript produces a derivative work. So
all code here is GPL-3.0-or-later, and so is anything you contribute to it.

**By opening a pull request you agree that your code contribution is licensed GPL-3.0-or-later.** No
CLA, no copyright assignment, no signing anything — you keep your copyright, I just need the same
licence in as goes out.

If you port more logic from ToME, the file header is mandatory:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/interface/Combat.lua:1444-1462
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license
```

That is a licence courtesy and a debugging lifeline in equal measure. A port without a citation will
be sent back.

### Art and game content — © the author, All Rights Reserved

The art — sprites, tilesets, icons, UI frames — along with the world, its characters, its writing and
the name *Inner Datum*, comes from my own **Outer Index** project. **It is not under the GPL, no
licence to reuse it is granted, and it is not distributed with this repository at all.**

`client/public/assets/` is excluded from version control in its entirety. Run `npm run assets` to
generate the procedural set; see [ASSETS-REQUIRED.md](ASSETS-REQUIRED.md) for the rest. A checkout
with no art still builds, still passes the full test suite, and still runs — in placeholder boxes.

This is explicitly permitted by GPL-3.0 § 5: an aggregate may combine a covered work with separate
works that "are not by their nature extensions of the covered work". Sprites are data the program
consumes, not linked code, and are in no way derived from ToME. Upstream does exactly the same thing —
ToME ships GPL code beside restricted art governed by its own `COPYING-MEDIA`.

**One exception, and it cuts the other way:** the game content under `src/server/content/` and
`src/server/talents/` holds values transcribed from ToME's Lua. Those are derivative works of a GPL
work and are **GPL-3.0-or-later**, not All Rights Reserved. They carry per-file SPDX headers naming
their upstream source and line range, and are itemised in [NOTICE § 1.2](NOTICE). The art licence
covers pixels, not balance tables.

In practice, for you:

- **You may** fork this repo, run the game locally, and modify the code however you want.
- **You may not** ship the art in your own game, sell it, put it in an asset pack, train on it, or
  redistribute it detached from this project — including art extracted from a running instance. It
  not being in this repository is a decision, not an oversight.
- **If you fork and publish**, supply your own art. GitHub's Terms of Service let anyone fork a public
  repo — that mechanism does not grant you a copyright licence to anything, and this is the file that
  says so.

See [LICENSE](LICENSE), [COPYING](COPYING), [ASSETS-LICENSE.md](ASSETS-LICENSE.md) and
[THIRD_PARTY.md](THIRD_PARTY.md).

### Do not commit assets at all

**This is the one contribution rule I will be inflexible about, and it is not "no unlicensed assets".
It is none at all.**

No sprite, tile, icon, font, sound, or music file enters this repository. Not yours, not CC0, not
public domain, not one you have the rights to. The art tree is gitignored wholesale, so committing one
takes a deliberate `git add -f` — if you find yourself reaching for that flag, the answer is no.

The rule is absolute because a per-file judgement call is exactly the thing that erodes. A repository
that ships no binaries needs no audit, no provenance table to keep accurate, and no argument about
whether a given file's licence was read correctly. One that ships "only properly licensed" assets
needs all three, forever, and gets them wrong quietly.

Especially not ToME's own: `reference/t-engine4/COPYING-MEDIA` restricts its media to *"the Tales of
Maj'Eyal game only"*, so a single ToME sprite here would be a licence violation for both projects at
once.

Art belongs in your own checkout, generated by `npm run assets` or drawn to
[ASSETS-REQUIRED.md](ASSETS-REQUIRED.md). A binary file in a PR is an automatic close, not a review
comment. It is vastly cheaper to reject than to unpick from a published history later.

If you want to know what art is actually still needed, it is all listed in
the design notes — but read the paragraph above first.

---

## Do not commit other people's data

The running game stores **Discord user IDs and display names of real people** under `data/`. That
directory is gitignored and must stay that way.

When filing an issue, **scrub before you paste**:

- Server logs contain user IDs and Discord display names.
- Crash dumps contain a serialised world — every player in it.
- Screenshots contain the party panel and the voice-channel roster.
- `config/allowlist.json` is nothing but a list of people's account IDs.

Replace snowflakes with `<user1>`, `<user2>`. Your friends did not volunteer to be indexed by a search
engine.

---

## Dev setup

**Requirements**

- **Node 24 LTS (≥ 24.12).** Not optional: the server runs `.ts` files directly via native
  type-stripping, with no build step and no `tsx`/`ts-node`.
- Git.
- A Discord application of your own, if you want to run inside Discord. You cannot use mine — the
  client secret is mine and stays mine.

**Getting running**

```bash
git clone https://github.com/<owner>/inner-datum.git
cd inner-datum
npm ci                       # ci, not install — respect the lockfile
cp.env.example.env         # then fill it in; every var is documented inline
npm run dev                  # server on :3000 + Vite client
```

Open `http://localhost:3000` in a plain browser. **You do not need Discord for most work.** The client
boots against `DiscordSDKMock` whenever the `frame_id` query parameter is absent, which covers
rendering, fog, targeting, layout, the log and the hotbar — about 95% of client work — with hot reload
and real DevTools.

To run it as a real Activity you need your own Discord app plus a public HTTPS origin. Both are
documented end to end in the design notes and
the design notes. It is an afternoon, not five minutes.

**Commands**

```bash
npm run dev        # server (node --watch) + Vite client
npm test           # Vitest
npm run check      # tsc --noEmit, both tsconfigs
npm run assets     # rebuild sprite atlases — needs ART_SOURCE_DIR, which you
                   # will not have. This is expected. The built output is
                   # committed, so a plain clone runs.
```

**The ToME reference clone** is not in the repo (345 MB of somebody else's code). If you want to check
a citation or port something new, recreate it with the commands in
the design notes — shallow, blob-filtered, sparse, pinned to commit `304327e`.
It deliberately never fetches ToME's media directories.

---

## House rules for code

These are load-bearing. A PR that breaks one of them will be sent back even if it is otherwise good.

1. **`src/shared/` stays pure.** No `fs`, no `Date.now`, no `Math.random`. That purity is what
   makes deterministic replay and every unit test possible.
2. **Never `await` inside the scheduler.** Synchronous resolution *is* the mutex — it is why two
   WebSocket messages can't interleave mid-turn. If you feel you need a lock, the real bug is that
   resolution went async.
3. **The server owns all randomness, damage and inventory.** The client sends intents and renders
   state. It never rolls dice, and it is never trusted.
4. **No `enum`, no `namespace`, no parameter properties, no decorators.** Node's type-stripper cannot
   erase them (`erasableSyntaxOnly`). Use `as const` unions. Relative imports need explicit `.ts`
   extensions.
5. **Cite every port** with `file:line` into `reference/t-engine4`.
6. **Test the maths, not the plumbing.** New combat or scheduler logic needs a table-driven test. There
   are deliberately no socket tests, route tests beyond `/healthz`, or rendering tests, and there is no
   coverage target.
7. **Validate client input with zod at the boundary and nowhere else.** Server→client is our own data;
   validating it burns CPU for no safety.
8. **Render user-controlled text with `.textContent`, never `innerHTML`.** Discord nicknames are
   arbitrary attacker-controlled input and Discord does not sanitise them for you.
9. **Do not touch `build.assetsInlineLimit: 0` in `vite.config.ts`.** It is licence compliance, not
   build tuning — see [ASSETS-LICENSE.md § 4](ASSETS-LICENSE.md).

---

## Security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).

---

## Credit where it's due

This game exists because **Tales of Maj'Eyal** exists. Its combat model is the reason this plays the
way it does, and DarkGod released it under a licence that let me learn from it line by line. If you
enjoy this, go buy ToME.
