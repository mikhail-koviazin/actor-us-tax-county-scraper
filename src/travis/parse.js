/**
 * Fixed-width record cutting for the TCAD appraisal export.
 *
 * PROP.TXT is 9,922 characters per record, CRLF separated, no header row, no delimiters
 * and no quoting. Field boundaries come from `layout.json`, which is generated from TCAD's
 * published spec by `scripts/generate-travis-layout.mjs` and never edited by hand.
 *
 * Two things make this less mechanical than it sounds:
 *
 *   - Related fields are not adjacent. The situs street, suffix and city sit at 1040-1149,
 *     and the house number is at 4460, over three thousand characters away. There is no
 *     "read the address block" shortcut.
 *   - Everything is padded. Numbers are zero padded to their full width, so `market_value`
 *     arrives as "00000004336640" and an empty numeric is a run of zeros that has to be
 *     told apart from a real zero by what the field means, not by its shape.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const layout = require('./layout.json');

export const RECORD_WIDTH = layout.record_width;

/** CRLF. Verified on the 2026 certified export: every separator in 493,000 records. */
export const RECORD_SEPARATOR = '\r\n';
export const RECORD_STRIDE = RECORD_WIDTH + RECORD_SEPARATOR.length;

const BY_NAME = new Map(layout.fields.map((f) => [f.name, f]));

export const field = (name) => {
    const f = BY_NAME.get(name);
    if (!f) throw new Error(`no field "${name}" in the TCAD Property layout`);
    return f;
};

export const fieldNames = () => [...BY_NAME.keys()];

/**
 * Build a cutter for exactly the fields wanted.
 *
 * Cutting all 470 fields of every record would mean 470 substring operations across
 * 493,000 records to populate an index that uses two dozen of them. The projection is
 * the difference between a build that finishes and one that does not.
 */
export const projector = (names) => {
    const cuts = names.map((name) => {
        const f = field(name);
        return { name, start: f.start, end: f.end };
    });
    return (record) => {
        const out = {};
        for (const c of cuts) out[c.name] = record.slice(c.start, c.end).trim();
        return out;
    };
};

/** A padded numeric, where an all-zero field may be a real zero or may be nothing at all. */
export const padded = (value) => {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
};

/**
 * TCAD writes dates as MM-DD-YYYY, which is a fourth convention across four counties:
 * Cook sends an ISO timestamp, San Diego sends MMDDYY with no century, Florida sends the
 * year and the month in separate columns and no day at all.
 */
export const tcadDate = (value) => {
    const s = String(value ?? '').trim();
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
    if (!m) return null;
    const [, mm, dd, yyyy] = m;
    if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
    return `${yyyy}-${mm}-${dd}`;
};

/**
 * Split a stream of decompressed bytes into records, calling back once per record.
 *
 * The file does not fit in memory: 4.9 GB uncompressed from a 129 MB ranged read. The
 * caller gets one record string at a time and is expected not to keep them.
 *
 * A record whose separator is not CRLF is a signal that the stride assumption is wrong,
 * which would silently shift every subsequent field. That is worth stopping for, not
 * worth recovering from, so it throws.
 */
export async function forEachRecord(stream, onRecord) {
    let carry = '';
    let count = 0;

    stream.setEncoding('latin1');
    for await (const chunk of stream) {
        let buffer = carry + chunk;
        let offset = 0;
        while (offset + RECORD_STRIDE <= buffer.length) {
            const separator = buffer.slice(offset + RECORD_WIDTH, offset + RECORD_STRIDE);
            if (separator !== RECORD_SEPARATOR) {
                throw new Error(
                    `record ${count} is not ${RECORD_WIDTH} characters: separator at that offset is ` +
                        `${JSON.stringify(separator)}. The layout and the file disagree, so every field ` +
                        'after this point would be cut in the wrong place.',
                );
            }
            onRecord(buffer.slice(offset, offset + RECORD_WIDTH), count);
            offset += RECORD_STRIDE;
            count += 1;
        }
        carry = buffer.slice(offset);
        buffer = '';
    }

    // A final record without a trailing CRLF is legal and has to be taken.
    const tail = carry.replace(/\r?\n$/, '');
    if (tail.length === RECORD_WIDTH) {
        onRecord(tail, count);
        count += 1;
    } else if (tail.length > 0) {
        throw new Error(`${tail.length} trailing characters left over, not a whole record`);
    }

    return count;
}
