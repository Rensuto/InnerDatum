// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE STANDING ART COMMISSION: WHO LIVES IN ALDERBROOK, WHAT HUNTS UNDER IT,
 * AND WHAT A FIGHT LOOKS LIKE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Read by `npm run art:needs` (tools/art-needs.mjs): every id in a constant
 * whose name ends in `ART_REQUESTS` is reported as requested art, and as
 * missing until a file of that id is deployed. Nothing in the game reads this
 * file. An entry leaves it when the art lands AND the code names the id.
 *
 * WHERE THE LIST COMES FROM. Upstream's bestiary, towns, traps and base items
 * (ToME `data/general/npcs/`, `data/zones/*`, `data/general/traps/`,
 * `data/general/objects/`), each renamed and redrawn for Alderbrook. `port`
 * names the upstream entry an id stands in for, so its tier and role carry
 * over; the picture does not.
 *
 * ═══ THE SETTING, IN ONE PARAGRAPH ═══
 * Alderbrook is a gaslit city of watchmen, inspectors, clerks and alchemists,
 * soot and brass, typewriters and ledgers. The detectives work out of an office
 * on Saint Orwin's Square. Beneath the city is the Index, a record rewriting
 * what it files. Its creatures are THE REDACTED: things half-erased and
 * overwritten, shown with loose pages, black redaction bars, strike-through
 * marks, ink and a faint static. Its human servants are THE FILED. Ordinary
 * fauna of the moor and the underways is plain and grim, not cute. Tone is dry
 * and procedural; nothing is played for laughs. In early-game names avoid "the
 * Veil", "Outer Index" and "cosmic entity".
 *
 * ═══ SIZES AND ANCHORS — ASSETS-REQUIRED.md § Runtime scale contract ═══
 *   48x64   a standing human-scale body, one frame, facing SOUTH, bottom-centred
 *   96x128  a large creature, one frame, facing south; overflows up and sideways
 *   64x64   an icon, a prop that fills one cell, or a single cell-space overlay
 *   256x64  an effect LOOP: 4 frames of 64x64 left to right
 *   384x64  an effect played ONCE: 6 frames of 64x64 left to right
 * RGBA8, straight alpha, hard pixel edges, a bounded palette. Actors must read
 * as themselves at 48x64 in silhouette before colour.
 *
 * ═══ EFFECTS (`ui_fx_*`) ARE NOT WIRED YET ═══
 * The renderer draws one frame per actor and paints zones and projectiles as
 * shapes. These strips are commissioned ahead of that work:
 *   projectile  256x64 loop, drawn pointing EAST (the renderer rotates it)
 *   hit         384x64 once, centred on the struck cell
 *   area        256x64 loop, one per affected cell, seamless with its neighbours
 *   beam        256x64 loop, a horizontal segment that tiles end to end
 *   on a body   384x64 once, centred on the body's cell
 * Damage types are upstream's twelve (`data/damage_types.lua`), each in its own
 * colour family so a player can tell a fire hit from a blight hit at a glance.
 */

export type ArtSize = '48x64' | '96x128' | '64x64' | '256x64' | '384x64';

export type ArtRequest = {
  readonly id: string;
  readonly size: ArtSize;
  /** Where it appears: a town, a delve, a class, or "any". */
  readonly where: string;
  /** The upstream entry this stands in for, when there is one. */
  readonly port?: string;
  readonly brief: string;
};

const actor = (id: string, where: string, port: string, brief: string): ArtRequest => ({
  id,
  size: '48x64',
  where,
  ...(port === '' ? {} : { port }),
  brief,
});

const large = (id: string, where: string, port: string, brief: string): ArtRequest => ({
  id,
  size: '96x128',
  where,
  ...(port === '' ? {} : { port }),
  brief,
});

const cell = (id: string, where: string, port: string, brief: string): ArtRequest => ({
  id,
  size: '64x64',
  where,
  ...(port === '' ? {} : { port }),
  brief,
});

const loop = (id: string, where: string, port: string, brief: string): ArtRequest => ({
  id,
  size: '256x64',
  where,
  ...(port === '' ? {} : { port }),
  brief,
});

const once = (id: string, where: string, port: string, brief: string): ArtRequest => ({
  id,
  size: '384x64',
  where,
  ...(port === '' ? {} : { port }),
  brief,
});

const NPCS = 'data/general/npcs';
const ZONES = 'data/zones';

/**
 * ═══ THE PEOPLE OF ALDERBROOK ═══
 * The ten named townsfolk all wear one stand-in today (`chr_npc_counter_keeper_s`);
 * each gets a face. The rest fill streets, shops and camps.
 */
export const TOWNSFOLK_ART_REQUESTS: readonly ArtRequest[] = [
  actor(
    'chr_npc_merrow_stitch_s',
    'Threadneedle Row',
    '',
    'Merrow Stitch, a mender in a patched waistcoat: tape measure round the neck, needles along one lapel, a spool of black thread.',
  ),
  actor(
    'chr_npc_pinnock_vane_s',
    'Threadneedle Row',
    '',
    'Pinnock Vane, a broad porter bent under a strapped bundle of cloth bolts, cap pushed back, sleeves rolled.',
  ),
  actor(
    'chr_npc_reeve_ashcombe_s',
    'Alderbrook',
    `${ZONES}/town-last-hope/npcs.lua`,
    'Reeve Ashcombe, the gatekeeper: long greatcoat, a ring of iron keys, a lantern on a pole, weathered and unsmiling.',
  ),
  actor(
    'chr_npc_halloway_bell_s',
    'Alderbrook',
    '',
    'Halloway Bell, a delver who came back: scorched field coat, one bandaged hand, a satchel of salvage.',
  ),
  actor(
    'chr_npc_sexton_pell_s',
    "Saint's Rest",
    '',
    'Sexton Pell, gravedigger: spade over the shoulder, mud to the knees, oilcloth hat dripping.',
  ),
  actor(
    'chr_npc_wren_colley_s',
    "Saint's Rest",
    '',
    'Wren Colley, registrar of burials: a thin clerk hugging a ledger, ink-stained cuffs, pencil behind the ear.',
  ),
  actor(
    'chr_npc_carrow_ninefold_s',
    "A Wayfarers' Camp",
    '',
    'Carrow Ninefold, a long-legged walker in a waxed cape with a staff and a map case, boots grey with dust.',
  ),
  actor(
    'chr_npc_mabbot_ash_s',
    "A Wayfarers' Camp",
    '',
    'Mabbot Ash, a heavyset stranded traveller with a rug round the shoulders and a battered trunk at the feet.',
  ),
  actor(
    'chr_npc_thessaly_vaunt_s',
    'Ashwick Alchemy Row',
    '',
    'Thessaly Vaunt, a tall alchemist in a stained leather apron, smoked goggles pushed up, a faintly glowing flask.',
  ),
  actor(
    'chr_npc_ivo_quill_s',
    'Ashwick Alchemy Row',
    '',
    'Ivo Quill, a young tester with singed eyebrows, salve on one cheek, a notebook and a pair of tongs.',
  ),
  actor(
    'chr_npc_city_watch_s',
    'Alderbrook streets',
    `${NPCS}/sunwall-town.lua`,
    'A city watchman on patrol: dark tunic, brass buttons, truncheon at the hip, a crested helmet.',
  ),
  actor(
    'chr_npc_watch_sergeant_s',
    'Alderbrook streets',
    `${ZONES}/town-derth/npcs.lua`,
    'A watch sergeant: heavier coat, a sash of rank, a whistle on a chain, a hand bell.',
  ),
  actor(
    'chr_npc_lamplighter_s',
    'Alderbrook streets',
    '',
    'A lamplighter with a long brass pole and a hooded lantern, collar up against the fog.',
  ),
  actor(
    'chr_npc_street_crier_s',
    'Alderbrook streets',
    '',
    'An adult news crier with a satchel of broadsheets, one held high.',
  ),
  actor(
    'chr_npc_citizen_man_s',
    'any town',
    `${ZONES}/town-last-hope/npcs.lua`,
    'An ordinary working man: flat cap, waistcoat, rolled sleeves. Plain enough to repeat in a crowd.',
  ),
  actor(
    'chr_npc_citizen_woman_s',
    'any town',
    `${ZONES}/town-last-hope/npcs.lua`,
    'An ordinary working woman: shawl, long skirt, basket on the arm. Plain enough to repeat.',
  ),
  actor(
    'chr_npc_citizen_elder_s',
    'any town',
    `${ZONES}/town-last-hope/npcs.lua`,
    'An elderly citizen with a walking stick and a heavy coat, stooped but watchful.',
  ),
  actor(
    'chr_npc_registry_clerk_s',
    "Saint Orwin's Square",
    '',
    'A registry clerk in sleeve garters and a green eyeshade, pen in hand.',
  ),
  actor(
    'chr_npc_office_secretary_s',
    "The detective's office",
    '',
    "The office's secretary: neat dark dress, reading glasses on a cord, a tin of typewriter ribbon.",
  ),
  actor(
    'chr_npc_coroner_s',
    "Saint Orwin's Square",
    '',
    'The coroner: a rubber apron over a good suit, a small inspection lamp, tired eyes.',
  ),
  actor(
    'chr_npc_foundry_hand_s',
    'Gearford Industrial Ward',
    '',
    'A foundry hand black with soot: leather cap, heavy gauntlets, long tongs.',
  ),
  actor(
    'chr_npc_foundry_foreman_s',
    'Gearford Industrial Ward',
    '',
    'A foundry foreman in a bowler with a pocket watch out and rolled blueprints under one arm.',
  ),
  actor(
    'chr_npc_alchemy_apprentice_s',
    'Ashwick Alchemy Row',
    `${ZONES}/town-angolwen/npcs.lua`,
    'An apprentice in an oversized apron carrying an armful of jars.',
  ),
  actor(
    'chr_npc_curate_s',
    "Saint's Rest",
    `${NPCS}/sunwall-town.lua`,
    'The curate: black cassock, a lantern and a prayer book, a calm and stubborn face.',
  ),
  actor(
    'chr_npc_mourner_s',
    "Saint's Rest",
    '',
    'A veiled mourner in black holding a few white lilies.',
  ),
  actor(
    'chr_npc_smallholder_s',
    'Blackwood Outskirts',
    `${ZONES}/town-derth/npcs.lua`,
    'A smallholder with a hoe and a basket of turnips, boots caked in field mud.',
  ),
  actor(
    'chr_npc_camp_cook_s',
    "A Wayfarers' Camp",
    '',
    'A camp cook with a ladle and a dented pot, apron over a greatcoat.',
  ),
  actor(
    'chr_npc_drover_s',
    "A Wayfarers' Camp",
    '',
    'A drover with a crook and a long weatherproof coat.',
  ),
  actor(
    'chr_npc_pawnbroker_s',
    'Threadneedle Row',
    '',
    "A pawnbroker in half-moon spectacles with a jeweller's loupe and a ticket book.",
  ),
  actor(
    'chr_npc_fence_s',
    'Threadneedle Row',
    '',
    'A fence with a turned-up collar and a coat lined with pockets, glancing sideways.',
  ),
  actor(
    'chr_npc_quartermaster_s',
    'Outfitter shops',
    '',
    'A quartermaster with a clipboard and a coil of rope over one shoulder.',
  ),
  actor(
    'chr_npc_apothecary_s',
    'Ashwick Alchemy Row',
    '',
    'An apothecary grinding with a mortar and pestle, rows of bottles implied at the belt.',
  ),
  actor(
    'chr_npc_archivist_s',
    'The Glass Archive',
    '',
    'A friendly archivist in white cotton gloves carrying a document in a glass case.',
  ),
  actor(
    'chr_npc_bookbinder_s',
    'Threadneedle Row',
    '',
    'A bookbinder with an awl and a stack of folded signatures.',
  ),
  actor('chr_npc_ferryman_s', 'The Weir', '', 'A ferryman in oilskins leaning on a boathook.'),
  actor(
    'chr_npc_miner_s',
    'The Hollow Mine',
    '',
    'A miner who got out: lamp helmet, pick, dust-grey face, a shaking hand.',
  ),
  actor(
    'chr_npc_chapel_warden_s',
    'The Drowned Chapel',
    '',
    'A chapel warden in a waterlogged cassock holding a bell.',
  ),
  actor(
    'chr_npc_intro_survivor_s',
    'The intro cave',
    `${ZONES}/reknor-escape/npcs.lua`,
    'A fellow detective who woke in the dark beside you: bandaged head, cracked lantern, revolver held low.',
  ),
  large(
    'chr_npc_alchemist_golem',
    'The Alchemist',
    `${NPCS}/construct.lua`,
    "The Alchemist's golem: a riveted brass-and-oak frame with a boiler for a chest and heavy fists.",
  ),
];

