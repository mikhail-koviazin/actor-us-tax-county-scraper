/**
 * Address parsing and geocoding.
 *
 * Two jurisdictions need an address broken into parts, and neither can do it itself:
 *
 *   - San Diego stores the house number and the street name in separate columns and the
 *     suffix in a third, so `SITUS_STREET='RIDGEGATE ROW'` matches nothing.
 *   - Duval cannot filter on the address column at all (56 seconds, then a 400), so its
 *     only route is through coordinates.
 *
 * The US Census Bureau geocoder is used because it is public domain, needs no key and no
 * terms acceptance, and answered in 1.4 to 3.7 s on 2026-08-02. Anything it touches gets
 * the `resolved_via_external_geocoder` flag: it is not run by the parcel publisher, and a
 * geocoding miss is otherwise indistinguishable from a parcel that does not exist.
 */

import { getJson, Outcome } from './http.js';
import { str } from './normalize.js';

const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

/**
 * Split a free-text address without calling anything.
 *
 * Deliberately conservative: it only claims a split it can defend. San Diego's route
 * needs house number plus street name with the suffix removed, which is what this
 * returns, and it returns null the moment the string does not look like that.
 */
const SUFFIXES = new Set([
    'ST',
    'STREET',
    'AVE',
    'AVENUE',
    'RD',
    'ROAD',
    'DR',
    'DRIVE',
    'LN',
    'LANE',
    'CT',
    'COURT',
    'BLVD',
    'BOULEVARD',
    'WAY',
    'PL',
    'PLACE',
    'TER',
    'TERRACE',
    'CIR',
    'CIRCLE',
    'ROW',
    'PKWY',
    'PARKWAY',
    'TRL',
    'TRAIL',
    'HWY',
    'HIGHWAY',
    'SQ',
    'SQUARE',
    'LOOP',
    'RUN',
    'PATH',
    'WALK',
]);
const DIRECTIONS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

export const splitAddress = (input) => {
    const raw = str(input);
    if (raw === null) return null;

    // Drop anything after a comma: city, state and ZIP are not part of the street columns.
    const streetPart = raw.split(',')[0];
    const tokens = streetPart.toUpperCase().replace(/[.#]/g, ' ').split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return null;

    const number = tokens[0];
    if (!/^\d+$/.test(number)) return null;

    let rest = tokens.slice(1);
    let preDir = null;
    if (rest.length > 1 && DIRECTIONS.has(rest[0])) {
        preDir = rest[0];
        rest = rest.slice(1);
    }

    let suffix = null;
    let postDir = null;
    if (rest.length > 1 && DIRECTIONS.has(rest[rest.length - 1])) {
        postDir = rest[rest.length - 1];
        rest = rest.slice(0, -1);
    }
    if (rest.length > 1 && SUFFIXES.has(rest[rest.length - 1])) {
        suffix = rest[rest.length - 1];
        rest = rest.slice(0, -1);
    }
    if (rest.length === 0) return null;

    return { number, preDir, street: rest.join(' '), suffix, postDir };
};

/**
 * Geocode one address to a WGS84 point.
 *
 * @returns {Promise<{ok: true, x: number, y: number, matched: string, ms: number, endpoint: string}
 *   | {ok: false, outcome: string, detail?: string, ms: number, endpoint: string}>}
 */
export async function geocode(address, { budgetMs = 10_000 } = {}) {
    const result = await getJson(
        CENSUS,
        { address, benchmark: 'Public_AR_Current', format: 'json' },
        {
            budgetMs,
            isEmpty: (b) => (b?.result?.addressMatches ?? []).length === 0,
            // A geocoder legitimately finds nothing for an address that does not exist.
            emptyIsAnAnswer: true,
        },
    );

    const endpoint = result.url ?? CENSUS;
    if (result.outcome === Outcome.EMPTY) {
        return { ok: false, outcome: Outcome.EMPTY, ms: result.ms, endpoint };
    }
    if (!result.ok) {
        return { ok: false, outcome: result.outcome, detail: result.detail, ms: result.ms, endpoint };
    }

    const match = result.body.result.addressMatches[0];
    return {
        ok: true,
        x: match.coordinates.x,
        y: match.coordinates.y,
        matched: match.matchedAddress,
        ms: result.ms,
        endpoint,
    };
}

/** A square envelope of `half` degrees around a point, in the order ArcGIS expects. */
export const envelope = (x, y, half) => [x - half, y - half, x + half, y + half].map((n) => n.toFixed(8)).join(',');
