import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { addressKeyOf, addressShard, propShard } from '../../src/travis/build-index.js';
import { field, forEachRecord, padded, RECORD_WIDTH, tcadDate } from '../../src/travis/parse.js';

/**
 * These need no network and no index. They cover the parts of the Travis pipeline where
 * being wrong is silent: an offset that is one character off parses every record cleanly
 * and returns the wrong data in every field after it.
 */

describe('the generated layout', () => {
    it('is 9922 characters wide, which is what TCAD documents and what the file delivers', () => {
        expect(RECORD_WIDTH).toBe(9922);
    });

    it('cuts prop_id from the first twelve characters', () => {
        expect(field('prop_id')).toMatchObject({ start: 0, end: 12 });
    });

    it('keeps the situs house number three thousand characters from the situs street', () => {
        // Related fields are not adjacent in this format, and assuming they are is how a
        // hand-written parser goes wrong.
        expect(field('situs_street').start).toBe(1049);
        expect(field('situs_num').start).toBe(4459);
    });

    it('refuses a field name that is not in the spec rather than returning undefined', () => {
        expect(() => field('sale_price')).toThrow(/no field/);
    });

    it('has no sale price field at all, which is Texas non-disclosure in the schema', () => {
        for (const name of ['sale_price', 'sale_amount', 'consideration', 'sale_amt']) {
            expect(() => field(name)).toThrow();
        }
        // What it does have is the deed, recorded without a price.
        expect(field('deed_dt')).toBeDefined();
        expect(field('deed_num')).toBeDefined();
    });
});

describe('padded', () => {
    it('reads a zero-padded numeric', () => {
        expect(padded('00000004336640')).toBe(4336640);
    });

    it('reads an all-zero field as zero, not as missing', () => {
        // Unlike Florida, where zero is used as null, a Texas value of zero is a value.
        expect(padded('000000000000000')).toBe(0);
    });

    it('reads a blank field as missing', () => {
        expect(padded('   ')).toBeNull();
        expect(padded('')).toBeNull();
    });
});

describe('tcadDate', () => {
    it('reads MM-DD-YYYY, the fourth date convention across four counties', () => {
        expect(tcadDate('12-31-2013')).toBe('2013-12-31');
        expect(tcadDate('06-12-2001')).toBe('2001-06-12');
    });

    it('refuses anything else rather than guessing', () => {
        expect(tcadDate('2013-12-31')).toBeNull();
        expect(tcadDate('13-45-2013')).toBeNull();
        expect(tcadDate('')).toBeNull();
    });
});

describe('forEachRecord', () => {
    const stream = (text) => Readable.from([text]);

    it('stops rather than shifting every field when the stride is wrong', async () => {
        const short = `${'x'.repeat(RECORD_WIDTH - 1)}\r\n${'y'.repeat(RECORD_WIDTH)}\r\n`;
        await expect(forEachRecord(stream(short), () => {})).rejects.toThrow(/not 9922 characters/);
    });

    it('takes a final record with no trailing newline', async () => {
        const seen = [];
        const text = `${'a'.repeat(RECORD_WIDTH)}\r\n${'b'.repeat(RECORD_WIDTH)}`;
        const count = await forEachRecord(stream(text), (r) => seen.push(r[0]));
        expect(count).toBe(2);
        expect(seen).toEqual(['a', 'b']);
    });
});

describe('index keys', () => {
    it('shards properties on the last two digits of the padded prop id', () => {
        expect(propShard('000000100008')).toBe('08');
        expect(propShard('000000988400')).toBe('00');
    });

    it('reduces a situs address the same way for the index and for a query', () => {
        expect(
            addressKeyOf({
                situs_num: '1201',
                situs_street_prefx: 'S',
                situs_street: 'LAMAR',
                situs_street_suffix: 'BLVD',
            }),
        ).toBe('1201 S LAMAR BLVD');
    });

    it('drops the columns that are blank rather than leaving gaps in the key', () => {
        expect(addressKeyOf({ situs_num: '', situs_street: 'LAKEVIEW ST', situs_street_suffix: '' })).toBe(
            'LAKEVIEW ST',
        );
    });

    it('spreads address shards over the full byte range', () => {
        const shards = new Set(
            ['1201 S LAMAR BLVD', '1501 BARTON SPRINGS RD', '1904 GOODRICH AVE', 'LAKEVIEW ST'].map(addressShard),
        );
        expect(shards.size).toBeGreaterThan(1);
        for (const s of shards) expect(s).toMatch(/^[0-9a-f]{2}$/);
    });
});
