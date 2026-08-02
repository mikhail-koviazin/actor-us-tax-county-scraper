/**
 * Cook County, Illinois. Socrata open data portal, no token, no registration.
 *
 * Cook has the best open data programme of the four and it still cannot answer "tell me
 * about this parcel" in one request. The parcel is spread across six datasets joined on
 * `pin`, and which sixth one you need depends on what kind of building it is.
 *
 * The datasets are one day old, which is the freshest of the four jurisdictions. That
 * matters for reading the rest of this file: none of the problems below is neglect.
 */

import { getJson, Outcome } from '../http.js';
import { addressKey, num, str, zeroAsNull } from '../normalize.js';
import { AsOfBasis, buildFailure, buildRecord, Mode, Stage, ValuationBasis } from '../record.js';

export const id = 'cook-il';
export const mode = Mode.OPEN_DATA_PORTAL;
export const supports = { parcel_id: true, address: true, live: true };

const HOST = 'https://datacatalog.cookcountyil.gov/resource';

const DATASETS = {
    /** Current year only. The multi-year universe exists too and is the wrong one here. */
    universe: 'pabr-t5kh',
    values: 'uzyt-m557',
    addresses: '3723-97qp',
    sales: 'wvhk-k5uv',
    /** Single and multi-family improvement characteristics. */
    charHouse: 'x54s-btds',
    /** Residential condominium unit characteristics. Different dataset, different names. */
    charCondo: '3r7i-mrz4',
};

const url = (key) => `${HOST}/${DATASETS[key]}.json`;

const soql = (key, params, opts = {}) =>
    getJson(url(key), params, {
        // Socrata answers a point lookup on an indexed column in 1 to 3 s and never
        // answers an unauthenticated aggregate at all, so nothing here aggregates.
        isEmpty: (b) => !Array.isArray(b) || b.length === 0,
        ...opts,
    });

/**
 * `year` is a string, and not a consistently shaped one: the same column holds `'2026.0'`,
 * `'2025'` and `'2024'`. `$order=year DESC` therefore sorts text, which happens to give
 * the right answer for four-digit years and would not survive a three-digit one. Every
 * ordering in this file is redone numerically on the client rather than trusted.
 */
const byYearDesc = (rows) => [...rows].sort((a, b) => (num(b.year) ?? -1) - (num(a.year) ?? -1));

/** Socrata omits a key entirely when the value is missing, so absent and blank are one case. */
const amount = (row, key) => num(row?.[key]);

const STAGES = [
    { prefix: 'mailed', stage: Stage.MAILED },
    { prefix: 'certified', stage: Stage.CERTIFIED },
    { prefix: 'board', stage: Stage.BOARD_OF_REVIEW },
];

const PARTS = [
    { suffix: 'land', basis: ValuationBasis.IL_FRACTIONAL_LAND },
    { suffix: 'bldg', basis: ValuationBasis.IL_FRACTIONAL_BUILDING },
    { suffix: 'tot', basis: ValuationBasis.IL_FRACTIONAL_ASSESSED },
];

const hasAnyAmount = (row) => STAGES.some((s) => PARTS.some((p) => amount(row, `${s.prefix}_${p.suffix}`) !== null));

/**
 * Pick the year to report, and say whether it is the newest one.
 *
 * The newest row is routinely the empty one. A township whose assessment has not been
 * mailed yet still gets a row for the coming year with every value absent, so an agent
 * that sorts by year and takes the first row reports "no assessed value" for an ordinary
 * house. The fallback is not optional, and neither is saying that it happened.
 */
export const chooseValuationYear = (rows) => {
    const sorted = byYearDesc(rows);
    if (sorted.length === 0) return { row: null, newestYear: null, pending: false, fellBack: false };

    const newest = sorted[0];
    const newestYear = num(newest.year);
    if (hasAnyAmount(newest)) return { row: newest, newestYear, pending: false, fellBack: false };

    const withValues = sorted.find(hasAnyAmount) ?? null;
    return { row: withValues, newestYear, pending: true, fellBack: withValues !== null };
};

