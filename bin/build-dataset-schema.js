#!/usr/bin/env node
/**
 * Generate `.actor/dataset_schema.json` from the vocabularies in `src/record.js`.
 *
 * The platform reads a static file at build time, so the file has to be checked in, and a
 * checked-in copy of a vocabulary is a copy that drifts. It is generated here for the same
 * reason the notes are generated from the flags: the second place a vocabulary is written
 * down by hand is the place that goes quietly wrong. `test/unit/dataset-schema.test.js`
 * fails if the checked-in file is not what this script produces.
 *
 * Why it exists at all: the Apify MCP server hands an agent the input schema and, for the
 * output, whatever it can infer from recent runs. Inferred from a sample, this record comes
 * out as a positional list (`flags/0`, `valuation/amounts/2/basis`) that reports the arity
 * of one answer and none of the rules. Declaring it replaces that with the vocabularies.
 *
 * Usage: node bin/build-dataset-schema.js [--check]
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AsOfBasis, FLAG_NOTES, JURISDICTIONS, Mode, Refusal, Stage, ValuationBasis } from '../src/record.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '.actor', 'dataset_schema.json');

const values = (o) => Object.values(o).sort();

/** A nullable scalar. Almost everything here is one: a source that has no answer says null. */
const nullable = (type, description, extra = {}) => ({ type: [type, 'null'], description, ...extra });

const jurisdiction = {
    type: ['object', 'null'],
    description:
        'Which county answered. Present on every record including refusals, because an agent asking several counties at once receives one flat list and a record that cannot name its source is not attributable to anything.',
    properties: {
        county: nullable('string', 'County name.', {
            enum: [...new Set(Object.values(JURISDICTIONS).map((j) => j.county))].sort(),
        }),
        state: nullable('string', 'Two-letter state code.'),
        fips: nullable(
            'string',
            'Five-digit FIPS county code, read from the jurisdiction table rather than typed per adapter.',
        ),
    },
};

const source = {
    type: ['object', 'null'],
    description: 'How the answer was obtained, and from where.',
    properties: {
        mode: nullable('string', 'How this county is reached. The four counties are reached four different ways.', {
            enum: values(Mode),
        }),
        endpoints: {
            type: 'array',
            description:
                'Every URL that contributed to this record, in full. An array and not a single string: one Cook parcel takes six requests across five datasets, and naming one of them would be a false attribution. Empty on a refusal that happened before anything was asked, because "nobody was contacted" is an answer and an absent field is not.',
            items: { type: 'string' },
        },
        retrieved_at: nullable(
            'string',
            'When the request was made, ISO 8601. Absent on answers served from a pre-built index.',
        ),
        live: nullable('boolean', 'Whether a source was contacted for this answer. False means it came from an index.'),
    },
};

const amount = {
    type: 'object',
    description:
        'One money amount, labelled on both axes. Neither label is optional: Florida publishes five figures for one parcel that differ by basis with the stage constant, and Cook publishes three that differ by stage with the basis constant. A number labelled on one axis holds one of those counties and loses the other.',
    properties: {
        basis: nullable(
            'string',
            'What is being valued, and under which state rule. There is no generic "assessed value" because the four counties mean four different things by it.',
            {
                enum: values(ValuationBasis),
            },
        ),
        stage: nullable('string', 'Where in the assessment and appeal cycle the figure was taken.', {
            enum: values(Stage),
        }),
        amount: nullable('number', 'The figure itself, in valuation.currency.'),
    },
};

const characteristics = {
    type: ['object', 'null'],
    description:
        'Physical description of the property. The first six keys are normalized across all counties; the rest are published by some counties and not others, and are absent rather than null where a county does not have them. Null for Travis on every record: the certified export carries no building file in the part the index is built from.',
    properties: {
        living_area_sqft: nullable('number', 'Heated or finished living area in square feet.'),
        lot_acres: nullable('number', 'Lot size in acres, converted where the source publishes square feet.'),
        year_built: nullable('integer', 'Year of construction.'),
        bedrooms: nullable('number', 'Bedroom count.'),
        bathrooms: nullable(
            'number',
            'Bathroom count in halves. Three counties store this three different ways and all of them arrive here as a number of bathrooms.',
        ),
        units: nullable('integer', 'Residential unit count on the parcel.'),
        building_records: nullable(
            'integer',
            'How many improvement records back this block. Above one, the block describes one of them and the multiple_buildings flag is set.',
        ),
        building_area_sqft: nullable('number', 'Total building area, where the source separates it from living area.'),
        rooms: nullable('integer', 'Total room count.'),
        building_type: nullable('string', 'The building type code as the source publishes it.'),
        land_lines: nullable('integer', 'How many land lines the parcel carries in the source.'),
        owner_occupied: nullable('boolean', 'Whether the source marks the parcel owner-occupied.'),
    },
    // Closed for the same reason as a sale, and this is the block where it mattered: Cook
    // published `building_records` here and Duval published `buildings`, one concept under
    // two names, for as long as nothing described the block.
    additionalProperties: false,
};

