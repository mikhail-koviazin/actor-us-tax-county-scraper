/**
 * Build the Travis lookup index from the certified appraisal export.
 *
 * This is the piece that makes Travis answerable at all. The other three counties are
 * proxied: a question goes out, an answer comes back. Travis publishes no endpoint that
 * answers a question about one parcel, so the Actor materializes an index once and serves
 * from it, and says so in every record it returns.
 *
 * What the build has to get right, none of it optional:
 *
 *   - **One property is several rows.** TCAD writes one record per property per owner,
 *     keyed by prop_id + prop_val_yr + owner_id + sup_num. Counting lines overstates the
 *     parcel count and an index keyed on prop_id alone silently drops co-owners.
 *   - **Supplements are a change log.** sup_num 0 is the certified roll; higher numbers
 *     are supplements carrying sup_action of A, M or D. Concatenating files is wrong:
 *     they have to be applied in order and a D has to actually delete.
 *   - **Confidentiality is in the data.** py_confidential_flag and py_address_suppress_flag
 *     mark owners who must not be exposed. A suppressed record is "exists, withheld",
 *     never "not found", and the index stores the flag rather than the name.
 *
 * Nothing here holds the file in memory. PROP.TXT is 4.9 GB uncompressed, and the first
 * version of this builder did hold the assembled index in a Map and died at 4 GB of heap
 * on roughly 490,000 properties. The data is not large; the JavaScript objects wrapping it
 * are. The fix is not a bigger heap, which an Actor pays for by the megabyte-hour, but
 * exploiting something the export does not document: **records arrive sorted by prop_id**,
 * so every property is complete the moment a different prop_id appears and can be written
 * out and forgotten. The builder verifies that ordering instead of trusting it, because if
 * it were ever false the index would silently gain duplicate properties.
 */

import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { forEachRecord, padded, projector, tcadDate } from './parse.js';
import { openEntry, readCentralDirectory } from './zip-range.js';

export const DEFAULT_ARCHIVE =
    'https://traviscad.org/wp-content/largefiles/2026%20Certified%20Appraisal%20Export%20Supp%200_07182026.zip';

const ENTRY = 'PROP.TXT';

/** Twenty-six of 470 fields. The projection is what makes the build finish. */
const WANTED = [
    'prop_id',
    'prop_type_cd',
    'prop_val_yr',
    'sup_num',
    'sup_action',
    'geo_id',
    'legal_desc',
    'py_owner_id',
    'py_owner_name',
    'partial_owner',
    'udi_group',
    'py_confidential_flag',
    'py_address_suppress_flag',
    'py_addr_line1',
    'py_addr_city',
    'py_addr_state',
    'py_addr_zip',
    'situs_num',
    'situs_street_prefx',
    'situs_street',
    'situs_street_suffix',
    'situs_unit',
    'situs_city',
    'situs_zip',
    'market_value',
    'appraised_val',
    'assessed_val',
    'ten_percent_cap',
    'land_hstd_val',
    'land_non_hstd_val',
    'imprv_hstd_val',
    'imprv_non_hstd_val',
    'ag_use_val',
    'ag_market',
    'deed_dt',
    'deed_num',
];

/** 100 shards keyed on the last two digits of prop_id, which are evenly spread. */
export const propShard = (propId) => String(propId).slice(-2).padStart(2, '0');