const buildValuation = (row) => {
    if (!row) return null;
    const amounts = [];
    for (const { prefix, stage } of STAGES) {
        for (const { suffix, basis } of PARTS) {
            const value = amount(row, `${prefix}_${suffix}`);
            if (value !== null) amounts.push({ basis, stage, amount: value });
        }
    }
    return {
        year: num(row.year),
        currency: 'USD',
        // Illinois assessed values are a fraction of market value, 10% for most
        // residential property, so 14550 is not a $14,550 house.
        amounts,
        headline_basis: ValuationBasis.IL_FRACTIONAL_ASSESSED,
        headline_stage: Stage.BOARD_OF_REVIEW,
    };
};

/** Did the assessment move during the appeal cycle for the reported year. */
const movedOnAppeal = (row) => {
    if (!row) return false;
    const totals = STAGES.map((s) => amount(row, `${s.prefix}_tot`)).filter((v) => v !== null);
    return new Set(totals).size > 1;
};

/**
 * Characteristics come from one of two datasets that describe the same things under
 * different names. A house has `char_beds` and `char_fbath`; a condominium unit has
 * `char_bedrooms` and `char_full_baths`, plus a unit area separate from the building area.
 * Both are published by the same assessor.
 */
const buildCharacteristics = (house, condo) => {
    if (condo) {
        const full = num(condo.char_full_baths) ?? 0;
        const half = num(condo.char_half_baths) ?? 0;
        return {
            living_area_sqft: zeroAsNull(condo.char_unit_sf),
            lot_acres: zeroAsNull(condo.char_land_sf) === null ? null : zeroAsNull(condo.char_land_sf) / 43560,
            year_built: zeroAsNull(condo.char_yrblt),
            bedrooms: num(condo.char_bedrooms),
            bathrooms: full + half * 0.5,
            units: num(condo.char_building_pins),
            building_area_sqft: zeroAsNull(condo.char_building_sf),
        };
    }
    if (house) {
        const full = num(house.char_fbath) ?? 0;
        const half = num(house.char_hbath) ?? 0;
        return {
            living_area_sqft: zeroAsNull(house.char_bldg_sf),
            lot_acres: zeroAsNull(house.char_land_sf) === null ? null : zeroAsNull(house.char_land_sf) / 43560,
            year_built: zeroAsNull(house.char_yrblt),
            bedrooms: num(house.char_beds),
            // Full and half baths are separate columns here, where San Diego stores one
            // column multiplied by ten. Same quantity, three conventions across four counties.
            bathrooms: full + half * 0.5,
            units: null,
            rooms: num(house.char_rooms),
            building_type: str(house.char_type_resd),
            // A pin can carry more than one improvement record, one per building. In a
            // sample of 200 current-year rows, 3 did. Reporting the first one as if it
            // were the parcel is how a two-building property becomes a one-bedroom house.
            building_records: num(house.pin_num_cards),
            land_lines: num(house.pin_num_landlines),
        };
    }
    return null;
};

/**
 * A price is not a sale.
 *
 * The dataset ships three filter flags, which is the publisher saying out loud that the
 * raw price is not usable. The reference parcel's only recent transaction is a $1 transfer
 * into a family trust; another is a $4,600 partial taking by the state highway department.
 * Neither is what "what did this house sell for" means.
 */