/**
 * ═══ WHAT HUNTS UNDER THE CITY ═══
 * Each block is one upstream family, renamed and redrawn. Within a block the
 * entries run weakest to strongest, as upstream's do.
 */
export const ENEMY_ART_REQUESTS: readonly ArtRequest[] = [
  // Rodents — `rodent.lua`. Cellars, the Underworks.
  actor(
    'enemy_ledger_mouse_s',
    'The Underworks, cellars',
    `${NPCS}/rodent.lua`,
    'A pale mouse the size of a terrier, pulped paper matted into its fur.',
  ),
  actor(
    'enemy_ledger_rat_s',
    'The Underworks, cellars',
    `${NPCS}/rodent.lua`,
    'A grey-brown rat as long as a forearm, a strip of ledger paper in its teeth.',
  ),
  actor(
    'enemy_moor_hare_s',
    'Blackwood Outskirts',
    `${NPCS}/rodent.lua`,
    'A moor hare grown wrong: too long in the legs, too still, eyes like wet ink.',
  ),
  actor(
    'enemy_glass_rat_s',
    'The Glass Archive',
    `${NPCS}/rodent.lua`,
    'A rat with shards of archive glass grown out through its back.',
  ),
  // Worm masses — `vermin.lua`.
  actor(
    'enemy_pageworm_mass_s',
    'The Underworks',
    `${NPCS}/vermin.lua`,
    'A heap of pale worms threaded through pulped paper, slowly spreading.',
  ),
  actor(
    'enemy_pageworm_mass_green_s',
    'The Underworks',
    `${NPCS}/vermin.lua`,
    'The acid kind: green, dripping, leaving etched stone where it crawled.',
  ),
  actor(
    'enemy_carrion_pageworm_mass_s',
    "Saint's Rest",
    `${NPCS}/vermin.lua`,
    "The diseased kind: grey-red worms feeding on something in a clerk's coat.",
  ),
  // Undead rats — `undead-rat.lua`.
  actor(
    'enemy_struck_rat_skeletal_s',
    "Saint's Rest",
    `${NPCS}/undead-rat.lua`,
    'A rat skeleton with a black strike-through bar across its skull.',
  ),
  actor(
    'enemy_struck_rat_ghoulish_s',
    "Saint's Rest",
    `${NPCS}/undead-rat.lua`,
    'A half-rotten rat, fur in patches, mouth stitched with thread that has split.',
  ),
  actor(
    'enemy_struck_rat_spectral_s',
    "Saint's Rest",
    `${NPCS}/undead-rat.lua`,
    'A see-through rat outlined in static.',
  ),
  actor(
    'enemy_struck_rat_vampire_s',
    "Saint's Rest",
    `${NPCS}/undead-rat.lua`,
    'A bloated black rat with a red-wet muzzle and long front teeth.',
  ),
  large(
    'enemy_gigantic_bone_rat',
    "Saint's Rest",
    `${NPCS}/undead-rat.lua`,
    'A rat skeleton the size of a pony, ribs strung with name tags.',
  ),
  // Molds — `molds.lua`. Stationary.
  actor(
    'enemy_ink_bloom_grey_s',
    'Cellars, the Underworks',
    `${NPCS}/molds.lua`,
    'A grey fungal bloom that is also a spreading ink blot, rooted to the floor.',
  ),
  actor(
    'enemy_ink_bloom_brown_s',
    'Cellars, the Underworks',
    `${NPCS}/molds.lua`,
    'A brown bloom that puffs spores like dust from an old file.',
  ),
  actor(
    'enemy_ink_bloom_shining_s',
    'The Hollow Mine',
    `${NPCS}/molds.lua`,
    'A bloom that crackles with a pale electric light.',
  ),
  actor(
    'enemy_ink_bloom_green_s',
    'Blackwood Outskirts',
    `${NPCS}/molds.lua`,
    'A poison-green bloom glistening with droplets.',
  ),
  // Oozes — `ooze.lua`. Spilled ink that moves.
  actor(
    'enemy_ink_spill_green_s',
    'The Underworks',
    `${NPCS}/ooze.lua`,
    'A crawling pool of green ink with half-dissolved pages in it.',
  ),
  actor(
    'enemy_ink_spill_red_s',
    'The Underworks',
    `${NPCS}/ooze.lua`,
    'Red ink that steams where it moves.',
  ),
  actor(
    'enemy_ink_spill_blue_s',
    'The Weir',
    `${NPCS}/ooze.lua`,
    'Blue-black ink with a skin of frost.',
  ),
  actor(
    'enemy_ink_spill_white_s',
    'The Glass Archive',
    `${NPCS}/ooze.lua`,
    'Correction fluid gone feral: chalk-white, blank, erasing the floor under it.',
  ),
  actor(
    'enemy_ink_spill_black_s',
    'The Outer Index',
    `${NPCS}/ooze.lua`,
    'Pure black ink that swallows the light around it.',
  ),
  large(
    'enemy_the_blotter',
    'The Underworks',
    `${NPCS}/ooze.lua`,
    "A translucent cube of blotting jelly with a lost detective's hat and keys suspended inside.",
  ),
  // Jellies — `jelly.lua`. Stationary, one per colour.
  actor(
    'enemy_ink_jelly_green_s',
    'The Underworks',
    `${NPCS}/jelly.lua`,
    'A wobbling mound of green jelly, rooted where it settled.',
  ),
  actor(
    'enemy_ink_jelly_red_s',
    'The Underworks',
    `${NPCS}/jelly.lua`,
    'A red jelly mound, faintly warm.',
  ),
  actor(
    'enemy_ink_jelly_blue_s',
    'The Weir',
    `${NPCS}/jelly.lua`,
    'A blue jelly mound rimed with ice.',
  ),
  actor(
    'enemy_ink_jelly_white_s',
    'The Glass Archive',
    `${NPCS}/jelly.lua`,
    'A white jelly mound with a paper clip floating in it.',
  ),
  actor(
    'enemy_ink_jelly_yellow_s',
    'The Hollow Mine',
    `${NPCS}/jelly.lua`,
    'A yellow jelly mound that hums.',
  ),
  actor(
    'enemy_ink_jelly_black_s',
    'The Outer Index',
    `${NPCS}/jelly.lua`,
    'A black jelly mound with a surface like a printed page.',
  ),
  // Snakes — `snake.lua`. Blackwood.
  actor(
    'enemy_moor_adder_s',
    'Blackwood Outskirts',
    `${NPCS}/snake.lua`,
    'A thick brown adder coiled to strike.',
  ),
  actor(
    'enemy_pale_adder_s',
    'Blackwood Outskirts',
    `${NPCS}/snake.lua`,
    'A white adder, almost colourless.',
  ),
  actor(
    'enemy_copperhead_s',
    'Blackwood Outskirts',
    `${NPCS}/snake.lua`,
    'A copper-banded snake with a coppery head.',
  ),
  actor(
    'enemy_rattlesnake_s',
    'Blackwood Outskirts',
    `${NPCS}/snake.lua`,
    'A rattlesnake raised with its tail up.',
  ),
  actor('enemy_hooded_cobra_s', 'The Weir', `${NPCS}/snake.lua`, 'A hooded cobra spread wide.'),
  actor(
    'enemy_black_mamba_s',
    'Blackwood Outskirts',
    `${NPCS}/snake.lua`,
    'A long black snake reared high and fast.',
  ),
  large(
    'enemy_river_constrictor',
    'The Weir',
    `${NPCS}/snake.lua`,
    'A huge constrictor looped over itself, head as big as a satchel.',
  ),
  // Canines — `canine.lua`.
  actor(
    'enemy_moor_wolf_s',
    'Blackwood Outskirts',
    `${NPCS}/canine.lua`,
    'A lean grey moor wolf, ribs showing.',
  ),
  actor(
    'enemy_great_wolf_s',
    'Blackwood Outskirts',
    `${NPCS}/canine.lua`,
    'A heavy wolf with a torn ear and a scarred muzzle.',
  ),
  large(
    'enemy_dire_wolf',
    'Cairnfoot',
    `${NPCS}/canine.lua`,
    'A wolf the size of a horse, shoulders humped with muscle.',
  ),
  actor(
    'enemy_white_wolf_s',
    'Cairnfoot',
    `${NPCS}/canine.lua`,
    'A white wolf with frost in its coat.',
  ),
  actor(
    'enemy_static_hound_s',
    'Streets at night',
    `${NPCS}/canine.lua`,
    'A stray hound that is mostly static, its outline flickering, teeth solid.',
  ),
  actor(
    'enemy_moor_fox_s',
    'Blackwood Outskirts',
    `${NPCS}/canine.lua`,
    'A red fox, quick and low.',
  ),
  // Bears — `bear.lua`.
  large(
    'enemy_brown_bear',
    'Blackwood Outskirts',
    `${NPCS}/bear.lua`,
    'A brown bear reared on its hind legs.',
  ),
  large(
    'enemy_black_bear',
    'Blackwood Outskirts',
    `${NPCS}/bear.lua`,
    'A black bear on all fours, head low.',
  ),
  large(
    'enemy_cave_bear',
    'The Hollow Mine',
    `${NPCS}/bear.lua`,
    'A pale cave bear with blind milky eyes.',
  ),
  large(
    'enemy_war_bear',
    'Cairnfoot',
    `${NPCS}/bear.lua`,
    'A bear in scraps of chain barding, a broken collar round its neck.',
  ),
  // Spiders — `spider.lua`. They bind with paper and gum.
  actor(
    'enemy_binder_spider_s',
    'The Glass Archive',
    `${NPCS}/spider.lua`,
    'A dog-sized spider spinning strands of gummed paper.',
  ),
  actor(
    'enemy_gum_spitter_s',
    'The Glass Archive',
    `${NPCS}/spider.lua`,
    'A squat spider with a swollen jaw that spits glue.',
  ),
  actor(
    'enemy_chitin_binder_s',
    'The Hollow Mine',
    `${NPCS}/spider.lua`,
    'A heavily plated spider with a back like riveted leather.',
  ),
  actor(
    'enemy_weaver_young_s',
    'The Glass Archive',
    `${NPCS}/spider.lua`,
    'A pale young weaver, legs too long for its body.',
  ),
  large(
    'enemy_weaver_patriarch',
    'The Glass Archive',
    `${NPCS}/spider.lua`,
    'A huge male weaver wearing a shawl of stitched pages.',
  ),
  large(
    'enemy_weaver_matriarch',
    'The Glass Archive',
    `${NPCS}/spider.lua`,
    'A huge female weaver, egg sac bound in ledger cloth.',
  ),
  // Ants — `ant.lua`. Archive ants carry away paper.
  actor(
    'enemy_archive_ant_white_s',
    'The Glass Archive',
    `${NPCS}/ant.lua`,
    'A white ant the size of a cat, carrying a torn page.',
  ),
  actor(
    'enemy_archive_ant_brown_s',
    'The Glass Archive',
    `${NPCS}/ant.lua`,
    'A brown worker ant, mandibles open.',
  ),
  actor(
    'enemy_archive_ant_carpenter_s',
    'Blackwood Outskirts',
    `${NPCS}/ant.lua`,
    'A black carpenter ant with sawdust on its jaws.',
  ),
  actor(
    'enemy_archive_ant_red_s',
    'The Underworks',
    `${NPCS}/ant.lua`,
    'A red soldier ant, head bigger than its body.',
  ),
  actor(
    'enemy_archive_ant_fire_s',
    'Gearford Industrial Ward',
    `${NPCS}/ant.lua`,
    'An ant glowing like a coal from inside.',
  ),
  actor(
    'enemy_archive_ant_ice_s',
    'Cairnfoot',
    `${NPCS}/ant.lua`,
    'A blue ant crusted with frost.',
  ),
  actor(
    'enemy_archive_ant_lightning_s',
    'The Hollow Mine',
    `${NPCS}/ant.lua`,
    'A yellow ant with sparks jumping between its antennae.',
  ),
  actor(
    'enemy_archive_ant_acid_s',
    'The Underworks',
    `${NPCS}/ant.lua`,
    'A green ant dripping acid from its abdomen.',
  ),
  actor(
    'enemy_archive_ant_army_s',
    'The Glass Archive',
    `${NPCS}/ant.lua`,
    'A column of small ants moving as one body.',
  ),
  // Swarms — `swarm.lua`.
  actor(
    'enemy_citation_moth_swarm_s',
    'The Glass Archive',
    `${NPCS}/swarm.lua`,
    'A cloud of grey moths with printed marks on their wings.',
  ),
  actor('enemy_bee_swarm_s', 'Blackwood Outskirts', `${NPCS}/swarm.lua`, 'An angry cloud of bees.'),
  actor(
    'enemy_hornet_swarm_s',
    'Blackwood Outskirts',
    `${NPCS}/swarm.lua`,
    'A dense cloud of large hornets.',
  ),
  actor(
    'enemy_hummerhorn_s',
    'The Weir',
    `${NPCS}/swarm.lua`,
    'A single huge biting fly with a drill-like proboscis.',
  ),
  // Skeletons — `skeleton.lua`. THE STRUCK-THROUGH: dead with their names crossed out.
  actor(
    'enemy_struck_warrior_degenerated_s',
    "Saint's Rest",
    `${NPCS}/skeleton.lua`,
    'A crumbling skeleton with a rusted blade and a black bar across the skull.',
  ),
  actor(
    'enemy_struck_archer_degenerated_s',
    "Saint's Rest",
    `${NPCS}/skeleton.lua`,
    'A crumbling skeleton with a warped bow.',
  ),
  actor(
    'enemy_struck_mage_s',
    "Saint's Rest",
    `${NPCS}/skeleton.lua`,
    "A skeleton in the rags of a clerk's robe, finger bones inked black.",
  ),
  actor(
    'enemy_struck_warrior_s',
    'Barrow End',
    `${NPCS}/skeleton.lua`,
    "A whole skeleton with a watchman's rusted sword and buckler.",
  ),
  actor(
    'enemy_struck_archer_s',
    'Barrow End',
    `${NPCS}/skeleton.lua`,
    'A whole skeleton with a crossbow.',
  ),
  actor(
    'enemy_struck_magus_s',
    'Barrow End',
    `${NPCS}/skeleton.lua`,
    'A skeleton trailing loose pages that circle it like a cloak.',
  ),
  actor(
    'enemy_struck_warrior_armoured_s',
    'Barrow End',
    `${NPCS}/skeleton.lua`,
    'A skeleton in dented plate stamped with a filing number.',
  ),
  actor(
    'enemy_struck_master_archer_s',
    'Barrow End',
    `${NPCS}/skeleton.lua`,
    'A skeleton archer with a quiver of ink-black bolts.',
  ),
  actor(
    'enemy_struck_assassin_s',
    'Barrow End',
    `${NPCS}/skeleton.lua`,
    'A crouched skeleton with two long knives and a dark hood.',
  ),
  // Ghouls — `ghoul.lua`. THE UNFILED.
  actor(
    'enemy_unfiled_ghoul_s',
    "Saint's Rest",
    `${NPCS}/ghoul.lua`,
    'A grey hunched corpse in a burial shroud with long cracked nails.',
  ),
  actor(
    'enemy_unfiled_ghast_s',
    "Saint's Rest",
    `${NPCS}/ghoul.lua`,
    'A leaner ghoul with a stench shown as a green haze.',
  ),
  large(
    'enemy_unfiled_ghoulking',
    "Saint's Rest",
    `${NPCS}/ghoul.lua`,
    'A towering ghoul wearing a mourning coat and a chain of office.',
  ),
  actor(
    'enemy_risen_corpse_s',
    "Saint's Rest",
    `${NPCS}/ghoul.lua`,
    'A fresh corpse still in its Sunday clothes, toe tag swinging.',
  ),
  // Ghosts — `ghost.lua`. WRONG SHADOWS.
  actor(
    'enemy_wrong_shadow_s',
    'Anywhere dark',
    `${NPCS}/ghost.lua`,
    'A person-shaped shadow standing where no one is, edges smeared.',
  ),
  actor(
    'enemy_wrong_shadow_master_s',
    'The Drowned Chapel',
    `${NPCS}/ghost.lua`,
    'A taller shadow with a ring of smaller shadows orbiting it.',
  ),
  actor(
    'enemy_banshee_s',
    "Saint's Rest",
    `${NPCS}/ghost.lua`,
    "A pale woman's shape mid-scream, hair drifting upward.",
  ),
  actor(
    'enemy_ruin_banshee_s',
    'Barrow End',
    `${NPCS}/ghost.lua`,
    'A banshee made of dust and crumbling plaster.',
  ),
  // Wights — `wight.lua`.
  actor(
    'enemy_forest_wight_s',
    'Blackwood Outskirts',
    `${NPCS}/wight.lua`,
    'A gaunt dead thing wrapped in moss and roots, eyes like marsh lights.',
  ),
  actor(
    'enemy_grave_wight_s',
    "Saint's Rest",
    `${NPCS}/wight.lua`,
    'A dead gentleman in grave clothes with a cold blue light in its chest.',
  ),
  actor(
    'enemy_barrow_wight_s',
    'Barrow End',
    `${NPCS}/wight.lua`,
    'An ancient dead chieftain in corroded bronze, a grave-good torque at the neck.',
  ),
  large(
    'enemy_emperor_wight',
    'Barrow End',
    `${NPCS}/wight.lua`,
    'A crowned wight on a broken throne-chair it drags behind it.',
  ),
  // Vampires — `vampire.lua`.
  actor(
    'enemy_lesser_vampire_s',
    "Saint's Rest",
    `${NPCS}/vampire.lua`,
    "A pale young man in an undertaker's coat with too many teeth.",
  ),
  actor(
    'enemy_vampire_s',
    "Saint's Rest",
    `${NPCS}/vampire.lua`,
    'A vampire in good evening dress, cape lined red.',
  ),
  actor(
    'enemy_master_vampire_s',
    "Saint's Rest",
    `${NPCS}/vampire.lua`,
    'An old vampire in a frock coat with a silver-topped cane.',
  ),
  actor(
    'enemy_elder_vampire_s',
    'The Drowned Chapel',
    `${NPCS}/vampire.lua`,
    'A withered vampire in the vestments of a drowned priest.',
  ),
  large(
    'enemy_vampire_lord',
    'The Drowned Chapel',
    `${NPCS}/vampire.lua`,
    'A tall vampire lord with a cloak of bats that are also torn pages.',
  ),
  // Liches — `lich.lua`.
  actor(
    'enemy_lich_s',
    'The Glass Archive',
    `${NPCS}/lich.lua`,
    'A skeletal archivist in rotted robes holding a glowing index card.',
  ),
  large(
    'enemy_ancient_lich',
    'The Glass Archive',
    `${NPCS}/lich.lua`,
    'An ancient lich floating in a column of drifting pages.',
  ),
  large(
    'enemy_archlich',
    'The Outer Index',
    `${NPCS}/lich.lua`,
    'A lich with a crown of fountain pens, its robe a black redaction bar.',
  ),
  large(
    'enemy_blood_lich',
    'The Outer Index',
    `${NPCS}/lich.lua`,
    'A lich wet with red ink that runs upward.',
  ),
  // Bone giants — `bone-giant.lua`.
  large(
    'enemy_bone_giant',
    "Saint's Rest",
    `${NPCS}/bone-giant.lua`,
    'A giant built of many skeletons wired together.',
  ),
  large(
    'enemy_heavy_bone_giant',
    'Barrow End',
    `${NPCS}/bone-giant.lua`,
    'A squat, massive bone giant with a club made of a thighbone.',
  ),
  large(
    'enemy_eternal_bone_giant',
    'The Outer Index',
    `${NPCS}/bone-giant.lua`,
    'A bone giant whose bones are covered in tiny handwriting.',
  ),
  large(
    'enemy_runed_bone_giant',
    'The Outer Index',
    `${NPCS}/bone-giant.lua`,
    'A bone giant with glowing filing numbers branded down its spine.',
  ),
  // Orcs — `orc.lua`. THE FILED: gangs working for whoever is annotating.
  actor(
    'enemy_filed_bruiser_s',
    'Gearford Industrial Ward',
    `${NPCS}/orc.lua`,
    "A big gang bruiser in a docker's coat with an iron bar and a Filed armband.",
  ),
  actor(
    'enemy_filed_crossbow_s',
    'Gearford Industrial Ward',
    `${NPCS}/orc.lua`,
    'A gang shooter with a heavy crossbow and a bandolier of bolts.',
  ),
  actor(
    'enemy_filed_soldier_s',
    'Gearford Industrial Ward',
    `${NPCS}/orc.lua`,
    'A drilled gang soldier in a patched uniform with a bayonet on a stick.',
  ),
  actor(
    'enemy_filed_firebrand_s',
    'Gearford Industrial Ward',
    `${NPCS}/orc.lua`,
    'A gang member with a fuel tank on the back and a burning brand.',
  ),
  actor(
    'enemy_filed_frostbrand_s',
    'Cairnfoot',
    `${NPCS}/orc.lua`,
    'A gang member breathing frost through a scarf, hands rimed white.',
  ),
  actor(
    'enemy_filed_knife_s',
    'Threadneedle Row',
    `${NPCS}/orc.lua`,
    'A knife-man in a long coat, blade held reversed.',
  ),
  actor(
    'enemy_filed_master_knife_s',
    'Threadneedle Row',
    `${NPCS}/orc.lua`,
    'A senior knife-man with two blades and a scar across the mouth.',
  ),
  actor(
    'enemy_filed_grand_knife_s',
    'Threadneedle Row',
    `${NPCS}/orc.lua`,
    'The best knife in the Filed: masked, silent, a blade in each hand and one in the teeth.',
  ),
  // Thieves — `thieve.lua`. Street crime.
  actor(
    'enemy_cutpurse_s',
    'Alderbrook streets',
    `${NPCS}/thieve.lua`,
    'A skinny cutpurse with a hooked blade and quick eyes.',
  ),
  actor(
    'enemy_rogue_s',
    'Alderbrook streets',
    `${NPCS}/thieve.lua`,
    'A rogue in a battered top hat with a short sword.',
  ),
  actor(
    'enemy_thief_s',
    'Alderbrook streets',
    `${NPCS}/thieve.lua`,
    'A thief in dark clothes with a sack over one shoulder.',
  ),
  actor(
    'enemy_bandit_s',
    'Blackwood Outskirts',
    `${NPCS}/thieve.lua`,
    'A road bandit with a scarf over the face and a cudgel.',
  ),
  actor(
    'enemy_bandit_lord_s',
    'Blackwood Outskirts',
    `${NPCS}/thieve.lua`,
    "A bandit chief in a stolen officer's coat with a sabre.",
  ),
  actor(
    'enemy_street_assassin_s',
    'Threadneedle Row',
    `${NPCS}/thieve.lua`,
    'An assassin in grey with a thin blade and a poison vial.',
  ),
  actor(
    'enemy_shadowblade_s',
    'Threadneedle Row',
    `${NPCS}/thieve.lua`,
    'A figure half-dissolved into shadow with only the blades clear.',
  ),
  actor(
    'enemy_rogue_sapper_s',
    'The Underworks',
    `${NPCS}/thieve.lua`,
    "A sapper with a lit fuse, a satchel of charges and a miner's cap.",
  ),
  // Trolls — `troll.lua`. BRUTES.
  large(
    'enemy_furnace_brute',
    'Gearford Industrial Ward',
    `${NPCS}/troll.lua`,
    'A hulking brute with furnace-burned skin and a shovel-sized fist.',
  ),
  large(
    'enemy_stone_brute',
    'The Hollow Mine',
    `${NPCS}/troll.lua`,
    'A grey-skinned brute who looks carved from the mine wall.',
  ),
  large(
    'enemy_cave_brute',
    'The Underworks',
    `${NPCS}/troll.lua`,
    'A pale, long-armed brute with dripping hair.',
  ),
  large(
    'enemy_mountain_brute',
    'Cairnfoot',
    `${NPCS}/troll.lua`,
    'A huge brute with a boulder under one arm.',
  ),
  large(
    'enemy_thunder_brute',
    'Cairnfoot',
    `${NPCS}/troll.lua`,
    'A brute with a lightning rod strapped to its back, crackling.',
  ),
  large(
    'enemy_patchwork_brute',
    'Ashwick Alchemy Row',
    `${NPCS}/troll.lua`,
    'A brute stitched from several bodies, surgical thread and brass staples.',
  ),
  large(
    'enemy_hedge_wizard_brute',
    'Blackwood Outskirts',
    `${NPCS}/troll.lua`,
    "A brute in a hedge-witch's shawl with a bundle of burning herbs.",
  ),
  // Constructs — `construct.lua`. Gearford automata.
  actor(
    'enemy_broken_automaton_s',
    'Gearford Industrial Ward',
    `${NPCS}/construct.lua`,
    'A half-collapsed automaton trailing a leg, gears exposed.',
  ),
  large(
    'enemy_automaton',
    'Gearford Industrial Ward',
    `${NPCS}/construct.lua`,
    'A riveted iron automaton with a furnace belly and piston arms.',
  ),
  large(
    'enemy_alchemist_automaton',
    'Ashwick Alchemy Row',
    `${NPCS}/construct.lua`,
    'An automaton with glass tanks of bubbling reagent on its shoulders.',
  ),
  // Crystals — `crystal.lua`. ARCHIVE GLASS.
  actor(
    'enemy_archive_glass_red_s',
    'The Glass Archive',
    `${NPCS}/crystal.lua`,
    'A floating red glass shard with a fire inside.',
  ),
  actor(
    'enemy_archive_glass_white_s',
    'The Glass Archive',
    `${NPCS}/crystal.lua`,
    'A floating white glass shard, frosted.',
  ),
  actor(
    'enemy_archive_glass_black_s',
    'The Glass Archive',
    `${NPCS}/crystal.lua`,
    'A floating black glass shard that reflects nothing.',
  ),
  actor(
    'enemy_archive_glass_crimson_s',
    'The Glass Archive',
    `${NPCS}/crystal.lua`,
    'A crimson shard with a vein pulsing through it.',
  ),
  actor(
    'enemy_archive_glass_blue_s',
    'The Glass Archive',
    `${NPCS}/crystal.lua`,
    'A blue shard with lightning trapped inside.',
  ),
  actor(
    'enemy_archive_glass_multihued_s',
    'The Glass Archive',
    `${NPCS}/crystal.lua`,
    'A prism shard throwing coloured light on the floor.',
  ),
  actor(
    'enemy_archive_glass_shimmering_s',
    'The Glass Archive',
    `${NPCS}/crystal.lua`,
    'A shard that is hard to look at, shimmering in and out of focus.',
  ),
  // Plants — `plant.lua`. Blackwood.
  actor(
    'enemy_moor_flytrap_s',
    'Blackwood Outskirts',
    `${NPCS}/plant.lua`,
    'A man-high flytrap with jaws lined in thorns.',
  ),
  large(
    'enemy_blackwood_treant',
    'Blackwood Outskirts',
    `${NPCS}/plant.lua`,
    'A walking blackthorn tree with a face in the bark.',
  ),
  actor(
    'enemy_poison_ivy_s',
    'Blackwood Outskirts',
    `${NPCS}/plant.lua`,
    'A writhing mat of ivy with glossy poisonous leaves.',
  ),
  large(
    'enemy_honey_tree',
    'Blackwood Outskirts',
    `${NPCS}/plant.lua`,
    'A squat tree dripping amber with a hive in its trunk.',
  ),
  // Felines — `feline.lua`.
  actor(
    'enemy_moor_cat_s',
    'Cairnfoot',
    `${NPCS}/feline.lua`,
    'A grey wild cat the size of a lynx.',
  ),
  actor(
    'enemy_panther_s',
    'Blackwood Outskirts',
    `${NPCS}/feline.lua`,
    'A black panther low in the grass.',
  ),
  large(
    'enemy_striped_tiger',
    'The Weir',
    `${NPCS}/feline.lua`,
    'An escaped menagerie tiger with a broken chain on its collar.',
  ),
  large(
    'enemy_sabertooth',
    'The Hollow Mine',
    `${NPCS}/feline.lua`,
    'A sabertooth cat with long yellowed fangs.',
  ),
  // Ritch — `ritch.lua`. The Hollow Mine.
  actor(
    'enemy_ritch_larva_s',
    'The Hollow Mine',
    `${NPCS}/ritch.lua`,
    'A fat white grub with mandibles.',
  ),
  actor(
    'enemy_ritch_hunter_s',
    'The Hollow Mine',
    `${NPCS}/ritch.lua`,
    'An insect hunter with scything forelegs.',
  ),
  large(
    'enemy_ritch_hive_mother',
    'The Hollow Mine',
    `${NPCS}/ritch.lua`,
    'A bloated hive mother with larvae crawling over her.',
  ),
  // Xorn — `xorn.lua`. Things that move through rock.
  large(
    'enemy_umber_hulk',
    'The Hollow Mine',
    `${NPCS}/xorn.lua`,
    'A beetle-like hulk with huge digging claws and too many eyes.',
  ),
  large(
    'enemy_rock_eater',
    'The Hollow Mine',
    `${NPCS}/xorn.lua`,
    'A round three-armed rock-eater with a mouth on top.',
  ),
  actor(
    'enemy_rock_eater_young_s',
    'The Hollow Mine',
    `${NPCS}/xorn.lua`,
    'A small rock-eater with gravel teeth.',
  ),
  // Minotaurs — `minotaur.lua`. The Underworks.
  large(
    'enemy_minotaur',
    'The Underworks',
    `${NPCS}/minotaur.lua`,
    "A bull-headed giant in a butcher's apron with a cleaver.",
  ),
  large(
    'enemy_maulotaur',
    'The Underworks',
    `${NPCS}/minotaur.lua`,
    'A bull-headed giant in iron with a steam maul.',
  ),
  // Horrors — `horror.lua`. Late, deep, wrong.
  actor(
    'enemy_worm_that_walks_s',
    'The Outer Index',
    `${NPCS}/horror.lua`,
    "A mass of worms in the shape of a man in a clerk's coat.",
  ),
  large(
    'enemy_bloated_horror',
    'The Outer Index',
    `${NPCS}/horror.lua`,
    'A floating swollen head with tiny weeping eyes.',
  ),
  actor(
    'enemy_nightmare_horror_s',
    'The Outer Index',
    `${NPCS}/horror.lua`,
    'A shape made of the dark behind a closed door.',
  ),
  large(
    'enemy_headless_horror',
    'The Outer Index',
    `${NPCS}/horror.lua`,
    'A giant body with an open neck and eyes in its palms.',
  ),
  actor(
    'enemy_eldritch_eye_s',
    'The Outer Index',
    `${NPCS}/horror.lua`,
    'A single floating eye with a trailing optic nerve.',
  ),
  actor(
    'enemy_luminous_horror_s',
    'The Outer Index',
    `${NPCS}/horror.lua`,
    'A spindly thing of hard white light.',
  ),
  large(
    'enemy_radiant_horror',
    'The Outer Index',
    `${NPCS}/horror.lua`,
    'A larger light horror, too bright to see the shape of.',
  ),
  large(
    'enemy_devourer',
    'The Outer Index',
    `${NPCS}/horror.lua`,
    'A mouth on legs, lined with rings of teeth.',
  ),
  actor(
    'enemy_blade_horror_s',
    'The Outer Index',
    `${NPCS}/horror.lua`,
    'A whirl of floating knives around an empty centre.',
  ),
  large(
    'enemy_oozing_horror',
    'The Outer Index',
    `${NPCS}/horror.lua`,
    'A dripping heap of ink and flesh with arms forming and dissolving.',
  ),
  actor(
    'enemy_umbral_horror_s',
    'The Outer Index',
    `${NPCS}/horror.lua`,
    'A horror made of shadow with white pinprick eyes.',
  ),
  large(
    'enemy_dreaming_horror',
    'The Drowned Chapel',
    `${NPCS}/horror.lua`,
    'A sleeping curled giant, its dreams drifting up as faint shapes.',
  ),
  actor(
    'enemy_dream_seed_s',
    'The Drowned Chapel',
    `${NPCS}/horror.lua`,
    'A small pulsing seed of dream-stuff.',
  ),
  actor(
    'enemy_parasitic_horror_s',
    'The Outer Index',
    `${NPCS}/horror.lua`,
    'A leech-like thing with a hooked mouth and too many fins.',
  ),
  actor(
    'enemy_animated_sword_s',
    'The Glass Archive',
    `${NPCS}/horror.lua`,
    'An old ceremonial sword floating point-down, turning slowly.',
  ),
];

