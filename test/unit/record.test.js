import { describe, expect, it } from 'vitest';

import { splitAddress } from '../../src/geocode.js';
import { buildRecord, FLAG_NOTES } from '../../src/record.js';

const minimal = {
    parcelId: '3532803300',
    jurisdiction: 'san-diego-ca',
    source: { mode: 'arcgis_rest', endpoint: 'https://example.invalid', retrieved_at: 'now', live: true },
    asOf: { basis: 'unknown', value: null },
};

describe('buildRecord', () => {
    it('refuses a flag that is not in the vocabulary, so a typo cannot ship silently', () => {
        expect(() => buildRecord({ ...minimal, flags: ['probably_stale'] })).toThrow(/unknown flag/);
    });

    it('gives every flag its sentence, so uncertainty is never machine-only', () => {
        const record = buildRecord({ ...minimal, flags: ['not_assessable', 'co_located_parcels'] });
        expect(record.notes).toHaveLength(2);
        expect(record.notes.every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
    });

    it('deduplicates flags rather than repeating a sentence', () => {
        const record = buildRecord({ ...minimal, flags: ['not_assessable', 'not_assessable'] });
        expect(record.flags).toEqual(['not_assessable']);
        expect(record.notes).toHaveLength(1);
    });

    it('carries the jurisdiction identity so two records can be told apart', () => {
        expect(buildRecord(minimal).jurisdiction).toEqual({
            county: 'San Diego',
            state: 'CA',
            fips: '06073',
        });
    });

    it('has no bare total, only labelled amounts', () => {
        const record = buildRecord({
            ...minimal,
            valuation: {
                year: 2025,
                stage: 'certified',
                currency: 'USD',
                amounts: [{ basis: 'fl_just_value', amount: 337293 }],
                headline_basis: 'fl_just_value',
            },
        });
        expect(record.valuation.total).toBeUndefined();
        expect(record.valuation.amounts[0].basis).toBe('fl_just_value');
    });
});

describe('FLAG_NOTES', () => {
    it('has a sentence for every flag and no orphans', () => {
        for (const [flag, note] of Object.entries(FLAG_NOTES)) {
            expect(note, flag).toBeTypeOf('string');
            expect(note.length, flag).toBeGreaterThan(20);
        }
    });
});

describe('splitAddress', () => {
    it('splits into the columns San Diego actually stores', () => {
        expect(splitAddress('2461 Ridgegate Row, La Jolla, CA 92037')).toEqual({
            number: '2461',
            preDir: null,
            street: 'RIDGEGATE',
            suffix: 'ROW',
            postDir: null,
        });
    });

    it('keeps a leading direction out of the street name', () => {
        expect(splitAddress('100 N Main Ave')).toEqual({
            number: '100',
            preDir: 'N',
            street: 'MAIN',
            suffix: 'AVE',
            postDir: null,
        });
    });

    it('keeps a multi-word street name whole', () => {
        expect(splitAddress('4094 Union Square')).toEqual({
            number: '4094',
            preDir: null,
            street: 'UNION',
            suffix: 'SQUARE',
            postDir: null,
        });
    });

    it('refuses rather than guessing when there is no house number', () => {
        expect(splitAddress('Ridgegate Row')).toBeNull();
        expect(splitAddress('not an address at all')).toBeNull();
        expect(splitAddress('')).toBeNull();
    });
});
