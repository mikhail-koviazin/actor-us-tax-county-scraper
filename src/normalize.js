/**
 * Value-level normalization.
 *
 * Every function here exists because one source does one specific thing. None of them
 * is applied globally: a shared "treat 0 as null" rule would corrupt a legitimate zero
 * somewhere else. Adapters pick the ones their source has earned.
 */

/**
 * Missing, in every disguise seen so far.
 *
 * Florida writes a single space for month and qualification codes. San Diego writes ten
 * spaces for a missing SITUS_ZIP, an empty string for ACREAGE, and null in the same
 * YEAR_EFFECTIVE column that also holds two spaces. All of these survive a `!== ''` test.
 */
export const blank = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    return v;
};

/** Trim a string that may be null, keeping null as null. */
export const str = (v) => {
    const b = blank(v);
    return b === null ? null : String(b).trim();
};

/**
 * Zero used as null.
 *
 * Florida ships TOT_LVG_AR 0, ACT_YR_BLT 0, SALE_PRC1 0. A house built in year 0 with
 * 0 square feet is a missing value. Only call this on fields where zero is impossible,
 * never on a value that may legitimately be zero.
 */
export const zeroAsNull = (v) => {
    const b = blank(v);
    if (b === null) return null;
    const n = Number(b);
    return Number.isFinite(n) && n !== 0 ? n : null;
};

/** A number that may arrive as "2026.0", "14550.0", "003" or 2026. */
export const num = (v) => {
    const b = blank(v);
    if (b === null) return null;
    const n = Number(b);
    return Number.isFinite(n) ? n : null;
};

/** An integer that may arrive zero padded, "003" being 3. */
export const paddedInt = (v) => {
    const n = num(v);
    return n === null ? null : Math.trunc(n);
};

/**
 * San Diego stores bathrooms times ten as a zero-padded string: "025" is 2.5, "035" is 3.5.
 * A client that trusts the field name reports a house with 25 bathrooms.
 */
export const bathsTimesTen = (v) => {
    const n = num(v);
    return n === null ? null : n / 10;
};

/**
 * San Diego DOCDATE is MMDDYY with no separator and no century: "110315" is 2015-11-03.
 *
 * The century is a guess and it is labelled as one. Deed dates in an assessor roll are
 * historical, so a two-digit year above the current one is read as last century.
 */
export const mmddyy = (v, { now = new Date() } = {}) => {
    const s = str(v);
    if (s === null || !/^\d{6}$/.test(s)) return null;
    const mm = Number(s.slice(0, 2));
    const dd = Number(s.slice(2, 4));
    const yy = Number(s.slice(4, 6));
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const currentYY = now.getUTCFullYear() % 100;
    const century = yy <= currentYY ? 2000 : 1900;
    const year = century + yy;
    return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
};

/**
 * A two-digit year with no other signal, as in San Diego's YEAR_EFFECTIVE.
 *
 * Returns the disambiguated year and says so, because "26" is 1926 or 2026 and the
 * column does not say which. Callers that cannot carry the uncertainty should not use it.
 */
export const twoDigitYear = (v, { now = new Date() } = {}) => {
    const s = str(v);
    if (s === null || !/^\d{2}$/.test(s)) return null;
    const yy = Number(s);
    const currentYY = now.getUTCFullYear() % 100;
    return { year: (yy <= currentYY ? 2000 : 1900) + yy, ambiguous: true };
};

/**
 * A measurement that has hit the ceiling of its column.
 *
 * San Diego's TOTAL_LVG_AREA is five digits wide and saturates: 1,637 parcels sit on
 * exactly 99999, nothing in the layer exceeds it, and the whole band from 90,000 to
 * 99,998 holds only 270. So the value is a clamp, not a measurement, and it is the
 * most dangerous kind of disguised null because it is a plausible number.
 *
 * Returns `{ value, clamped }` so the caller can flag it rather than silently drop it.
 */
export const clampedAt = (v, ceiling) => {
    const n = num(v);
    if (n === null) return { value: null, clamped: false };
    return n >= ceiling ? { value: null, clamped: true } : { value: n, clamped: false };
};

/** Join address parts, dropping every disguised blank, collapsing whitespace. */
export const joinParts = (...parts) =>
    parts
        .map((p) => str(p))
        .filter((p) => p !== null)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim() || null;

/** Compare addresses the way a caller typed them against the way a source stores them. */
export const addressKey = (s) =>
    String(s ?? '')
        .toUpperCase()
        .replace(/[.,#]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