/**
 * ═══ THE NAMED ONES ═══
 * Upstream's early uniques, each moved to the delve it now guards. Named, so
 * each must read as one individual rather than a bigger member of a family.
 */
export const BOSS_ART_REQUESTS: readonly ArtRequest[] = [
  large(
    'enemy_the_watcher',
    "The Watcher's Altar",
    '',
    "The Watcher, which today borrows the Index Cairn's sprite: a tall shrouded figure of stacked filing drawers, one great open eye in the top drawer.",
  ),
  large(
    'enemy_undermost_warden',
    'The intro cave, last floor',
    `${ZONES}/reknor-escape/npcs.lua`,
    'The boss at the cave mouth: a huge overseer in a riveted mining harness with a skull-splitting felling axe, eyes gone to static.',
  ),
  actor(
    'enemy_undermost_picket_s',
    'The intro cave, last floor',
    `${ZONES}/reknor-escape/npcs.lua`,
    "The warden's pickets: miners in torn safety harnesses with picks, heads bound in Index pages.",
  ),
  actor(
    'enemy_the_rat_registrar_s',
    "Saint's Rest",
    `${NPCS}/undead-rat.lua`,
    'A skeletal rat in a tiny paper mortarboard with green witchfire in its sockets.',
  ),
  actor(
    'enemy_the_skeletal_bloom_s',
    'The Underworks',
    `${NPCS}/molds.lua`,
    'An ink bloom grown over a whole skeleton, which it moves like a puppet.',
  ),
  actor(
    'enemy_barrow_end_shade_s',
    'Barrow End',
    `${ZONES}/ruins-kor-pul/npcs.lua`,
    'The Shade: the ghost of a sorcerer-clerk in a tall collar, pages whirling round him.',
  ),
  large(
    'enemy_kors_fury',
    'Barrow End',
    `${ZONES}/ruins-kor-pul/npcs.lua`,
    "Kor's Fury: a storm of dust and plaster in the shape of a screaming man.",
  ),
  large(
    'enemy_old_bill_of_the_stonecut',
    'Blackwood Outskirts',
    `${ZONES}/trollmire/npcs.lua`,
    'Old Bill, a quarry brute grown half into stone, a granite block for a club.',
  ),
  large(
    'enemy_shax_who_drinks_the_mire',
    'Blackwood Outskirts',
    `${ZONES}/trollmire/npcs.lua`,
    'Shax, a slime-dripping brute that lives in the bog, weeds hanging from its jaw.',
  ),
  actor(
    'enemy_prox_the_toll_taker_s',
    'Blackwood Outskirts',
    `${ZONES}/trollmire/npcs.lua`,
    'Prox, a road boss with a toll box chained to his wrist and a spiked club.',
  ),
  actor(
    'enemy_aluin_the_lapsed_curate_s',
    "Saint's Rest",
    `${ZONES}/trollmire/npcs.lua`,
    'Aluin, a fallen curate in scorched vestments with a cracked sun-disc staff.',
  ),
  large(
    'enemy_norgos_the_pit_bear',
    'The Hollow Mine',
    `${ZONES}/norgos-lair/npcs.lua`,
    'Norgos, an enormous bear with pickaxe heads embedded in its hide.',
  ),
  large(
    'enemy_the_prism_record',
    'The Glass Archive',
    `${ZONES}/scintillating-caves/npcs.lua`,
    'A vast faceted crystal holding a burning page at its heart.',
  ),
  actor(
    'enemy_the_simulacrum_s',
    'The Glass Archive',
    `${ZONES}/scintillating-caves/npcs.lua`,
    'A glass copy of a detective, perfect and empty.',
  ),
  large(
    'enemy_the_withering_thing',
    'The Drowned Chapel',
    `${ZONES}/heart-gloom/npcs.lua`,
    'A drooping mass of dead flowers and grave wreaths that drains colour around it.',
  ),
  large(
    'enemy_the_dreaming_one',
    'The Drowned Chapel',
    `${ZONES}/heart-gloom/npcs.lua`,
    'A floating sleeper wrapped in wet sheets, dreams leaking from its mouth.',
  ),
  large(
    'enemy_wrathroot',
    'Blackwood Outskirts',
    `${ZONES}/old-forest/npcs.lua`,
    'Wrathroot, an ancient furious blackthorn treant.',
  ),
  large(
    'enemy_shardskin',
    'Blackwood Outskirts',
    `${ZONES}/old-forest/npcs.lua`,
    'Shardskin, a treant with crystal growths splitting its bark.',
  ),
  large(
    'enemy_snaproot',
    'Blackwood Outskirts',
    `${ZONES}/old-forest/npcs.lua`,
    'Snaproot, a low spreading treant with roots like snares.',
  ),
  large(
    'enemy_the_underworks_minotaur',
    'The Underworks',
    `${ZONES}/maze/npcs.lua`,
    "The Minotaur of the tunnels: huge, horned, wearing a sewer-worker's rubber waders and a chain of keys.",
  ),
  large(
    'enemy_horned_horror',
    'The Underworks',
    `${ZONES}/maze/npcs.lua`,
    'A horned horror with arms ending in hooks.',
  ),
  large(
    'enemy_nimisil',
    'The Underworks',
    `${ZONES}/maze/npcs.lua`,
    'Nimisil, a vast pale spider nesting in a collapsed pumping station.',
  ),
  large(
    'enemy_the_silt_queen',
    'The Weir',
    `${ZONES}/sandworm-lair/npcs.lua`,
    'The Silt Queen, a giant worm rising from river mud, ringed mouth open.',
  ),
  large(
    'enemy_the_silted_wyrm',
    'The Weir',
    `${ZONES}/sandworm-lair/npcs.lua`,
    'A worm-dragon caked in grey silt and rot.',
  ),
  large(
    'enemy_rantha_the_frost_drake',
    'Cairnfoot',
    `${ZONES}/daikara/npcs.lua`,
    'Rantha, a white frost drake coiled on a cairn.',
  ),
  large(
    'enemy_varsha_the_writhing',
    'Cairnfoot',
    `${ZONES}/daikara/npcs.lua`,
    'Varsha, a fire drake whose body writhes like smoke.',
  ),
  actor(
    'enemy_massok_the_drake_hunter_s',
    'Cairnfoot',
    `${ZONES}/daikara/npcs.lua`,
    'Massok, a scarred hunter in drake-hide armour with a long spear.',
  ),
  actor(
    'enemy_the_master_of_saints_rest_s',
    "Saint's Rest",
    `${ZONES}/dreadfell/npcs.lua`,
    "The Master: an ancient vampire in a mayor's chain of office, perfectly calm.",
  ),
  large(
    'enemy_the_pale_drake',
    "Saint's Rest",
    `${ZONES}/dreadfell/npcs.lua`,
    'A skeletal drake with pale fire in its ribs.',
  ),
  actor(
    'enemy_borfast_the_broken_s',
    "Saint's Rest",
    `${ZONES}/dreadfell/npcs.lua`,
    'Borfast, a ghoul miner still in his lamp helmet, jaw hanging loose.',
  ),
  actor(
    'enemy_aletta_soultorn_s',
    "Saint's Rest",
    `${ZONES}/dreadfell/npcs.lua`,
    'Aletta, a spectral woman torn down the middle, half of her in static.',
  ),
  actor(
    'enemy_filio_flightfond_s',
    "Saint's Rest",
    `${ZONES}/dreadfell/npcs.lua`,
    'Filio, a small quick ghost-thief with two ghostly knives.',
  ),
  actor(
    'enemy_subject_z_s',
    'Ashwick Alchemy Row',
    `${ZONES}/halfling-ruins/npcs.lua`,
    'Subject Z, a failed experiment in a torn hospital gown, tubes still in its arms.',
  ),
  large(
    'enemy_the_mouth',
    'The Underworks, deep',
    `${ZONES}/deep-bellow/npcs.lua`,
    'The Mouth, a vast toothed opening in the tunnel floor with a tongue of pipes.',
  ),
  large(
    'enemy_the_abomination',
    'The Underworks, deep',
    `${ZONES}/deep-bellow/npcs.lua`,
    'The Abomination, a fused heap of bodies and machinery crawling on its arms.',
  ),
  actor(
    'enemy_fillarel_aldaren_s',
    'The Hollow Mine',
    `${ZONES}/unremarkable-cave/npcs.lua`,
    'Fillarel, a severe mage in grey travelling robes with a staff of dark wood.',
  ),
  actor(
    'enemy_krogar_s',
    'The Hollow Mine',
    `${ZONES}/unremarkable-cave/npcs.lua`,
    "Krogar, a Filed boss in a stained miner's coat with an axe and a lantern.",
  ),
  large(
    'enemy_the_archive_queen',
    'The Glass Archive',
    `${NPCS}/ant.lua`,
    'The queen of the archive ants, bloated with eggs, surrounded by paper nests.',
  ),
  large(
    'enemy_ninandra_the_great_weaver',
    'The Glass Archive',
    `${NPCS}/spider.lua`,
    'Ninandra, the great weaver, spinning a web of bound books.',
  ),
  large(
    'enemy_kratorr_the_glutton',
    'Gearford Industrial Ward',
    `${NPCS}/orc.lua`,
    'The Glutton, a vast Filed boss eating at a table he drags behind him.',
  ),
  large(
    'enemy_rungof_the_hound_titan',
    'Blackwood Outskirts',
    `${NPCS}/canine.lua`,
    'Rungof, a hound as big as a cart with a spiked collar and a broken chain.',
  ),
];

