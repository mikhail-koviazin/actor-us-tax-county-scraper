# Agent instructions

This Actor answers one question about one parcel across US counties that publish the same data completely different ways. It is a router and a normalizer, not a scraper: no Crawlee, no browser, no HTML parsing anywhere. It calls documented public APIs and bulk files.

Read `README.md` first. The output contract lives in the companion research repo, `spec/actor-contract.md`.

## Working agreements

- Chat with Mike in Russian. Everything written into this repo is in English.
- No em-dashes anywhere. Commas, colons, parentheses, sentence breaks.
- No line breaks inside a sentence. One paragraph or bullet per line, never wrapped to a column width.
- Commit messages in Russian, short summary line under ~70 chars, bullets for several changes. Stage explicit paths, never `git add -A`.
- The repo is public and an article links to it twice. Anything written here is read by strangers.

## Commands

- `npm test` runs the unit suite. `npm run test:live` hits real county endpoints: slow, and not deterministic, timeouts and transport errors pass on retry.
- `npm run schema` rebuilds `.actor/dataset_schema.json` from the record definition. Run it after any change to the output shape.
- `npm run lint` and `npm run format:check` before committing.
- `npm run probe -- san-diego-ca parcel_id 3532803300 [--owner]` hits one source directly.
- Run the Apify CLI through `npx --no-install apify-cli`. `apify push` and `apify call` do not release the terminal after they succeed: check the result with `apify builds ls --limit=10 --desc`.

## Platform facts that cost time

- The declared dataset schema is validated by the platform on `pushData`. A mismatch kills the whole run. Locally only `test/declared-schema.js` catches it.
- Local `storage/` is never synced to the Cloud. Output visible in the Console is proof, local files are not.
- Use `apify/log`, not `console.log`: it censors tokens and keys.
- `apify datasets ls` lists named datasets only. A run's dataset comes from `runs info <id> --json`.
- The Apify Console keeps edits in a draft and needs an explicit Save, including icon upload. After any edit, reload the page and check that the "unsaved changes" banner is gone.

## Ask first

- Installing packages, `apify push`, Dockerfile changes, deleting datasets or key-value stores, anything that changes the Store listing.

## Store listing

- `README.md` is the Actor's public page on Apify Store, not developer documentation.
- Listing assets (the icon, its generator, screenshots) live in `assets/`.
