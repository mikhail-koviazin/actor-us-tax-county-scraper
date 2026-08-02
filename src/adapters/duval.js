/**
 * Duval County, Florida, through the state programme.
 *
 * The Department of Revenue collects the roll from all 67 county property appraisers and
 * the Florida Geographic Information Office publishes it as one statewide layer, so one
 * integration replaces sixty-seven. The price is that the layer holds 10.8M parcels and
 * only answers questions its indexes like.
 *
 * Measured 2026-08-02:
 *   where=PARCEL_ID='...'                    1570 ms
 *   where=CO_NO=26 + returnIdsOnly           3956 ms, 398,063 ids
 *   where=PHY_ADDR1='...'                    error 400 after 55704 ms
 *   where=PHY_ADDR1='...' + returnIdsOnly    error 400 after 56040 ms
 *   where=PHY_ADDR1='...' + returnCountOnly  error 400 after 56687 ms
 *
 * So the service enumerates every Duval parcel in four seconds and spends fifty-six
 * failing to count the rows matching one address string. The response shape was never
 * the point: one predicate column is indexed and the other is not. Nothing in this file
 * ever puts an address in a where clause.
 */

import { envelope, geocode } from '../geocode.js';
import { getJson, noFeatures, Outcome } from '../http.js';
import { addressKey, joinParts, num, str, zeroAsNull } from '../normalize.js';
import { AsOfBasis, buildFailure, buildRecord, buildRefusal, Mode, Refusal, Stage, ValuationBasis } from '../record.js';

export const id = 'duval-fl';
export const mode = Mode.STATE_PROGRAMME;
export const supports = { parcel_id: true, address: true, live: true };

const LAYER =
    'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Parcel_Centroid_Version/FeatureServer/0/query';

/** Duval's county number inside the statewide layer. */
const CO_NO = 26;

const OUT_FIELDS = [
    'OBJECTID',
    'PARCEL_ID',
    'CO_NO',
    'ASMNT_YR',
    'DOR_UC',
    'OWN_NAME',
    'OWN_ADDR1',
    'OWN_ADDR2',
    'OWN_CITY',
    'OWN_STATE',
    'OWN_ZIPCD',
    'PHY_ADDR1',
    'PHY_ADDR2',
    'PHY_CITY',
    'PHY_ZIPCD',
    'JV',
    'LND_VAL',
    'AV_SD',
    'AV_NSD',
    'TV_SD',
    'TV_NSD',
    'LND_SQFOOT',
    'ACT_YR_BLT',
    'TOT_LVG_AR',
    'NO_BULDNG',
    'NO_RES_UNT',
    'SALE_PRC1',
    'SALE_YR1',
    'SALE_MO1',
    'QUAL_CD1',
    'VI_CD1',
    'OR_BOOK1',
    'OR_PAGE1',
    'SALE_PRC2',
    'SALE_YR2',
    'SALE_MO2',
    'QUAL_CD2',
    'VI_CD2',
    'OR_BOOK2',
    'OR_PAGE2',
].join(',');

/**
 * Envelope widths in degrees, tried in order until something matches.
 *
 * There is no width that is right for both a house and a tower. ±0.0002 found the
 * reference house exactly, one candidate; the same width around a condominium returned
 * zero, and ±0.0005 returned four units of a different building as a clean success.
 * The list stops at ±0.0020 because at that width the reference house's neighbourhood
 * already yields 422 candidates, and a wider box says more about the geocoder's error
 * than about the parcel.
 */
const ENVELOPES = [0.0002, 0.0005, 0.001, 0.002];

const query = (params, opts) =>
    getJson(
        LAYER,
        { f: 'json', returnGeometry: 'false', outFields: OUT_FIELDS, ...params },
        { isEmpty: noFeatures, ...opts },
    );

const sale = (price, year, month, qual, vi, book, page) => {
    // Zero is used as null throughout this layer, and the empty string is a single space.
    const p = zeroAsNull(price);
    const y = zeroAsNull(year);
    const m = str(month);
    if (p === null && y === null) return null;

    // Year and month are separate fields and there is no day anywhere in the layer, so a
    // sale date is a partial date and says which part of it is real.
    let date = null;
    let precision = null;
    if (y !== null) {
        date = String(y);
        precision = 'year';
        if (m !== null) {
            date = `${y}-${String(Number(m)).padStart(2, '0')}`;
            precision = 'month';
        }
    }

    return {
        date,
        date_precision: precision,
        price: p,
        // A token price is nominal whatever the deed says. Anything above that is left
        // undecided rather than guessed: the qualification code is the source's own answer.
        nominal: p !== null && p <= 100 ? true : null,
        buyer: null,
        seller: null,
        deed_type: null,
        vacant_or_improved: str(vi),
        qualified: str(qual),
        document: joinParts(book, page),
    };
};

