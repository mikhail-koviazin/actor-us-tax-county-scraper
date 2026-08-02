/**
 * The output record, its controlled vocabularies, and the flag to sentence mapping.
 *
 * Contract rule 2 is that uncertainty is machine readable first and prose second, so
 * every flag here has exactly one sentence and nothing is explained only in prose.
 */

/** How the jurisdiction is reached. */
export const Mode = {
    OPEN_DATA_PORTAL: 'open_data_portal',
    ARCGIS_REST: 'arcgis_rest',
    STATE_PROGRAMME: 'state_programme',
    BULK_INDEX: 'bulk_index',
};

/** What `as_of.value` is measuring. Four sources, four different meanings. */
export const AsOfBasis = {
    ASSESSMENT_YEAR: 'assessment_year',
    DATA_LAST_EDIT: 'data_last_edit',
    FILE_PUBLISHED: 'file_published',
    /** San Diego publishes no update timestamp of any kind. This is a real answer. */
    UNKNOWN: 'unknown',
};

/**
 * What a money amount is. There is no `assessed_value`, because the four sources mean
 * four different things by it and an agent asked to compare two of them will do it.
 */
export const ValuationBasis = {
    IL_FRACTIONAL_LAND: 'il_fractional_land',
    IL_FRACTIONAL_BUILDING: 'il_fractional_building',
    IL_FRACTIONAL_ASSESSED: 'il_fractional_assessed',
    CA_PROP13_FACTORED: 'ca_prop13_factored',
    CA_LAND: 'ca_land',
    CA_IMPROVEMENT: 'ca_improvement',
    FL_JUST_VALUE: 'fl_just_value',
    FL_LAND_VALUE: 'fl_land_value',
    FL_ASSESSED_SCHOOL: 'fl_assessed_school',
    FL_ASSESSED_NONSCHOOL: 'fl_assessed_nonschool',
    FL_TAXABLE_SCHOOL: 'fl_taxable_school',
    FL_TAXABLE_NONSCHOOL: 'fl_taxable_nonschool',
    TX_MARKET: 'tx_market',
    TX_APPRAISED: 'tx_appraised',
    TX_ASSESSED_CAPPED: 'tx_assessed_capped',
};

/**
 * Where in the appeal cycle an amount was taken.
 *
 * This belongs to the amount, not to the valuation. Cook publishes mailed, certified and
 * board of review figures for the same parcel in the same year, and they diverge: one
 * parcel in 2016 was mailed at 3041, certified at 3041, and cut to 1303 by the Board of
 * Review. Three correct answers to "what is the assessed value", 57% apart, depending on
 * where you stand. A single `stage` on the valuation object can only hold one of them.
 */
export const Stage = {
    MAILED: 'mailed',
    CERTIFIED: 'certified',
    BOARD_OF_REVIEW: 'board_of_review',
    FINAL: 'final',
    PENDING: 'pending',
    UNKNOWN: 'unknown',
};

/**
 * Flags and the one sentence each of them means.
 *
 * The sentence is generated, never hand written per record, so a flag can never be set
 * without the caller being told what it means in words as well.
 */
