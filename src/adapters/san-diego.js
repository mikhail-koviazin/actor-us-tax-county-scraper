/**
 * San Diego County, California. Public ArcGIS REST, no token.
 *
 * One layer answers the whole parcel question in a single request, which makes this the
 * cheapest of the four and the one that hides the most. Everything in here that looks
 * defensive is defending against something measured on 2026-08-02.
 */

import { splitAddress } from '../geocode.js';
import { getJson, noFeatures, Outcome } from '../http.js';
import { addressKey, bathsTimesTen, blank, clampedAt, joinParts, mmddyy, num, paddedInt, str } from '../normalize.js';
import { AsOfBasis, buildFailure, buildRecord, buildRefusal, Mode, Refusal, Stage, ValuationBasis } from '../record.js';

export const id = 'san-diego-ca';
export const mode = Mode.ARCGIS_REST;
export const supports = { parcel_id: true, address: true, live: true };

const LAYER = 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/ARCC/apprmapr/MapServer/2/query';

const OUT_FIELDS = [
    'OBJECTID',
    'APN',
    'APN_8',
    'OWN_NAME1',
    'OWN_NAME2',
    'OWN_NAME3',
    'OWN_ADDR1',
    'OWN_ADDR2',
    'OWN_ADDR3',
    'OWN_ADDR4',
    'OWN_ZIP',
    'SITUS_ADDRESS',
    'SITUS_PRE_DIR',
    'SITUS_STREET',
    'SITUS_SUFFIX',
    'SITUS_POST_DIR',
    'SITUS_FRACTION',
    'SITUS_BUILDING',
    'SITUS_SUITE',
    'SITUS_COMMUNITY',
    'SITUS_ZIP',
    'SITUS_JURIS',
    'ASR_LAND',
    'ASR_IMPR',
    'ASR_TOTAL',
    'ASR_LANDUSE',
    'NUCLEUS_USE_CD',
    'ASR_ZONE',
    'DOCTYPE',
    'DOCNMBR',
    'DOCDATE',
    'ACREAGE',
    'TAXSTAT',
    'OWNEROCC',
    'UNITQTY',
    'TOTAL_LVG_AREA',
    'BEDROOMS',
    'BATHS',
    'YEAR_EFFECTIVE',
    'MULTI',
    'X_COORD',
    'Y_COORD',
].join(',');

/**
 * "Information only" parcels: 48,490 of them, 4.5% of the county.
 *
 * They exist to track ownership history without being assessable, and nothing in the
 * record's shape says so. Their values are 0 rather than null, their TAXSTAT is 'T',
 * identical to a real parcel, and their OWN_NAME1 is the literal string INFORMATION ONLY.
 * The only honest discriminator is the land use code, which is documented in a FAQ and
 * not in the service. Note the type instability: it is queried as '06' and returned as 6.
 */
const NOT_ASSESSABLE_USE_CODES = new Set(['060', '067', '068', '069']);
const isNotAssessable = (a) =>
    paddedInt(a.ASR_LANDUSE) === 6 || NOT_ASSESSABLE_USE_CODES.has(str(a.NUCLEUS_USE_CD) ?? '');

/**
 * Stacked parcels. Condominiums, possessory interests (APN prefix 76, 4,733 parcels) and
 * mobile homes (prefix 77, 33,524) each get a taxable APN on the parent parcel's polygon.
 * One point returned 90 parcels across three street names, as a clean success.
 */
const isCoLocated = (a) => {
    const apn = str(a.APN) ?? '';
    return str(a.MULTI) === 'Y' || apn.startsWith('76') || apn.startsWith('77');
};

const query = (params, opts) =>
    getJson(
        LAYER,
        { f: 'json', returnGeometry: 'false', outFields: OUT_FIELDS, ...params },
        { isEmpty: noFeatures, ...opts },
    );