const buildSale = (row) => {
    const price = num(row.sale_price);
    const flagged =
        row.sale_filter_less_than_10k === true ||
        row.sale_filter_deed_type === true ||
        row.sale_filter_same_sale_within_365 === true;

    return {
        date: (str(row.sale_date) ?? '').slice(0, 10) || null,
        date_precision: row.sale_date ? 'day' : null,
        price,
        nominal: flagged ? true : null,
        // Illinois is a disclosure state, so unlike Texas the parties are published. They
        // are just not always known: this dataset carries sales whose buyer is "UNKNOWN".
        buyer: str(row.buyer_name),
        seller: str(row.seller_name),
        deed_type: str(row.deed_type),
        document: str(row.doc_no),
        qualified: null,
        excluded_by_publisher: flagged,
        multi_parcel_sale: row.is_multisale === true ? num(row.num_parcels_sale) : null,
    };
};

const PIN_LENGTH = 14;
const normalizePin = (input) => String(input ?? '').replace(/\D/g, '');

/** Fire everything at once. Serially this is six requests and roughly nine seconds. */
const fetchAll = async (pin) => {
    const [universe, values, addresses, sales, charHouse, charCondo] = await Promise.all([
        soql('universe', { pin, $limit: '1' }),
        soql('values', { pin, $order: 'year DESC', $limit: '8' }),
        soql('addresses', { pin, $order: 'year DESC', $limit: '1' }),
        soql('sales', { pin, $order: 'sale_date DESC', $limit: '5' }),
        soql('charHouse', { pin, $order: 'year DESC', $limit: '1' }),
        soql('charCondo', { pin, $order: 'year DESC', $limit: '1' }),
    ]);
    return { universe, values, addresses, sales, charHouse, charCondo };
};

const rowsOf = (result) => (result.ok ? result.body : []);
const firstOf = (result) => rowsOf(result)[0] ?? null;

const assemble = (pin, parts, { extraFlags = [], resultSet = null } = {}) => {
    const { universe, values, addresses, sales, charHouse, charCondo } = parts;
    const retrievedAt = new Date().toISOString();
    const flags = [...extraFlags];

    // Anything that neither succeeded nor came back legitimately empty is a hole in the
    // answer, and the answer still goes out with the hole named rather than hidden.
    const failed = Object.entries(parts)
        .filter(([, r]) => !r.ok && r.outcome !== Outcome.EMPTY)
        .map(([name]) => name);
    if (failed.length) flags.push('partial_result');

    const current = firstOf(universe);
    // The historical datasets answer for parcels that stopped existing years ago. Only the
    // current-year universe knows. PIN 17052170040000 still returns an owner and a value
    // for 2016 and has not been a live parcel since.
    if (!current && universe.outcome === Outcome.EMPTY) flags.push('parcel_not_current');

    const address = firstOf(addresses);
    const chosen = chooseValuationYear(rowsOf(values));
    if (chosen.pending) flags.push('values_pending_for_year');
    if (chosen.fellBack) flags.push('fell_back_to_prior_year');
    if (movedOnAppeal(chosen.row)) flags.push('values_under_appeal');

    const house = firstOf(charHouse);
    const condo = firstOf(charCondo);
    if (house && (num(house.pin_num_cards) ?? 1) > 1) flags.push('multiple_buildings');
    if (condo) {
        if (num(condo.char_building_pins) > 1) flags.push('co_located_parcels');
        // A parcel can be a parking space or a piece of common area. It exists, it has a
        // pin, and it is not a home.
        if (condo.is_parking_space === true || condo.is_common_area === true) {
            flags.push('not_assessable');
        }
    }

    const saleRows = rowsOf(sales).map(buildSale);
    if (saleRows.some((s) => s.nominal)) flags.push('sale_price_nominal');

    return buildRecord({
        parcelId: pin,
        jurisdiction: id,
        source: {
            mode,
            // Six requests, so one endpoint string would be a lie. Rule 4 says an answer
            // is attributable; with a join across datasets that means all of them.
            endpoints: Object.values(parts)
                .map((r) => r.url)
                .filter(Boolean),
            retrieved_at: retrievedAt,
            live: true,
        },
        resultSet,
        // Cook is the only one of the four whose metadata freshness claim survives contact
        // with the rows: the catalogue said one day old and the rows agree.
        asOf: { basis: AsOfBasis.ASSESSMENT_YEAR, value: chosen.row ? num(chosen.row.year) : null },
        owner: {
            names: [str(address?.owner_address_name)].filter((n) => n !== null),
            mailing_address: str(address?.mail_address_full),
        },
        situsAddress: {
            full: str(address?.prop_address_full),
            number: null,
            street: str(address?.prop_address_full),
            unit: null,
            city: str(address?.prop_address_city_name),
            state: str(address?.prop_address_state) ?? 'IL',
            zip: str(address?.prop_address_zipcode_1),
        },
        valuation: buildValuation(chosen.row),
        characteristics: buildCharacteristics(house, condo),
        sales: saleRows,
        flags,
    });
};

