import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sanitize from 'sanitize-filename';

export const WORLD_INFO_VERSION_HEADER = 'X-World-Info-Version';
export const WORLD_INFO_MISSING_VERSION = 'missing';

/**
 * Hashes the exact bytes written to disk (not timestamps, whose resolution varies by OS).
 * @param {string|Buffer} contents File contents
 * @returns {string} Opaque version
 */
export function getWorldInfoVersion(contents) {
    return createHash('sha256').update(contents).digest('hex');
}

/**
 * Reads data and its version together. Callers must keep compare-and-write synchronous.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @param {string} name Lorebook name
 * @returns {{data: object, version: string}} Current snapshot
 */
export function readWorldInfoSnapshot(directories, name) {
    const filename = path.join(directories.worlds, sanitize(`${name}.json`));
    try {
        const contents = fs.readFileSync(filename);
        return { data: JSON.parse(contents.toString('utf8')), version: getWorldInfoVersion(contents) };
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { data: { entries: {} }, version: WORLD_INFO_MISSING_VERSION };
        }
        throw error;
    }
}
