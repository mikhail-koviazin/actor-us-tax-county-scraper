import { describe, expect, it } from 'vitest';

import { chooseValuationYear } from '../../src/adapters/cook.js';
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
                currency: 'USD',
                amounts: [{ basis: 'fl_just_value', stage: 'certified', amount: 337293 }],
                headline_basis: 'fl_just_value',
                headline_stage: 'certified',
            },
        });
        expect(record.valuation.total).toBeUndefined();
        expect(record.valuation.amounts[0].basis).toBe('fl_just_value');
        // The stage is a property of the amount, because Cook has three at once.
        expect(record.valuation.amounts[0].stage).toBe('certified');
    });
});

describe('chooseValuationYear (Cook)', () => {
    const row = (year, tot) => ({ year, ...(tot === null ? {} : { mailed_tot: String(tot) }) });

    it('takes the newest year when it carries values', () => {
        const chosen = chooseValuationYear([row('2025', 14550), row('2024', 14000)]);
        expect(chosen.row.year).toBe('2025');
        expect(chosen.pending).toBe(false);
        expect(chosen.fellBack).toBe(false);
    });

    it('falls back past the empty newest row, which is the normal case mid-cycle', () => {
        // Socrata omits the key entirely rather than sending an empty string, and the
        // newest row for a township that has not been mailed yet has no amount keys.
        const chosen = chooseValuationYear([row('2026.0', null), row('2025', 14550)]);
        expect(chosen.row.year).toBe('2025');
        expect(chosen.newestYear).toBe(2026);
        expect(chosen.pending).toBe(true);
        expect(chosen.fellBack).toBe(true);
    });

    it('sorts numerically, not by the text the API returns', () => {
        // "2026.0" and "2025" are both strings in the same column, so a text sort is a
        // coincidence that holds for four-digit years and nothing else.
        const chosen = chooseValuationYear([row('2024', 1), row('2026.0', 3), row('2025', 2)]);
        expect(chosen.row.year).toBe('2026.0');
    });

    it('reports pending with no fallback when no year has values at all', () => {
        const chosen = chooseValuationYear([row('2026.0', null), row('2025', null)]);
        expect(chosen.row).toBeNull();
        expect(chosen.pending).toBe(true);
        expect(chosen.fellBack).toBe(false);
    });

    it('survives an empty dataset', () => {
        expect(chooseValuationYear([])).toEqual({
            row: null,
            newestYear: null,
            pending: false,
            fellBack: false,
        });
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

describe('buildRecord vocabularies beyond the flags', () => {
    // The flags threw from the first commit. basis, stage, as_of.basis and source.mode were
    // used by convention across four adapters and checked nowhere, which is the arrangement
    // that let the refusal path drift. Declaring the dataset schema is what surfaced it.
    it('refuses a valuation basis that is not in the vocabulary', () => {
        expect(() =>
            buildRecord({
                ...minimal,
                valuation: { amounts: [{ basis: 'assessed_value', stage: 'final', amount: 1 }] },
            }),
        ).toThrow(/unknown basis/);
    });

    it('refuses a stage that is not in the vocabulary', () => {
        expect(() =>
            buildRecord({
                ...minimal,
                valuation: { amounts: [{ basis: 'ca_land', stage: 'appealed', amount: 1 }] },
            }),
        ).toThrow(/unknown stage/);
    });

    it('checks the headline labels too, which are the ones a caller quotes', () => {
        expect(() => buildRecord({ ...minimal, valuation: { amounts: [], headline_basis: 'market_value' } })).toThrow(
            /unknown basis/,
        );
    });

    it('refuses an as_of basis and a source mode outside their vocabularies', () => {
        expect(() => buildRecord({ ...minimal, asOf: { basis: 'recently', value: null } })).toThrow(
            /unknown as_of.basis/,
        );
        expect(() => buildRecord({ ...minimal, source: { ...minimal.source, mode: 'scraped' } })).toThrow(
            /unknown source.mode/,
        );
    });

    it('lets a missing label through, because absent is a gap and wrong is a lie', () => {
        const record = buildRecord({
            ...minimal,
            valuation: { amounts: [{ basis: null, stage: null, amount: null }] },
        });
        expect(record.valuation.amounts).toHaveLength(1);
    });
});