/** Normalized situs address, the form both the index and a caller's query are reduced to. */
export const addressKeyOf = (parts) =>
    [parts.situs_num, parts.situs_street_prefx, parts.situs_street, parts.situs_street_suffix]
        .map((p) => (p ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .toUpperCase()
        .replace(/[.,#]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

/** 256 shards for the address index, keyed on a cheap hash so the spread does not depend on street names. */
export const addressShard = (key) => {
    // A cheap rolling hash kept inside 16 bits with a modulo, so the shard a street lands
    // in does not depend on how many streets share a first letter.
    let h = 0;
    for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 65536;
    return (h % 256).toString(16).padStart(2, '0');
};

const ownerFrom = (r) => ({
    owner_id: r.py_owner_id,
    // The name is dropped, not stored and hidden, when the source marks it confidential.
    // An index that keeps a suppressed name is one leak away from publishing it.
    name: r.py_confidential_flag === 'T' ? null : r.py_owner_name || null,
    withheld: r.py_confidential_flag === 'T',
    address_withheld: r.py_address_suppress_flag === 'T',
    mailing_address:
        r.py_address_suppress_flag === 'T'
            ? null
            : [r.py_addr_line1, r.py_addr_city, r.py_addr_state, r.py_addr_zip].filter(Boolean).join(', ') || null,
    partial: r.partial_owner === 'T',
    udi_group: r.udi_group && r.udi_group !== '000000000000' ? r.udi_group : null,
});

const propertyFrom = (r) => ({
    prop_id: r.prop_id,
    prop_type: r.prop_type_cd || null,
    year: padded(r.prop_val_yr),
    sup_num: padded(r.sup_num),
    geo_id: r.geo_id || null,
    legal_desc: r.legal_desc || null,
    situs: {
        num: r.situs_num || null,
        street: [r.situs_street_prefx, r.situs_street, r.situs_street_suffix].filter(Boolean).join(' ') || null,
        unit: r.situs_unit || null,
        city: r.situs_city || null,
        zip: r.situs_zip || null,
    },
    values: {
        market: padded(r.market_value),
        appraised: padded(r.appraised_val),
        // Texas defines assessed as appraised minus the homestead cap, so the two are
        // not interchangeable and neither is "the" assessed value in another state.
        assessed_capped: padded(r.assessed_val),
        homestead_cap: padded(r.ten_percent_cap),
        land_homestead: padded(r.land_hstd_val),
        land_non_homestead: padded(r.land_non_hstd_val),
        improvement_homestead: padded(r.imprv_hstd_val),
        improvement_non_homestead: padded(r.imprv_non_hstd_val),
        ag_use: padded(r.ag_use_val),
        ag_market: padded(r.ag_market),
    },
    // Texas is a non-disclosure state. The deed is recorded and the price is not: the
    // Property file has deed_dt, deed_num, deed_book_id and deed_book_page, and no price
    // field of any kind. This is confirmed from TCAD's own layout spec, not inferred.
    deed: { date: tcadDate(r.deed_dt), number: r.deed_num || null },
    owners: [],
});

/**
 * @param {object} [options]
 * @param {string} [options.archiveUrl]
 * @param {string} [options.outDir]
 * @param {number} [options.limit] stop after this many records, for a smoke build
 * @param {(progress: object) => void} [options.onProgress]
 */
export async function buildIndex({
    archiveUrl = DEFAULT_ARCHIVE,
    outDir = '.travis-index',
    limit = Infinity,
    onProgress = () => {},
} = {}) {
    const startedAt = Date.now();
    const { entries, archive } = await readCentralDirectory(archiveUrl);
    const entry = entries.find((e) => e.name === ENTRY);
    if (!entry) throw new Error(`${ENTRY} is not in the archive; entries: ${entries.map((e) => e.name).join(', ')}`);

    const skipped = entries.filter((e) => e.name !== ENTRY).reduce((sum, e) => sum + e.compressedSize, 0);
    onProgress({
        phase: 'plan',
        archiveBytes: archive.size,
        entryBytes: entry.compressedSize,
        entryUncompressedBytes: entry.uncompressedSize,
        skippedBytes: skipped,
    });

    const { stream } = await openEntry(archiveUrl, entry);
    const project = projector(WANTED);

    const propDir = join(outDir, 'props');
    const addrDir = join(outDir, 'addr');
    await rm(outDir, { recursive: true, force: true });
    await mkdir(propDir, { recursive: true });
    await mkdir(addrDir, { recursive: true });

    /**
     * One buffer per shard, flushed to an append-only NDJSON file when it fills. Bounded
     * memory: 100 shards times the flush threshold, not the whole county.
     */
    const FLUSH_AT = 2000;
    const buffers = new Map();
    const flush = async (shard) => {
        const lines = buffers.get(shard);
        if (!lines?.length) return;
        await appendFile(join(propDir, `${shard}.ndjson`), `${lines.join('\n')}\n`);
        buffers.set(shard, []);
    };
    const emit = async (property) => {
        const shard = propShard(property.prop_id);
        if (!buffers.has(shard)) buffers.set(shard, []);
        const lines = buffers.get(shard);
        lines.push(JSON.stringify(property));
        if (lines.length >= FLUSH_AT) await flush(shard);
    };

    /**
     * The address index stays in memory. It is only strings and short arrays, about half a
     * million keys, which is two orders of magnitude cheaper than the property objects were.
     */
    const addresses = new Map();

    const stats = {
        records: 0,
        properties: 0,
        multiOwner: 0,
        confidential: 0,
        addressSuppressed: 0,
        partialOwners: 0,
        supplemented: 0,
        deleted: 0,
        withoutSitus: 0,
        outOfOrder: 0,
        years: new Map(),
        actions: new Map(),
    };

    const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

    /** The property currently being assembled. Exactly one is ever live. */
    let open = null;
    const pending = [];

    const closeOpen = () => {
        if (!open) return;
        if (open.deleted) {
            open = null;
            return;
        }
        const { property } = open;
        if (property.owners.length > 1) stats.multiOwner += 1;

        const key = addressKeyOf({ situs_num: property.situs.num, situs_street: property.situs.street });
        if (key) {
            if (!addresses.has(key)) addresses.set(key, []);
            addresses.get(key).push(property.prop_id);
        } else {
            stats.withoutSitus += 1;
        }

        stats.properties += 1;
        pending.push(emit(property));
        open = null;
    };

    await forEachRecord(stream, (record, i) => {
        if (i >= limit) return;
        const r = project(record);
        stats.records += 1;
        bump(stats.years, r.prop_val_yr);
        bump(stats.actions, r.sup_action || '(none)');

        const supNum = padded(r.sup_num) ?? 0;
        if (supNum > 0) stats.supplemented += 1;

        if (open && open.property.prop_id !== r.prop_id) {
            // The sort is ascending, so a prop_id lower than the one just closed means the
            // ordering assumption is wrong and this property has already been written out.
            if (r.prop_id < open.property.prop_id) stats.outOfOrder += 1;
            closeOpen();
        }

        if (!open) {
            open = { property: propertyFrom(r), deleted: false };
        } else if (supNum >= (open.property.sup_num ?? 0)) {
            // A later supplement replaces the property's own fields and keeps the owners
            // collected so far: a modify is not a truncate.
            const replacement = propertyFrom(r);
            replacement.owners = open.property.owners;
            open.property = replacement;
        }

        // Supplements are a change log. A delete removes the property outright rather than
        // leaving the certified row standing behind it.
        if (r.sup_action === 'D') {
            stats.deleted += 1;
            open.deleted = true;
            return;
        }

        const owner = ownerFrom(r);
        if (owner.withheld) stats.confidential += 1;
        if (owner.address_withheld) stats.addressSuppressed += 1;
        if (owner.partial) stats.partialOwners += 1;
        if (!open.property.owners.some((o) => o.owner_id === owner.owner_id)) {
            open.property.owners.push(owner);
        }

        if (stats.records % 100000 === 0) onProgress({ phase: 'scan', records: stats.records });
    });

    closeOpen();
    await Promise.all(pending);
    for (const shard of [...buffers.keys()]) await flush(shard);

    onProgress({ phase: 'write', properties: stats.properties, addresses: addresses.size });

    const addrShards = new Map();
    for (const [key, ids] of addresses) {
        const shard = addressShard(key);
        if (!addrShards.has(shard)) addrShards.set(shard, {});
        addrShards.get(shard)[key] = ids;
    }
    for (const [shard, contents] of addrShards) {
        await writeFile(join(addrDir, `${shard}.json`), JSON.stringify(contents));
    }

    const manifest = {
        built_at: new Date().toISOString(),
        build_seconds: Math.round((Date.now() - startedAt) / 1000),
        archive: {
            url: archiveUrl,
            bytes: archive.size,
            last_modified: archive.lastModified,
            etag: archive.etag,
        },
        entry: {
            name: ENTRY,
            compressed_bytes: entry.compressedSize,
            uncompressed_bytes: entry.uncompressedSize,
        },
        bytes_fetched: entry.compressedSize,
        bytes_skipped: skipped,
        records: stats.records,
        properties: stats.properties,
        addresses: addresses.size,
        multi_owner_properties: stats.multiOwner,
        confidential_owner_records: stats.confidential,
        address_suppressed_records: stats.addressSuppressed,
        partial_owner_records: stats.partialOwners,
        supplemented_records: stats.supplemented,
        deleted_records: stats.deleted,
        properties_without_situs: stats.withoutSitus,
        // Non-zero means the file is not sorted by prop_id after all, the streaming
        // assumption is void, and the index has duplicate properties in it.
        out_of_order_prop_ids: stats.outOfOrder,
        years: Object.fromEntries(stats.years),
        sup_actions: Object.fromEntries(stats.actions),
        prop_shards: buffers.size,
        addr_shards: addrShards.size,
    };
    await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);

    onProgress({ phase: 'done', manifest });
    return manifest;
}