export async function byParcelId(parcelId, { maxResults = 5 } = {}) {
    const pin = normalizePin(parcelId);
    if (pin.length !== PIN_LENGTH) {
        return [
            {
                result: 'unparsed_parcel_id',
                requested: { lookup_by: 'parcel_id', query: parcelId },
                reason: `Cook parcel identifiers are ${PIN_LENGTH} digits with no separators. Received ${pin.length}.`,
            },
        ];
    }

    const parts = await fetchAll(pin);

    // If every dataset failed for the same reason, there is nothing to assemble and the
    // caller needs the failure, not an empty shell that looks like a parcel.
    const anyUsable = Object.values(parts).some((r) => r.ok || r.outcome === Outcome.EMPTY);
    if (!anyUsable) {
        const worst = Object.values(parts)[0];
        return [
            buildFailure({
                jurisdiction: id,
                lookupBy: 'parcel_id',
                query: parcelId,
                outcome: worst.outcome,
                detail: worst.detail,
                endpoint: worst.url,
                ms: worst.ms,
            }),
        ];
    }

    // Nothing anywhere knows this pin, in any year. That is a clean "not found".
    const known = Object.values(parts).some((r) => r.ok);
    if (!known) return [];

    return [assemble(pin, parts, { resultSet: { matched: 1, returned: 1 } })].slice(0, maxResults);
}

/**
 * Address lookup on the addresses dataset, one request to find the pins and then the
 * normal parcel assembly for each.
 *
 * The dataset is one row per pin per year, so a single parcel is many rows. Without an
 * explicit order the API returns them in an order that is stable, arbitrary, and wrong:
 * three consecutive runs for the reference parcel all returned 2011 first, with an owner
 * who sold the house years ago. The stability is what makes it dangerous.
 */
export async function byAddress(address, { maxResults = 5 } = {}) {
    const wanted = addressKey(String(address).split(',')[0]);

    const r = await soql('addresses', {
        prop_address_full: wanted,
        $order: 'year DESC',
        $limit: '200',
    });

    if (r.outcome === Outcome.EMPTY) return [];
    if (!r.ok) {
        return [
            buildFailure({
                jurisdiction: id,
                lookupBy: 'address',
                query: address,
                outcome: r.outcome,
                detail: r.detail,
                endpoint: r.url,
                ms: r.ms,
            }),
        ];
    }

    // One row per pin per year. Collapse to distinct pins, keeping the newest row for each.
    const newestByPin = new Map();
    for (const row of byYearDesc(r.body)) {
        if (!newestByPin.has(row.pin)) newestByPin.set(row.pin, row);
    }

    const pins = [...newestByPin.keys()];
    const flags = pins.length > 1 ? ['address_resolved_to_building'] : [];
    if (pins.length > maxResults) flags.push('results_truncated');

    const resultSet = { matched: pins.length, returned: Math.min(pins.length, maxResults) };
    const chosen = pins.slice(0, maxResults);

    const assembled = await Promise.all(
        chosen.map(async (pin) => assemble(pin, await fetchAll(pin), { extraFlags: flags, resultSet })),
    );
    return assembled;
}
