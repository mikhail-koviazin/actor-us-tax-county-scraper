#!/usr/bin/env node
/**
 * Local probe. Runs a lookup against the live sources without the Actor runtime, so the
 * adapters can be exercised before anything touches the platform.
 *
 *   node bin/probe.js san-diego-ca parcel_id 3532803300
 *   node bin/probe.js san-diego-ca parcel_id 3532803300 --owner
 *   node bin/probe.js duval-fl address "7519 Caravaca Ct, Jacksonville, FL 32244"
 *   node bin/probe.js --capabilities
 */

import { capabilities, jurisdictions, lookup } from '../src/router.js';

const argv = process.argv.slice(2);

if (argv[0] === '--capabilities') {
    console.log(JSON.stringify(capabilities(), null, 2));
    process.exit(0);
}

// Opt in to owner names a publisher disputes. Off by default here for the same reason it is
// off by default in the input schema.
const allowContestedOwnerNames = argv.includes('--owner');
const args = argv.filter((a) => a !== '--owner');

const [jurisdiction, lookupBy, ...rest] = args;
const query = rest.join(' ');

if (!jurisdiction || !lookupBy || !query) {
    console.error('usage: node bin/probe.js <jurisdiction> <parcel_id|address> <query> [--owner]');
    console.error(`       jurisdictions: ${jurisdictions().join(', ')}`);
    process.exit(2);
}

const started = performance.now();
const records = await lookup({ jurisdiction, lookupBy, query, maxResults: 5, allowContestedOwnerNames });
const ms = Math.round(performance.now() - started);

console.log(JSON.stringify(records, null, 2));
console.error(`\n[${records.length} record(s) in ${ms} ms]`);
