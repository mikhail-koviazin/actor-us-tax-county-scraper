#!/usr/bin/env node
/**
 * Generate the Travis fixed-width field layout from TCAD's own layout spec.
 *
 * The Property file is 9,922 characters per line across 493 fields, not delimited, not
 * quoted, no header row. Every field is cut by a documented start and end offset. Hand
 * typing 493 offsets is an invitation to be silently wrong about one of them, so the
 * layout is generated from the spreadsheet TCAD publishes and the result is committed.
 *
 * Source spec, re-downloadable:
 *   https://traviscad.org/wp-content/largefiles/Website_Legacy8.0.33-AppraisalExportLayout_06182026.zip
 * The zip holds a PDF and an XLSX of the same document. This reads the XLSX.
 *
 * Usage:
 *   node scripts/generate-travis-layout.mjs <path-to>/Legacy8.0.33-AppraisalExportLayout.xlsx
 *
 * The generator validates before it writes: offsets must be contiguous from 1 with no
 * gaps and no overlaps, every field's length must equal end - start + 1, and the last
 * field must end exactly on the documented record width. A spec that fails any of those
 * is a spec we have misread, and the right move is to stop rather than emit a layout
 * that cuts every field one character off.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../src/travis/layout.json');

/** The sheet holding the Property file layout, and the width its records must come to. */
const SHEET = 'Property';
const EXPECTED_WIDTH = 9922;

const xlsxPath = process.argv[2];
if (!xlsxPath) {
    console.error('usage: node scripts/generate-travis-layout.mjs <layout>.xlsx');
    process.exit(2);
}

/**
 * Read the sheet through Python's openpyxl rather than adding an xlsx parser to the
 * Actor's dependencies. This script runs once when TCAD publishes a new layout version;
 * the Actor itself only ever reads the committed JSON.
 */
const PY = `
import json, sys, warnings
warnings.filterwarnings('ignore')
import openpyxl
wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
rows = list(wb[sys.argv[2]].iter_rows(values_only=True))
hdr = next(i for i, r in enumerate(rows) if r and r[0] == 'Field Name')
out = []
for r in rows[hdr + 1:]:
    if not r or r[0] is None or r[2] is None:
        continue
    out.append({
        'name': str(r[0]).strip(),
        'type': str(r[1]).strip(),
        'start': int(r[2]),
        'end': int(r[3]),
        'length': int(r[4]),
        'description': ' '.join(str(r[5] or '').split()),
    })
json.dump(out, sys.stdout)
`;

const raw = execFileSync('python', ['-c', PY, resolve(xlsxPath), SHEET], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
});
const fields = JSON.parse(raw);

// Validate before writing. A misread spec is worse than no spec: it produces records that
// parse cleanly and are wrong in every field after the first mistake.
const problems = [];
let cursor = 0;
for (const f of fields) {
    if (f.start !== cursor + 1) {
        problems.push(`${f.name}: starts at ${f.start}, previous field ended at ${cursor}`);
    }
    if (f.end - f.start + 1 !== f.length) {
        problems.push(`${f.name}: ${f.start}-${f.end} is ${f.end - f.start + 1} wide, spec says ${f.length}`);
    }
    cursor = f.end;
}
if (cursor !== EXPECTED_WIDTH) {
    problems.push(`record width is ${cursor}, expected ${EXPECTED_WIDTH}`);
}
if (problems.length) {
    console.error(`Refusing to write a layout with ${problems.length} problem(s):`);
    for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
    process.exit(1);
}

// `filler` appears 23 times and is documented as "Not In Use". Keeping the entries would
// mean 23 identically named fields in a lookup keyed by name.
const usable = fields.filter((f) => f.name !== 'filler');

const layout = {
    generated_from: 'Legacy8.0.33-AppraisalExportLayout.xlsx, sheet Property',
    file: 'PROP.TXT (APPRAISAL_INFO.TXT)',
    record_width: cursor,
    field_count_including_filler: fields.length,
    fields: usable.map((f) => ({
        name: f.name,
        type: f.type,
        // Zero-based half-open, ready for slice(). The spec is one-based inclusive.
        start: f.start - 1,
        end: f.end,
        description: f.description,
    })),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(layout, null, 1)}\n`);

console.log(`Wrote ${OUT}`);
console.log(`  ${fields.length} fields in the spec, ${usable.length} usable, ${fields.length - usable.length} filler`);
console.log(`  record width ${cursor} characters, validated contiguous with no gaps`);
