/**
 * Actor entry point.
 *
 * The Actor is called by an AI agent through the Apify MCP Server, not by a human filling
 * a form, so the input schema is a prompt as much as it is a validation rule and every
 * answer, including a refusal, is written to the dataset in a shape the caller can act on.
 */

import { Actor, log } from 'apify';

import { lookup } from './router.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { jurisdiction, lookupBy = 'parcel_id', query, maxResults = 5, allowContestedOwnerNames = false } = input;

if (!jurisdiction || !query) {
    throw new Error('Both "jurisdiction" and "query" are required.');
}

log.info('Looking up parcel', { jurisdiction, lookupBy, query, maxResults, allowContestedOwnerNames });

const started = Date.now();
const records = await lookup({ jurisdiction, lookupBy, query, maxResults, allowContestedOwnerNames });
const elapsed = Date.now() - started;

await Actor.pushData(records);

log.info(`Answered in ${elapsed} ms`, {
    records: records.length,
    results: records.map((r) => r.result ?? 'parcel'),
});

await Actor.exit();