/**
 * ═══ WHAT A FIGHT LOOKS LIKE ═══
 * See the file header for the strip conventions. One projectile, one hit and
 * one area per damage type, then weapons, class signatures, support effects and
 * hazards.
 */
export const EFFECT_ART_REQUESTS: readonly ArtRequest[] = [
  loop(
    'ui_fx_bolt_physical',
    'any',
    'data/damage_types.lua',
    'A physical bolt in flight, pointing east, in grey and bone white.',
  ),
  once(
    'ui_fx_hit_physical',
    'any',
    'data/damage_types.lua',
    'A physical impact bursting on a cell and fading, in grey and bone white.',
  ),
  loop(
    'ui_fx_area_physical',
    'any',
    'data/damage_types.lua',
    'One cell of a physical area effect, seamless with its neighbours, in grey and bone white.',
  ),
  loop(
    'ui_fx_bolt_fire',
    'any',
    'data/damage_types.lua',
    'A fire bolt in flight, pointing east, in orange and yellow.',
  ),
  once(
    'ui_fx_hit_fire',
    'any',
    'data/damage_types.lua',
    'A fire impact bursting on a cell and fading, in orange and yellow.',
  ),
  loop(
    'ui_fx_area_fire',
    'any',
    'data/damage_types.lua',
    'One cell of a fire area effect, seamless with its neighbours, in orange and yellow.',
  ),
  loop(
    'ui_fx_bolt_cold',
    'any',
    'data/damage_types.lua',
    'A cold bolt in flight, pointing east, in pale blue and white.',
  ),
  once(
    'ui_fx_hit_cold',
    'any',
    'data/damage_types.lua',
    'A cold impact bursting on a cell and fading, in pale blue and white.',
  ),
  loop(
    'ui_fx_area_cold',
    'any',
    'data/damage_types.lua',
    'One cell of a cold area effect, seamless with its neighbours, in pale blue and white.',
  ),
  loop(
    'ui_fx_bolt_lightning',
    'any',
    'data/damage_types.lua',
    'A lightning bolt in flight, pointing east, in electric yellow and violet.',
  ),
  once(
    'ui_fx_hit_lightning',
    'any',
    'data/damage_types.lua',
    'A lightning impact bursting on a cell and fading, in electric yellow and violet.',
  ),
  loop(
    'ui_fx_area_lightning',
    'any',
    'data/damage_types.lua',
    'One cell of a lightning area effect, seamless with its neighbours, in electric yellow and violet.',
  ),
  loop(
    'ui_fx_bolt_acid',
    'any',
    'data/damage_types.lua',
    'A acid bolt in flight, pointing east, in sick green.',
  ),
  once(
    'ui_fx_hit_acid',
    'any',
    'data/damage_types.lua',
    'A acid impact bursting on a cell and fading, in sick green.',
  ),
  loop(
    'ui_fx_area_acid',
    'any',
    'data/damage_types.lua',
    'One cell of a acid area effect, seamless with its neighbours, in sick green.',
  ),
  loop(
    'ui_fx_bolt_nature',
    'any',
    'data/damage_types.lua',
    'A nature bolt in flight, pointing east, in leaf green and brown.',
  ),
  once(
    'ui_fx_hit_nature',
    'any',
    'data/damage_types.lua',
    'A nature impact bursting on a cell and fading, in leaf green and brown.',
  ),
  loop(
    'ui_fx_area_nature',
    'any',
    'data/damage_types.lua',
    'One cell of a nature area effect, seamless with its neighbours, in leaf green and brown.',
  ),
  loop(
    'ui_fx_bolt_blight',
    'any',
    'data/damage_types.lua',
    'A blight bolt in flight, pointing east, in bruise purple and bile green.',
  ),
  once(
    'ui_fx_hit_blight',
    'any',
    'data/damage_types.lua',
    'A blight impact bursting on a cell and fading, in bruise purple and bile green.',
  ),
  loop(
    'ui_fx_area_blight',
    'any',
    'data/damage_types.lua',
    'One cell of a blight area effect, seamless with its neighbours, in bruise purple and bile green.',
  ),
  loop(
    'ui_fx_bolt_light',
    'any',
    'data/damage_types.lua',
    'A light bolt in flight, pointing east, in gold and white.',
  ),
  once(
    'ui_fx_hit_light',
    'any',
    'data/damage_types.lua',
    'A light impact bursting on a cell and fading, in gold and white.',
  ),
  loop(
    'ui_fx_area_light',
    'any',
    'data/damage_types.lua',
    'One cell of a light area effect, seamless with its neighbours, in gold and white.',
  ),
  loop(
    'ui_fx_bolt_darkness',
    'any',
    'data/damage_types.lua',
    'A darkness bolt in flight, pointing east, in black and deep blue.',
  ),
  once(
    'ui_fx_hit_darkness',
    'any',
    'data/damage_types.lua',
    'A darkness impact bursting on a cell and fading, in black and deep blue.',
  ),
  loop(
    'ui_fx_area_darkness',
    'any',
    'data/damage_types.lua',
    'One cell of a darkness area effect, seamless with its neighbours, in black and deep blue.',
  ),
  loop(
    'ui_fx_bolt_arcane',
    'any',
    'data/damage_types.lua',
    'A arcane bolt in flight, pointing east, in magenta.',
  ),
  once(
    'ui_fx_hit_arcane',
    'any',
    'data/damage_types.lua',
    'A arcane impact bursting on a cell and fading, in magenta.',
  ),
  loop(
    'ui_fx_area_arcane',
    'any',
    'data/damage_types.lua',
    'One cell of a arcane area effect, seamless with its neighbours, in magenta.',
  ),
  loop(
    'ui_fx_bolt_mind',
    'any',
    'data/damage_types.lua',
    'A mind bolt in flight, pointing east, in pale violet.',
  ),
  once(
    'ui_fx_hit_mind',
    'any',
    'data/damage_types.lua',
    'A mind impact bursting on a cell and fading, in pale violet.',
  ),
  loop(
    'ui_fx_area_mind',
    'any',
    'data/damage_types.lua',
    'One cell of a mind area effect, seamless with its neighbours, in pale violet.',
  ),
  loop(
    'ui_fx_bolt_temporal',
    'any',
    'data/damage_types.lua',
    'A temporal bolt in flight, pointing east, in teal and brass.',
  ),
  once(
    'ui_fx_hit_temporal',
    'any',
    'data/damage_types.lua',
    'A temporal impact bursting on a cell and fading, in teal and brass.',
  ),
  loop(
    'ui_fx_area_temporal',
    'any',
    'data/damage_types.lua',
    'One cell of a temporal area effect, seamless with its neighbours, in teal and brass.',
  ),
  loop(
    'ui_fx_beam_lightning',
    'any',
    '',
    'A crackling lightning beam segment that tiles end to end.',
  ),
  loop('ui_fx_beam_light', 'any', '', 'A steady golden light beam segment.'),
  loop('ui_fx_beam_arcane', 'any', '', 'A magenta arcane beam segment with drifting glyph flecks.'),
  loop('ui_fx_beam_fire', 'any', '', 'A jet of flame segment.'),
  once('ui_fx_swing_slash', 'any', '', 'A bright crescent slash across the cell.'),
  once('ui_fx_swing_crush', 'any', '', 'A heavy downward crush with a ring of dust.'),
  once('ui_fx_swing_pierce', 'any', '', 'A quick straight thrust flash.'),
  once('ui_fx_swing_claw', 'any', '', 'Three parallel claw rakes.'),
  once('ui_fx_swing_bite', 'any', '', 'Jaws snapping shut.'),
  once('ui_fx_swing_unarmed', 'any', '', 'A punch impact with small shock lines.'),
  loop('ui_fx_shot_pistol', 'The Inspector', '', 'A pistol tracer: a short bright streak.'),
  loop('ui_fx_shot_crossbow_bolt', 'any', `${NPCS}/orc.lua`, 'A crossbow bolt in flight.'),
  loop('ui_fx_shot_arrow', 'any', 'data/general/objects/bows.lua', 'An arrow in flight.'),
  loop(
    'ui_fx_shot_sling_stone',
    'any',
    'data/general/objects/slings.lua',
    'A spinning sling stone.',
  ),
  loop(
    'ui_fx_thrown_flask',
    'The Alchemist',
    '',
    'A stoppered flask tumbling end over end, liquid sloshing.',
  ),
  loop('ui_fx_thrown_knife', 'any', `${NPCS}/thieve.lua`, 'A spinning throwing knife.'),
  once(
    'ui_fx_flask_shatter',
    'The Alchemist',
    '',
    'A flask shattering into a cloud of glass and reagent.',
  ),
  once(
    'ui_fx_redaction_strike',
    'The Redactor',
    '',
    'A thick black redaction bar stamping across the target, then flaking away.',
  ),
  once('ui_fx_warrant_whistle', 'The Watchman', '', 'Sound rings spreading from a whistle blast.'),
  once(
    'ui_fx_evidence_mark',
    'The Inspector',
    '',
    'A chalk circle and arrow drawn around a target.',
  ),
  once('ui_fx_heal', 'any', '', 'Soft rising motes of green-white light.'),
  loop('ui_fx_regeneration', 'any', '', 'A slow looping shimmer of healing on a body.'),
  once(
    'ui_fx_shield_up',
    'any',
    '',
    'A pane of brass-edged force snapping into place round a body.',
  ),
  once('ui_fx_shield_break', 'any', '', 'That pane cracking and falling apart.'),
  once('ui_fx_buff', 'any', '', 'Upward chevrons of warm light.'),
  once('ui_fx_debuff', 'any', '', 'Downward drips of dark ink.'),
  once('ui_fx_cleanse', 'any', '', 'A clean white wash wiping upward through a body.'),
  once('ui_fx_level_up', 'any', '', 'A column of gold light with a stamped seal flash.'),
  once('ui_fx_revive', 'any', '', 'A body lit from below as it is helped back up.'),
  once(
    'ui_fx_teleport_out',
    'any',
    'data/general/traps/teleport.lua',
    'A body folding away into a crease of static.',
  ),
  once(
    'ui_fx_teleport_in',
    'any',
    'data/general/traps/teleport.lua',
    'A body unfolding out of a crease of static.',
  ),
  once('ui_fx_summon', 'any', '', 'A ring of chalk lines flaring as something arrives.'),
  once('ui_fx_stealth_fade', 'any', '', 'A body fading into shadow.'),
  once(
    'ui_fx_death_erase',
    'The Redacted',
    '',
    'A Redacted body erased: pages peeling off and the shape crossing out.',
  ),
  once(
    'ui_fx_page_burst',
    'The Redacted',
    '',
    'A burst of loose pages scattering from a struck Redacted.',
  ),
  loop('ui_fx_stunned', 'any', '', 'Small circling sparks above a stunned head.'),
  loop('ui_fx_confused', 'any', '', 'Swirling question-mark scribbles above a head.'),
  loop('ui_fx_asleep', 'any', '', 'Slow drifting motes above a sleeping body.'),
  once('ui_fx_fear', 'any', '', 'A shiver of cold outline around a frightened body.'),
  once('ui_fx_critical_hit', 'any', '', 'A sharp star-flare on a critical hit.'),
  once('ui_fx_blood_splash', 'any', '', 'A small dark splash, not gory.'),
  once(
    'ui_fx_trap_trigger',
    'any',
    'data/general/traps/elemental.lua',
    'A pressure-plate click with a flash of warning red.',
  ),
  loop(
    'ui_fx_boulder_roll',
    'any',
    'data/general/traps/complex.lua',
    'A rolling boulder, pointing east.',
  ),
  once(
    'ui_fx_alarm_pulse',
    'any',
    'data/general/traps/alarm.lua',
    'Rings of red light pulsing from an alarm.',
  ),
  loop(
    'ui_fx_poison_cloud',
    'any',
    'data/general/traps/elemental.lua',
    'One cell of drifting green poison cloud.',
  ),
  loop('ui_fx_smoke', 'any', '', 'One cell of grey smoke.'),
  loop('ui_fx_ink_pool', 'any', '', 'One cell of spreading black ink on the floor.'),
  loop('ui_fx_burning_ground', 'any', '', 'One cell of low flames on the floor.'),
  once('ui_fx_dig', 'any', 'data/general/objects/digger.lua', 'Rock chips and dust from digging.'),
  once('ui_fx_loot_glint', 'any', '', 'A small glint on something worth picking up.'),
];

