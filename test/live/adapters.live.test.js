import { describe, expect, it } from 'vitest';

import { lookup } from '../../src/router.js';

/**
 * Live tests. These hit the real endpoints, so they are slow, they need the network, and
 * they fail when a county changes something.
 *
 * That is the point. Every assertion here is a claim the research repo makes on the
 * strength of one measurement on 2026-08-02. If a county silently reshapes its data, this
 * suite is what says so, instead of the article being quietly wrong months later.
 *
 * Values that will drift with the roll (owner names, assessed amounts) are asserted on
 * shape rather than on the exact number. Values that are structural are asserted exactly.
 */

const T = 60_000;
const only = (records) => {
    expect(records, JSON.stringify(records).slice(0, 300)).toHaveLength(1);
    return records[0];
};

describe('San Diego, public ArcGIS REST', () => {
    it(
        'answers a parcel id in one request and decodes the fields that lie about themselves',
        async () => {
            const r = only(await lookup({ jurisdiction: 'san-diego-ca', lookupBy: 'parcel_id', query: '3532803300' }));

            expect(r.parcel_id).toBe('3532803300');
            expect(r.situs_address.full).toBe('2461 RIDGEGATE ROW');
            // BATHS is stored times ten as a zero padded string: "025" is 2.5, not 25.
            expect(r.characteristics.bathrooms).toBe(2.5);
            expect(r.characteristics.bedrooms).toBe(3);
            // DOCDATE 110315 is MMDDYY, month first, no century.
            expect(r.sales[0].date).toBe('2015-11-03');
            // The layer exposes editingInfo: null and no date field. Unknown is the answer.
            expect(r.as_of.basis).toBe('unknown');
            expect(r.flags).toContain('source_freshness_unknown');
            // No bare total anywhere: every amount carries the basis it was computed on.
            expect(r.valuation.total).toBeUndefined();
            expect(r.valuation.headline_basis).toBe('ca_prop13_factored');
        },
        T,
    );

    it(
        'flags an information-only parcel instead of reporting a $0 property owned by INFORMATION ONLY',
        async () => {
            const r = only(await lookup({ jurisdiction: 'san-diego-ca', lookupBy: 'parcel_id', query: '7763015203' }));

            expect(r.flags).toContain('not_assessable');
            // The sentinel string must not reach the caller as a person.
            expect(r.owner.names).toEqual([]);
            // Values are 0 in the source and must not be reported as an assessment of zero.
            expect(r.valuation.amounts.every((a) => a.amount === null)).toBe(true);
        },
        T,
    );

    it(
        'reports a saturated measurement as unknown rather than as 99999 square feet',
        async () => {
            const r = only(await lookup({ jurisdiction: 'san-diego-ca', lookupBy: 'parcel_id', query: '1751373000' }));

            expect(r.flags).toContain('measurement_clamped');
            expect(r.characteristics.living_area_sqft).toBeNull();
        },
        T,
    );

    it(
        'flags a stacked parcel, because its geometry is shared with other taxable parcels',
        async () => {
            const r = only(await lookup({ jurisdiction: 'san-diego-ca', lookupBy: 'parcel_id', query: '4724003936' }));
            expect(r.flags).toContain('co_located_parcels');
        },
        T,
    );

    it(
        'answers an address without a geocoder, and narrows the candidate set on the attributes',
        async () => {
            const r = only(
                await lookup({
                    jurisdiction: 'san-diego-ca',
                    lookupBy: 'address',
                    query: '2461 Ridgegate Row, La Jolla, CA 92037',
                }),
            );

            expect(r.parcel_id).toBe('3532803300');
            expect(r.flags).not.toContain('resolved_via_external_geocoder');
            expect(r.flags).not.toContain('address_match_approximate');
        },
        T,
    );

    it(
        'does not return "100 N Main Ave" when asked for "100 Main St"',
        async () => {
            const records = await lookup({ jurisdiction: 'san-diego-ca', lookupBy: 'address', query: '100 Main St' });
            // The layer holds both, and only one of them is the address that was asked for.
            expect(records.every((r) => r.situs_address.full === '100 MAIN ST')).toBe(true);
        },
        T,
    );

    it(
        'refuses an unparsable address instead of querying something arbitrary',
        async () => {
            const r = only(
                await lookup({ jurisdiction: 'san-diego-ca', lookupBy: 'address', query: 'not an address at all' }),
            );
            expect(r.result).toBe('unparsed_address');
        },
        T,
    );
});