export const FLAG_NOTES = {
    parcel_not_current:
        'This parcel is absent from the current assessment year and was answered from historical data. It may no longer exist.',
    values_pending_for_year: 'The current year exists in the source but its values have not been published yet.',
    fell_back_to_prior_year:
        'The most recent assessment year carries no values, so the figures here are from an earlier year. The year they are from is in valuation.year.',
    multiple_buildings:
        'The parcel carries more than one improvement record. The characteristics describe one of them, and the count is in characteristics.building_records.',
    source_freshness_unknown:
        'The source publishes no update timestamp, so the age of this record cannot be established from the source itself.',
    answered_from_index:
        'This jurisdiction publishes no live endpoint. The answer came from a pre-built index, not from a request to the source.',
    index_may_lag_supplements:
        'The index behind this answer may not include the latest supplement file from the source.',
    sale_price_nominal:
        'The recorded sale price is nominal, not a market price. Trustee and family transfers are commonly recorded at a token amount.',
    sale_parties_unknown: 'The source does not publish the parties to this sale.',
    sale_price_not_published:
        'Texas is a non-disclosure state. Sale prices are not in the public record and this source does not carry them.',
    owner_withheld:
        'The parcel exists and the source marks its owner as confidential. The person is withheld, not missing.',
    co_owners_present: 'This parcel has more than one owner of record and the source issues one row per owner.',
    partial_result:
        'Some of the requested sections could not be retrieved. What is present is complete; what is absent is listed.',
    results_truncated: 'The source matched more records than were returned. Raise maxResults to see the rest.',
    address_match_approximate:
        'No candidate carried the address as it was asked for, so nearby parcels are returned instead. These are neighbours, not the address requested.',
    measurement_clamped:
        'At least one measurement sits exactly on the maximum its column can hold and is reported as unknown rather than as a number.',
    address_resolved_to_building:
        'This address identifies a building, not a single parcel. Every unit sharing the address is returned.',
    resolved_via_external_geocoder:
        'The address was resolved through a third-party geocoder before querying the source, so a geocoding miss and a parcel that does not exist are not distinguishable here.',
    co_located_parcels:
        'This parcel shares its geometry with other parcels. Condominiums, possessory interests and mobile homes are stacked on the parent parcel.',
    not_assessable:
        "This record exists for the assessor's own record keeping and carries no assessment. It is not a taxable parcel.",
    values_under_appeal:
        'The mailed, certified and board of review figures for this year are not all the same, so the assessment changed during the appeal cycle. Which one is correct depends on the date the question is being asked about.',
};

export const JURISDICTIONS = {
    'cook-il': { county: 'Cook', state: 'IL', fips: '17031' },
    'san-diego-ca': { county: 'San Diego', state: 'CA', fips: '06073' },
    'duval-fl': { county: 'Duval', state: 'FL', fips: '12031' },
    'travis-tx': { county: 'Travis', state: 'TX', fips: '48453' },
};

/**
 * Build one output record.
 *
 * `valuation.amounts` is a list rather than a `total` field. Florida publishes a ladder
 * (just value, assessed school and non-school, taxable school and non-school) whose gaps
 * are the Save Our Homes cap and the exemptions, and collapsing it into one number throws
 * away the part that explains the tax bill. A list makes contract rule 1, no bare numbers,
 * structural instead of advisory.
 */
export const buildRecord = ({
    parcelId,
    jurisdiction,
    source,
    asOf,
    owner = null,
    situsAddress = null,
    valuation = null,
    characteristics = null,
    sales = [],
    flags = [],
    // How many records the source matched against how many are being returned. "241 units
    // exist and you are seeing 5" is the difference between an agent that knows it has a
    // partial view and one that thinks it has the answer.
    resultSet = null,
}) => {
    const unique = [...new Set(flags)].sort();
    const unknown = unique.filter((f) => !(f in FLAG_NOTES));
    if (unknown.length) throw new Error(`unknown flag(s): ${unknown.join(', ')}`);

    return {
        parcel_id: parcelId,
        jurisdiction: JURISDICTIONS[jurisdiction],
        source,
        result_set: resultSet,
        as_of: asOf,
        owner,
        situs_address: situsAddress,
        valuation,
        characteristics,
        sales,
        flags: unique,
        notes: unique.map((f) => FLAG_NOTES[f]),
    };
};

/**
 * The answer to a question this jurisdiction cannot answer.
 *
 * Contract rule 3: an unsupported lookup is a structured answer listing what the
 * jurisdiction does support, not an error. An agent can act on the former.
 */
export const buildUnsupported = ({ jurisdiction, lookupBy, query, supported, reason }) => ({
    result: 'unsupported_lookup',
    jurisdiction: JURISDICTIONS[jurisdiction],
    requested: { lookup_by: lookupBy, query },
    supported_lookups: supported,
    reason,
});

/** A failure the caller has to see, in the same shape as a success. */
export const buildFailure = ({ jurisdiction, lookupBy, query, outcome, detail, endpoint, ms }) => ({
    result: 'source_failure',
    jurisdiction: JURISDICTIONS[jurisdiction],
    requested: { lookup_by: lookupBy, query },
    failure: { outcome, detail, endpoint, elapsed_ms: ms },
});