const toRecord = (a, { endpoint, retrievedAt, extraFlags = [], resultSet = null }) => {
    const flags = [...extraFlags];
    const sales = [
        sale(a.SALE_PRC1, a.SALE_YR1, a.SALE_MO1, a.QUAL_CD1, a.VI_CD1, a.OR_BOOK1, a.OR_PAGE1),
        sale(a.SALE_PRC2, a.SALE_YR2, a.SALE_MO2, a.QUAL_CD2, a.VI_CD2, a.OR_BOOK2, a.OR_PAGE2),
    ].filter(Boolean);
    if (sales.some((s) => s.nominal)) flags.push('sale_price_nominal');
    if (sales.length) flags.push('sale_parties_unknown');

    return buildRecord({
        parcelId: str(a.PARCEL_ID),
        jurisdiction: id,
        source: { mode, endpoints: [endpoint], retrieved_at: retrievedAt, live: true },
        resultSet,
        // The rows are the only honest freshness signal this source has. The AGOL item
        // said 2026-07-08 and the layer said 2026-06-09 while the rows said 2025.
        asOf: { basis: AsOfBasis.ASSESSMENT_YEAR, value: num(a.ASMNT_YR) },
        owner: {
            names: [str(a.OWN_NAME)].filter((n) => n !== null),
            mailing_address: joinParts(a.OWN_ADDR1, a.OWN_ADDR2, a.OWN_CITY, a.OWN_STATE, a.OWN_ZIPCD),
        },
        situsAddress: {
            full: joinParts(a.PHY_ADDR1, a.PHY_ADDR2),
            number: null,
            street: str(a.PHY_ADDR1),
            unit: null, // The unit is glued inside PHY_ADDR1 and the layer does not separate it.
            city: str(a.PHY_CITY),
            state: 'FL',
            // PHY_ZIPCD is a Double, so it arrives as a number and loses any leading zero.
            zip: a.PHY_ZIPCD ? String(Math.trunc(Number(a.PHY_ZIPCD))) : null,
        },
        valuation: {
            year: num(a.ASMNT_YR),
            currency: 'USD',
            // Florida publishes the whole ladder and the gaps between the rungs are the
            // Save Our Homes cap and the exemptions. One number would throw away the
            // part that explains the tax bill. The state receives the roll after the
            // county has certified it, so every rung is at the same stage.
            amounts: [
                { basis: ValuationBasis.FL_JUST_VALUE, stage: Stage.CERTIFIED, amount: num(a.JV) },
                { basis: ValuationBasis.FL_LAND_VALUE, stage: Stage.CERTIFIED, amount: num(a.LND_VAL) },
                { basis: ValuationBasis.FL_ASSESSED_SCHOOL, stage: Stage.CERTIFIED, amount: num(a.AV_SD) },
                { basis: ValuationBasis.FL_ASSESSED_NONSCHOOL, stage: Stage.CERTIFIED, amount: num(a.AV_NSD) },
                { basis: ValuationBasis.FL_TAXABLE_SCHOOL, stage: Stage.CERTIFIED, amount: num(a.TV_SD) },
                { basis: ValuationBasis.FL_TAXABLE_NONSCHOOL, stage: Stage.CERTIFIED, amount: num(a.TV_NSD) },
            ],
            headline_basis: ValuationBasis.FL_JUST_VALUE,
            headline_stage: Stage.CERTIFIED,
        },
        characteristics: {
            // Zero is null here: a house built in year 0 with 0 square feet is a gap.
            living_area_sqft: zeroAsNull(a.TOT_LVG_AR),
            lot_acres: zeroAsNull(a.LND_SQFOOT) === null ? null : zeroAsNull(a.LND_SQFOOT) / 43560,
            year_built: zeroAsNull(a.ACT_YR_BLT),
            bedrooms: null, // Not in the statewide layer.
            bathrooms: null,
            units: zeroAsNull(a.NO_RES_UNT),
            buildings: zeroAsNull(a.NO_BULDNG),
        },
        sales,
        flags,
    });
};