describe('Duval, the Florida statewide layer', () => {
    it(
        'answers a parcel id and publishes the whole valuation ladder, not one number',
        async () => {
            const r = only(await lookup({ jurisdiction: 'duval-fl', lookupBy: 'parcel_id', query: '0991354355R' }));

            expect(r.parcel_id).toBe('0991354355R');
            expect(r.jurisdiction.county).toBe('Duval');
            // The rows are the only honest freshness signal this source has.
            expect(r.as_of.basis).toBe('assessment_year');
            expect(r.as_of.value).toBeGreaterThanOrEqual(2025);

            const bases = r.valuation.amounts.map((a) => a.basis);
            // The gaps between these rungs are the Save Our Homes cap and the exemptions.
            expect(bases).toEqual(
                expect.arrayContaining([
                    'fl_just_value',
                    'fl_assessed_school',
                    'fl_assessed_nonschool',
                    'fl_taxable_school',
                    'fl_taxable_nonschool',
                ]),
            );
        },
        T,
    );

    it(
        'reaches a house by address through coordinates, and says it used a geocoder',
        async () => {
            const r = only(
                await lookup({
                    jurisdiction: 'duval-fl',
                    lookupBy: 'address',
                    query: '7519 Caravaca Ct, Jacksonville, FL 32244',
                }),
            );

            expect(r.parcel_id).toBe('0991354355R');
            // A geocoding miss and a parcel that is not there are otherwise indistinguishable.
            expect(r.flags).toContain('resolved_via_external_geocoder');
            expect(r.flags).not.toContain('address_resolved_to_building');
        },
        T,
    );

    it(
        'tells the caller that a tower address is a building, and how many units it hid',
        async () => {
            const records = await lookup({
                jurisdiction: 'duval-fl',
                lookupBy: 'address',
                query: '1431 Riverplace Blvd, Jacksonville, FL 32207',
                maxResults: 5,
            });

            expect(records).toHaveLength(5);
            for (const r of records) {
                expect(r.flags).toContain('address_resolved_to_building');
                expect(r.flags).toContain('results_truncated');
                // The unit number is glued into PHY_ADDR1, so an exact match finds nothing
                // while every one of these starts with what the caller typed.
                expect(r.situs_address.full.startsWith('1431 RIVERPLACE BLVD')).toBe(true);
            }
            // Returning one of these silently would be wrong for all the others.
            expect(records[0].result_set.matched).toBeGreaterThan(200);
            expect(records[0].result_set.returned).toBe(5);
        },
        T,
    );

    it(
        'says an address did not geocode rather than reporting a parcel that is not there',
        async () => {
            const r = only(
                await lookup({
                    jurisdiction: 'duval-fl',
                    lookupBy: 'address',
                    query: '1 Nowhere Rd, Jacksonville, FL 32207',
                }),
            );
            expect(['address_not_geocoded', 'address_not_found']).toContain(r.result);
        },
        T,
    );
});

