/**
 * Random-sample sweep over all four counties.
 *
 * Every earlier measurement in the research repo runs through four reference parcels that
 * were picked while the adapters were being written. This samples identifiers out of each
 * county's own list instead, looks every one of them up, and checks the answer against the
 * declared schema and a set of invariants the contract promises.
 *
 *   npm run sweep -- 25          sample size per county
 *   npm run sweep -- 250 --addr  also round-trip each record's own situs address back through
 *                                the address path, which is where the interesting failures are
 *
 * Run it from the repository root: the Travis half reads the local index at .travis-index.
 *
 * Latency is deliberately not reported: this runs on the local path, which the research
 * notes measured at 0.35 to 1.25 s of overhead per request.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { lookup } from '../src/router.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');

const N = Number(process.argv[2] ?? 25);
const batchAt = process.argv.indexOf('--batch');
const BATCH = batchAt >= 0 ? Number(process.argv[batchAt + 1]) : 200;
const CACHE = '.sweep-cache';
const ROUNDTRIP = process.argv.includes('--addr');
const concAt = process.argv.indexOf('--conc');
const onlyAt = process.argv.indexOf('--only');
const ONLY = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;
const outAt = process.argv.indexOf('--out');
const OUT = outAt >= 0 ? process.argv[outAt + 1] : 'sweep-report.json';
/**
 * One at a time by default, and the counties run one after another too.
 *
 * Four in parallel pushed 2,499 San Diego lookups through in twenty minutes, and 144 of them
 * came back as `source_failure`, all of them in the last third of the run. Every one of those
 * identifiers answered on a calm retry, one at a time, so the failures were the sweep's own
 * load and nothing about the county's data. A measurement that changes the thing it measures
 * is not a measurement, and a public county service is not ours to lean on.
 */
const CONCURRENCY = concAt >= 0 ? Number(process.argv[concAt + 1]) : 1;

