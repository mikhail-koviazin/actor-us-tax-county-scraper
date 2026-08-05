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
    owner_withheld_by_policy:
        'The owner name and mailing address are withheld: the county assessor publishes them, and the county GIS agency states that California AB1785 bars publishing them online. Set allowContestedOwnerNames to true to receive them.',
    owner_name_contested:
        "This owner name was returned on request and its publication is disputed: the county GIS agency states that California AB1785 bars publishing it online, while the assessor's own service returns it to anyone who asks.",
};

/**
 * Whether this county's owner name is safe to pass on.
 *
 * `contested` is not a judgement about who is right. SanGIS, the joint city and county GIS
 * agency, states that under California AB1785 it may not publish parcel owner name and
 * address information in any publicly accessible online location. The county assessor's own
 * layer served that field on every parcel queried on 2026-08-02, unauthenticated, over the
 * public internet. Both statements were current, and settling which of them governs is not
 * this Actor's job. Shipping whatever the endpoint hands over is not neutral either: it
 * picks the same side, silently. So the default withholds and says why.
 */
export const OwnerNamePolicy = {
    PUBLISHED: 'published',
    CONTESTED: 'contested',
};

/**
 * The counties, and the two things that are true about each one before any request is made.
 *
 * The owner name policy lives here rather than in the adapter on purpose. The refusal path
 * drifted for four versions because five adapters each built the same thing their own way,
 * and the lesson generalizes: a rule that has to be remembered by whoever writes the next
 * adapter is a rule that will be missed. A county added to this table inherits the question.
 */
export const JURISDICTIONS = {
    'cook-il': { county: 'Cook', state: 'IL', fips: '17031', owner_name_policy: OwnerNamePolicy.PUBLISHED },
    'san-diego-ca': { county: 'San Diego', state: 'CA', fips: '06073', owner_name_policy: OwnerNamePolicy.CONTESTED },
    'duval-fl': { county: 'Duval', state: 'FL', fips: '12031', owner_name_policy: OwnerNamePolicy.PUBLISHED },
    'travis-tx': { county: 'Travis', state: 'TX', fips: '48453', owner_name_policy: OwnerNamePolicy.PUBLISHED },
};

/**
 * The jurisdiction identity as a record carries it: who answered, and nothing else.
 *
 * The table above holds policy alongside identity, and policy has no business in the output
 * shape, so the projection is explicit rather than a spread of whatever the table grows next.
 */
const place = (key) => {
    const j = JURISDICTIONS[key];
    return j ? { county: j.county, state: j.state, fips: j.fips } : null;
};

/**
 * Add a flag to a finished record, keeping notes derived from flags rather than appended.
 *
 * Contract rule 2 holds only if it is impossible to flag something without explaining it,
 * so the sentences are regenerated from the flag list instead of being pushed alongside it.
 */
const withFlag = (record, flag) => {
    const flags = [...new Set([...(record.flags ?? []), flag])].sort();
    return { ...record, flags, notes: flags.map((f) => FLAG_NOTES[f]) };
};

/**
 * Apply the owner name policy to one answer.
 *
 * Runs once in the router over everything an adapter returns, for the reason given on
 * JURISDICTIONS. Both outcomes are flagged: withholding the name is a fact the caller needs,
 * and so is receiving a name whose publication is disputed, because whatever the agent does
 * with that name next happens outside this Actor.
 */
export const applyOwnerNamePolicy = (record, jurisdiction, { allowContestedOwnerNames = false } = {}) => {
    if (JURISDICTIONS[jurisdiction]?.owner_name_policy !== OwnerNamePolicy.CONTESTED) return record;
    // A refusal carries no owner, and a record with no owner block has nothing to withhold.
    if (record.result || !record.owner) return record;

    if (allowContestedOwnerNames) return withFlag(record, 'owner_name_contested');

    return withFlag(
        { ...record, owner: { ...record.owner, names: [], mailing_address: null } },
        'owner_withheld_by_policy',
    );
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
        jurisdiction: place(jurisdiction),
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
 * Why an answer could not be given. A refusal is an answer, so these are as controlled as
 * the flags are: a code outside this list throws when the refusal is built.
 */
export const Refusal = {
    /** The jurisdiction is real, this lookup route is not. */
    UNSUPPORTED_LOOKUP: 'unsupported_lookup',
    /** The query does not have the shape this county's identifiers have. */
    UNPARSED_PARCEL_ID: 'unparsed_parcel_id',
    /** The address could not be split into the columns the source stores. */
    UNPARSED_ADDRESS: 'unparsed_address',
    /** The address route runs through a geocoder and the geocoder returned nothing. */
    ADDRESS_NOT_GEOCODED: 'address_not_geocoded',
    /** The address geocoded and no parcel near the point carries it. */
    ADDRESS_NOT_FOUND: 'address_not_found',
    /** Travis answers from an index and no index has been built. */
    INDEX_NOT_BUILT: 'index_not_built',
    /** The source was asked and did not answer usefully. */
    SOURCE_FAILURE: 'source_failure',
};

const REFUSAL_CODES = new Set(Object.values(Refusal));

/**
 * Build one refusal.
 *
 * Every refusal goes through here for the same reason every success goes through
 * buildRecord: so that the shape cannot drift per adapter. It drifted anyway for four
 * versions, because refusals were object literals written at five call sites, and nobody
 * noticed while the reader of a refusal was the person who had typed the query. An agent
 * fanning out across four counties does not have that context, so the county has to be in
 * the record.
 *
 * `source.endpoints` is the same key a success uses, and it is an array here too, empty
 * when the refusal happened before anything was asked. Contract rule 4 says a record names
 * where it came from; a record that came from nowhere says so, rather than omitting the
 * field and leaving the caller to guess.
 */
export const buildRefusal = ({
    result,
    jurisdiction,
    lookupBy,
    query,
    mode = null,
    endpoints = [],
    reason,
    remedy = null,
    failure = null,
    supportedLookups = null,
    search = null,
}) => {
    if (!REFUSAL_CODES.has(result)) throw new Error(`unknown refusal result: ${result}`);
    if (!reason) throw new Error(`refusal ${result} has no reason`);

    return {
        result,
        jurisdiction: place(jurisdiction),
        requested: { lookup_by: lookupBy, query },
        source: { mode, endpoints },
        reason,
        ...(remedy ? { remedy } : {}),
        ...(failure ? { failure } : {}),
        ...(supportedLookups ? { supported_lookups: supportedLookups } : {}),
        ...(search ? { search } : {}),
    };
};

/**
 * The answer to a question this jurisdiction cannot answer.
 *
 * Contract rule 3: an unsupported lookup is a structured answer listing what the
 * jurisdiction does support, not an error. An agent can act on the former.
 */
export const buildUnsupported = ({ jurisdiction, lookupBy, query, supported, reason, mode = null }) =>
    buildRefusal({
        result: Refusal.UNSUPPORTED_LOOKUP,
        jurisdiction,
        lookupBy,
        query,
        mode,
        reason,
        supportedLookups: supported,
    });

/** A failure the caller has to see, in the same shape as a success. */
export const buildFailure = ({ jurisdiction, lookupBy, query, mode = null, outcome, detail, endpoint, ms, reason }) =>
    buildRefusal({
        result: Refusal.SOURCE_FAILURE,
        jurisdiction,
        lookupBy,
        query,
        mode,
        endpoints: endpoint ? [endpoint] : [],
        reason: reason ?? `The source was asked and the request ended as "${outcome}".`,
        failure: { outcome, detail, elapsed_ms: ms },
    });
