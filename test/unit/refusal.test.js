import { describe, expect, it, vi } from 'vitest';

import * as cook from '../../src/adapters/cook.js';
import * as sanDiego from '../../src/adapters/san-diego.js';
import { buildRefusal, JURISDICTIONS, Refusal } from '../../src/record.js';

/**
 * Travis reads its index directory once at import time, and a developer machine that has
 * built the index would answer the lookup instead of refusing it. Pointing the module at a
 * directory that does not exist is how the refusal stays reachable in a test that must not
 * depend on whether a 368 MB index happens to be on disk.
 */
const travisWithoutIndex = async () => {
    vi.stubEnv('TRAVIS_INDEX_DIR', 'test-fixture-no-index');
    vi.resetModules();
    try {
        return await import('../../src/adapters/travis.js');
    } finally {
        vi.unstubAllEnvs();
    }
};

/**
 * A refusal is an answer, so it is held to the same standard as a record.
 *
 * These exist because the shape drifted once already. Refusals were object literals at
 * five call sites, and by v0.5 three of the five had lost the jurisdiction, the endpoint
 * had three different key names, and the one refusal that did carry a jurisdiction carried
 * it as a hardcoded literal. None of it was visible while the person reading the refusal
 * was the person who had typed the query. An agent asking four counties at once has no
 * such context: if the record does not say which county refused, nothing does.
 */

const REQUIRED = ['result', 'jurisdiction', 'requested', 'source', 'reason'];

const shapeOf = (refusal) => {
    for (const key of REQUIRED) expect(refusal, `missing ${key}`).toHaveProperty(key);
    expect(Object.values(Refusal)).toContain(refusal.result);
    expect(refusal.requested).toHaveProperty('lookup_by');
    expect(refusal.requested).toHaveProperty('query');
    expect(Array.isArray(refusal.source.endpoints), 'source.endpoints is always an array').toBe(true);
    expect(refusal.reason.length).toBeGreaterThan(20);
    return refusal;
};

describe('buildRefusal', () => {
    const minimal = {
        result: Refusal.UNPARSED_ADDRESS,
        jurisdiction: 'san-diego-ca',
        lookupBy: 'address',
        query: 'not an address at all',
        reason: 'The address could not be split into the columns this layer stores.',
    };

    it('refuses a result code that is not in the vocabulary, exactly as a flag is refused', () => {
        expect(() => buildRefusal({ ...minimal, result: 'probably_broken' })).toThrow(/unknown refusal result/);
    });

    it('refuses a refusal with no reason, because an unexplained no is not actionable', () => {
        expect(() => buildRefusal({ ...minimal, reason: '' })).toThrow(/no reason/);
    });

    it('takes the jurisdiction from the table rather than from whoever is calling', () => {
        expect(buildRefusal(minimal).jurisdiction).toEqual(JURISDICTIONS['san-diego-ca']);
    });

    it('always carries source.endpoints, empty when nothing was asked', () => {
        expect(buildRefusal(minimal).source).toEqual({ mode: null, endpoints: [] });
    });

    it('omits the optional parts rather than filling them with null', () => {
        const refusal = buildRefusal(minimal);
        expect(refusal).not.toHaveProperty('remedy');
        expect(refusal).not.toHaveProperty('failure');
        expect(refusal).not.toHaveProperty('search');
    });
});

describe('the refusals reachable without a network', () => {
    it('San Diego: an address it cannot split', async () => {
        const [refusal] = await sanDiego.byAddress('not an address at all');
        shapeOf(refusal);
        expect(refusal.result).toBe(Refusal.UNPARSED_ADDRESS);
        expect(refusal.jurisdiction.county).toBe('San Diego');
    });

    it('Cook: a parcel identifier of the wrong length', async () => {
        const [refusal] = await cook.byParcelId('123');
        shapeOf(refusal);
        expect(refusal.result).toBe(Refusal.UNPARSED_PARCEL_ID);
        expect(refusal.jurisdiction.county).toBe('Cook');
    });

    it('Travis: no index built, and it says how to build one', async () => {
        const travis = await travisWithoutIndex();
        const [refusal] = await travis.byParcelId('100008');
        shapeOf(refusal);
        expect(refusal.result).toBe(Refusal.INDEX_NOT_BUILT);
        // The FIPS code used to be a literal here and is now the same table every other
        // record reads, so it cannot drift on its own.
        expect(refusal.jurisdiction).toEqual(JURISDICTIONS['travis-tx']);
        expect(refusal.remedy).toMatch(/build-travis-index/);
    });
});

describe('every refusal names the county that refused', () => {
    /**
     * The regression in one assertion. An agent fanning out across counties gets a flat
     * list back, and a refusal that does not name its jurisdiction is unattributable.
     */
    it('holds for each refusal that can be produced offline', async () => {
        const travis = await travisWithoutIndex();
        const refusals = [
            (await sanDiego.byAddress('not an address at all'))[0],
            (await cook.byParcelId('123'))[0],
            (await travis.byParcelId('100008'))[0],
            (await travis.byAddress('1 Nowhere Rd'))[0],
        ];

        for (const refusal of refusals) {
            shapeOf(refusal);
            expect(refusal.jurisdiction, refusal.result).not.toBeNull();
            expect(refusal.jurisdiction.fips, refusal.result).toMatch(/^\d{5}$/);
        }
    });
});