const schema = JSON.parse(await readFile(new URL('../.actor/dataset_schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema.fields);

const pick = (arr, n) => {
    const copy = [...arr];
    const out = [];
    while (out.length < n && copy.length) out.push(...copy.splice(Math.floor(Math.random() * copy.length), 1));
    return out;
};

let throttled = 0;
const wait = (ms) =>
    new Promise((r) => {
        setTimeout(r, ms);
    });

/**
 * Sampling runs before any lookup does, so one connection timeout here throws away an hour of
 * work that had not started yet. Retried with a backoff, and 429 is waited out rather than
 * hammered: a sweep this size is a guest on somebody else's public service.
 */
const getJson = async (url, { attempts = 4, timeout = 60_000 } = {}) => {
    let last;
    for (let i = 0; i < attempts; i += 1) {
        try {
            const r = await fetch(url, {
                headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(timeout),
            });
            if (r.status === 429) {
                throttled += 1;
                await wait(5_000 * (i + 1));
                continue;
            }
            if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 120)}`);
            return r.json();
        } catch (e) {
            last = e;
            await wait(2_000 * (i + 1));
        }
    }
    throw last;
};

async function pool(items, worker) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            while (i < items.length) {
                const at = i++;
                out[at] = await worker(items[at], at);
            }
        }),
    );
    return out;
}

/* ---------- sampling: identifiers come out of each county's own list ---------- */

async function sampleSanDiego(n) {
    const base = 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/ARCC/apprmapr/MapServer/2/query';
    // Every object id in a layer of 1,089,648 parcels is about 10 MB of JSON, and the local
    // path drags it through a proxy, so this one request gets minutes rather than seconds.
    const ids = await getJson(`${base}?where=1%3D1&returnIdsOnly=true&f=json`, { timeout: 300_000 });
    const chosen = pick(ids.objectIds, n);
    const out = [];
    for (let i = 0; i < chosen.length; i += 50) {
        const batch = chosen.slice(i, i + 50);
        const r = await getJson(
            `${base}?where=${encodeURIComponent(`OBJECTID IN (${batch.join(',')})`)}&outFields=APN&returnGeometry=false&f=json`,
        );
        out.push(...r.features.map((f) => f.attributes.APN).filter(Boolean));
    }
    return out;
}

async function sampleDuval(n) {
    const base =
        'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Parcel_Centroid_Version/FeatureServer/0/query';
    const ids = await getJson(`${base}?where=${encodeURIComponent('CO_NO=26')}&returnIdsOnly=true&f=json`, {
        timeout: 300_000,
    });
    const chosen = pick(ids.objectIds, n);
    const out = [];
    for (let i = 0; i < chosen.length; i += 50) {
        const batch = chosen.slice(i, i + 50);
        const r = await getJson(
            `${base}?where=${encodeURIComponent(`OBJECTID IN (${batch.join(',')})`)}&outFields=PARCEL_ID&returnGeometry=false&f=json`,
        );
        out.push(...r.features.map((f) => f.attributes.PARCEL_ID).filter(Boolean));
    }
    return out;
}

/**
 * Cook has no way to hand over every identifier at once the way an ArcGIS layer does, and
 * asking for one pin per request costs a request per parcel sampled. So: a dozen blocks read
 * from random offsets in pin order, and the sample drawn out of those. Not uniform over the
 * county the way the other three are, and stratified enough that no ward, no township and no
 * range of pins can dominate it, at twelve requests instead of thousands.
 */
async function sampleCook(n) {
    const host = 'https://datacatalog.cookcountyil.gov/resource/pabr-t5kh.json';
    const [{ count }] = await getJson(`${host}?%24select=count(*)%20as%20count`);
    const total = Number(count);
    const blocks = 12;
    const perBlock = Math.ceil(n / blocks);
    const out = [];
    for (let b = 0; b < blocks; b += 1) {
        const offset = Math.floor(Math.random() * Math.max(1, total - perBlock * 4));
        const rows = await getJson(`${host}?%24select=pin&%24order=pin&%24limit=${perBlock * 4}&%24offset=${offset}`, {
            timeout: 120_000,
        });
        out.push(...pick(rows.map((r) => r.pin).filter(Boolean), perBlock));
    }
    return out.slice(0, n);
}

async function sampleTravis(n) {
    const dir = '.travis-index/props';
    const shards = await readdir(dir);
    const out = [];
    while (out.length < n) {
        const shard = shards[Math.floor(Math.random() * shards.length)];
        const lines = (await readFile(join(dir, shard), 'utf8')).split('\n').filter(Boolean);
        const line = lines[Math.floor(Math.random() * lines.length)];
        const id = JSON.parse(line).prop_id;
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

/* ---------- invariants the contract promises ---------- */

const AS_OF = new Set(['assessment_year', 'data_last_edit', 'file_published', 'unknown']);
const FIPS = { 'san-diego-ca': '06073', 'duval-fl': '12031', 'cook-il': '17031', 'travis-tx': '48453' };

function check(jurisdiction, requested, records) {
    const problems = [];
    if (records.length === 0) return [{ kind: 'no_record_for_own_identifier', requested }];

    for (const rec of records) {
        if (rec.result) {
            problems.push({ kind: 'refusal_for_own_identifier', requested, result: rec.result });
            continue;
        }
        if (!validate(rec)) {
            problems.push({
                kind: 'schema_violation',
                requested,
                detail: validate.errors.slice(0, 3).map((e) => `${e.instancePath} ${e.message}`),
            });
        }
        if (rec.jurisdiction?.fips !== FIPS[jurisdiction]) {
            problems.push({ kind: 'wrong_fips', requested, got: rec.jurisdiction?.fips });
        }
        const asked = String(requested).replace(/^0+/, '');
        const got = String(rec.parcel_id ?? '').replace(/^0+/, '');
        if (asked !== got) problems.push({ kind: 'parcel_id_mismatch', requested, got: rec.parcel_id });
        if ((rec.notes?.length ?? 0) !== (rec.flags?.length ?? 0)) {
            problems.push({
                kind: 'flags_notes_length_differ',
                requested,
                flags: rec.flags?.length,
                notes: rec.notes?.length,
            });
        }
        if (!AS_OF.has(rec.as_of?.basis))
            problems.push({ kind: 'as_of_basis_outside_vocabulary', requested, got: rec.as_of?.basis });
        const amounts = rec.valuation?.amounts ?? [];
        if (amounts.length > 0) {
            if (!rec.valuation.headline_basis || !rec.valuation.headline_stage) {
                problems.push({ kind: 'amounts_without_headline', requested });
            } else if (
                !amounts.some(
                    (a) => a.basis === rec.valuation.headline_basis && a.stage === rec.valuation.headline_stage,
                )
            ) {
                problems.push({ kind: 'headline_not_among_amounts', requested });
            }
            // A null amount is declared legal: the schema types it ["number","null"] and San
            // Diego uses it to say a basis exists with no figure behind it on a parcel that is
            // not assessable. Only a missing label or a non-numeric figure is malformed.
            if (amounts.some((a) => !a.basis || !a.stage || !(typeof a.amount === 'number' || a.amount === null))) {
                problems.push({ kind: 'malformed_amount', requested, sample: amounts.slice(0, 2) });
            }
        }
        const live = jurisdiction !== 'travis-tx';
        if (rec.source?.live !== live) problems.push({ kind: 'wrong_source_live', requested, got: rec.source?.live });
        if (live && !(rec.source?.endpoints?.length > 0))
            problems.push({ kind: 'no_endpoints_on_live_answer', requested });
    }
    return problems;
}

/* ---------- the sweep ---------- */

const byKindCount = (problems, kind) => problems.filter((p) => p.kind === kind).length;

const countByKind = (problems) => {
    const out = {};
    for (const p of problems) out[p.kind] = (out[p.kind] ?? 0) + 1;
    return out;
};

const SAMPLERS = {
    'san-diego-ca': sampleSanDiego,
    'duval-fl': sampleDuval,
    'cook-il': sampleCook,
    'travis-tx': sampleTravis,
};

/**
 * The identifier pool is drawn once per county and cached, because San Diego's costs a
 * download of every object id in the layer and there is no reason to pay it twice. Batches
 * then partition that pool, and the report is written after every batch, so a sweep that
 * dies in its fortieth minute still leaves behind everything it had learned by then.
 */
const poolOfIds = async (jurisdiction, sampler, n) => {
    const file = join(CACHE, `${jurisdiction}.json`);
    try {
        const cached = JSON.parse(await readFile(file, 'utf8'));
        if (cached.length >= n) {
            process.stderr.write(`${jurisdiction}: reusing ${cached.length} cached identifiers\n`);
            return pick(cached, n);
        }
    } catch {
        /* no cache yet */
    }
    process.stderr.write(`${jurisdiction}: sampling ${n}\n`);
    const ids = await sampler(n);
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, JSON.stringify(ids));
    return ids;
};

const report = {};

/**
 * One county at a time inside this process, and one request at a time inside a county. Run
 * several counties beside each other by starting a process per county with --only: they are
 * four different services, so nothing about that raises the load any one of them sees.
 */
const selected = Object.entries(SAMPLERS).filter(([j]) => !ONLY || j === ONLY);
if (ONLY && !selected.length) throw new Error(`unknown jurisdiction: ${ONLY}`);

for (const [jurisdiction, sampler] of selected) {
    const ids = await poolOfIds(jurisdiction, sampler, N);
    process.stderr.write(`${jurisdiction}: ${ids.length} identifiers, in batches of ${BATCH}\n`);

    const problems = [];
    // A miss is three different things and only one of them is bad. A refusal says so, a
    // truncated candidate set says so, and an empty list says nothing at all.
    const roundtrip = { attempted: 0, found: 0, refused: 0, truncated: 0, empty: [], wrong_parcel: [], missed: [] };
    let empty = 0;
    let threw = 0;
    // The local path adds 0.35 to 1.25 s per request and its TLS goes through a proxy, so a
    // timeout here is the measuring instrument and not the Actor. Retried, and counted apart.
    let transientTimeouts = 0;

    const lookupOne = async (id) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const recs = await lookup({ jurisdiction, lookupBy: 'parcel_id', query: String(id), maxResults: 5 });
                if (recs[0]?.failure?.outcome === 'timeout' && attempt < 2) {
                    transientTimeouts += 1;
                    continue;
                }
                if (recs.length === 0) empty += 1;
                problems.push(...check(jurisdiction, id, recs));
                return recs[0] ?? null;
            } catch (e) {
                if (attempt === 2) {
                    threw += 1;
                    problems.push({ kind: 'threw', requested: id, detail: e.message });
                    return null;
                }
            }
        }
        return null;
    };

    const records = [];
    for (let start = 0; start < ids.length; start += BATCH) {
        records.push(...(await pool(ids.slice(start, start + BATCH), lookupOne)));
        const done = Math.min(start + BATCH, ids.length);
        report[jurisdiction] = {
            sampled: done,
            of: ids.length,
            answered: done - empty - threw - byKindCount(problems, 'refusal_for_own_identifier'),
            empty,
            threw,
            transient_timeouts_retried: transientTimeouts,
            throttled_429: throttled,
            problems: countByKind(problems),
            examples: problems.slice(0, 8),
        };
        await writeFile(OUT, JSON.stringify(report, null, 2));
        process.stderr.write(
            `${jurisdiction}: ${done}/${ids.length} ${JSON.stringify(countByKind(problems)) || '{}'}\n`,
        );
    }

    if (ROUNDTRIP) {
        // Feed each record's own situs address back through the address path and see whether
        // the parcel it came from returns. Cook costs six requests per candidate parcel, so
        // the cap stays low and a miss under truncation is reported as inconclusive, not a miss.
        const withAddress = pick(
            records.filter((r) => r?.situs_address?.full),
            Math.min(50, records.length),
        );
        await pool(withAddress, async (rec) => {
            const parts = [
                rec.situs_address.full,
                rec.situs_address.city,
                rec.situs_address.state,
                rec.situs_address.zip,
            ]
                .filter(Boolean)
                .join(', ');
            roundtrip.attempted += 1;
            try {
                const back = await lookup({ jurisdiction, lookupBy: 'address', query: parts, maxResults: 10 });
                const asked = String(rec.parcel_id).replace(/^0+/, '');
                const answers = back.filter((b) => !b.result);
                if (answers.some((b) => String(b.parcel_id ?? '').replace(/^0+/, '') === asked)) roundtrip.found += 1;
                else if (back.length && back.every((b) => b.result)) roundtrip.refused += 1;
                else if (answers.some((b) => b.flags?.includes('results_truncated'))) roundtrip.truncated += 1;
                else if (back.length === 0) roundtrip.empty.push({ parcel_id: rec.parcel_id, address: parts });
                else
                    roundtrip.wrong_parcel.push({
                        parcel_id: rec.parcel_id,
                        address: parts,
                        got: answers.map((b) => b.parcel_id),
                    });
            } catch (e) {
                roundtrip.missed.push({ parcel_id: rec.parcel_id, address: parts, error: e.message });
            }
        });
    }

    report[jurisdiction] = {
        ...report[jurisdiction],
        sampled: ids.length,
        of: ids.length,
        answered: ids.length - empty - threw - byKindCount(problems, 'refusal_for_own_identifier'),
        problems: countByKind(problems),
        examples: problems.slice(0, 8),
        roundtrip: ROUNDTRIP ? roundtrip : undefined,
    };
    await writeFile(OUT, JSON.stringify(report, null, 2));
    process.stderr.write(`${jurisdiction}: done ${JSON.stringify(report[jurisdiction].problems)}\n`);
}

await writeFile(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
