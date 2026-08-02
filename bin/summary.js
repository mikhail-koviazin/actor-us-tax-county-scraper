#!/usr/bin/env node
/** Compact one-line-per-record view of a probe, for eyeballing many cases at once. */

import { lookup } from '../src/router.js';

const cases = [
    ['san-diego-ca', 'parcel_id', '7763015203', 'information only parcel'],
    ['san-diego-ca', 'parcel_id', '4724003936', 'stacked condo unit'],
    ['san-diego-ca', 'address', '2461 Ridgegate Row, La Jolla, CA 92037', 'detached house'],
    ['san-diego-ca', 'address', '100 Main St', 'ambiguous, two counties apart'],
    ['san-diego-ca', 'address', 'not an address at all', 'unparsable'],
    ['duval-fl', 'parcel_id', '0991354355R', 'reference house'],
    ['duval-fl', 'address', '7519 Caravaca Ct, Jacksonville, FL 32244', 'detached house'],
    ['duval-fl', 'address', '1431 Riverplace Blvd, Jacksonville, FL 32207', 'condo tower, 241 units'],
    ['duval-fl', 'address', '1 Nowhere Rd, Jacksonville, FL 32207', 'address that does not exist'],
    ['cook-il', 'parcel_id', '29352110190000', 'six datasets, newest year is empty'],
    ['cook-il', 'parcel_id', '17052170040000', 'parcel that stopped existing in 2016'],
    ['cook-il', 'parcel_id', '33073170061016', 'condominium, different characteristics dataset'],
    ['cook-il', 'address', '18102 Dorchester Ave', 'address, one row per pin per year'],
    ['travis-tx', 'parcel_id', '100008', 'answered from the index, not from a request'],
    ['travis-tx', 'parcel_id', '988400', 'six undivided-interest owners'],
    ['travis-tx', 'address', '1501 Barton Springs Rd', 'address, 63 parcels share it'],
];

for (const [jurisdiction, lookupBy, query, label] of cases) {
    const t0 = performance.now();
    let records;
    try {
        records = await lookup({ jurisdiction, lookupBy, query, maxResults: 5 });
    } catch (err) {
        console.log(`${jurisdiction} ${lookupBy} "${query}" (${label})\n    THREW ${err.message}\n`);
        continue;
    }
    const ms = Math.round(performance.now() - t0);
    console.log(`${jurisdiction} ${lookupBy} "${query}"  (${label})  [${records.length} rec, ${ms} ms]`);
    for (const r of records.slice(0, 3)) {
        if (r.result) {
            console.log(`    ${r.result}: ${(r.reason ?? r.failure?.detail ?? '').slice(0, 110)}`);
            continue;
        }
        const headline = r.valuation?.amounts?.find(
            (a) => a.basis === r.valuation.headline_basis && a.stage === r.valuation.headline_stage,
        );
        console.log(
            `    ${r.parcel_id}  ${(r.situs_address?.full ?? '').padEnd(30)}  ` +
                `${r.valuation.headline_basis}=${headline?.amount ?? 'null'}  ` +
                `owner=${(r.owner?.names?.[0] ?? '(none)').slice(0, 22)}`,
        );
        console.log(`      flags: ${r.flags.join(', ') || '(none)'}`);
    }
    if (records.length > 3) console.log(`    ... and ${records.length - 3} more`);
    console.log();
}
