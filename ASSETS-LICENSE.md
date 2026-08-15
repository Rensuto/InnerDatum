# Asset Licence — Inner Datum

**The art is not in this repository, and it is not GPL.** This file is the authoritative statement of
what that means.

Nothing here restricts your rights under the GNU GPL to the *software* in this repository. For that,
see [COPYING](COPYING), [LICENSE](LICENSE) and [NOTICE](NOTICE).

---

## 1. The statement

> **Copyright © 2026 Dalton Barraclough. All Rights Reserved.**
>
> The Outer Index artwork, user-interface art and first-party game content are the separate and
> independent work of the author. They are **not** licensed under the GNU General Public License, they
> are **not distributed with this repository**, and no licence to use, copy, modify or redistribute
> them is granted by this repository being public.

Publishing source code on GitHub does not place accompanying files in the public domain. GitHub's
Terms of Service grant other users the right to *view and fork* a public repository — not a licence to
extract and reuse individual works inside it. Absent an explicit grant, default copyright applies, and
this file declines to make that grant.

---

## 2. What is excluded

`client/public/assets/` is excluded from version control in its entirety — sprites, icons, the
generated manifest, and the prop metadata sitting alongside them. The rule is the whole directory
rather than a list of subfolders, so a folder added later is excluded automatically instead of being
published by omission.

Also reserved, though not all of it is a copyright matter: the names **"Inner Datum"** and **"Outer
Index"**, the setting, its characters, its factions and its prose.

## 3. What this file does NOT cover

| Path | Governed by |
|---|---|
| `src/**`, `tools/**`, `test/**` | GPL-3.0-or-later — [COPYING](COPYING) |
| Ported values transcribed from T-Engine4 | **GPL-3.0-or-later**. See [NOTICE § 1.2](NOTICE) |
| `*.md` in the repository root | GPL-3.0-or-later unless the file says otherwise |

That second row matters and is easy to get wrong. Content whose numbers were read out of ToME's Lua is
a derivative of a GPL work; it cannot be claimed as All Rights Reserved, and it is not claimed here.
The art licence covers pixels, not balance tables.

---

## 4. Running the game without the art

A clone is expected to bring its own art, and the code is built to make that the ordinary path rather
than a repair job:

```
python -m pip install pillow
npm run assets
```

That generates **64 of the 111 sprites the game addresses** — panels, pips, cursors, markers, status
and turn icons, props, placeholder branding — plus the manifest, which is the only table the client
reads. None of it needs any source art. [ASSETS-REQUIRED.md](ASSETS-REQUIRED.md) lists the other 47
with their exact dimensions and conventions.

Anything you have not supplied draws as a violet fallback box rather than vanishing, so a missing
sprite is visible on screen instead of presenting as an invisible monster. Running with no art at all
is supported too: the client logs one line naming the cause and the cure, then boots into
all-placeholder rendering. **A missing asset must never be able to stop the game from starting** — if
you change the loader, keep that property.

`tools/derive_assets.py` crops finished tokens out of a separate source-art tree via `ART_SOURCE_DIR`.
It is specific to this author's art and is not required by anything.

---

## 5. Why the art is not committed

Recorded so it is a decision rather than a drift, and because it reverses an earlier one.

The earlier reasoning was that the art is served unauthenticated to every browser that opens the
Activity, so anyone in the voice channel can already save every PNG from devtools — and that
withholding it from git therefore protected nothing while costing the repo the property that makes
open-sourcing a friends' game worthwhile: that a clone actually runs.

Both halves of that were true and neither was the point. The difference between *a friend can save a
PNG from devtools* and *the complete art tree is a `git clone` away, indexed, forkable, and mirrored by
anyone who ever cloned it* is not a difference of degree. The first is a handful of files pulled by
someone who was invited to play. The second is a permanent, enumerable, machine-readable corpus — and
the one thing you cannot do with a published git history is retract it. A force-push removes nothing
from the clones, the forks, or the GitHub Events API record.

