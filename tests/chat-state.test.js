import { describe, expect, test } from '@jest/globals';
import { applyEntryOverrides, createChatState, diffChatState, getEntryOverride, isChatState, normalizeBookNames, sameBookSelection, sameEntryOverrides, withEntryOverride } from '../public/scripts/chat-state-utils.js';

const state = () => createChatState('P1', ['B1']);

describe('Chat state entry switches', () => {
    test('applies disable/enable overrides only to matching book and UID without mutating the record or entries', () => {
        let record = withEntryOverride(state(), 'B1', 0, true, false);
        record = withEntryOverride(record, 'B2', 0, false, true);
        const entries = [
            { world: 'B1', uid: 0, disable: false, content: 'constant' },
            { world: 'B2', uid: 0, disable: true },
            { world: 'B1', uid: 1, disable: false },
        ];
        const before = structuredClone({ record, entries });
        expect(applyEntryOverrides(entries, record).map(entry => entry.disable)).toEqual([true, false, false]);
        expect({ record, entries }).toEqual(before);
    });

    test('returning to the book value removes the switch and empty book map', () => {
        const record = withEntryOverride(state(), 'B1', 0, true, false);
        expect(withEntryOverride(record, 'B1', 0, false, false).entryOverrides).toEqual({});
        expect(record.entryOverrides).toEqual({ B1: { 0: true } });
    });

    test('clearing one entry preserves other switches', () => {
        let record = withEntryOverride(state(), 'B1', 0, true, false);
        record = withEntryOverride(record, 'B1', 1, false, true);
        expect(withEntryOverride(record, 'B1', 0, undefined, false).entryOverrides).toEqual({ B1: { 1: false } });
    });

    test('external book edits make equal overrides ineffective and removable', () => {
        const record = withEntryOverride(state(), 'B1', 0, true, false);
        expect(getEntryOverride(record, 'B1', 0, true)).toBeUndefined();
        expect(withEntryOverride(record, 'B1', 0, true, true).entryOverrides).toEqual({});
    });

    test('missing records, inherited properties and non-boolean values are ignored', () => {
        const entry = { world: 'B1', uid: 0, disable: false };
        expect(applyEntryOverrides([entry], null)).toEqual([entry]);
        const record = state();
        record.entryOverrides = Object.create({ B1: { 0: true } });
        expect(getEntryOverride(record, 'B1', 0, false)).toBeUndefined();
        record.entryOverrides = { B1: { 0: 'true' } };
        expect(getEntryOverride(record, 'B1', 0, false)).toBeUndefined();
    });

    test('compares override maps independently of key order', () => {
        expect(sameEntryOverrides({ B1: { 0: true }, B2: { 1: false } }, { B2: { 1: false }, B1: { 0: true } })).toBe(true);
        expect(sameEntryOverrides({ B1: { 0: true } }, { B1: { 0: false } })).toBe(false);
        expect(sameEntryOverrides({ B1: { 0: true } }, {})).toBe(false);
    });

    test('names such as __proto__ are plain keys, not prototype mutations', () => {
        const record = withEntryOverride(state(), '__proto__', '__proto__', true, false);
        expect(getEntryOverride(record, '__proto__', '__proto__', false)).toBe(true);
        expect(Object.getPrototypeOf(record.entryOverrides)).toBe(Object.prototype);
        expect({}.disable).toBeUndefined();
    });
});

describe('Lightweight records and restore diff', () => {
    test('records contain only version, preset name, book names and switches', () => {
        expect(state()).toEqual({ version: 1, preset: 'P1', globalBooks: ['B1'], entryOverrides: {} });
        expect(isChatState(state())).toBe(true);
        expect(isChatState({ ...state(), version: 2 })).toBe(false);
        expect(isChatState({ ...state(), entryOverrides: [] })).toBe(false);
        expect(isChatState(null)).toBe(false);
    });

    test('normalizes duplicate names and compares unordered selections', () => {
        expect(normalizeBookNames(['B2', 'B1', 'B2', '', null])).toEqual(['B2', 'B1']);
        expect(normalizeBookNames(null)).toEqual([]);
        expect(sameBookSelection(['B1', 'B2'], ['B2', 'B1'])).toBe(true);
        expect(sameBookSelection(['B1'], ['B2'])).toBe(false);
    });

    test('no-op diff needs no restore', () => {
        expect(diffChatState(state(), 'P1', ['B1'], ['P1'], ['B1'])).toEqual({
            preset: null, globalBooks: ['B1'], booksChanged: false, missingPreset: null, missingBooks: [],
        });
    });

    test('restores the available names and retains missing preset/books in the record', () => {
        const record = { ...state(), globalBooks: ['B1', 'DeletedBook'] };
        const before = structuredClone(record);
        expect(diffChatState(record, 'P2', ['B2'], ['P2'], ['B1', 'B2'])).toEqual({
            preset: null, globalBooks: ['B1'], booksChanged: true, missingPreset: 'P1', missingBooks: ['DeletedBook'],
        });
        expect(record).toEqual(before);
    });

    test('empty global selection clears other books and null preset is not restored', () => {
        expect(diffChatState(createChatState(null, []), 'P2', ['B2'], ['P2'], ['B2'])).toMatchObject({
            preset: null, globalBooks: [], booksChanged: true, missingPreset: null,
        });
    });

    test('an imported empty preset name is reported as missing, never applied', () => {
        expect(diffChatState(createChatState('', []), 'P2', [], ['P2'], [])).toMatchObject({ preset: null, missingPreset: '' });
    });

    test('different existing preset is restored by exact name', () => {
        expect(diffChatState(state(), 'P2', [], ['P1', 'P2'], ['B1'])).toMatchObject({ preset: 'P1', booksChanged: true });
    });
});