const toRecord = (attrs, { endpoint, retrievedAt, extraFlags = [] }) => {
    const a = attrs;
    const flags = [
        // The layer exposes editingInfo: null and carries no date field of any kind.
        // Unknown is the honest answer, and it has to be representable.
        'source_freshness_unknown',
        ...extraFlags,
    ];
    if (isNotAssessable(a)) flags.push('not_assessable');
    if (isCoLocated(a)) flags.push('co_located_parcels');

    const ownerNames = [a.OWN_NAME1, a.OWN_NAME2, a.OWN_NAME3]
        .map((n) => str(n))
        .filter((n) => n !== null && n !== 'INFORMATION ONLY');

    const notAssessable = flags.includes('not_assessable');

    // TOTAL_LVG_AREA is five digits wide and saturates at 99999. Reporting the clamp as a
    // number would be reporting a 126-unit building as a 99,999 square foot house.
    const livingArea = clampedAt(a.TOTAL_LVG_AREA, 99999);
    if (livingArea.clamped) flags.push('measurement_clamped');

    const stage = notAssessable ? Stage.UNKNOWN : Stage.FINAL;

    const sales = [];
    const saleDate = mmddyy(a.DOCDATE);
    if (saleDate) {
        sales.push({
            date: saleDate,
            price: null,
            nominal: null,
            buyer: null,
            seller: null,
            deed_type: str(a.DOCTYPE),
            document_number: str(a.DOCNMBR),
            qualified: null,
        });
        // California does not publish the consideration in this layer at all, so the
        // absence of a price here is a property of the source, not of the transaction.
        flags.push('sale_parties_unknown');
    }

    return buildRecord({
        parcelId: str(a.APN),
        jurisdiction: id,
        source: { mode, endpoints: [endpoint], retrieved_at: retrievedAt, live: true },
        asOf: { basis: AsOfBasis.UNKNOWN, value: null },
        owner: {
            names: ownerNames,
            mailing_address: joinParts(a.OWN_ADDR1, a.OWN_ADDR2, a.OWN_ADDR3, a.OWN_ADDR4, a.OWN_ZIP),
        },
        situsAddress: {
            full: joinParts(
                a.SITUS_ADDRESS,
                a.SITUS_FRACTION,
                a.SITUS_PRE_DIR,
                a.SITUS_STREET,
                a.SITUS_SUFFIX,
                a.SITUS_POST_DIR,
            ),
            number: str(a.SITUS_ADDRESS),
            street: joinParts(a.SITUS_PRE_DIR, a.SITUS_STREET, a.SITUS_SUFFIX, a.SITUS_POST_DIR),
            unit: str(a.SITUS_SUITE) ?? str(a.SITUS_BUILDING),
            city: str(a.SITUS_COMMUNITY),
            state: 'CA',
            // SITUS_ZIP arrives as ten spaces when it is missing, which survives a !== '' test.
            zip: str(a.SITUS_ZIP),
        },
        valuation: {
            year: null,
            currency: 'USD',
            // The stage rides on the amount, not on the valuation. California publishes one
            // figure per parcel with no appeal cycle visible in this layer, so every amount
            // here carries the same stage; Cook is where that stops being true.
            amounts: [
                { basis: ValuationBasis.CA_LAND, stage, amount: notAssessable ? null : num(a.ASR_LAND) },
                { basis: ValuationBasis.CA_IMPROVEMENT, stage, amount: notAssessable ? null : num(a.ASR_IMPR) },
                {
                    basis: ValuationBasis.CA_PROP13_FACTORED,
                    stage,
                    amount: notAssessable ? null : num(a.ASR_TOTAL),
                },
            ],
            headline_basis: ValuationBasis.CA_PROP13_FACTORED,
            headline_stage: stage,
        },
        characteristics: {
            living_area_sqft: livingArea.value,
            lot_acres: num(a.ACREAGE),
            year_built: null, // YEAR_EFFECTIVE is a two-digit year and is not the build year.
            bedrooms: paddedInt(a.BEDROOMS),
            // Stored times ten: "025" is 2.5 bathrooms, not 25.
            bathrooms: bathsTimesTen(a.BATHS),
            units: paddedInt(a.UNITQTY),
            owner_occupied: blank(a.OWNEROCC) === null ? null : str(a.OWNEROCC) === 'Y',
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
    const apn = String(parcelId).replace(/[^0-9A-Za-z]/g, '');
    const r = await query({
        where: `APN='${apn.replace(/'/g, "''")}'`,
        resultRecordCount: String(maxResults),
    });
    const retrievedAt = new Date().toISOString();

    if (r.outcome === Outcome.EMPTY) return [];
    if (!r.ok) return [failure('parcel_id', parcelId, r)];

    return r.body.features.map((f) => toRecord(f.attributes, { endpoint: r.url, retrievedAt }));
}

/**
 * Address lookup, one request, no geocoder.
 *
 * ADDRAPN is named address-to-APN and does not return an APN in any of its 16 candidate
 * fields, and its advertised SingleLine parameter answers HTTP 200 with a 400 error body.
 * A plain attribute query on the situs columns answers in about 1.4 s, case insensitively,
 * which is the same query shape that dies after 56 s on Florida's statewide layer.
 */
export async function byAddress(address, { maxResults = 5 } = {}) {
    const parts = splitAddress(address);
    if (!parts) {
        return [
            buildRefusal({
                result: Refusal.UNPARSED_ADDRESS,
                jurisdiction: id,
                lookupBy: 'address',
                query: address,
                mode,
                reason: 'The address could not be split into a house number and a street name, which is what this layer stores in separate columns.',
            }),
        ];
    }

    const escaped = parts.street.replace(/'/g, "''");
    const where = [`SITUS_ADDRESS=${Number(parts.number)}`, `SITUS_STREET='${escaped}'`];
    if (parts.preDir) where.push(`SITUS_PRE_DIR='${parts.preDir}'`);

    const r = await query({
        where: where.join(' AND '),
        // House number plus street name is not unique across 1,089,648 parcels, so this
        // is a candidate set from the start. Ask for one more than we will return, to
        // know whether the caller is seeing everything.
        resultRecordCount: String(maxResults + 1),
    });
    const retrievedAt = new Date().toISOString();

    if (r.outcome === Outcome.EMPTY) return [];
    if (!r.ok) return [failure('address', address, r)];

    const { features } = r.body;
    const truncated = features.length > maxResults;
    const wanted = addressKey(address);

    // Contract rule 6: a hit is a candidate set, never an answer. Filter on the address
    // attributes, and if several survive, say the address named a building.
    //
    // The comparison runs caller-starts-with-source, the opposite direction from Duval,
    // and the asymmetry is not a slip. San Diego keeps the unit in its own SITUS_SUITE
    // column, so the source's assembled street address is a prefix of what a caller types
    // with a city and a ZIP on the end. Florida glues the unit into PHY_ADDR1, so there
    // the source string is the longer one. Neither direction works for both.
    const kept = features.slice(0, maxResults);
    const exact = kept.filter((f) => {
        const a = f.attributes;
        const full = addressKey(
            joinParts(a.SITUS_ADDRESS, a.SITUS_PRE_DIR, a.SITUS_STREET, a.SITUS_SUFFIX, a.SITUS_POST_DIR),
        );
        return full !== null && wanted.startsWith(full);
    });

    const extraFlags = [];
    // Falling back to unfiltered candidates is allowed, but never silently: these are
    // neighbours the query happened to return, not the address that was asked for.
    if (exact.length === 0) extraFlags.push('address_match_approximate');
    const chosen = exact.length > 0 ? exact : kept;

    if (chosen.length > 1) extraFlags.push('address_resolved_to_building');
    if (truncated) extraFlags.push('results_truncated');

    return chosen.map((f) => toRecord(f.attributes, { endpoint: r.url, retrievedAt, extraFlags }));
}
