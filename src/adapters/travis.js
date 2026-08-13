/**
 * Travis County, Texas (TCAD). Bulk export only, answered from a pre-built index.
 *
 * This is the county that breaks the shape of the other three. There is no request that
 * answers a question about one parcel: TCAD publishes the whole certified roll as a 531 MB
 * archive and nothing else. So the Actor is not a proxy here, it is an index, and the
 * difference is visible to the caller in every field that says so.
 *
 * Two consequences the contract insists on rather than hides:
 *
 *   - `source.live` is false and `answered_from_index` is always set. An agent budgeting
 *     latency across counties has to know that this one cannot be refreshed on demand.
 *   - `as_of.basis` is `file_published`, the date TCAD posted the roll, not today. The
 *     2026 roll was certified 2026-07-18 and posted four days later, and supplements land
 *     year round, so the index is stale between builds by construction.
 *
 * The index itself is built by `src/travis/build-index.js`. See `bin/build-travis-index.js`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { addressKey } from '../normalize.js';
import { AsOfBasis, buildRecord, buildRefusal, Mode, Refusal, Stage, ValuationBasis } from '../record.js';
import { addressKeyOf, addressShard, propShard } from '../travis/build-index.js';

export const id = 'travis-tx';
export const mode = Mode.BULK_INDEX;
export const supports = { parcel_id: true, address: true, live: false };

/**
 * Deliberately not under `storage/`. `apify run` purges the default local stores on every
 * start, and an index that takes a minute to rebuild has no business living somewhere a
 * routine command empties. On the platform this becomes a named key-value store.
 */
const INDEX_DIR = process.env.TRAVIS_INDEX_DIR ?? '.travis-index';

/** Shards are read once and kept. A shard is roughly 5,000 properties. */
const shardCache = new Map();
let manifestCache;

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const manifest = async () => {
    if (manifestCache === undefined) {
        try {
            manifestCache = await readJson(join(INDEX_DIR, 'manifest.json'));
        } catch {
            manifestCache = null;
        }
    }
    return manifestCache;
};

const propShardRows = async (shard) => {
    const key = `p:${shard}`;
    if (!shardCache.has(key)) {
        let rows = new Map();
        try {
            const text = await readFile(join(INDEX_DIR, 'props', `${shard}.ndjson`), 'utf8');
            rows = new Map(
                text
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => {
                        const p = JSON.parse(line);
                        return [p.prop_id, p];
                    }),
            );
        } catch {
            /* a missing shard is an empty shard */
        }
        shardCache.set(key, rows);
    }
    return shardCache.get(key);
};

const addrShardRows = async (shard) => {
    const key = `a:${shard}`;
    if (!shardCache.has(key)) {
        let rows = {};
        try {
            rows = await readJson(join(INDEX_DIR, 'addr', `${shard}.json`));
        } catch {
            /* a missing shard is an empty shard */
        }
        shardCache.set(key, rows);
    }
    return shardCache.get(key);
};

/**
 * The answer when there is no index yet.
 *
 * This is not an error. The jurisdiction is real, the route is real, and the only thing
 * missing is a build the operator has not run. Saying so is actionable; a 500 is not.
 *
 * The platform image ships no index, so on a run this refusal is the only answer this
 * county gives. The remedy therefore has to start from a repository the caller does not
 * have, not from a shell the caller does not have either.
 */
const noIndex = (lookupBy, query) =>
    buildRefusal({
        result: Refusal.INDEX_NOT_BUILT,
        jurisdiction: id,
        lookupBy,
        query,
        mode,
        reason: 'This county publishes no endpoint that answers a question about one parcel, so answers come from an index built from the certified export. No index has been built yet, and the platform build ships none.',
        remedy: 'Clone the repository and run bin/build-travis-index.js. It fetches 129 MB of a 531 MB archive and takes under a minute.',
    });

