# US county property tax lookup

Ask one question about a US parcel and get one answer, whichever way the county happens to publish its data.

This is not a scraper. No page is parsed anywhere. The same question is answered through a public ArcGIS service in one county, a state programme that aggregates all 67 counties in another, an open data portal in a third, and a 531 MB bulk file with no live endpoint at all in a fourth. **The caller should not have to know which.** The Actor is a router and a normalizer.

The reconnaissance behind every design decision here, with measured timings and raw responses, lives in a separate repo (`research-us-tax-county`). Nothing in this code is defensive by habit: every guard is guarding against something a county did on 2026-08-02.

## Status

| County        | Access mode                 | Parcel id          | Address                    | Live   |
| ------------- | --------------------------- | ------------------ | -------------------------- | ------ |
| San Diego, CA | public ArcGIS REST          | yes, 1 request     | yes, 1 request             | yes    |
| Duval, FL     | Florida DOR statewide layer | yes, 1 request     | yes, geocode then envelope | yes    |
| Cook, IL      | Socrata open data portal    | yes, 6 in parallel | yes, 1 then 6 per parcel   | yes    |
| Travis, TX    | bulk export                 | not implemented    | not implemented            | **no** |

Travis is the one that breaks the shape. It publishes no endpoint that answers a question about one parcel, so the Actor builds an index from the certified roll and serves from it: `source.live` is false, `as_of.basis` is the date the roll was posted rather than today, and every record carries `answered_from_index`. Lookups come back in about 35 ms, which is twenty times faster than the live counties and twenty times less current.

Building it reads **129 MB of a 531 MB archive**. A ZIP keeps its table of contents at the end, so with HTTP Range you can learn every entry's offset and fetch only the one file you need; the largest thing in this archive is 207 MB of building sketches a parcel lookup never touches. The 531 MB inflates to 18.0 GB, and `PROP.TXT` alone is 4.9 GB, so nothing is ever held whole.

```bash
node bin/build-travis-index.js     # 129 MB fetched, 493,246 properties, about 25 s
```

Wall clock for a parcel id lookup runs about 1.5 to 3 seconds everywhere, but a single timing on these services is reproducible only to about a factor of five, so the request count is the honest column and the seconds are not.

## Running it locally

```bash
npm install
npm run probe -- san-diego-ca parcel_id 3532803300
npm run probe -- duval-fl address "7519 Caravaca Ct, Jacksonville, FL 32244"
npm run probe -- --capabilities
```

`npm test` runs the unit tests, which need no network. `npm run test:live` hits the real endpoints.

## Why the output looks like this

Four decisions drive the shape of every record, and each was forced by something measured.

**No bare numbers.** There is no `assessed_value` field, and no `total`. `valuation.amounts` is a list of `{ basis, stage, amount }`, because "assessed value" means four different things: an Illinois fraction of market value, a California Proposition 13 base year value frozen at the last sale, a Florida ladder whose rungs differ by the Save Our Homes cap, and a Texas appraised value minus a homestead cap. An agent asked to compare two properties will compare them, so the difference has to be structural rather than documented.

`stage` rides on the amount rather than on the valuation because Cook publishes three of them for the same parcel in the same year, and they diverge. One parcel in 2016 was mailed at 3041, certified at 3041, and cut to 1303 by the Board of Review: three correct answers to "what is the assessed value", 57% apart, depending on where in the appeal cycle you stand.

**Uncertainty is machine readable first.** Everything a caller must know to avoid being wrong is a flag from a fixed vocabulary, and `notes` carries the same thing as sentences. A flag outside the vocabulary throws at build time, so a typo cannot ship as a silently absent warning.

**A refusal has the same shape as a success.** An unsupported lookup returns a record listing what the jurisdiction does support. An agent can act on that and can only give up on an error.

**A spatial hit is a candidate set, never an answer.** One point in San Diego returns 90 parcels, because condominiums, possessory interests and mobile homes are stacked on the parent parcel's polygon. The same route in Florida returns the wrong building for a condominium tower, because the geocoder puts the street address 200 m from the assessor's centroids. Both come back as clean successes. So anything reached through geometry is filtered on the address attributes afterwards, and if several survive, the caller is told the address named a building.

## Failure handling

`src/http.js` classifies every response into six outcomes and retries two of them. The rules are not generic:

- **Parse the body before the status.** Florida returns HTTP 200 carrying `{"error":{"code":400}}` after 56 seconds. `response.ok` is never consulted on its own.
- **Do not match on the error text.** The same layer worded that error two ways on the same day, once in `message` and once in `details`.
- **Empty is sometimes a failure.** San Diego answers a sum that overflows a 32-bit integer with HTTP 200, the output fields declared, and `"features": []`. Nothing in that response is malformed, so the classifier has to be told per call whether empty is a possible correct answer.
- **Reshape rather than retry.** Florida's 56 second failure is deterministic across six measurements. Retrying it burns minutes. No address ever goes into a `where` clause for that county.

`test/live/known-failures.live.test.js` asserts that these three source behaviours still exist. If a county fixes its index or its column type, that suite fails, which is the point.

## Licence and terms

None of the four endpoints states machine-readable terms. San Diego's service carries no `licenseInfo` key at all, and empty description and copyright fields. Availability is not permission.

Owner names are the sensitive field. SanGIS states that under California AB1785 it may not publish owner name and address online, while the county's own layer served them unauthenticated on 2026-08-02. Both statements were current, and this repo takes no position on which is right.
