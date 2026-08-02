import { describe, expect, it } from 'vitest';

import { getJson, noFeatures, Outcome } from '../../src/http.js';

/**
 * The failures, asserted as facts.
 *
 * These do not test our code. They test that the three source behaviours the design is
 * built on are still true. Each one is a load-bearing claim: if a county quietly fixes
 * its index or its column type, the adapter's shape stops being justified and the
 * article's central examples stop being reproducible. Better to learn that here.
 *
 * Slow on purpose. Florida's failure is a fifty-six second wall and cannot be measured
 * any faster. Run with `npm run test:live -- known-failures`.
 */

const FL =
    'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Parcel_Centroid_Version/FeatureServer/0/query';
const SD = 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/ARCC/apprmapr/MapServer/2/query';

const SLOW = 120_000;

describe('Florida still refuses to filter on its address column', () => {
    it(
        'answers HTTP 200 with a 400 error body after about a minute, for a value that exists',
        async () => {
            const r = await getJson(
                FL,
                { f: 'json', where: "PHY_ADDR1='7519 CARAVACA CT'", returnCountOnly: 'true' },
                { budgetMs: 90_000, isEmpty: noFeatures },
            );

            // If this ever becomes Outcome.OK, Florida has indexed the column and the
            // whole geocode-and-envelope route in the Duval adapter is no longer needed.
            expect(r.outcome).toBe(Outcome.ENVELOPE_LIE);
            expect(r.status).toBe(200);
            expect(r.detail).toMatch(/400/);
            expect(r.ms).toBeGreaterThan(30_000);
        },
        SLOW,
    );

    it(
        'answers the same filter on the indexed column in seconds, so it is the index and not the load',
        async () => {
            const r = await getJson(
                FL,
                { f: 'json', where: 'CO_NO=26', returnIdsOnly: 'true' },
                { budgetMs: 30_000, isEmpty: (b) => (b?.objectIds ?? []).length === 0 },
            );

            expect(r.outcome).toBe(Outcome.OK);
            expect(r.body.objectIds.length).toBeGreaterThan(300_000);
            expect(r.ms).toBeLessThan(20_000);
        },
        SLOW,
    );
});

describe('San Diego still drops a statistic that overflows int32', () => {
    const sum = (where) =>
        getJson(
            SD,
            {
                f: 'json',
                where,
                returnGeometry: 'false',
                outStatistics: JSON.stringify([
                    { statisticType: 'sum', onStatisticField: 'ASR_TOTAL', outStatisticFieldName: 's' },
                ]),
            },
            {
                isEmpty: noFeatures,
                // A sum over a non-empty set has an answer. Empty here is not one.
                emptyIsAnAnswer: false,
            },
        );

    it(
        'returns a well-formed empty answer where the sum exceeds 2147483647',
        async () => {
            const r = await sum('OBJECTID<=1794');

            expect(r.status).toBe(200);
            expect(r.body.error).toBeUndefined();
            expect(r.body.fields).toHaveLength(1);
            expect(r.body.features).toEqual([]);
            // Nothing a normal client checks would call this a failure. Ours does.
            expect(r.outcome).toBe(Outcome.EMPTY_UNEXPECTED);
        },
        SLOW,
    );

    it(
        'answers the same query one row smaller, just under the ceiling',
        async () => {
            const r = await sum('OBJECTID<=1793');

            expect(r.outcome).toBe(Outcome.OK);
            const total = r.body.features[0].attributes.s;
            expect(total).toBeLessThan(2_147_483_647);
            // The margin was 212,371 on 2026-08-02, and the next parcel is worth 627,300.
            expect(2_147_483_647 - total).toBeLessThan(1_000_000);
        },
        SLOW,
    );

    it(
        'counts the same rows it will not sum, so the scope is answerable',
        async () => {
            const r = await getJson(SD, { f: 'json', where: '1=1', returnCountOnly: 'true' }, { isEmpty: () => false });

            expect(r.outcome).toBe(Outcome.OK);
            expect(r.body.count).toBeGreaterThan(1_000_000);
        },
        SLOW,
    );
});
