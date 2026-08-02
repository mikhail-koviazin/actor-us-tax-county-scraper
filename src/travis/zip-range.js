/**
 * Read one file out of a remote ZIP without downloading the ZIP.
 *
 * TCAD publishes the whole appraisal roll as a single 531 MB archive and no endpoint that
 * answers a question about one parcel. That is the constraint the Travis adapter exists to
 * work around, and it does not follow that the whole 531 MB has to be fetched.
 *
 * A ZIP keeps its table of contents at the end, so with HTTP Range support you can read
 * the last 128 KB, learn every entry's offset and compressed size, and then fetch exactly
 * the bytes of the one entry you want. Measured against the 2026 certified export on
 * 2026-08-02:
 *
 *   whole archive                            557,228,168 bytes
 *   PROP.TXT alone, the only file we need     128,967,256 bytes
 *   SKETCH_INFO.TXT, which we never need      207,590,747 bytes
 *
 * So the targeted read is 4.3 times smaller than the download, and the single largest
 * thing in the archive is building sketches that a parcel lookup has no use for.
 *
 * The archive also expands 34 times: 531 MB of ZIP is 18.0 GB of fixed-width text, and
 * PROP.TXT is 4.9 GB of that on its own. Nothing here ever holds a whole file in memory.
 */

import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The end-of-central-directory record is 22 bytes plus a comment of up to 65,535. */
const TAIL_BYTES = 128 * 1024;

/** Values that mean "this number did not fit in 32 bits, look in the ZIP64 extra field". */
const U32_MAX = 0xffffffff;

const fetchRange = async (url, start, end) => {
    const headers = { range: end === undefined ? `bytes=${start}-` : `bytes=${start}-${end}` };
    const response = await fetch(url, { headers });
    if (response.status !== 206) {
        throw new Error(
            `expected HTTP 206 for a ranged read, got ${response.status}. ` +
                'This server may not support Range requests, in which case the whole archive has to be downloaded.',
        );
    }
    return Buffer.from(await response.arrayBuffer());
};

export const headArchive = async (url) => {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) throw new Error(`HEAD ${url} returned ${response.status}`);
    return {
        size: Number(response.headers.get('content-length')),
        lastModified: response.headers.get('last-modified'),
        acceptsRanges: response.headers.get('accept-ranges') === 'bytes',
        etag: response.headers.get('etag'),
    };
};

/**
 * Parse the ZIP64 extended information extra field, which is where the real sizes live
 * once any of them overflows 32 bits. PROP.TXT does: 4.9 GB uncompressed.
 */
const readZip64Extra = (extra, sizes) => {
    const patched = { ...sizes };
    let p = 0;
    while (p + 4 <= extra.length) {
        const headerId = extra.readUInt16LE(p);
        const size = extra.readUInt16LE(p + 2);
        if (headerId === 0x0001) {
            let q = p + 4;
            // The order is fixed and only the overflowed values are present, so each read
            // is conditional on that value having been the 32-bit sentinel.
            if (patched.uncompressedSize === U32_MAX) {
                patched.uncompressedSize = Number(extra.readBigUInt64LE(q));
                q += 8;
            }
            if (patched.compressedSize === U32_MAX) {
                patched.compressedSize = Number(extra.readBigUInt64LE(q));
                q += 8;
            }
            if (patched.localHeaderOffset === U32_MAX) {
                patched.localHeaderOffset = Number(extra.readBigUInt64LE(q));
                q += 8;
            }
        }
        p += 4 + size;
    }
    return patched;
};

/**
 * Read the archive's table of contents.
 *
 * @returns {Promise<{entries: Array<{name, compressedSize, uncompressedSize, method, localHeaderOffset}>, archive: object}>}
 */
export async function readCentralDirectory(url) {
    const archive = await headArchive(url);
    if (!archive.acceptsRanges) {
        throw new Error('server does not advertise Accept-Ranges: bytes, so a targeted read is not possible');
    }

    const tailStart = Math.max(0, archive.size - TAIL_BYTES);
    const tail = await fetchRange(url, tailStart, archive.size - 1);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
        if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('no end-of-central-directory record in the last 128 KB');

    const entryCount = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);

    const directory =
        directoryOffset >= tailStart
            ? tail.subarray(directoryOffset - tailStart, directoryOffset - tailStart + directorySize)
            : await fetchRange(url, directoryOffset, directoryOffset + directorySize - 1);

    const entries = [];
    let p = 0;
    while (p < directory.length && directory.readUInt32LE(p) === CENTRAL_SIGNATURE) {
        const nameLength = directory.readUInt16LE(p + 28);
        const extraLength = directory.readUInt16LE(p + 30);
        const commentLength = directory.readUInt16LE(p + 32);

        const entry = readZip64Extra(directory.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength), {
            name: directory.subarray(p + 46, p + 46 + nameLength).toString('utf8'),
            method: directory.readUInt16LE(p + 10),
            compressedSize: directory.readUInt32LE(p + 20),
            uncompressedSize: directory.readUInt32LE(p + 24),
            localHeaderOffset: directory.readUInt32LE(p + 42),
        });
        entries.push(entry);

        p += 46 + nameLength + extraLength + commentLength;
    }

    if (entries.length !== entryCount) {
        throw new Error(`central directory says ${entryCount} entries, parsed ${entries.length}`);
    }
    return { entries, archive };
}

/**
 * Stream one entry's contents, fetching only its bytes.
 *
 * The local file header repeats the name and carries its own extra field, whose length
 * routinely differs from the central directory's, so the offset of the compressed data
 * has to be read from the local header rather than computed from the central one.
 */
export async function openEntry(url, entry) {
    if (entry.method !== 8) {
        throw new Error(`entry ${entry.name} uses compression method ${entry.method}, only deflate is handled`);
    }

    // 30 fixed bytes, then a name and an extra field whose lengths are in those 30.
    const header = await fetchRange(url, entry.localHeaderOffset, entry.localHeaderOffset + 29);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
        throw new Error(`no local file header at offset ${entry.localHeaderOffset} for ${entry.name}`);
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);

    const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize - 1;

    const response = await fetch(url, { headers: { range: `bytes=${dataStart}-${dataEnd}` } });
    if (response.status !== 206) {
        throw new Error(`ranged read of ${entry.name} returned ${response.status}`);
    }

    return {
        dataStart,
        dataEnd,
        bytes: entry.compressedSize,
        stream: Readable.fromWeb(response.body).pipe(createInflateRaw()),
    };
}
