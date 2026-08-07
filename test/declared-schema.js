import { readFileSync } from 'node:fs';

import Ajv from 'ajv';

import { lookup as routerLookup } from '../src/router.js';

/**
 * Validate records against `.actor/dataset_schema.json`, the way the platform does.
 *
 * The platform enforces the declared dataset schema on `pushData`: an item that does not
 * match comes back HTTP 400 `schema-validation-error` and the run fails. That is a good
 * thing and it is also a foot-gun, because until now nothing between `buildRecord` and the
 * platform ever compared a real record to the declaration.
 *
 * It cost one failed run to find out. Build 0.1.5 declared `as_of.value` as a string, and
 * Cook puts an integer year in it, so the first agent-driven run under that build died at
 * `pushData` with `/as_of/value must be string,null`. The unit suite passed and so did the
 * live suite: neither of them pushes anything.
 *
 * So every live lookup now goes through here. The live suite is the only place real records
 * from all four counties exist, which makes it the only place this check is worth anything.
 */
const schema = JSON.parse(readFileSync(new URL('../.actor/dataset_schema.json', import.meta.url), 'utf8'));

// strict off: the schema carries `title` and `description` on nodes for the agent reading
// it, which Ajv's strict mode objects to and the platform does not.
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema.fields);

/** Throw the way the platform would, with the same instance paths in the message. */
export const assertDeclared = (item) => {
    if (validate(item)) return item;
    const errors = validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new Error(`record does not match the declared dataset schema: ${errors}`);
};

/** `lookup`, plus the check the platform will apply to whatever comes back. */
export const lookup = async (input) => {
    const records = await routerLookup(input);
    for (const record of records) assertDeclared(record);
    return records;
};
