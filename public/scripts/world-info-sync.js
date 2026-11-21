const VERSION_HEADER = 'X-World-Info-Version';
const MISSING_VERSION = 'missing';
const MAX_SAVE_ATTEMPTS = 4;

/**
 * Compares JSON values without depending on object key order.
 * @param {any} left First value
 * @param {any} right Second value
 * @returns {boolean} Whether the values are equal
 */
export function worldInfoEquals(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
        && keys.every(key => Object.hasOwn(right, key) && worldInfoEquals(left[key], right[key]));
}

/**
 * Applies local changes to the latest book, without mutating any input.
 * Arrays and nested objects are fields, not recursively merged subfields.
 * @param {object} base Last loaded/saved book
 * @param {object} local Locally edited book
 * @param {object} latest Current server book
 * @returns {{data: object, conflicts: string[], remappedUids: object}} Merged book, conflict labels and relocated local UIDs
 */
export function mergeWorldInfo(base, local, latest) {
    const data = structuredClone(latest);
    const conflicts = new Set();
    const remappedUids = {};
    const applyFields = (before, edited, remote, target, label, excluded = []) => {
        for (const field of new Set([...Object.keys(before), ...Object.keys(edited)])) {
            if (excluded.includes(field)) continue;
            const unchanged = (a, b) => Object.hasOwn(a, field) === Object.hasOwn(b, field)
                && worldInfoEquals(a[field], b[field]);
            if (unchanged(before, edited)) continue;
            if (!unchanged(before, remote) && !unchanged(edited, remote)) conflicts.add(label);
            if (Object.hasOwn(edited, field)) {
                Object.defineProperty(target, field, {
                    value: structuredClone(edited[field]), enumerable: true, configurable: true, writable: true,
                });
            } else {
                delete target[field];
            }
        }
    };
    applyFields(base, local, latest, data, '世界书属性', ['entries']);
    data.entries ??= {};
    const baseEntries = base.entries ?? {};
    const localEntries = local.entries ?? {};
    const latestEntries = latest.entries ?? {};

    // Reserve every local UID before allocating replacements for concurrent additions.
    const reserved = new Set([...Object.keys(latestEntries), ...Object.keys(localEntries)]);
    for (const uid of new Set([...Object.keys(baseEntries), ...Object.keys(localEntries)])) {
        const before = baseEntries[uid];
        const edited = localEntries[uid];
        const remote = latestEntries[uid];
        const label = `${edited?.comment || before?.comment || '未命名条目'} (${uid})`;
        if (!Object.hasOwn(localEntries, uid)) {
            if (remote && !worldInfoEquals(before, remote)) conflicts.add(label);
            delete data.entries[uid];
        } else if (!Object.hasOwn(baseEntries, uid)) {
            let newUid = uid;
            if (Object.hasOwn(latestEntries, uid) && !worldInfoEquals(edited, remote)) {
                let candidate = 0;
                while (reserved.has(String(candidate))) candidate++;
                newUid = String(candidate);
                reserved.add(newUid);
            }
            data.entries[newUid] = structuredClone(edited);
            if (newUid !== uid) {
                data.entries[newUid].uid = Number(newUid);
                remappedUids[uid] = newUid;
            }
        } else if (!worldInfoEquals(before, edited)) {
            if (!Object.hasOwn(latestEntries, uid)) {
                data.entries[uid] = structuredClone(edited);
                conflicts.add(label);
            } else {
                applyFields(before, edited, remote, data.entries[uid], label);
            }
        }
    }
    return { data, conflicts: [...conflicts], remappedUids };
}

/**
 * Coordinates per-book optimistic saves and invalidation. UI/account hooks stay in world-info.js.
 * @param {object} hooks Cache, request headers, editor, list, event and notification callbacks
 * @returns {object} Lorebook synchronization controller
 */
