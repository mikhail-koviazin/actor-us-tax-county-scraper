**Ask one question about a US parcel and get one answer**, whichever way the county happens to publish its data. Give this Actor a county and either a parcel identifier or a street address, and it returns one normalized record per parcel: assessed values labelled by what each number actually means, owner of record, situs address, building characteristics, recorded sales, and a closed vocabulary of flags carrying everything a caller has to know to avoid being wrong.

**This is not a scraper. No page is parsed anywhere.** The same question is answered through a public ArcGIS service in one county, a state programme that aggregates all 67 counties in another, an open data portal in a third, and a 531 MB bulk file with no live endpoint at all in a fourth. **The caller should not have to know which.** The Actor is a router and a normalizer.

It runs on the [Apify platform](https://docs.apify.com/platform/actors), so the same lookup is available through the API, on a schedule, through the integrations, and as a tool an AI agent can call over the [Apify MCP Server](https://docs.apify.com/platform/integrations/mcp). The output is a declared dataset schema rather than whatever the last run happened to contain, which is what makes it safe to hand to an agent.

## What data you can get, and for which counties

Four counties, picked so that no two of them could be reached the same way. Four out of 3,144 is a design claim and not a coverage claim.

| County        | Access mode                 | Parcel id          | Address                | Requests per parcel     | Freshness the source publishes         |
| ------------- | --------------------------- | ------------------ | ---------------------- | ----------------------- | -------------------------------------- |
| San Diego, CA | public ArcGIS REST          | yes                | yes                    | 1                       | none of any kind                       |
| Duval, FL     | Florida DOR statewide layer | yes                | geocode, then envelope | 1, plus a geocode       | assessment year 2025                   |
| Cook, IL      | Socrata open data portal    | yes                | yes                    | 6, issued in parallel   | data one day old, serves 2025          |
| Travis, TX    | bulk export, no API at all  | from a local index | from a local index     | 0, nothing is contacted | 2026 certified roll, posted 2026-07-22 |

Every record carries the county that answered, the exact URLs that contributed to it, and what its date is a date of, because `as_of.basis` is a vocabulary with four values and one of them is `unknown`.

Latency, measured on 2026-08-13 from a single datacenter node in Osaka, five rounds per target: San Diego 0.71 to 1.40 s, Cook's six requests in parallel 0.91 to 1.28 s, Duval 0.38 to 14.90 s, Travis about 35 ms from the index. Duval's spread is a CDN edge and not Florida, so a single timing there does not reproduce to better than a factor of forty. A platform run adds roughly 2.1 s of container pull and SDK boot on top, before the first byte leaves for the county.

Travis is the one that breaks the shape, and it breaks it in your favour on freshness: the county publishes no endpoint answering a question about one parcel, only the whole certified roll as a 531 MB archive, so the Actor builds an index from it and serves from that. Answers come back with `source.live` false and the flag `answered_from_index`. **On the platform this index is not shipped, so a Travis lookup returns the structured refusal `index_not_built` with the command to build it.** Locally it works after one command, which reads 129 MB of the 531 MB archive using HTTP Range and takes about 25 seconds.

## How to use the US county property tax lookup

1. Click **Use Actor** to open it in Apify Console. A free account is enough.
2. Pick the **County**. There is no auto-detection, on purpose: resolving a county from an address is a separate problem, and guessing it wrong returns a confident answer about the wrong property.
3. Choose **Look up by**, either a parcel identifier or a street address. It is never inferred from the shape of the string, because some parcel identifiers look like house numbers.
4. Put the identifier or the address into **Parcel identifier or address**. One real example per county is in the field description.
5. Optionally raise **Maximum records** (1 to 50, default 5), and decide about owner names in San Diego (see the FAQ).
6. Click **Start**. One run answers one question, and every answer, including a refusal, is one dataset item.
7. Read the result in the **Output** tab. You can download the dataset in various formats such as JSON, HTML, CSV, or Excel, or fetch it from the API.

### Calling it from an AI agent

The Apify MCP Server exposes the Actor to an agent as a tool carrying the full input schema, enums, defaults and the prefill example included. In Claude Code that is one command:

```bash
claude mcp add --transport http apify "https://mcp.apify.com?tools=actors,mikhail.koviazin/actor-us-tax-county-scraper"
```

The `?tools=` parameter **replaces** the default tool set rather than extending it, so the session gets the `actors` category and this Actor and nothing else. Two things worth knowing: a client reads its configuration at startup, so adding the server does not affect the session that added it, and the tool definition an agent holds is a snapshot, so a redeployed input schema reaches it only after a reconnect.

### Running it locally

```bash
npm install
npm run probe -- san-diego-ca parcel_id 3532803300
npm run probe -- duval-fl address "7519 Caravaca Ct, Jacksonville, FL 32244"
npm run probe -- --capabilities
node bin/build-travis-index.js     # 129 MB fetched, 493,246 properties, about 25 s
```

`npm test` runs 94 unit tests, which need no network. `npm run test:live` runs 26 tests against the real counties, which is how a change on their side becomes visible here.

## Input

| Field                      | Type    | Default        | What it is for                                                                                      |
| -------------------------- | ------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `jurisdiction`             | enum    | `san-diego-ca` | Which county to ask: `san-diego-ca`, `duval-fl`, `cook-il`, `travis-tx`. Required.                  |
| `lookupBy`                 | enum    | `parcel_id`    | `parcel_id` or `address`. Stated explicitly, never inferred.                                        |
| `query`                    | string  | prefilled      | The identifier or the address. No format is enforced, identifiers differ per county. Required.      |
| `maxResults`               | integer | `5`            | 1 to 50. An address is ambiguous by nature, and one condominium address can be hundreds of parcels. |
| `allowContestedOwnerNames` | boolean | `false`        | Return owner names whose publication two publishers disagree about. Affects San Diego only.         |

```json
{
    "jurisdiction": "cook-il",
    "lookupBy": "parcel_id",
    "query": "29352110190000",
    "maxResults": 5,
    "allowContestedOwnerNames": false
}
```

## Output

One item per parcel. Here is a real record, the La Jolla house from parcel 3532803300, abridged: the full endpoint URL and the untouched null fields are cut, nothing else is edited.

```json
{
    "parcel_id": "3532803300",
    "jurisdiction": { "county": "San Diego", "state": "CA", "fips": "06073" },
    "source": {
        "mode": "arcgis_rest",
        "endpoints": ["https://gis-public.sandiegocounty.gov/arcgis/rest/services/ARCC/apprmapr/MapServer/2/query?..."],
        "retrieved_at": "2026-08-13T10:08:54.433Z",
        "live": true
    },
    "as_of": { "basis": "unknown", "value": null },
    "owner": { "names": [], "mailing_address": null },
    "situs_address": {
        "full": "2461 RIDGEGATE ROW",
        "city": "LA JOLLA",
        "state": "CA",
        "zip": "92037-0919"
    },
    "valuation": {
        "currency": "USD",
        "amounts": [
            { "basis": "ca_land", "stage": "final", "amount": 1328217 },
            { "basis": "ca_improvement", "stage": "final", "amount": 694292 },
            { "basis": "ca_prop13_factored", "stage": "final", "amount": 2022509 }
        ],
        "headline_basis": "ca_prop13_factored",
        "headline_stage": "final"
    },
    "characteristics": {
        "living_area_sqft": 3577,
        "bedrooms": 3,
        "bathrooms": 2.5,
        "units": 1,
        "owner_occupied": true
    },
    "sales": [{ "date": "2015-11-03", "price": null, "deed_type": "1", "document": "574671" }],
    "flags": ["owner_withheld_by_policy", "sale_parties_unknown", "source_freshness_unknown"],
    "notes": [
        "The owner name and mailing address are withheld: the county assessor publishes them, and the county GIS agency states that California AB1785 bars publishing them online. Set allowContestedOwnerNames to true to receive them.",
        "The source does not publish the parties to this sale.",
        "The source publishes no update timestamp, so the age of this record cannot be established from the source itself."
    ]
}
```

A refusal is an item too, carrying the same `jurisdiction` and `source` keys as an answer, so a caller fanning out across counties reads the whole result set the same way.

```json
{
    "result": "index_not_built",
    "jurisdiction": { "county": "Travis", "state": "TX", "fips": "48453" },
    "requested": { "lookup_by": "parcel_id", "query": "100008" },
    "source": { "mode": "bulk_index", "endpoints": [] },
    "reason": "This county publishes no endpoint that answers a question about one parcel, so answers come from an index built from the certified export. No index has been built yet.",
    "remedy": "Run bin/build-travis-index.js. It fetches 129 MB of a 531 MB archive and takes under a minute."
}
```

## Output fields

Present on an answer:

| Field             | Type   | What it holds                                                                                |
| ----------------- | ------ | -------------------------------------------------------------------------------------------- |
| `parcel_id`       | string | The identifier this county uses. There is no national format and no per-state one.           |
| `jurisdiction`    | object | County, two-letter state, five-digit FIPS. Present on every record, refusals included.       |
| `source`          | object | `mode`, every URL that contributed, `retrieved_at`, and `live`.                              |
| `result_set`      | object | `matched`, `returned`, `envelope_degrees`. How much of the match you are seeing.             |
| `as_of`           | object | `basis` (`assessment_year`, `data_last_edit`, `file_published`, `unknown`) and `value`.      |
| `owner`           | object | Names as published, and mailing address, subject to the owner policy below.                  |
| `situs_address`   | object | The property address, split the way the sources store it.                                    |
| `valuation`       | object | `amounts`, each labelled by `basis` and `stage`, plus `headline_basis` and `headline_stage`. |
| `characteristics` | object | Living area, lot acres, year built, bedrooms, bathrooms, units, then per-county extras.      |
| `sales`           | array  | Recorded transfers: date and its precision, price, nominal, parties, deed type, document.    |
| `flags`           | array  | A closed vocabulary of 23. A flag outside it throws while the record is being built.         |
| `notes`           | array  | One sentence per flag, generated from the flag, so the two cannot drift apart.               |

Present on a refusal, instead of the answer fields:

| Field               | Type   | What it holds                                                                                         |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `result`            | string | The refusal in one token, from a vocabulary of 7, such as `index_not_built`.                          |
| `requested`         | object | What was asked, echoed back, so one of several parallel lookups can be told from another.             |
| `reason`            | string | Why the answer could not be given, in a sentence. A refusal with no reason throws.                    |
| `remedy`            | string | What to do about it, where there is something to do. This is the field an agent can act on.           |
| `failure`           | object | `outcome`, `detail`, `elapsed_ms`, where a source was contacted and the request did not end usefully. |
| `supported_lookups` | array  | On an unsupported lookup, what this county does support.                                              |
| `search`            | object | How far a spatial search got before giving up.                                                        |

The full declaration, with every vocabulary and a sentence per field, is `.actor/dataset_schema.json` in the repository, and the platform validates every item against it on push.

## How much does one parcel lookup cost?

**The Actor itself is free.** There is no rent and no price per result, so you pay only for Apify platform usage, and the Apify free plan includes monthly platform usage credits with no credit card required.

Measured, not estimated: seven lookups driven by an agent over MCP on 2026-08-02, at the default 4 GB, were billed **$0.001 to $0.003 each**, and total account usage after all seven was **$0.01**. That is about seven parcel lookups per cent.

Most of that is not the county. About 2.1 seconds of every run is container pull and SDK boot, and the Cook lookup inside one such run took 275 milliseconds. An agent measuring "how slow is this county" through a run measures the platform as well.

Building the Travis index is a local step today and costs nothing on the platform. It transfers 129 MB.

## Why the output looks like this

Four decisions drive the shape of every record, and each was forced by something measured.

**No bare numbers.** There is no `assessed_value` field, and no `total`. `valuation.amounts` is a list of `{ basis, stage, amount }`, because "assessed value" means four different things: an Illinois fraction of market value, a California Proposition 13 base year value frozen at the last sale, a Florida ladder whose rungs differ by the Save Our Homes cap, and a Texas appraised value minus a homestead cap. An agent asked to compare two properties will compare them, so the difference has to be structural rather than documented.

`stage` rides on the amount rather than on the valuation because Cook publishes three of them for the same parcel in the same year, and they diverge. One parcel in 2016 was mailed at 3041, certified at 3041, and cut to 1303 by the Board of Review: three correct answers to "what is the assessed value", 57% apart, depending on where in the appeal cycle you stand.

**Uncertainty is machine readable first.** Everything a caller must know to avoid being wrong is a flag from a fixed vocabulary, and `notes` carries the same thing as sentences. A flag outside the vocabulary throws at build time, so a typo cannot ship as a silently absent warning.

**A refusal has the same shape as a success.** An unsupported lookup returns a record listing what the jurisdiction does support. An agent can act on that and can only give up on an error.

**A spatial hit is a candidate set, never an answer.** One point in San Diego returns 90 parcels, because condominiums, possessory interests and mobile homes are stacked on the parent parcel's polygon. The same route in Florida returns the wrong building for a condominium tower, because the geocoder puts the street address 200 m from the assessor's centroids. Both come back as clean successes. So anything reached through geometry is filtered on the address attributes afterwards, and if several survive, the caller is told the address named a building.

## Failure handling

`src/http.js` classifies every response into seven outcomes and retries two of them. The rules are not generic:

- **Parse the body before the status.** Florida returns HTTP 200 carrying `{"error":{"code":400}}` after 56 seconds. `response.ok` is never consulted on its own.
- **Do not match on the error text.** The same layer worded that error two ways on the same day, once in `message` and once in `details`.
- **Empty is sometimes a failure.** San Diego answers a sum that overflows a 32-bit integer with HTTP 200, the output fields declared, and `"features": []`. Nothing in that response is malformed, so the classifier has to be told per call whether empty is a possible correct answer.
- **Reshape rather than retry.** Florida's 56 second failure is deterministic across seven measurements taken on two dates, 55.5 to 58.5 seconds. Retrying it burns minutes. No address ever goes into a `where` clause for that county.

`test/live/known-failures.live.test.js` asserts that these three source behaviours still exist. If a county fixes its index or its column type, that suite fails, which is the point.

## Known limits

- **Travis returns a refusal on the platform.** The index is built locally, and the refusal carries the command that builds it.
- **Tax amounts are out of scope.** In all four jurisdictions the amount owed belongs to a treasurer or a collector, a different agency from the assessor. This Actor reads assessment data and says so rather than silently omitting it.
- **The county is never guessed.** A caller who does not know which county a property is in cannot start here.
- **Travis supplement handling has never been exercised.** The certified file carries supplement 0 and an empty action on every record, so that code path is written from a document and flagged as `index_may_lag_supplements`.
- **Four counties out of 3,144.** 10.9 million people, 3.2% of the country, 0.13% of its counties.

## FAQ

### Is looking up this data legal?

This Actor reads public documented endpoints and published bulk files only. It parses no HTML, uses no login, and bypasses nothing. Travis publishes bulk files and no documented API, and the vendor backend behind its property search was deliberately left alone.

None of the four endpoints states machine-readable terms. San Diego's service carries no `licenseInfo` key at all, and empty description and copyright fields. **Availability is not permission**, so check the publisher's own terms for your use case. Nothing here is legal advice, and county data is published for the county's purposes, not yours.

### Does it return the property tax bill?

No. It returns assessment data: values, owner, characteristics, sales. The amount owed is held by a treasurer or a collector, which is a different agency in all four counties.

### Why is the owner name missing for San Diego?

Because two publishers of the same data disagree, and shipping whatever the endpoint hands over would silently pick a side. SanGIS states that under California AB1785 it may not publish owner name and address online, while the county's own layer served them unauthenticated on 2026-08-02. So the name and mailing address are withheld by default and the record says so with `owner_withheld_by_policy`. Set `allowContestedOwnerNames` to true and the name comes back flagged `owner_name_contested`, so the dispute travels with the data instead of ending at the first hop. The three counties whose owner names are published without dispute are unaffected.

### What happens when the parcel does not exist?

You get an empty result, because that is a true answer, and it is deliberately different from a refusal. A refusal means the lookup could not be performed, and it says which county refused, what was asked, why, and what to do about it.

### Can an AI agent call this Actor?

That is what it was built for. It is exposed over the Apify MCP Server as a tool with its full input schema, and the field descriptions are written for the model that reads them when it chooses arguments. The output is a declared dataset schema, so the platform does not have to infer the shape from recent runs.

### Can you add my county?

Each county here is a separate adapter, because each publishes differently. Open an issue in the **Issues** tab with the county and the source you have in mind.

### Something is wrong with a record, where do I report it?

The **Issues** tab. A parcel identifier and the county are enough to reproduce it. The source code is public: [actor-us-tax-county-scraper](https://github.com/mikhail-koviazin/actor-us-tax-county-scraper).