describe('Cook, Socrata open data portal', () => {
    it(
        'joins six datasets into one record and does not report the empty newest year',
        async () => {
            const r = only(await lookup({ jurisdiction: 'cook-il', lookupBy: 'parcel_id', query: '29352110190000' }));

            expect(r.parcel_id).toBe('29352110190000');
            expect(r.situs_address.full).toBe('18102 DORCHESTER AVE');
            expect(r.owner.names[0]).toMatch(/FEIKEMA/);
            // Six requests, so one endpoint would not attribute the answer honestly.
            expect(r.source.endpoints.length).toBe(6);

            // The newest row exists with every value absent because that township has not
            // been mailed yet. Taking it would report "no assessed value" for a normal house.
            expect(r.flags).toContain('values_pending_for_year');
            expect(r.flags).toContain('fell_back_to_prior_year');
            expect(r.valuation.year).toBeLessThan(2026);
            expect(r.valuation.amounts.length).toBeGreaterThan(0);
            expect(r.valuation.amounts.every((a) => a.amount !== null)).toBe(true);
        },
        T,
    );

    it(
        'carries three stages of the same year, because they are three different answers',
        async () => {
            const r = only(await lookup({ jurisdiction: 'cook-il', lookupBy: 'parcel_id', query: '29352110190000' }));

            const stages = new Set(r.valuation.amounts.map((a) => a.stage));
            expect(stages).toEqual(new Set(['mailed', 'certified', 'board_of_review']));
            // The stage belongs to the amount. A single stage on the valuation object
            // could only hold one of the three.
            expect(r.valuation.stage).toBeUndefined();
            expect(r.valuation.headline_stage).toBe('board_of_review');
        },
        T,
    );

    it(
        'says a nine-year-old answer is nine years old rather than answering with confidence',
        async () => {
            const r = only(await lookup({ jurisdiction: 'cook-il', lookupBy: 'parcel_id', query: '17052170040000' }));

            // The historical datasets still answer for this parcel. Only the current-year
            // universe knows it stopped existing.
            expect(r.flags).toContain('parcel_not_current');
            // And this is the parcel the Board of Review cut by 57%, so the three stages
            // of its last year disagree.
            expect(r.flags).toContain('values_under_appeal');

            const totals = r.valuation.amounts.filter((a) => a.basis === 'il_fractional_assessed');
            expect(new Set(totals.map((a) => a.amount)).size).toBeGreaterThan(1);
        },
        T,
    );

    it(
        'reads a condominium from the condominium dataset, which names its columns differently',
        async () => {
            const r = only(await lookup({ jurisdiction: 'cook-il', lookupBy: 'parcel_id', query: '33073170061016' }));

            // char_unit_sf, not char_bldg_sf: the unit, not the building it is in.
            expect(r.characteristics.living_area_sqft).toBeLessThan(r.characteristics.building_area_sqft);
            expect(r.characteristics.bedrooms).toBeGreaterThan(0);
            // char_building_pins is how many units share the building.
            expect(r.characteristics.units).toBeGreaterThan(1);
            expect(r.flags).toContain('co_located_parcels');
        },
        T,
    );

    it(
        'flags every sale the publisher itself excludes, instead of reporting a $1 house',
        async () => {
            const r = only(await lookup({ jurisdiction: 'cook-il', lookupBy: 'parcel_id', query: '29352110190000' }));

            const trustTransfer = r.sales.find((s) => s.price === 1);
            expect(trustTransfer).toBeDefined();
            expect(trustTransfer.nominal).toBe(true);
            expect(trustTransfer.excluded_by_publisher).toBe(true);
            expect(r.flags).toContain('sale_price_nominal');
        },
        T,
    );

    it(
        'answers an address, collapsing the one-row-per-year dataset to one record per parcel',
        async () => {
            const records = await lookup({
                jurisdiction: 'cook-il',
                lookupBy: 'address',
                query: '18102 Dorchester Ave',
            });

            expect(records.length).toBeGreaterThan(0);
            // The addresses dataset holds a row per pin per year; the answer is per pin.
            expect(new Set(records.map((r) => r.parcel_id)).size).toBe(records.length);
            expect(records[0].owner.names[0]).toMatch(/FEIKEMA/);
        },
        T,
    );

    it('refuses a parcel id of the wrong length instead of querying with it', async () => {
        const r = only(await lookup({ jurisdiction: 'cook-il', lookupBy: 'parcel_id', query: '1234' }));
        expect(r.result).toBe('unparsed_parcel_id');
    });
});

describe('routing', () => {
    it('answers for a jurisdiction with no adapter in the shape of a success', async () => {
        const r = only(await lookup({ jurisdiction: 'travis-tx', lookupBy: 'address', query: '1 Congress Ave' }));
        expect(r.result).toBe('unsupported_lookup');
        expect(r.jurisdiction.county).toBe('Travis');
        expect(r.reason).toMatch(/no live endpoint/i);
    });

    it('throws only for a county it has never heard of', async () => {
        await expect(lookup({ jurisdiction: 'kings-ny', lookupBy: 'parcel_id', query: '1' })).rejects.toThrow(
            /unknown jurisdiction/,
        );
    });
});
