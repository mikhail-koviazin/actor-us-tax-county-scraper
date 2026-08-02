#!/usr/bin/env node
/**
 * Build the Travis index from the certified export.
 *
 *   node bin/build-travis-index.js                 full build
 *   node bin/build-travis-index.js --limit 200000  smoke build over the first N records
 *
 * The full build reads 129 MB over HTTP Range out of a 531 MB archive and inflates 4.9 GB
 * through a stream. Nothing is written to disk except the index.
 */

import { buildIndex, DEFAULT_ARCHIVE } from '../src/travis/build-index.js';

const args = process.argv.slice(2);
const limitAt = args.indexOf('--limit');
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
const outAt = args.indexOf('--out');
const outDir = outAt >= 0 ? args[outAt + 1] : 'storage/travis-index';

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const started = Date.now();

const manifest = await buildIndex({
    archiveUrl: DEFAULT_ARCHIVE,
    outDir,
    limit,
    onProgress: (p) => {
        if (p.phase === 'plan') {
            console.log(`archive        ${mb(p.archiveBytes)}`);
            console.log(`PROP.TXT       ${mb(p.entryBytes)} compressed, ${mb(p.entryUncompressedBytes)} inflated`);
            console.log(`not fetched    ${mb(p.skippedBytes)} of other entries`);
            console.log('');
        }
        if (p.phase === 'scan' && p.records % 500000 === 0) {
            const secs = (Date.now() - started) / 1000;
            console.log(
                `  ${p.records.toLocaleString()} records  ${secs.toFixed(0)}s  ${Math.round(p.records / secs).toLocaleString()}/s`,
            );
        }
        if (p.phase === 'write')
            console.log(
                `\nwriting ${p.properties.toLocaleString()} properties, ${p.addresses.toLocaleString()} addresses`,
            );
    },
});

console.log('');
console.log(JSON.stringify(manifest, null, 1));