The cost that argument correctly identified — that a code-only repo does not run — turned out to be
avoidable rather than inherent. Fixing it was § 4: most of the art is procedurally generated anyway,
the loader degrades to fallback boxes, and what remains is specified precisely enough to redraw. The
repo still runs on a bare clone. It simply runs in placeholder art, which is the correct look for
somebody else's fork.

Publishing the code costs nothing and is the point. Publishing the art is irreversible and is not.

---

## 6. What you may do

- Fork, modify, self-host and redistribute **the software**, under the GPL.
- Run this game with your own art — see § 4. Sprites are addressed entirely through the manifest, so a
  replacement set using the same paths drops in without touching `src/`.
- Screenshot, stream, record, and write about the game.
- Quote the art in review, criticism and commentary, as fair dealing / fair use permits.

## 7. What you may not do

- Redistribute the art, in whole or in part, inside another game or asset pack.
- Extract it from a running instance and republish it. It not being in this repository is a decision,
  not an oversight, and scraping it from a deployment does not change its licence.
- Train a generative model on it.
- Sell it, or sell anything whose value is the art.
- Re-license it — including by adding it to a GPL or CC-licensed fork and labelling it accordingly. A
  fork inherits the GPL for `src/`; it inherits no right whatsoever to the art.

## 8. Asking

Permission is available, and for non-commercial use the answer is usually yes. Open an issue prefixed
`asset-request:` on the repository. That is the only contact route published here — a licence that
demands you ask should not also require the author to publish a personal address to a search engine.

## 9. Never add these

- **ToME art and audio.** `COPYING-MEDIA` restricts it to Tales of Maj'Eyal only. Never copied here;
  the reference clone is sparse and never fetches those paths, and a hook enforces it.
- **The Outer Index music tracks.** Provenance is undocumented in the source project — no licence
  file, no provenance note anywhere. `*.mp3` and `*.m4a` are gitignored so that adding one takes a
  deliberate override rather than a stray `git add -A`.
- **Untraced SFX** resting on a blanket "these are CC0" README claim with no traced original.
- **Fonts.** None are used, shipped, or referenced by any stylesheet. The client renders with system
  fonts. Adding a font file means taking on its licence and its attribution obligations — see
  [THIRD_PARTY.md](THIRD_PARTY.md) before you do.

---

## 10. The one thing that would break the licence split

Fusing art into a GPL-licensed file. That is not a concern for the repository any more — there is no
art in it — but it very much still applies to **anything you build and distribute** from this code
with art added back.

Two ways it happens in practice:

1. **A bundler base64-inlining PNGs** into the same JavaScript chunk as `src/shared/scale.ts` and
   `src/shared/checkhit.ts`, which carry logic ported from T-Engine4. Vite's
   `build.assetsInlineLimit` defaults to **4096 bytes**, and most UI icons are smaller than that, so a
   default configuration would embed a large part of the icon set directly into the bundle carrying
   the ported GPL logic.
2. **A single-file distributable** with embedded resources — a packaged `.exe`, a spritesheet compiled
   into a `.ts` array, a generated service-worker precache blob.

So `vite.config.ts` pins `build.assetsInlineLimit: 0` and keeps generated JS/CSS out of the art tree
via `assetsDir: 'bundle'`. **Those are licence compliance, not build tuning. Do not remove them.**

Note what the failure mode actually is, because it is usually described backwards: the GPL would not
relicense your art — you own it and cannot infringe yourself. The problem is that you would be
conveying a *combined* work whose corresponding source you are unwilling to release under the GPL,
which is a violation against the **upstream** author's code, and which hands your users a
self-contradictory grant.

GPL-3.0 § 5's final paragraph is what makes the separation legitimate in the first place: a compilation
of a covered work with separate and independent works, not combined such as to form a larger program,
is an "aggregate", and inclusion in an aggregate does not extend the licence to the other parts. PNGs
fetched over HTTP and decoded by the browser are exactly that — data the program consumes, sharing no
address space with the engine. This is the ordinary arrangement for open-source games, not an edge
case: id Software's Doom and Quake engines are GPL while their WAD and PAK data stayed commercial, and
this project's own upstream ships GPL code beside artwork restricted by its `COPYING-MEDIA`.