/**
 * ═══ STATUS ICONS FOR UPSTREAM'S EFFECTS NOT YET DRAWN ═══
 * 64x64, beside `icon_status_*` in `ui/icons/status/`. Each must read at 16x16.
 */
export const STATUS_ICON_ART_REQUESTS: readonly ArtRequest[] = [
  cell(
    'icon_status_poisoned',
    'any',
    'data/timed_effects/physical.lua',
    'A green droplet with a skull-like highlight.',
  ),
  cell('icon_status_burning', 'any', 'data/timed_effects/magical.lua', 'A small flame.'),
  cell(
    'icon_status_frozen',
    'any',
    'data/timed_effects/magical.lua',
    'A body outline inside an ice block.',
  ),
  cell('icon_status_wet', 'any', 'data/timed_effects/physical.lua', 'Three falling water drops.'),
  cell(
    'icon_status_diseased',
    'any',
    'data/timed_effects/magical.lua',
    'A cluster of purple spots.',
  ),
  cell(
    'icon_status_cursed',
    'any',
    'data/timed_effects/other.lua',
    'A cracked seal with a black mark.',
  ),
  cell(
    'icon_status_silenced',
    'any',
    'data/timed_effects/mental.lua',
    'A mouth with a black bar over it.',
  ),
  cell('icon_status_disarmed', 'any', 'data/timed_effects/physical.lua', 'A falling sword.'),
  cell(
    'icon_status_terrified',
    'any',
    'data/timed_effects/mental.lua',
    'Wide eyes with a sweat drop.',
  ),
  cell(
    'icon_status_asleep',
    'any',
    'data/timed_effects/mental.lua',
    'A closed eye with a crescent moon.',
  ),
  cell('icon_status_stealthed', 'any', 'data/timed_effects/other.lua', 'A half-shadowed hood.'),
  cell('icon_status_invisible', 'any', 'data/timed_effects/magical.lua', 'A dotted body outline.'),
  cell(
    'icon_status_weakened',
    'any',
    'data/timed_effects/physical.lua',
    'A bent arm with a downward arrow.',
  ),
  cell(
    'icon_status_taunted',
    'any',
    'data/timed_effects/mental.lua',
    'A pointing finger inside a red ring.',
  ),
  cell(
    'icon_status_crippled',
    'any',
    'data/timed_effects/physical.lua',
    'A leg with a cracked bone mark.',
  ),
  cell(
    'icon_status_drained',
    'any',
    'data/timed_effects/magical.lua',
    'An empty vial with a downward arrow.',
  ),
];

