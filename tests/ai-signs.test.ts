/** The fixed control-value sign contract is shared by supervised and direct strength fitting. */
import { describe, it, expect } from 'vitest';
import { FEATURE_NAMES, FEATURE_SIGNS, projectWeights } from '../src/ai/features.js';
import { W0 } from '../src/ai/value.js';

const positive = [
  'renown',
  'productionTimber',
  'productionClay',
  'productionGrain',
  'productionBronze',
  'productionHorses',
  'productionTotal',
  'productionDiversity',
  'productionMinimum',
  'harbourHeld',
  'shrinesHeld',
  'monuments',
  'granaries',
  'warlordHeld',
  'reachableSteadingSites',
  'bestReachableSitePips',
  'steadingUpgrades',
  'townUpgrades',
];
const negative = [
  'deficitTrack',
  'deficitSteading',
  'deficitTown',
  'deficitCitadel',
  'deficitCard',
  'deficitMuster',
  'tracksToOpenSite',
  'tracksToFreeShrine',
  'storageExcess',
  'warbandOnOwnHex',
  'strongestOpponentRenown',
];

describe('shared weight sign contract', () => {
  it('pins the fixed feature groups and leaves every unlisted feature free', () => {
    expect(FEATURE_SIGNS).toHaveLength(FEATURE_NAMES.length);
    FEATURE_NAMES.forEach((name, j) =>
      expect(FEATURE_SIGNS[j]).toBe(positive.includes(name) ? 1 : negative.includes(name) ? -1 : 0),
    );
    expect(FEATURE_SIGNS.filter((sign) => sign === 1)).toHaveLength(18);
    expect(FEATURE_SIGNS.filter((sign) => sign === -1)).toHaveLength(11);
    expect(FEATURE_SIGNS.filter((sign) => sign === 0)).toHaveLength(20);
    for (const name of [
      'distanceToWin',
      'handTimber',
      'handClay',
      'handGrain',
      'handBronze',
      'handHorses',
    ] as const)
      expect(FEATURE_SIGNS[FEATURE_NAMES.indexOf(name)]).toBe(0);
  });
  it('clips only disallowed directions without mutating the supplied coefficients', () => {
    const raw = Object.freeze(FEATURE_SIGNS.map((sign, j) => (sign ? -sign * (j + 1) : -(j + 1))));
    const projected = projectWeights(raw);
    projected.forEach((weight, j) => expect(weight).toBe(FEATURE_SIGNS[j] ? 0 : raw[j]));
    expect(projectWeights(projected)).toEqual(projected);
    expect(projectWeights(W0)).toEqual([...W0]);
    expect(raw).toEqual(FEATURE_SIGNS.map((sign, j) => (sign ? -sign * (j + 1) : -(j + 1))));
  });
  it('rejects malformed projections rather than producing incomplete or non-finite models', () => {
    expect(() => projectWeights([0])).toThrow('Invalid weights for sign projection');
    expect(() => projectWeights(FEATURE_NAMES.map((_, j) => (j === 0 ? NaN : 0)))).toThrow(
      'Invalid weights for sign projection',
    );
    expect(() => projectWeights(FEATURE_NAMES.map((_, j) => (j === 1 ? Infinity : 0)))).toThrow(
      'Invalid weights for sign projection',
    );
  });
});