const sale = {
    type: 'object',
    description: 'One recorded transfer.',
    properties: {
        date: nullable('string', 'Recording date, ISO 8601.'),
        price: nullable(
            'number',
            'Recorded price. Null in Texas, which is a non-disclosure state and does not publish it.',
        ),
        nominal: nullable(
            'boolean',
            'True where the price is a token amount rather than a market price, as trustee and family transfers commonly are.',
        ),
        buyer: nullable('string', 'Grantee, where published.'),
        seller: nullable('string', 'Grantor, where published.'),
        date_precision: nullable(
            'string',
            'How much of the recording date the source actually published. A sale known only to the year is not a sale on the first of January, and this is the field that says which one you have.',
            { enum: ['day', 'month', 'year'] },
        ),
        deed_type: nullable('string', 'The deed type code as the source publishes it.'),
        document: nullable(
            'string',
            'Recorder document number, or book and page joined where the source publishes those instead.',
        ),
        excluded_by_publisher: nullable(
            'boolean',
            'True where the source itself marks the sale as one it excludes from analysis, which is the publisher declining to stand behind it rather than a judgement made here.',
        ),
        multi_parcel_sale: nullable(
            'integer',
            'How many parcels the transaction covered, where the source says the sale was a multi-parcel one. A price on a multi-parcel sale is not the price of this parcel.',
        ),
        vacant_or_improved: nullable(
            'string',
            'The code Florida publishes for whether the parcel was vacant or improved at the time of the sale. A price for vacant land is not comparable to a price for the same parcel with a house on it.',
        ),
        // Named like a boolean and carrying a code, which is the shape of mistake this
        // Actor exists to flatten out of the sources and had quietly reproduced. Declaring
        // it is what surfaced it. Only Florida publishes one, so the field is null in three
        // counties out of four and renaming it is deferred rather than done under a deadline.
        qualified: nullable(
            'string',
            'The qualification code the source publishes for this sale, saying whether it considers the transfer a market sale between unrelated parties. Florida publishes one; the other three counties do not, and the field is null there.',
        ),
    },
    // Closed on purpose. An undeclared sale field is how `document` and `document_number`
    // came to name one concept twice, and closing the object turns the next one into a
    // failing live test instead of a second name nobody reads.
    additionalProperties: false,
};