const failure = (lookupBy, q, r) =>
    buildFailure({
        jurisdiction: id,
        lookupBy,
        query: q,
        mode,
        outcome: r.outcome,
        detail: r.detail,
        endpoint: r.url,
        ms: r.ms,
    });

export async function byParcelId(parcelId, { maxResults = 5 } = {}) {
    const pid = String(parcelId).trim().replace(/'/g, "''");
    // PARCEL_ID alone answers in 1.6 s. Adding CO_NO=26 to the same query took 4.6 s and
    // buys nothing: the id is already unique statewide in every sample seen.
    const r = await query({ where: `PARCEL_ID='${pid}'`, resultRecordCount: String(maxResults) });
    const retrievedAt = new Date().toISOString();

    if (r.outcome === Outcome.EMPTY) return [];
    if (!r.ok) return [failure('parcel_id', parcelId, r)];

    return r.body.features
        .filter((f) => Number(f.attributes.CO_NO) === CO_NO)
        .map((f) => toRecord(f.attributes, { endpoint: r.url, retrievedAt }));
}

/**
 * Address lookup: geocode, widen an envelope until something matches, prefix match.
 *
 * The prefix is not a convenience. Florida glues the unit number into PHY_ADDR1, so
 * `1431 RIVERPLACE BLVD 2803` is what the layer holds for an address a caller types as
 * `1431 Riverplace Blvd`. Exact matching returns zero rows while 241 rows start with it.
 */
export async function byAddress(address, { maxResults = 5 } = {}) {
    const geo = await geocode(address);
    if (!geo.ok) {
        return [
            buildRefusal({
                result: geo.outcome === Outcome.EMPTY ? Refusal.ADDRESS_NOT_GEOCODED : Refusal.SOURCE_FAILURE,
                jurisdiction: id,
                lookupBy: 'address',
                query: address,
                mode,
                // The geocoder is not this county's publisher, and it is still where the
                // answer died. Naming it is the whole point of rule 4.
                endpoints: geo.endpoint ? [geo.endpoint] : [],
                failure: { outcome: geo.outcome, detail: geo.detail, elapsed_ms: geo.ms },
                reason: 'This jurisdiction cannot filter on its address column, so an address is only reachable through coordinates. Without a geocoded point there is no route.',
            }),
        ];
    }

    const wanted = addressKey(String(address).split(',')[0]);
    const retrievedAt = new Date().toISOString();
    let lastResult = null;

    for (const half of ENVELOPES) {
        const r = await query({
            geometry: envelope(geo.x, geo.y, half),
            geometryType: 'esriGeometryEnvelope',
            inSR: '4326',
            spatialRel: 'esriSpatialRelIntersects',
            resultRecordCount: '2000',
        });
        lastResult = r;

        if (r.outcome === Outcome.EMPTY) continue;
        if (!r.ok) return [failure('address', address, r)];

        // Contract rule 6: what came back is a candidate set. The spatial hit is thrown
        // away entirely unless the address attributes agree with what the caller asked.
        const matches = r.body.features.filter((f) => addressKey(f.attributes.PHY_ADDR1 ?? '').startsWith(wanted));
        if (matches.length === 0) continue;

        // The direction here is source-starts-with-caller, the opposite of San Diego's.
        // Florida glues the unit number into PHY_ADDR1, so `1431 RIVERPLACE BLVD 2803` is
        // what the layer holds for an address a caller types as `1431 Riverplace Blvd`.
        const flags = ['resolved_via_external_geocoder'];
        if (matches.length > 1) flags.push('address_resolved_to_building');
        if (matches.length > maxResults) flags.push('results_truncated');

        const resultSet = {
            matched: matches.length,
            returned: Math.min(matches.length, maxResults),
            envelope_degrees: half,
        };
        return matches
            .slice(0, maxResults)
            .map((f) => toRecord(f.attributes, { endpoint: r.url, retrievedAt, extraFlags: flags, resultSet }));
    }

    return [
        buildRefusal({
            result: Refusal.ADDRESS_NOT_FOUND,
            jurisdiction: id,
            lookupBy: 'address',
            query: address,
            mode,
            endpoints: lastResult?.url ? [lastResult.url] : [],
            search: {
                geocoded_to: { x: geo.x, y: geo.y, matched: geo.matched },
                envelopes_degrees: ENVELOPES,
            },
            reason: 'The address geocoded, but no parcel within the widest envelope tried carries it. Either the geocoder placed it away from the assessor centroids, or the parcel is not in this county.',
        }),
    ];
}
