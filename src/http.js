/**
 * One request wrapper for every source.
 *
 * The rules here are not a generic HTTP client's rules. They come from what the four
 * jurisdictions actually do, measured on 2026-08-02 and written up in the research repo:
 *
 *   - Florida returns HTTP 200 carrying {"error":{"code":400}} after 56 seconds.
 *   - The same layer worded that error two different ways on the same day, once in
 *     `message` and once in `details`, so the text is not a classification key.
 *   - San Diego returns HTTP 200, declared output fields and an empty `features`
 *     array when a statistic overflows int32. Nothing in that response is malformed.
 *
 * So: parse the body before looking at the status, and know per call whether empty
 * is a possible correct answer. `response.ok` is never consulted on its own.
 */

/** Terminal classification of one request. */
export const Outcome = {
    /** Body contains the shape we asked for. */
    OK: 'ok',
    /** fetch threw: DNS, connection reset, TLS. Retryable. */
    TRANSPORT: 'transport',
    /** HTTP 200 (or any status) whose body is an error object. Not retryable as-is. */
    ENVELOPE_LIE: 'envelope_lie',
    /** Real gateway timeout, or our own budget expired. Retryable. */
    TIMEOUT: 'timeout',
    /** A status the source is not documented to return. */
    HTTP_ERROR: 'http_error',
    /** Valid, empty, and empty is a possible answer to the question asked. */
    EMPTY: 'empty',
    /** Valid, empty, and empty cannot be the answer. The San Diego overflow case. */
    EMPTY_UNEXPECTED: 'empty_unexpected',
};

/** Only these are worth issuing again. A deterministic 400 costs a minute per retry. */
const RETRYABLE = new Set([Outcome.TRANSPORT, Outcome.TIMEOUT]);

export const isRetryable = (outcome) => RETRYABLE.has(outcome);

export class SourceResult {
    constructor({ outcome, body, status, ms, url, detail }) {
        this.outcome = outcome;
        this.body = body;
        this.status = status;
        this.ms = ms;
        this.url = url;
        this.detail = detail;
    }

    get ok() {
        return this.outcome === Outcome.OK;
    }
}

/**
 * Default per-source time budget.
 *
 * Florida's scan failure is deterministic at 56 to 57 seconds across six measurements.
 * An agent waiting on a parcel lookup has no use for an answer that takes a minute, and
 * every call shape we issue is one the source is known to answer in single digits, so a
 * request still running at 10 s is a request that has taken a path we did not intend.
 */
export const DEFAULT_BUDGET_MS = 10_000;

const buildUrl = (base, params) => {
    const url = new URL(base);
    for (const [k, v] of Object.entries(params ?? {})) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
    }
    return url;
};

/**
 * Pull an error out of a parsed body, whatever shape the source chose today.
 *
 * ArcGIS has used at least these two on the same layer on the same day:
 *   {"error":{"code":400,"message":"Cannot perform query. Invalid query parameters."}}
 *   {"error":{"code":400,"message":"","details":["Unable to perform query. ..."]}}
 * Socrata uses a flat {"error":true,"message":"..."}.
 */
const readErrorBody = (body) => {
    if (!body || typeof body !== 'object') return null;
    const e = body.error;
    if (e === undefined || e === null || e === false) return null;
    if (e === true) return { code: body.code ?? null, text: body.message ?? 'error' };
    const text = [e.message, ...(e.details ?? [])].filter(Boolean).join(' ') || 'error';
    return { code: e.code ?? null, text };
};

/**
 * Issue one GET and classify the answer.
 *
 * @param {string} base
 * @param {object} params query string
 * @param {object} [opts]
 * @param {number} [opts.budgetMs]
 * @param {(body:any) => boolean} [opts.isEmpty] does this body carry zero records
 * @param {boolean} [opts.emptyIsAnAnswer] may the correct answer be zero records
 * @returns {Promise<SourceResult>}
 */
export async function getJson(base, params, opts = {}) {
    const { budgetMs = DEFAULT_BUDGET_MS, isEmpty, emptyIsAnAnswer = true } = opts;
    const url = buildUrl(base, params);
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);

    let response;
    try {
        response = await fetch(url, {
            signal: AbortSignal.timeout(budgetMs),
            headers: { accept: 'application/json' },
        });
    } catch (err) {
        // AbortSignal.timeout rejects with TimeoutError; everything else is transport.
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return new SourceResult({
            outcome: timedOut ? Outcome.TIMEOUT : Outcome.TRANSPORT,
            ms: ms(),
            url: url.toString(),
            detail: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`,
        });
    }

    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        // A source that owes us JSON and sends something else has failed, whatever the status says.
        return new SourceResult({
            outcome: response.status === 504 ? Outcome.TIMEOUT : Outcome.HTTP_ERROR,
            status: response.status,
            ms: ms(),
            url: url.toString(),
            detail: `non-JSON body, ${text.length} bytes, starts: ${text.slice(0, 120)}`,
        });
    }

    // Body first. A 200 means nothing until this has run.
    const err = readErrorBody(body);
    if (err) {
        return new SourceResult({
            outcome: Outcome.ENVELOPE_LIE,
            body,
            status: response.status,
            ms: ms(),
            url: url.toString(),
            detail: `body error ${err.code ?? '?'}: ${err.text}`,
        });
    }

    if (response.status === 504) {
        return new SourceResult({
            outcome: Outcome.TIMEOUT,
            body,
            status: 504,
            ms: ms(),
            url: url.toString(),
        });
    }
    if (response.status >= 400) {
        return new SourceResult({
            outcome: Outcome.HTTP_ERROR,
            body,
            status: response.status,
            ms: ms(),
            url: url.toString(),
            detail: `HTTP ${response.status} with a body that carries no error object`,
        });
    }

    if (isEmpty?.(body)) {
        return new SourceResult({
            outcome: emptyIsAnAnswer ? Outcome.EMPTY : Outcome.EMPTY_UNEXPECTED,
            body,
            status: response.status,
            ms: ms(),
            url: url.toString(),
            detail: emptyIsAnAnswer
                ? undefined
                : 'well-formed response with zero records where zero is not a possible answer',
        });
    }

    return new SourceResult({
        outcome: Outcome.OK,
        body,
        status: response.status,
        ms: ms(),
        url: url.toString(),
    });
}

/** ArcGIS feature services: zero features. */
export const noFeatures = (body) => !Array.isArray(body?.features) || body.features.length === 0;
