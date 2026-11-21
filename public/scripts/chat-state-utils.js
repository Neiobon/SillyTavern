// Chat files contain names and switches only, never preset or lorebook contents.
export const CHAT_STATE_KEY = 'chat_state';

/**
 * @typedef {object} ChatState
 * @property {number} version
 * @property {string|null} preset Chat Completion preset name
 * @property {string[]} globalBooks Global lorebook names
 * @property {Record<string, Record<string, boolean>>} entryOverrides Disabled switches by book and UID
 */

/** Returns a unique list of names, accepting only strings. @param {any} names */
export function normalizeBookNames(names) {
    return Array.isArray(names) ? [...new Set(names.filter(name => typeof name === 'string' && name.length))] : [];
}

/** Compares selections independently of their order. @param {string[]} a @param {string[]} b */
export function sameBookSelection(a, b) {
    const left = normalizeBookNames(a);
    const right = normalizeBookNames(b);
    return left.length === right.length && left.every(name => right.includes(name));
}

/** Creates a lightweight record. @param {string|null} preset @param {string[]} globalBooks @returns {ChatState} */
export function createChatState(preset, globalBooks) {
    return { version: 1, preset: typeof preset === 'string' ? preset : null, globalBooks: normalizeBookNames(globalBooks), entryOverrides: {} };
}

/** Checks the supported record shape without rewriting imported metadata. @param {any} state @returns {boolean} */
export function isChatState(state) {
    return state?.version === 1 && (state.preset === null || typeof state.preset === 'string')
        && Array.isArray(state.globalBooks) && state.globalBooks.every(name => typeof name === 'string')
        && state.entryOverrides !== null && typeof state.entryOverrides === 'object' && !Array.isArray(state.entryOverrides);
}

/**
 * Returns an override only if it differs from the book's own switch.
 * @param {ChatState} state @param {string} book @param {string|number} uid @param {boolean} baseDisabled
 * @returns {boolean|undefined}
 */
export function getEntryOverride(state, book, uid, baseDisabled) {
    if (!Object.hasOwn(state?.entryOverrides ?? {}, book)) return undefined;
    const overrides = state.entryOverrides[book];
    if (!overrides || !Object.hasOwn(overrides, uid)) return undefined;
    const value = overrides[uid];
    return typeof value === 'boolean' && value !== Boolean(baseDisabled) ? value : undefined;
}

/**
 * Sets or clears a switch, removing redundant overrides and empty book maps. Does not mutate inputs.
 * @param {ChatState} state @param {string} book @param {string|number} uid
 * @param {boolean|undefined} disabled Undefined clears the override
 * @param {boolean} baseDisabled
 * @returns {ChatState}
 */
export function withEntryOverride(state, book, uid, disabled, baseDisabled) {
    const entryOverrides = { ...state.entryOverrides };
    const entries = { ...(Object.hasOwn(entryOverrides, book) ? entryOverrides[book] : {}) };
    if (typeof disabled !== 'boolean' || disabled === Boolean(baseDisabled)) {
        delete entries[uid];
    } else {
        Object.defineProperty(entries, uid, { value: disabled, enumerable: true, configurable: true, writable: true });
    }
    if (Object.keys(entries).length) {
        Object.defineProperty(entryOverrides, book, { value: entries, enumerable: true, configurable: true, writable: true });
    } else {
        delete entryOverrides[book];
    }
    return { ...state, entryOverrides };
}

/**
 * Applies switches to scan entries, not the cached/editor book. Call before computing entry hashes.
 * @param {object[]} entries @param {ChatState} state @returns {object[]}
 */
export function applyEntryOverrides(entries, state) {
    return entries.map(entry => {
        const disabled = getEntryOverride(state, entry.world, entry.uid, entry.disable);
        return disabled === undefined ? { ...entry } : { ...entry, disable: disabled };
    });
}

/** Compares override maps by book, UID and boolean value, ignoring object key order.
 * @param {object} a @param {object} b
 */
export function sameEntryOverrides(a = {}, b = {}) {
    const books = Object.keys(a);
    return books.length === Object.keys(b).length && books.every(book => {
        if (!Object.hasOwn(b, book)) return false;
        const left = a[book] ?? {};
        const right = b[book] ?? {};
        const uids = Object.keys(left);
        return uids.length === Object.keys(right).length && uids.every(uid => Object.hasOwn(right, uid) && left[uid] === right[uid]);
    });
}

/**
 * Computes the available parts to restore; missing names remain in the original record.
 * @param {ChatState} state @param {string|null} currentPreset @param {string[]} currentBooks
 * @param {string[]} presets @param {string[]} books
 */
export function diffChatState(state, currentPreset, currentBooks, presets, books) {
    const missingPreset = state.preset !== null && !presets.includes(state.preset) ? state.preset : null;
    const globalBooks = normalizeBookNames(state.globalBooks).filter(name => books.includes(name));
    return {
        preset: state.preset !== null && missingPreset === null && state.preset !== currentPreset ? state.preset : null,
        globalBooks,
        booksChanged: !sameBookSelection(globalBooks, currentBooks),
        missingPreset,
        missingBooks: normalizeBookNames(state.globalBooks).filter(name => !books.includes(name)),
    };
}