/**
 * ═══ UPSTREAM'S BASE ITEMS THAT DO NOT EXIST HERE YET ═══
 * 64x64, beside the other item icons in `items/equipment/`. Named for Alderbrook;
 * `port` is the upstream kind whose rules each carries.
 */
const OBJECTS = 'data/general/objects';

export const ITEM_ART_REQUESTS: readonly ArtRequest[] = [
  cell('item_shiv', 'any', `${OBJECTS}/knifes.lua`, 'A single short shiv with a taped handle.'),
  cell('item_sabre', 'any', `${OBJECTS}/swords.lua`, 'A cavalry sabre with a brass guard.'),
  cell(
    'item_cleaver',
    'any',
    `${OBJECTS}/2hswords.lua`,
    "A long two-handed butcher's cleaver-blade.",
  ),
  cell('item_cosh', 'any', `${OBJECTS}/maces.lua`, 'A leather cosh weighted with lead.'),
  cell('item_hatchet', 'any', `${OBJECTS}/axes.lua`, 'A one-handed hatchet.'),
  cell('item_felling_axe', 'any', `${OBJECTS}/2haxes.lua`, 'A two-handed felling axe.'),
  cell(
    'item_boathook',
    'any',
    `${OBJECTS}/2htridents.lua`,
    'A long iron boathook with a barbed tip.',
  ),
  cell(
    'item_surveyors_staff',
    'any',
    `${OBJECTS}/staves.lua`,
    "A surveyor's measuring staff with brass rings.",
  ),
  cell('item_sling', 'any', `${OBJECTS}/slings.lua`, 'A leather sling.'),
  cell('item_sling_shot', 'any', `${OBJECTS}/slings.lua`, 'A small pouch of lead shot.'),
  cell('item_crossbow', 'any', `${OBJECTS}/bows.lua`, 'A compact crossbow.'),
  cell('item_crossbow_bolts', 'any', `${OBJECTS}/bows.lua`, 'A bundle of crossbow bolts.'),
  cell('item_lash', 'any', `${OBJECTS}/whips.lua`, "A drover's coiled lash."),
  cell(
    'item_lodestone',
    'any',
    `${OBJECTS}/mindstars.lua`,
    'A dark polished lodestone that pulls at pins.',
  ),
  cell('item_wand', 'any', `${OBJECTS}/wands.lua`, 'A short wand of black wood tipped with brass.'),
  cell('item_rod', 'any', `${OBJECTS}/rods.lua`, 'A heavy iron rod with a crystal cap.'),
  cell('item_totem', 'any', `${OBJECTS}/totems.lua`, 'A carved bone totem on a cord.'),
  cell('item_clerks_coat', 'any', `${OBJECTS}/cloth-armors.lua`, "A clerk's long cloth coat."),
  cell('item_leather_duster', 'any', `${OBJECTS}/light-armors.lua`, 'A leather duster coat.'),
  cell('item_brigandine', 'any', `${OBJECTS}/heavy-armors.lua`, 'A riveted brigandine vest.'),
  cell(
    'item_bailiffs_plate',
    'any',
    `${OBJECTS}/massive-armors.lua`,
    "A full bailiff's plate harness.",
  ),
  cell(
    'item_riot_shield',
    'any',
    `${OBJECTS}/shields.lua`,
    'A tall wooden riot shield with an iron rim.',
  ),
  cell('item_flat_cap', 'any', `${OBJECTS}/leather-caps.lua`, 'A tweed flat cap.'),
  cell('item_steel_helm', 'any', `${OBJECTS}/helms.lua`, 'A steel helmet with a narrow brim.'),
  cell('item_wool_gloves', 'any', `${OBJECTS}/gloves.lua`, 'A pair of fingerless wool gloves.'),
  cell('item_gauntlets', 'any', `${OBJECTS}/gauntlets.lua`, 'A pair of steel-backed gauntlets.'),
  cell('item_work_boots', 'any', `${OBJECTS}/leather-boots.lua`, 'Laced leather work boots.'),
  cell('item_hobnail_boots', 'any', `${OBJECTS}/heavy-boots.lua`, 'Heavy hobnailed boots.'),
  cell(
    'item_leather_belt',
    'any',
    `${OBJECTS}/leather-belt.lua`,
    'A plain leather belt with a brass buckle.',
  ),
  cell('item_oilskin_cloak', 'any', `${OBJECTS}/cloak.lua`, 'An oilskin cloak with a hood.'),
  cell('item_plain_ring', 'any', `${OBJECTS}/jewelry.lua`, 'A plain iron ring.'),
  cell('item_plain_amulet', 'any', `${OBJECTS}/jewelry.lua`, 'A simple pendant on a chain.'),
  cell('item_torque', 'any', `${OBJECTS}/torques.lua`, 'A twisted metal torque.'),
  cell('item_infusion_vial', 'any', `${OBJECTS}/scrolls.lua`, 'A corked vial of glowing infusion.'),
  cell(
    'item_rune_slip',
    'any',
    `${OBJECTS}/scrolls.lua`,
    'A folded slip of paper stamped with a rune.',
  ),
  cell('item_lore_page', 'any', `${OBJECTS}/scrolls.lua`, 'A torn handwritten page.'),
  cell('item_coin_purse', 'any', `${OBJECTS}/money.lua`, 'A small leather purse spilling coins.'),
  cell('item_spade', 'any', `${OBJECTS}/digger.lua`, "A digger's spade."),
  cell('item_gem_white', 'any', `${OBJECTS}/gem.lua`, 'A cut white gem.'),
  cell('item_gem_red', 'any', `${OBJECTS}/gem.lua`, 'A cut red gem.'),
  cell('item_gem_blue', 'any', `${OBJECTS}/gem.lua`, 'A cut blue gem.'),
];

