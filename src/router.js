/**
 * Routing.
 *
 * Each jurisdiction registers what it can answer and the router refuses rather than
 * improvises. Contract rule 3: an unsupported lookup is a structured answer naming what
 * the jurisdiction does support, because an agent can act on that and can only give up
 * on an error.
 */

import * as duval from './adapters/duval.js';
import * as sanDiego from './adapters/san-diego.js';
import { buildUnsupported, JURISDICTIONS } from './record.js';

const ADAPTERS = {
    [sanDiego.id]: sanDiego,
    [duval.id]: duval,
};

/** Known to the contract, no adapter yet. Named so the answer is not "no such county". */
const PLANNED = {
    'cook-il': 'Socrata open data portal, four datasets joined on pin.',
    'travis-tx': 'Bulk export only, no live endpoint. Answers require a pre-built index.',
};

export const jurisdictions = () => Object.keys(JURISDICTIONS);

export const capabilities = () =>
    Object.fromEntries(
        Object.entries(JURISDICTIONS).map(([key, place]) => [
            key,
            {
                ...place,
                mode: ADAPTERS[key]?.mode ?? null,
                supports: ADAPTERS[key]?.supports ?? null,
                implemented: Boolean(ADAPTERS[key]),
                planned: PLANNED[key] ?? null,
            },
        ]),
    );

/**
 * Answer one lookup.
 *
 * @param {object} input
 * @param {'cook-il'|'san-diego-ca'|'duval-fl'|'travis-tx'} input.jurisdiction
 * @param {'parcel_id'|'address'} input.lookupBy
 * @param {string} input.query
 * @param {number} [input.maxResults]
 * @returns {Promise<object[]>} always an array, always something the caller can act on
 */
export async function lookup({ jurisdiction, lookupBy, query, maxResults = 5 }) {
    if (!(jurisdiction in JURISDICTIONS)) {
        throw new Error(`unknown jurisdiction "${jurisdiction}", expected one of: ${jurisdictions().join(', ')}`);
    }

    const adapter = ADAPTERS[jurisdiction];
    if (!adapter) {
        return [
            buildUnsupported({
                jurisdiction,
                lookupBy,
                query,
                supported: [],
                reason: `No adapter yet. ${PLANNED[jurisdiction]}`,
            }),
        ];
    }

    const supported = Object.entries(adapter.supports)
        .filter(([k, v]) => v && k !== 'live')
        .map(([k]) => k);

    if (!adapter.supports[lookupBy]) {
        return [
            buildUnsupported({
                jurisdiction,
                lookupBy,
                query,
                supported,
                reason: `This jurisdiction has no route for ${lookupBy}.`,
            }),
        ];
    }

    const opts = { maxResults };
    return lookupBy === 'parcel_id' ? adapter.byParcelId(query, opts) : adapter.byAddress(query, opts);
}