const schema = {
    actorSpecification: 1,
    fields: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        title: 'US county parcel record',
        description:
            'One item is either an answer about a parcel or a refusal to answer, and the two are the same kind of object on purpose: an agent can act on a structured refusal and can only give up on an error. Tell them apart by `result`, which is present only on a refusal. Both carry `jurisdiction` and `source`, so every item names who answered and what was contacted. A parcel identifier that does not exist in a county is neither: it returns no items, because that is a true answer rather than a failure.',
        properties: {
            // The answer shape.
            parcel_id: nullable(
                'string',
                'The identifier this county uses for the parcel. There is no national format and no per-state one, so this is whatever the county uses.',
            ),
            jurisdiction,
            source,
            result_set: {
                type: ['object', 'null'],
                description:
                    'How much of the match is being shown. One address can name a building rather than a parcel: a Jacksonville condominium tower matched 241 parcels, one per unit. "241 matched, you have 5" is a fact the caller has to have.',
                properties: {
                    matched: nullable('integer', 'How many records the source matched.'),
                    returned: nullable('integer', 'How many are in this response.'),
                    envelope_degrees: nullable(
                        'number',
                        'Half-width of the search box around the geocoded point, in degrees, where the route went through a geocoder.',
                    ),
                },
            },
            as_of: {
                type: ['object', 'null'],
                description:
                    'How old this answer is, and what that date is a date of. The basis matters more than the value: an assessment year and a file publication date are not comparable, and one county publishes no date of any kind.',
                properties: {
                    basis: nullable(
                        'string',
                        'What as_of.value measures. `unknown` is a legitimate value, and it is worse than stale, because stale can at least be flagged as stale.',
                        {
                            enum: values(AsOfBasis),
                        },
                    ),
                    // The type follows the basis and there is no honest way around it: a
                    // year is a number and a publication timestamp is a string. Declaring
                    // one of them and shipping the other is what a schema is for catching,
                    // and this is the field it caught.
                    value: {
                        type: ['string', 'integer', 'null'],
                        description:
                            'The date or year itself, where the source publishes one. An integer year where basis is assessment_year, an ISO 8601 timestamp where it is file_published or data_last_edit, and null where it is unknown.',
                    },
                },
            },
            owner: {
                type: ['object', 'null'],
                description:
                    'Owner of record. Empty names with a flag is not a missing parcel: where a source marks a record confidential, or where two publishers of the same data disagree in public about whether the name may be online, the parcel comes back complete and the name is withheld with the reason attached.',
                properties: {
                    names: {
                        type: 'array',
                        description: 'Owners of record, one entry per name the source publishes.',
                        items: { type: 'string' },
                    },
                    mailing_address: nullable('string', 'Owner mailing address, where published and not withheld.'),
                },
            },
            situs_address: {
                type: ['object', 'null'],
                description: 'The address of the property itself, split the way the sources store it.',
                properties: {
                    full: nullable('string', 'The address as one line.'),
                    number: nullable('string', 'House number.'),
                    street: nullable('string', 'Street name with its suffix, where the source stores them together.'),
                    unit: nullable('string', 'Unit or suite.'),
                    city: nullable('string', 'City or community.'),
                    state: nullable('string', 'Two-letter state code.'),
                    zip: nullable('string', 'Postal code as the source publishes it.'),
                },
            },
            valuation: {
                type: ['object', 'null'],
                description:
                    'What the assessor says the property is worth, as a list rather than a number. Collapsing the list throws away the part that explains it.',
                properties: {
                    year: nullable('integer', 'Assessment year these figures belong to.'),
                    currency: nullable('string', 'Currency of every amount below.'),
                    amounts: {
                        type: 'array',
                        description:
                            'Every figure the source publishes for this parcel and year, each labelled by basis and stage.',
                        items: amount,
                    },
                    headline_basis: nullable('string', 'Which basis to quote when only one figure can be shown.', {
                        enum: values(ValuationBasis),
                    }),
                    headline_stage: nullable('string', 'Which stage to quote when only one figure can be shown.', {
                        enum: values(Stage),
                    }),
                },
            },
            characteristics,
            sales: {
                type: 'array',
                description: 'Recorded transfers, most recent first where the source orders them.',
                items: sale,
            },
            flags: {
                type: 'array',
                description:
                    'Everything the caller has to know to avoid being wrong, from a closed vocabulary. A flag outside this list throws while the record is being built, so a warning cannot be silently absent because of a typo. Each flag generates exactly one sentence, and those sentences arrive in `notes` in the same order.',
                items: { type: 'string', enum: Object.keys(FLAG_NOTES).sort() },
            },
            notes: {
                type: 'array',
                description:
                    'One sentence per flag, generated from the flag rather than written per record, so the two cannot disagree.',
                items: { type: 'string' },
            },

            // The refusal shape.
            result: nullable(
                'string',
                'Present only on a refusal, and it is the reason in one token. Absent on an answer.',
                {
                    enum: values(Refusal),
                },
            ),
            requested: {
                type: ['object', 'null'],
                description:
                    'What was asked, echoed back on a refusal so the caller can tell which of several parallel lookups this one was.',
                properties: {
                    lookup_by: nullable('string', 'Whether the query was a parcel identifier or an address.', {
                        enum: ['parcel_id', 'address'],
                    }),
                    query: nullable('string', 'The query as it was received.'),
                },
            },
            reason: nullable(
                'string',
                'Why the answer could not be given, in a sentence. A refusal with no reason throws while it is being built.',
            ),
            remedy: nullable(
                'string',
                'What the caller can do about it, where there is something to do. This is the field an agent can act on.',
            ),
            failure: {
                type: ['object', 'null'],
                description: 'Present where a source was contacted and the request did not end usefully.',
                properties: {
                    outcome: nullable('string', 'How the request ended.'),
                    detail: nullable('string', 'What the source said, where it said anything.'),
                    elapsed_ms: nullable(
                        'integer',
                        'How long the caller waited before the failure. A deterministic slow failure is worth knowing about: one of these sources takes 56 seconds to report a client error it invented.',
                    ),
                },
            },
            supported_lookups: {
                type: ['array', 'null'],
                description:
                    'On an unsupported lookup, what this county does support. A county that cannot answer this question can usually answer another one.',
                items: { type: 'string' },
            },
            search: {
                type: ['object', 'null'],
                description: 'How far a spatial search got before giving up, where the route ran through a geocoder.',
            },
        },
        additionalProperties: true,
    },
    views: {
        overview: {
            title: 'Overview',
            transformation: {
                fields: [
                    'result',
                    'parcel_id',
                    'jurisdiction',
                    'situs_address',
                    'valuation',
                    'flags',
                    'notes',
                    'reason',
                ],
            },
            display: { component: 'table' },
        },
    },
};

const json = `${JSON.stringify(schema, null, 4)}\n`;

if (process.argv.includes('--check')) {
    const { readFileSync } = await import('node:fs');
    if (readFileSync(OUT, 'utf8') !== json) {
        console.error(`${OUT} is out of date. Run: node bin/build-dataset-schema.js`);
        process.exit(1);
    }
    console.log('dataset schema is up to date');
} else {
    writeFileSync(OUT, json);
    console.log(`wrote ${OUT}`);
}