/**
 * ═══ THINGS TO FURNISH A PLACE WITH ═══
 * 64x64, one cell each, bottom-anchored like an actor when they stand up.
 * Traps are the ARMED sprite a player sees once a trap is found.
 */
const TRAPS = 'data/general/traps';

export const PROP_ART_REQUESTS: readonly ArtRequest[] = [
  cell(
    'prop_market_stall',
    'any town',
    '',
    'A market stall with a striped awning and crates of produce.',
  ),
  cell('prop_shop_counter', 'shops', '', 'A wooden shop counter with a brass bell on top.'),
  cell('prop_lamp_post', 'streets', '', 'A cast-iron gas lamp post, lit.'),
  cell('prop_street_bench', 'streets', '', 'A wrought-iron park bench.'),
  cell('prop_crate', 'any', '', 'A stamped wooden crate.'),
  cell('prop_barrel', 'any', '', 'An iron-hooped barrel.'),
  cell('prop_grain_sack', 'any', '', 'A tied grain sack.'),
  cell('prop_handcart', 'streets', '', 'A two-wheeled handcart.'),
  cell('prop_well', 'any town', '', 'A stone well with a winch.'),
  cell('prop_noticeboard', 'any town', '', 'A noticeboard covered in pinned bills.'),
  cell(
    'prop_iron_safe',
    "The detective's office",
    '',
    'The iron safe that cites an address that does not exist.',
  ),
  cell(
    'prop_office_desk',
    "The detective's office",
    '',
    'A cluttered desk with a green-shaded lamp.',
  ),
  cell(
    'prop_filing_cabinet',
    'offices, archives',
    '',
    'A tall filing cabinet with one drawer open.',
  ),
  cell('prop_typewriter_desk', 'offices', '', 'A small desk with a typewriter.'),
  cell('prop_coat_stand', 'offices', '', 'A coat stand with a hat and a scarf.'),
  cell('prop_bookshelf', 'any interior', '', 'A crammed bookshelf.'),
  cell('prop_hearth', 'any interior', '', 'A small lit fireplace.'),
  cell('prop_furnace', 'Gearford Industrial Ward', '', 'A glowing blast furnace mouth.'),
  cell('prop_gear_pile', 'Gearford Industrial Ward', '', 'A pile of rusted gears.'),
  cell(
    'prop_steam_pipe',
    'Gearford Industrial Ward',
    '',
    'A standing steam pipe venting a little.',
  ),
  cell('prop_valve_wheel', 'Gearford, the Underworks', '', 'A big iron valve wheel.'),
  cell('prop_anvil', 'Gearford Industrial Ward', '', 'An anvil with a hammer on it.'),
  cell('prop_coal_heap', 'Gearford Industrial Ward', '', 'A heap of coal with a shovel in it.'),
  cell('prop_alembic', 'Ashwick Alchemy Row', '', 'A glass alembic bubbling over a burner.'),
  cell('prop_cauldron', 'Ashwick Alchemy Row', '', 'A cast-iron cauldron steaming.'),
  cell('prop_jar_shelf', 'Ashwick Alchemy Row', '', 'A shelf of labelled specimen jars.'),
  cell('prop_herb_rack', 'Ashwick Alchemy Row', '', 'A drying rack of hanging herbs.'),
  cell('prop_gravestone_a', "Saint's Rest", '', 'A leaning slate gravestone.'),
  cell('prop_gravestone_b', "Saint's Rest", '', 'A stone cross grave marker.'),
  cell(
    'prop_open_grave',
    "Saint's Rest",
    '',
    'A freshly dug open grave with a spade stuck in the mound.',
  ),
  cell('prop_mausoleum_door', "Saint's Rest", '', 'A mausoleum door with a rusted gate.'),
  cell('prop_chapel_pew', "Saint's Rest, the Drowned Chapel", '', 'A wooden pew.'),
  cell('prop_font', "Saint's Rest, the Drowned Chapel", '', 'A stone font.'),
  cell('prop_campfire', "A Wayfarers' Camp", '', 'A campfire with a kettle on a tripod.'),
  cell('prop_tent', "A Wayfarers' Camp", '', 'A canvas tent.'),
  cell('prop_bedroll', "A Wayfarers' Camp", '', 'A rolled blanket and a pack.'),
  cell('prop_wagon', "A Wayfarers' Camp", '', 'A covered wagon.'),
  cell('prop_loom', 'Threadneedle Row', '', 'A weaving loom mid-work.'),
  cell('prop_dress_form', 'Threadneedle Row', '', "A tailor's dress form with a half-made coat."),
  cell('prop_cloth_bolts', 'Threadneedle Row', '', 'Stacked bolts of cloth.'),
  cell('prop_glass_case', 'The Glass Archive', '', 'A glass display case holding one document.'),
  cell(
    'prop_card_catalogue',
    'The Glass Archive',
    '',
    'A card catalogue with a drawer pulled out.',
  ),
  cell('prop_reading_desk', 'The Glass Archive', '', 'A slanted reading desk with an open ledger.'),
  cell('prop_archive_shelf', 'The Glass Archive', '', 'A glass-fronted archive shelf.'),
  cell('prop_sewer_grate', 'The Underworks', '', 'A floor grate with dark water below.'),
  cell('prop_pipe_junction', 'The Underworks', '', 'A junction of large pipes.'),
  cell('prop_mine_cart', 'The Hollow Mine', '', 'An ore cart on a short stretch of rail.'),
  cell('prop_support_beam', 'The Hollow Mine', '', 'A timber mine support.'),
  cell('prop_ore_pile', 'The Hollow Mine', '', 'A pile of rough ore.'),
  cell('prop_broken_altar', 'The Drowned Chapel', '', 'A cracked altar under an inch of water.'),
  cell('prop_sluice_gate', 'The Weir', '', 'A wooden sluice gate.'),
  cell('prop_fishing_net', 'The Weir', '', 'A net hung to dry on poles.'),
  cell('prop_eel_trap', 'The Weir', '', 'A wicker eel trap.'),
  cell('prop_tree_stump', 'Blackwood Outskirts', '', 'A mossy tree stump.'),
  cell('prop_fallen_log', 'Blackwood Outskirts', '', 'A rotting fallen log.'),
  cell('prop_toadstools', 'Blackwood Outskirts', '', 'A ring of pale toadstools.'),
  cell(
    'prop_evidence_box_closed',
    'any delve',
    'data/general/objects/objects.lua',
    "A locked tin evidence box, the game's treasure chest.",
  ),
  cell(
    'prop_evidence_box_open',
    'any delve',
    'data/general/objects/objects.lua',
    'The same box, open and empty.',
  ),
  cell(
    'prop_cave_way_up',
    'The intro cave',
    `${ZONES}/reknor-escape/zone.lua`,
    'A rough stair cut up through the rock toward daylight.',
  ),
  cell(
    'prop_trap_pressure_plate',
    'any delve',
    `${TRAPS}/elemental.lua`,
    'A worn pressure plate set into the floor.',
  ),
  cell(
    'prop_trap_tripwire',
    'any delve',
    `${TRAPS}/complex.lua`,
    'A taut tripwire between two pins.',
  ),
  cell(
    'prop_trap_rune_fire',
    'any delve',
    `${TRAPS}/elemental.lua`,
    'A chalked fire sigil, faintly glowing orange.',
  ),
  cell(
    'prop_trap_rune_ice',
    'any delve',
    `${TRAPS}/elemental.lua`,
    'A chalked frost sigil, faintly glowing blue.',
  ),
  cell(
    'prop_trap_rune_lightning',
    'any delve',
    `${TRAPS}/elemental.lua`,
    'A chalked lightning sigil, faintly glowing yellow.',
  ),
  cell(
    'prop_trap_rune_acid',
    'any delve',
    `${TRAPS}/elemental.lua`,
    'A chalked acid sigil, faintly glowing green.',
  ),
  cell(
    'prop_trap_gas_vent',
    'any delve',
    `${TRAPS}/complex.lua`,
    'A vent in the floor leaking a thread of green gas.',
  ),
  cell(
    'prop_trap_boulder',
    'any delve',
    `${TRAPS}/complex.lua`,
    'A boulder wedged above a trigger.',
  ),
  cell('prop_trap_alarm_bell', 'any delve', `${TRAPS}/alarm.lua`, 'An alarm bell on a wire.'),
  cell(
    'prop_trap_teleport_glyph',
    'any delve',
    `${TRAPS}/teleport.lua`,
    'A circle of static drawn on the floor.',
  ),
  cell(
    'prop_trap_water_jet',
    'The Weir, the Underworks',
    `${TRAPS}/water.lua`,
    'A pipe nozzle pointed at the floor.',
  ),
  cell(
    'prop_trap_poison_vine',
    'Blackwood Outskirts',
    `${TRAPS}/natural_forest.lua`,
    'A coil of poison vine hiding a snare.',
  ),
  cell(
    'prop_trap_sliding_rock',
    'Blackwood Outskirts, Cairnfoot',
    `${TRAPS}/natural_forest.lua`,
    'Loose rock balanced on a slope.',
  ),
  cell(
    'prop_trap_time_pocket',
    'The Outer Index',
    `${TRAPS}/temporal.lua`,
    'A small ripple in the air where time is wrong.',
  ),
];
