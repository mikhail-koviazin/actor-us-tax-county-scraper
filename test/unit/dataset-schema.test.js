import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AsOfBasis, FLAG_NOTES, Mode, Refusal, Stage, ValuationBasis } from '../../src/record.js';

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
