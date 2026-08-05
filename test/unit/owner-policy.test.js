import { describe, expect, it } from 'vitest';

import { applyOwnerNamePolicy, buildRecord, buildRefusal, FLAG_NOTES, JURISDICTIONS } from '../../src/record.js';

/**
 * The owner name policy, v0.7.
 *
 * San Diego is the only county here where two publishers of the same parcel data disagree
 * in public about whether the owner name may be online. The Actor does not settle that; it
 * withholds by default and flags both outcomes. These tests pin the behaviour and, more
 * importantly, pin the two ways it could go quietly wrong: a policy field leaking into the
 * output shape, and a flag arriving without its sentence.
 */

const owner = { names: ['CHAN FAMILY TRUST 05-27-11'], mailing_address: '2461 RIDGEGATE ROW SAN DIEGO CA 92037' };

const record = (jurisdiction, flags = []) =>
    buildRecord({
        parcelId: '3532803300',
        jurisdiction,
        source: { mode: 'arcgis_rest', endpoints: ['https://example.invalid'], retrieved_at: 'now', live: true },
        asOf: { basis: 'unknown', value: null },
        owner: { ...owner },
        flags,
    });

describe('applyOwnerNamePolicy', () => {
    it('withholds the name and the mailing address for a contested county by default', () => {
        const r = applyOwnerNamePolicy(record('san-diego-ca'), 'san-diego-ca');

        expect(r.owner.names).toEqual([]);
        // SanGIS's statement covers owner name and address, so the address goes with it.
        expect(r.owner.mailing_address).toBeNull();
        expect(r.flags).toContain('owner_withheld_by_policy');
        expect(r.notes).toContain(FLAG_NOTES.owner_withheld_by_policy);
    });

    it('returns the name when asked, and still says the publication is disputed', () => {
        const r = applyOwnerNamePolicy(record('san-diego-ca'), 'san-diego-ca', { allowContestedOwnerNames: true });

        expect(r.owner).toEqual(owner);
        // Whatever the caller does with the name next happens outside this Actor, so the
        // fact has to travel with the name rather than staying in the input.
        expect(r.flags).toContain('owner_name_contested');
        expect(r.flags).not.toContain('owner_withheld_by_policy');
    });

    it('leaves a county whose owner names are published alone, in both directions', () => {
        const before = record('cook-il');
        expect(applyOwnerNamePolicy(before, 'cook-il')).toEqual(before);
        expect(applyOwnerNamePolicy(before, 'cook-il', { allowContestedOwnerNames: true })).toEqual(before);
    });

    it('keeps notes derived from flags rather than appending one and forgetting the other', () => {
        const r = applyOwnerNamePolicy(
            record('san-diego-ca', ['not_assessable', 'co_located_parcels']),
            'san-diego-ca',
        );

        expect(r.flags).toHaveLength(3);
        expect(r.notes).toHaveLength(3);
        // Regenerated from the flag list, so order and content cannot drift apart.
        expect(r.notes).toEqual(r.flags.map((f) => FLAG_NOTES[f]));
    });

    it('does not withhold from a refusal, which carries no owner to withhold', () => {
        const refusal = buildRefusal({
            result: 'unparsed_address',
            jurisdiction: 'san-diego-ca',
            lookupBy: 'address',
            query: 'not an address at all',
            reason: 'The address could not be split into a house number and a street name.',
        });

        expect(applyOwnerNamePolicy(refusal, 'san-diego-ca')).toEqual(refusal);
    });

    it('is idempotent, so a record cannot be withheld twice into two sentences', () => {
        const once = applyOwnerNamePolicy(record('san-diego-ca'), 'san-diego-ca');
        expect(applyOwnerNamePolicy(once, 'san-diego-ca')).toEqual(once);
    });
});

describe('the jurisdiction table', () => {
    it('gives every county a policy, so a new one cannot inherit silence', () => {
        for (const [key, j] of Object.entries(JURISDICTIONS)) {
            expect(['published', 'contested'], key).toContain(j.owner_name_policy);
        }
    });

    it('keeps policy out of the record, which carries identity only', () => {
        expect(record('san-diego-ca').jurisdiction).toEqual({ county: 'San Diego', state: 'CA', fips: '06073' });
        expect(record('san-diego-ca').jurisdiction.owner_name_policy).toBeUndefined();
    });
});