export function createWorldInfoSync(hooks) {
    const states = new Map();
    const sources = new WeakMap();
    let channel;
    let started = false;
    const stateFor = name => {
        if (!states.has(name)) states.set(name, { base: { entries: {} }, version: MISSING_VERSION, epoch: 0 });
        return states.get(name);
    };
    const isPending = name => {
        const state = states.get(name);
        return Boolean(state?.pending || state?.saving);
    };
    const request = (route, body) => fetch(`/api/worldinfo/${route}`, {
        method: 'POST', headers: hooks.getHeaders(), body: JSON.stringify(body), cache: 'no-cache',
    });
    const track = (name, data, state) => {
        sources.set(data, { name, base: structuredClone(state.base), version: state.version });
        return data;
    };
    const load = async name => {
        const state = stateFor(name);
        if (hooks.cache.has(name)) return track(name, hooks.cache.get(name), state);
        const epoch = state.epoch;
        const response = await request('get', { name });
        if (!response.ok) return null;
        const data = await response.json();
        // A notification or local edit may have arrived while the request was in flight.
        if (epoch !== state.epoch || isPending(name)) return load(name);
        state.base = structuredClone(data);
        state.version = response.headers.get(VERSION_HEADER) ?? MISSING_VERSION;
        hooks.cache.set(name, structuredClone(data));
        return track(name, data, state);
    };
    // UI setup triggers noSave handlers that backfill defaults; exclude those from user deltas.
    const captureNormalization = (data, uid) => {
        const before = structuredClone(uid === undefined ? data : { entries: { [uid]: data.entries[uid] } });
        return () => {
            const source = sources.get(data);
            if (!source) return;
            const updateFields = (base, old, normalized) => {
                for (const field of new Set([...Object.keys(old), ...Object.keys(normalized)])) {
                    const equal = (a, b) => Object.hasOwn(a, field) === Object.hasOwn(b, field)
                        && worldInfoEquals(a[field], b[field]);
                    // Only normalize unchanged fields; never mark existing local edits as saved.
                    if (!equal(base, old) || equal(old, normalized)) continue;
                    if (Object.hasOwn(normalized, field)) base[field] = structuredClone(normalized[field]);
                    else delete base[field];
                }
            };
            for (const uid of Object.keys(source.base.entries ?? {})) {
                if (before.entries?.[uid] && data.entries?.[uid]) {
                    updateFields(source.base.entries[uid], before.entries[uid], data.entries[uid]);
                }
            }
            for (const field of Object.keys(before).filter(field => field !== 'entries')) {
                if (worldInfoEquals(source.base[field], before[field]) && !worldInfoEquals(before[field], data[field])) {
                    source.base[field] = structuredClone(data[field]);
                }
            }
        };
    };
    const notify = (name, listChanged = false) => channel?.postMessage({ name, listChanged });
    const refreshEditor = async (name, data, force = false) => {
        if (!isPending(name) && hooks.getEditorName() === name) await hooks.refreshEditor(name, data, force);
    };
    const invalidate = async (name, force = false) => {
        const state = stateFor(name);
        state.epoch++;
        // Keep the original base and local object until the save path has merged them.
        if (isPending(name)) {
            state.invalidated = true;
            return;
        }
        state.invalidated = false;
        const cached = hooks.cache.has(name);
        hooks.cache.delete(name);
        if (cached || hooks.getEditorName() === name) {
            const data = await load(name);
            await refreshEditor(name, data, force);
        }
    };
    const checkVersions = async () => {
        const names = [...hooks.cache.keys()];
        for (let offset = 0; offset < names.length; offset += 1000) {
            const batch = names.slice(offset, offset + 1000);
            const response = await request('versions', { names: batch });
            if (!response.ok) return;
            const versions = await response.json();
            let listChanged = false;
            for (const name of batch) {
                if (versions[name] !== stateFor(name).version) {
                    listChanged ||= versions[name] === MISSING_VERSION;
                    await invalidate(name);
                }
            }
            if (listChanged) await hooks.refreshList();
        }
        // Also discover books created/renamed while this tab could not receive broadcasts.
        await hooks.refreshList();
    };
    const persist = async (name, job) => {
        const state = stateFor(name);
        const source = sources.get(job.data);
        let base = structuredClone(source.base);
        let version = source.version;
        const sent = structuredClone(job.data);
        let data = sent;
        const conflicts = new Set();
        const relocated = new Map();
        let saved = false;
        const creating = version === MISSING_VERSION;
        for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
            const response = await request('edit', { name, data, baseVersion: version });
            if (response.status === 409) {
                const latest = await response.json();
                if (latest.version === MISSING_VERSION && version !== MISSING_VERSION) {
                    throw new Error('世界书已在其他窗口删除。为避免重新创建，未保存本地编辑，请先导出备份。');
                }
                const merged = mergeWorldInfo(base, data, latest.data);
                merged.conflicts.forEach(label => conflicts.add(label));
                data = merged.data;
                // Remember relocations; the live editor object must not change until acknowledgement.
                for (const [oldUid, newUid] of Object.entries(merged.remappedUids)) {
                    const originalUid = [...relocated].find(([, currentUid]) => currentUid === oldUid)?.[0] ?? oldUid;
                    relocated.set(originalUid, newUid);
                }
                base = latest.data;
                version = latest.version;
                continue;
            }
            if (!response.ok) throw new Error(`世界书保存失败 (${response.status})，本地编辑仍保留。`);
            const result = await response.json();
            version = result.version ?? response.headers.get(VERSION_HEADER) ?? MISSING_VERSION;
            saved = true;
            break;
        }
        if (!saved) throw new Error('世界书被频繁修改，自动合并重试已达上限。本地编辑仍保留，请再次保存。');

        // Preserve typing that happened during the request; rebase queued saves on this acknowledgement.
        const currentLocal = structuredClone(job.data);
        for (const snapshot of [sent, currentLocal]) {
            for (const [oldUid, newUid] of relocated) {
                if (oldUid === newUid || !Object.hasOwn(snapshot.entries, oldUid)) continue;
                snapshot.entries[newUid] = snapshot.entries[oldUid];
                snapshot.entries[newUid].uid = Number(newUid);
                delete snapshot.entries[oldUid];
            }
        }
        const current = mergeWorldInfo(sent, currentLocal, data).data;
        if (!worldInfoEquals(job.data, current)) {
            for (const key of Object.keys(job.data)) delete job.data[key];
            Object.assign(job.data, current);
        }
        source.base = structuredClone(data);
        source.version = version;
        state.base = structuredClone(data);
        state.version = version;
        state.epoch++;
        hooks.cache.set(name, structuredClone(state.pending?.data ?? data));
        if (conflicts.size) hooks.warn(`世界书同时修改冲突，本窗口的修改已保留：${[...conflicts].join('、')}`);
        notify(name, creating);
        await hooks.onSaved(name, data);
        return { data, merged: !worldInfoEquals(sent, data) };
    };
    const drain = (name) => {
        const state = stateFor(name);
        clearTimeout(state.timer);
        if (state.saving) return state.saving;
        state.saving = (async () => {
            let result;
            let merged = false;
            while (state.pending) {
                const job = state.pending;
                state.pending = null;
                try {
                    result = await persist(name, job);
                    merged ||= result.merged;
                } catch (error) {
                    state.pending ??= job;
                    hooks.error(error.message);
                    throw error;
                }
            }
            return { ...result, merged };
        })().finally(() => { state.saving = null; });
        return state.saving.then(async result => {
            if (state.invalidated && !isPending(name)) {
                await invalidate(name, result?.merged);
            } else if (result?.merged) {
                await refreshEditor(name, result.data, true);
            }
        });
    };
    const save = async (name, data, immediately) => {
        const state = stateFor(name);
        if (sources.get(data)?.name !== name) track(name, data, state);
        state.epoch++;
        state.pending = { data };
        hooks.cache.set(name, structuredClone(data));
        clearTimeout(state.timer);
        if (immediately) return drain(name);
        state.timer = setTimeout(() => { drain(name).catch(() => {}); }, hooks.delay);
    };
    const start = () => {
        if (started) return;
        started = true;
        if (typeof BroadcastChannel !== 'undefined') {
            channel = new BroadcastChannel(`sillytavern-world-info:${hooks.getUserHandle()}`);
            channel.onmessage = async ({ data }) => {
                if (typeof data?.name !== 'string') return;
                try {
                    await invalidate(data.name);
                    if (data.listChanged) await hooks.refreshList();
                } catch (error) {
                    console.warn('World Info synchronization failed:', error);
                }
            };
        }
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                checkVersions().catch(error => console.warn('World Info version check failed:', error));
            }
        });
    };
    const deleted = name => {
        const state = stateFor(name);
        clearTimeout(state.timer);
        state.pending = null;
        state.epoch++;
        state.base = { entries: {} };
        state.version = MISSING_VERSION;
        hooks.cache.delete(name);
        notify(name, true);
    };
    return {
        load, save, start, notify, deleted, isPending, checkVersions, captureNormalization,
        getVersion: name => stateFor(name).version,
    };
}
