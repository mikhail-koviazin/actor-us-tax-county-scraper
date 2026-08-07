import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    AsOfBasis,
    buildFailure,
    buildRefusal,
    FLAG_NOTES,
    Mode,
    Refusal,
    Stage,
    ValuationBasis,
} from '../../src/record.js';
import { assertDeclared } from '../declared-schema.js';

const schema = JSON.parse(readFileSync(new URL('../../.actor/dataset_schema.json', import.meta.url), 'utf8'));
const props = schema.fields.properties;

describe('the declared dataset schema', () => {
    it('is what the generator produces, so the checked-in copy cannot drift', () => {
        // The platform reads the file, not the generator, which is why the file is checked
        // in at all. This is the check that keeps the two the same thing.
        expect(() => execFileSync(process.execPath, ['bin/build-dataset-schema.js', '--check'])).not.toThrow();
    });

    it('publishes every vocabulary, because an agent that has to guess them guesses wrong', () => {
        expect(props.flags.items.enum).toEqual(Object.keys(FLAG_NOTES).sort());
        expect(props.result.enum).toEqual(Object.values(Refusal).sort());
        expect(props.as_of.properties.basis.enum).toEqual(Object.values(AsOfBasis).sort());
        expect(props.source.properties.mode.enum).toEqual(Object.values(Mode).sort());

        const amount = props.valuation.properties.amounts.items.properties;
        expect(amount.basis.enum).toEqual(Object.values(ValuationBasis).sort());
        expect(amount.stage.enum).toEqual(Object.values(Stage).sort());
    });

    it('describes both shapes an item can have, not just the one worth reading', () => {
        // The refusal path drifted for four versions because nothing described it. A schema
        // that covers only the success shape would reintroduce exactly that.
        for (const key of ['parcel_id', 'valuation', 'flags', 'notes']) expect(props[key]).toBeDefined();
        for (const key of ['result', 'requested', 'reason', 'source']) expect(props[key]).toBeDefined();
    });

    it('gives every field a description, since the description is what reaches the agent', () => {
        const undescribed = Object.entries(props)
            .filter(([, v]) => !v.description)
            .map(([k]) => k);
        expect(undescribed).toEqual([]);
    });
});

describe('records validate against the declaration', () => {
    // The platform enforces this on pushData and a mismatch fails the whole run, so the
    // check belongs somewhere cheap. The live suite covers the four answer shapes; these
    // cover the refusals, which have no network in them.
    it('accepts a refusal that reached nobody', () => {
        expect(() =>
            assertDeclared(
                buildRefusal({
                    result: Refusal.INDEX_NOT_BUILT,
                    jurisdiction: 'travis-tx',
                    lookupBy: 'parcel_id',
                    query: '100008',
                    mode: 'bulk_index',
                    reason: 'No index has been built yet.',
                    remedy: 'Run bin/build-travis-index.js.',
                }),
            ),
        ).not.toThrow();
    });

    it('accepts a failure carrying the endpoint and how long the caller waited', () => {
        expect(() =>
            assertDeclared(
                buildFailure({
                    jurisdiction: 'duval-fl',
                    lookupBy: 'address',
                    query: '7519 Caravaca Ct, Jacksonville, FL 32244',
                    mode: 'state_programme',
                    outcome: 'timeout',
                    detail: 'TimeoutError',
                    endpoint: 'https://example.invalid/query',
                    ms: 10007,
                }),
            ),
        ).not.toThrow();
    });

    it('rejects a record the platform would reject, rather than finding out on a run', () => {
        expect(() => assertDeclared({ flags: ['not_a_real_flag'] })).toThrow(/does not match the declared/);
    });
});
