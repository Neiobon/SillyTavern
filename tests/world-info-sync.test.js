import { describe, expect, test, jest } from '@jest/globals';
import { mergeWorldInfo, worldInfoEquals, createWorldInfoSync } from '../public/scripts/world-info-sync.js';

const book = () => ({ entries: {
    0: { uid: 0, comment: 'X', content: 'old X', key: ['x'] },
    1: { uid: 1, comment: 'Y', content: 'old Y', key: ['y'] },
} });

/** Makes independent snapshots for three-way merge tests. */
function snapshots() {
    const base = book();
    return { base, local: structuredClone(base), latest: structuredClone(base) };
}

/** Creates a controller backed by a minimal optimistic server. */
function fixture() {
    let data = book();
    let revision = 1;
    const requests = [];
    const warn = jest.fn();
    const error = jest.fn();
    const refreshEditor = jest.fn();
    const cache = new Map();
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
        const body = JSON.parse(options.body);
        requests.push({ url, body });
        if (url.endsWith('/get')) return new Response(JSON.stringify(data), { headers: { 'X-World-Info-Version': String(revision) } });
        if (body.baseVersion !== String(revision)) {
            return new Response(JSON.stringify({ data, version: String(revision) }), { status: 409 });
        }
        data = body.data;
        revision++;
        return new Response(JSON.stringify({ ok: true, version: String(revision) }));
    });
    const sync = createWorldInfoSync({ cache, delay: 1000, getHeaders: () => ({}),
        getEditorName: () => 'test', refreshEditor, refreshList: jest.fn(), onSaved: jest.fn(), warn, error });
    return { sync, cache, requests, warn, refreshEditor, fetchMock,
        remote: value => { data = value; revision++; }, current: () => data };
}

describe('World Info three-way merge', () => {
    test('keeps independent entry and field edits without mutating inputs', () => {
        const { base, local, latest } = snapshots();
        local.entries[1].content = 'local Y';
        local.entries[0].key = ['new key'];
        latest.entries[0].content = 'remote X';
        const original = structuredClone({ base, local, latest });
        const result = mergeWorldInfo(base, local, latest);
        expect(result.conflicts).toEqual([]);
        expect(result.data.entries[0]).toMatchObject({ content: 'remote X', key: ['new key'] });
        expect(result.data.entries[1].content).toBe('local Y');
        expect({ base, local, latest }).toEqual(original);
    });

    test('local wins conflicts, warning labels are deduplicated', () => {
        const { base, local, latest } = snapshots();
        local.entries[0].content = 'local';
        local.entries[0].key = ['local'];
        latest.entries[0].content = 'remote';
        latest.entries[0].key = ['remote'];
        const result = mergeWorldInfo(base, local, latest);
        expect(result.conflicts).toEqual(['X (0)']);
        expect(result.data.entries[0]).toEqual(local.entries[0]);
    });

    test('equal edits and object key ordering are not conflicts', () => {
        const { base, local, latest } = snapshots();
        local.entries[0].filter = { a: 1, b: 2 };
        latest.entries[0].filter = { b: 2, a: 1 };
        expect(mergeWorldInfo(base, local, latest).conflicts).toEqual([]);
        expect(worldInfoEquals(local.entries[0], latest.entries[0])).toBe(true);
    });

    test('concurrent additions get free UIDs without taking other local additions', () => {
        const { base, local, latest } = snapshots();
        local.entries[2] = { uid: 2, comment: 'local' };
        local.entries[3] = { uid: 3, comment: 'another local' };
        latest.entries[2] = { uid: 2, comment: 'remote' };
        const result = mergeWorldInfo(base, local, latest);
        expect(result.data.entries[2].comment).toBe('remote');
        expect(result.data.entries[3].comment).toBe('another local');
        expect(result.data.entries[4]).toEqual({ uid: 4, comment: 'local' });
    });

    test('identical concurrent additions are not duplicated', () => {
        const { base, local, latest } = snapshots();
        local.entries[2] = latest.entries[2] = { uid: 2, comment: 'same' };
        expect(Object.keys(mergeWorldInfo(base, local, latest).data.entries)).toHaveLength(3);
    });

    test('untouched remote deletions stay deleted; local deletion wins remote edit with warning', () => {
        const { base, local, latest } = snapshots();
        delete latest.entries[0];
        local.entries[1].content = 'changed';
        expect(mergeWorldInfo(base, local, latest).data.entries[0]).toBeUndefined();
        delete local.entries[1];
        latest.entries[1].content = 'remote edit';
        const result = mergeWorldInfo(base, local, latest);
        expect(result.data.entries).toEqual({});
        expect(result.conflicts).toEqual(['Y (1)']);
    });

    test('locally modified remotely deleted entry is restored with warning', () => {
        const { base, local, latest } = snapshots();
        delete latest.entries[0];
        local.entries[0].content = 'restore';
        const result = mergeWorldInfo(base, local, latest);
        expect(result.data.entries[0]).toEqual(local.entries[0]);
        expect(result.conflicts).toEqual(['X (0)']);
    });

    test('top-level fields, removals, null and nested objects use field-level rules', () => {
        const { base, local, latest } = snapshots();
        base.extensions = local.extensions = { original: true };
        latest.extensions = { remote: true };
        base.remove = latest.remove = 'present';
        local.name = 'local title';
        local.nullable = null;
        latest.description = 'remote description';
        const result = mergeWorldInfo(base, local, latest);
        expect(result.data).toMatchObject({ name: 'local title', nullable: null,
            description: 'remote description', extensions: { remote: true } });
        expect(result.data).not.toHaveProperty('remove');
        expect(result.conflicts).toEqual([]);
        local.extensions = { local: true };
        expect(mergeWorldInfo(base, local, latest).conflicts).toEqual(['世界书属性']);
    });
});

