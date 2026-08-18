// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Authored for this game.

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *          HOW MUCH A ROOM SHOULD ASK OF THE PEOPLE WALKING INTO IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two numbers, because they are two different ways of being ready and a room
 * should answer either. A party of three at level 1 has three bodies to soak
 * and three sets of talents; a lone level-6 has neither, but hits far harder
 * and has a gap-closer. Grading a room on one of them alone gets the other
 * badly wrong, in opposite directions.
 *
 * IT IS A TYPE OF ITS OWN, in world/ rather than content/, so that
 * content/encounter.ts can take it without importing the realm registry and
 * realms.ts can pass it without importing the encounter. The thing both sides
 * need to agree on is the SHAPE, and this is it.
 */
export type PartyStrength = {
  /** The highest level in the party. See `partyMaxLevel` for why max. */
  readonly level: number;
  /** How many bodies are coming. */
  readonly size: number;
};

/** The gentlest possible reading: one person, freshly made. */
export const LONE_BEGINNER: PartyStrength = Object.freeze({ level: 1, size: 1 });
