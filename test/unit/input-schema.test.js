import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const schema = JSON.parse(readFileSync(new URL('../../.actor/input_schema.json', import.meta.url), 'utf8'));
const fields = Object.entries(schema.properties);

/**
 * The Apify MCP server delivers each input description to a connected agent truncated to
 * exactly 500 characters, mid-word, with an ellipsis. Nothing errors and nothing warns.
 *
 * Measured on 2026-08-08 against build 0.1.4. Two of the five fields were over: `query` had
 * been over since the first commit and lost its address guidance, and
 * `allowContestedOwnerNames` was cut at "This Actor does not settle which o", losing every
 * word about what the input actually does. The field exists to offer an ethical choice and
 * the description of the choice was the part that did not arrive.
 *
 * So the input schema is a prompt with a budget, and a budget that is not checked is a
 * budget that is exceeded.
 */
const MCP_DESCRIPTION_BUDGET = 500;

describe('the input schema as a prompt', () => {
    it.each(fields)('keeps %s inside what the MCP server delivers', (name, field) => {
        expect(field.description.length).toBeLessThanOrEqual(MCP_DESCRIPTION_BUDGET);
    });

    it('describes every input, because an undescribed field is one the agent guesses at', () => {
        for (const [, field] of fields) expect(field.description?.length ?? 0).toBeGreaterThan(0);
    });

    it('names the flag each owner-name outcome sets, so the caller can branch on it', () => {
        // Both outcomes are flagged and the description has to reach both, which is the
        // whole reason it was rewritten to fit.
        const { description } = schema.properties.allowContestedOwnerNames;
        expect(description).toContain('owner_withheld_by_policy');
        expect(description).toContain('owner_name_contested');
    });
});