describe('World Info save controller', () => {
    test('a stale loaded object merges even after the cache was refreshed', async () => {
        const f = fixture();
        try {
            const stale = await f.sync.load('test');
            const remote = book();
            remote.entries[0].content = 'remote';
            f.remote(remote);
            f.cache.delete('test');
            await f.sync.load('test');
            stale.entries[1].content = 'local';
            await f.sync.save('test', stale, true);
            expect(f.current().entries[0].content).toBe('remote');
            expect(f.current().entries[1].content).toBe('local');
            expect(f.requests.filter(r => r.url.endsWith('/edit')).map(r => r.body.baseVersion)).toEqual(['1', '2']);
            expect(f.refreshEditor).toHaveBeenCalled();
        } finally {
            f.fetchMock.mockRestore();
        }
    });

    test('UI normalization does not resurrect untouched remotely deleted entries', async () => {
        const f = fixture();
        try {
            const local = await f.sync.load('test');
            const finish = f.sync.captureNormalization(local, 0);
            local.entries[0].addMemo = true;
            local.entries[0].role = null;
            finish();
            const remote = book();
            delete remote.entries[0];
            f.remote(remote);
            local.entries[1].content = 'local';
            await f.sync.save('test', local, true);
            expect(f.current().entries[0]).toBeUndefined();
            expect(f.warn).not.toHaveBeenCalled();
        } finally {
            f.fetchMock.mockRestore();
        }
    });

    test('UI normalization never absorbs already pending user edits', async () => {
        const f = fixture();
        try {
            const local = await f.sync.load('test');
            local.entries[0].content = 'user edit';
            const finish = f.sync.captureNormalization(local, 0);
            local.entries[0].role = null;
            finish();
            const remote = book();
            remote.entries[0].content = 'remote';
            f.remote(remote);
            await f.sync.save('test', local, true);
            expect(f.current().entries[0].content).toBe('user edit');
            expect(f.warn).toHaveBeenCalledTimes(1);
        } finally {
            f.fetchMock.mockRestore();
        }
    });

    test('separate books keep independent debounced saves', async () => {
        const f = fixture();
        jest.useFakeTimers();
        try {
            const first = await f.sync.load('one');
            const second = await f.sync.load('two');
            first.entries[0].content = 'one';
            second.entries[1].content = 'two';
            await f.sync.save('one', first, false);
            await f.sync.save('two', second, false);
            await jest.runAllTimersAsync();
            expect(f.requests.filter(r => r.url.endsWith('/edit')).map(r => r.body.name)).toEqual(['one', 'two', 'two']);
        } finally {
            jest.useRealTimers();
            f.fetchMock.mockRestore();
        }
    });

    test('a deleted book is not silently recreated by a stale save', async () => {
        const f = fixture();
        try {
            const local = await f.sync.load('test');
            f.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: { entries: {} }, version: 'missing' }), { status: 409 }));
            local.entries[0].content = 'unsaved';
            await expect(f.sync.save('test', local, true)).rejects.toThrow('其他窗口删除');
            expect(local.entries[0].content).toBe('unsaved');
            expect(f.sync.isPending('test')).toBe(true);
        } finally {
            f.fetchMock.mockRestore();
        }
    });

    test('retry exhaustion retains local edits and reports an error', async () => {
        const f = fixture();
        try {
            const local = await f.sync.load('test');
            f.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: book(), version: 'new' }), { status: 409 }));
            local.entries[0].content = 'unsaved';
            await expect(f.sync.save('test', local, true)).rejects.toThrow('重试已达上限');
            expect(f.fetchMock).toHaveBeenCalledTimes(5);
            expect(local.entries[0].content).toBe('unsaved');
            expect(f.sync.isPending('test')).toBe(true);
        } finally {
            f.fetchMock.mockRestore();
        }
    });

    test('UID relocation keeps edits made while the addition save is in flight', async () => {
        const f = fixture();
        try {
            const local = await f.sync.load('test');
            const remote = book();
            remote.entries[2] = { uid: 2, comment: 'remote addition', content: 'remote' };
            f.remote(remote);
            local.entries[2] = { uid: 2, comment: 'local addition', content: 'first' };
            const saving = f.sync.save('test', local, true);
            local.entries[2].content = 'typed during save';
            const queued = f.sync.save('test', local, true);
            await Promise.all([saving, queued]);
            expect(f.current().entries[2].content).toBe('remote');
            expect(f.current().entries[3]).toEqual({ uid: 3, comment: 'local addition', content: 'typed during save' });
        } finally {
            f.fetchMock.mockRestore();
        }
    });

    test('changes made during an in-flight save are rebased and saved in order', async () => {
        const f = fixture();
        try {
            const local = await f.sync.load('test');
            const remote = book();
            remote.entries[0].content = 'remote';
            f.remote(remote);
            local.entries[1].content = 'first';
            const saving = f.sync.save('test', local, true);
            local.entries[1].content = 'second';
            const next = f.sync.save('test', local, true);
            await Promise.all([saving, next]);
            expect(f.current().entries[0].content).toBe('remote');
            expect(f.current().entries[1].content).toBe('second');
            expect(f.warn).not.toHaveBeenCalled();
        } finally {
            f.fetchMock.mockRestore();
        }
    });
});