const toRecord = (property, index, { extraFlags = [], resultSet = null } = {}) => {
    const flags = ['answered_from_index', ...extraFlags];

    // Supplements land year round and the index is a snapshot of one roll, so anything
    // built from it can be behind the county without any signal that it is.
    flags.push('index_may_lag_supplements');
    // Texas is a non-disclosure state: the export records the deed and not the price.
    flags.push('sale_price_not_published');

    const owners = property.owners ?? [];
    if (owners.length > 1) flags.push('co_owners_present');
    if (owners.some((o) => o.withheld)) flags.push('owner_withheld');

    const values = property.values ?? {};
    const amounts = [
        { basis: ValuationBasis.TX_MARKET, amount: values.market ?? null },
        { basis: ValuationBasis.TX_APPRAISED, amount: values.appraised ?? null },
        // Texas defines assessed as appraised minus the homestead cap, so this number can
        // sit well below market in the same field where Cook puts 10% of market and San
        // Diego puts a Proposition 13 base year value.
        { basis: ValuationBasis.TX_ASSESSED_CAPPED, amount: values.assessed_capped ?? null },
    ].map((a) => ({ ...a, stage: Stage.CERTIFIED }));

    return buildRecord({
        parcelId: property.prop_id,
        jurisdiction: id,
        source: {
            mode,
            endpoints: [index?.archive?.url].filter(Boolean),
            retrieved_at: index?.built_at ?? null,
            // The one county where this is false, and the caller has to see it.
            live: false,
        },
        resultSet,
        asOf: { basis: AsOfBasis.FILE_PUBLISHED, value: index?.archive?.last_modified ?? null },
        owner: {
            names: owners.filter((o) => !o.withheld && o.name).map((o) => o.name),
            mailing_address: owners.find((o) => o.mailing_address)?.mailing_address ?? null,
            co_owner_count: owners.length,
            // Undivided-interest co-owners are tied together by udi_group, and a partial
            // owner holds a share rather than the whole property.
            partial_interests: owners.filter((o) => o.partial).length,
        },
        situsAddress: {
            full: [property.situs?.num, property.situs?.street].filter(Boolean).join(' ') || null,
            number: property.situs?.num ?? null,
            street: property.situs?.street ?? null,
            unit: property.situs?.unit ?? null,
            city: property.situs?.city ?? null,
            state: 'TX',
            zip: property.situs?.zip ?? null,
        },
        valuation: {
            year: property.year ?? null,
            currency: 'USD',
            amounts,
            headline_basis: ValuationBasis.TX_MARKET,
            headline_stage: Stage.CERTIFIED,
        },
        // PROP.TXT carries no floor area, year built or room count. Those live in
        // IMP_INFO.TXT and IMP_DET.TXT, two more files in the same archive that this
        // index does not read yet. Reporting nulls is honest; inventing them is not.
        characteristics: null,
        sales: property.deed?.date
            ? [
                  {
                      date: property.deed.date,
                      date_precision: 'day',
                      // Not "we do not know": Texas does not publish it. The layout spec
                      // has deed_book_id, deed_book_page, deed_dt and deed_num, and no
                      // price field of any kind.
                      price: null,
                      nominal: null,
                      buyer: null,
                      seller: null,
                      deed_type: null,
                      document: property.deed.number ?? null,
                      qualified: null,
                  },
              ]
            : [],
        flags,
    });
};

export async function byParcelId(parcelId, { maxResults = 5 } = {}) {
    const index = await manifest();
    if (!index) return [noIndex('parcel_id', parcelId)];

    // The export writes prop_id zero padded to twelve digits. A caller will type 107422.
    const digits = String(parcelId).replace(/\D/g, '');
    const padded = digits.padStart(12, '0');

    const rows = await propShardRows(propShard(padded));
    const property = rows.get(padded);
    if (!property) return [];

    return [toRecord(property, index)].slice(0, maxResults);
}

export async function byAddress(address, { maxResults = 5 } = {}) {
    const index = await manifest();
    if (!index) return [noIndex('address', address)];

    // Reduce the caller's string the same way the index reduced the export's columns.
    const wanted = addressKeyOf({ situs_num: '', situs_street: addressKey(String(address).split(',')[0]) });
    if (!wanted) return [];

    const shard = await addrShardRows(addressShard(wanted));
    const ids = shard[wanted] ?? [];
    if (ids.length === 0) return [];

    const flags = [];
    if (ids.length > 1) flags.push('address_resolved_to_building');
    if (ids.length > maxResults) flags.push('results_truncated');

    const resultSet = { matched: ids.length, returned: Math.min(ids.length, maxResults) };
    const chosen = ids.slice(0, maxResults);

    const out = [];
    for (const propId of chosen) {
        const rows = await propShardRows(propShard(propId));
        const property = rows.get(propId);
        if (property) out.push(toRecord(property, index, { extraFlags: flags, resultSet }));
    }
    return out;
}

/** Exposed so the router can report whether Travis can currently answer anything. */
export const indexStatus = async () => {
    const index = await manifest();
    return index
        ? {
              built: true,
              built_at: index.built_at,
              roll_published: index.archive?.last_modified,
              properties: index.properties,
              addresses: index.addresses,
          }
        : { built: false };
};

/** Test seam: the shard cache is process-wide and a rebuilt index must not be shadowed. */
export const clearCache = () => {
    shardCache.clear();
    manifestCache = undefined;
};
