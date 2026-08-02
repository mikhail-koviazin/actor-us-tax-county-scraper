import { describe, expect, it } from 'vitest';

import {
    addressKey,
    bathsTimesTen,
    blank,
    clampedAt,
    joinParts,
    mmddyy,
    num,
    paddedInt,
    twoDigitYear,
    zeroAsNull,
} from '../../src/normalize.js';

/**
 * Every case here is a value one of the four sources actually returned. None of them is
 * hypothetical, and the comment says which source and why it is shaped that way.
 */

describe('blank', () => {
    it('treats a single space as missing (Florida SALE_MO1, QUAL_CD1)', () => {
        expect(blank(' ')).toBeNull();
    });

    it('treats ten spaces as missing (San Diego SITUS_ZIP)', () => {
        expect(blank('          ')).toBeNull();
    });

    it('keeps a legitimate zero', () => {
        expect(blank(0)).toBe(0);
    });

    it('keeps a string that only looks empty', () => {
        expect(blank('0')).toBe('0');
    });
});

describe('zeroAsNull', () => {
    it('reads Florida ACT_YR_BLT 0 as missing, not as the year zero', () => {
        expect(zeroAsNull(0)).toBeNull();
    });

    it('reads Florida TOT_LVG_AR 0 as missing', () => {
        expect(zeroAsNull('0')).toBeNull();
    });

    it('keeps a real measurement', () => {
        expect(zeroAsNull(2881)).toBe(2881);
    });
});

describe('num', () => {
    it('handles Cook returning 2026.0 and 2025 in the same column', () => {
        expect(num('2026.0')).toBe(2026);
        expect(num('2025')).toBe(2025);
    });

    it('handles Cook returning 14550.0 next to 14550', () => {
        expect(num('14550.0')).toBe(14550);
    });
});

describe('paddedInt', () => {
    it('reads San Diego BEDROOMS "003" as 3', () => {
        expect(paddedInt('003')).toBe(3);
    });

    it('reads ASR_LANDUSE queried as "06" and returned as 6', () => {
        expect(paddedInt('06')).toBe(6);
        expect(paddedInt(6)).toBe(6);
    });
});

describe('bathsTimesTen', () => {
    it('reads San Diego BATHS "025" as 2.5, not 25', () => {
        expect(bathsTimesTen('025')).toBe(2.5);
    });

    it('reads "035" as 3.5', () => {
        expect(bathsTimesTen('035')).toBe(3.5);
    });
});

describe('mmddyy', () => {
    const now = new Date('2026-08-02T00:00:00Z');

    it('reads San Diego DOCDATE 110315 as 2015-11-03, month first', () => {
        expect(mmddyy('110315', { now })).toBe('2015-11-03');
    });

    it('reads DOCDATE 031621 as 2021-03-16', () => {
        expect(mmddyy('031621', { now })).toBe('2021-03-16');
    });

    it('puts a two-digit year above the current one in the last century', () => {
        expect(mmddyy('070499', { now })).toBe('1999-07-04');
    });

    it('refuses anything that is not six digits rather than guessing', () => {
        expect(mmddyy('2015-11-03', { now })).toBeNull();
        expect(mmddyy('  ', { now })).toBeNull();
        expect(mmddyy('991315', { now })).toBeNull();
    });
});

describe('twoDigitYear', () => {
    const now = new Date('2026-08-02T00:00:00Z');

    it('says out loud that San Diego YEAR_EFFECTIVE is ambiguous', () => {
        expect(twoDigitYear('26', { now })).toEqual({ year: 2026, ambiguous: true });
        expect(twoDigitYear('99', { now })).toEqual({ year: 1999, ambiguous: true });
    });

    it('handles the two-space and null members of the same column', () => {
        expect(twoDigitYear('  ', { now })).toBeNull();
        expect(twoDigitYear(null, { now })).toBeNull();
    });
});

describe('clampedAt', () => {
    it('reports San Diego TOTAL_LVG_AREA 99999 as unknown, not as a measurement', () => {
        expect(clampedAt(99999, 99999)).toEqual({ value: null, clamped: true });
    });

    it('keeps a value below the ceiling', () => {
        expect(clampedAt(3577, 99999)).toEqual({ value: 3577, clamped: false });
    });

    it('keeps missing as missing without claiming a clamp', () => {
        expect(clampedAt('', 99999)).toEqual({ value: null, clamped: false });
    });
});

describe('joinParts', () => {
    it('assembles a San Diego situs address from its separate columns', () => {
        expect(joinParts('2461', '', 'RIDGEGATE', 'ROW', '')).toBe('2461 RIDGEGATE ROW');
    });

    it('drops a ten-space ZIP instead of padding the string with it', () => {
        expect(joinParts('100', 'MAIN', 'ST', '          ')).toBe('100 MAIN ST');
    });

    it('returns null rather than an empty string when everything is missing', () => {
        expect(joinParts('', ' ', null)).toBeNull();
    });
});

describe('addressKey', () => {
    it('makes a typed address comparable with a stored one', () => {
        expect(addressKey('2461 Ridgegate Row, La Jolla, CA 92037')).toBe('2461 RIDGEGATE ROW LA JOLLA CA 92037');
    });

    it('collapses the punctuation a caller uses for a unit', () => {
        expect(addressKey('1431 Riverplace Blvd. #2803')).toBe('1431 RIVERPLACE BLVD 2803');
    });
});
