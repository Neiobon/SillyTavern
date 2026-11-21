import { characters, chat_metadata, getCurrentChatId, saveMetadata, this_chid } from '../script.js';
import { eventSource, event_types } from './events.js';
import { selected_group } from './group-chats.js';
import { getPresetApplicationPromise, oai_settings } from './openai.js';
import { selected_world_info, world_names, refreshWorldInfoChatState, setGlobalWorldInfoSelection } from './world-info.js';
import { debounce_timeout } from './constants.js';
import { escapeHtml } from './utils.js';
import { CHAT_STATE_KEY, createChatState, diffChatState, getEntryOverride, isChatState, sameBookSelection, sameEntryOverrides, withEntryOverride } from './chat-state-utils.js';

let ownerRecord = null;
let ownerKey = null;
let observedBooks = [];
let observedPreset = null;
let observedOverrides = {};
let restoring = false;
let saveTimer = null;
let dirty = false;
let saving = null;

/** A filename alone is not unique across characters/groups. */
function currentKey() {
    const chatId = getCurrentChatId();
    return chatId ? JSON.stringify([selected_group, selected_group ? null : characters[this_chid]?.avatar, chatId]) : null;
}

/** Ignore events during loading/restoration, including async preset events from the old chat. */
function canRecord() {
    return !restoring && ownerKey !== null && ownerKey === currentKey() && ownerRecord === chat_metadata[CHAT_STATE_KEY];
}

/** Returns only a supported record from an actual open chat. */
export function getChatState() {
    return currentKey() && isChatState(chat_metadata[CHAT_STATE_KEY]) ? chat_metadata[CHAT_STATE_KEY] : null;
}

/** Schedule through the normal metadata save path, bound to the open chat. */
function scheduleSave() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void flushChatStateSave(); }, debounce_timeout.relaxed);
}

/**
 * Flush user changes before a switch cancels the debounce or resets character/group identity.
 * Merely opening an old chat never marks it dirty.
 * @returns {Promise<void>}
 */
export async function flushChatStateSave() {
    // The select updates its name synchronously, before OAI_PRESET_CHANGED_AFTER.
    // Capture an immediate user switch without awaiting (or re-entering) the preset event chain.
    recordPreset();
    recordGlobalBooks();
    clearTimeout(saveTimer);
    saveTimer = null;
    if (saving) await saving;
    if (!dirty || !canRecord()) return;
    dirty = false;
    saving = saveMetadata();
    try {
        await saving;
    } finally {
        saving = null;
    }
}

/** Record just the field that changed; missing recorded names must survive unrelated changes. */
function recordPreset() {
    const state = getChatState();
    if (!canRecord() || !state || observedPreset === oai_settings.preset_settings_openai) return;
    observedPreset = oai_settings.preset_settings_openai;
    state.preset = observedPreset;
    scheduleSave();
}

/** Global WI events also fire for budget/depth changes. Those are not chat state. */
export function recordGlobalBooks() {
    const state = getChatState();
    if (!canRecord() || !state || sameBookSelection(observedBooks, selected_world_info)) return;
    observedBooks = [...selected_world_info];
    state.globalBooks = [...selected_world_info];
    scheduleSave();
}

/**
 * Sets the open chat's switch only, leaving the editor/cached book untouched.
 * @param {string} book @param {string|number} uid @param {boolean|undefined} disabled @param {boolean} baseDisabled
 * @returns {boolean} Whether the click was handled for a chat
 */
export function setChatEntryOverride(book, uid, disabled, baseDisabled) {
    const state = getChatState();
    if (!canRecord() || !state) return false;
    ownerRecord = chat_metadata[CHAT_STATE_KEY] = withEntryOverride(state, book, uid, disabled, baseDisabled);
    observedOverrides = structuredClone(ownerRecord.entryOverrides);
    scheduleSave();
    refreshWorldInfoChatState();
    return true;
}

/** Remove switches made redundant by book edits, including edits arriving from another tab.
 * @param {string} book @param {object} entry
 */
export function normalizeChatEntryOverride(book, entry) {
    if (!entry) return;
    const state = getChatState();
    const switches = Object.hasOwn(state?.entryOverrides ?? {}, book) ? state.entryOverrides[book] : null;
    if (canRecord() && switches && Object.hasOwn(switches, entry.uid)
        && typeof switches[entry.uid] === 'boolean' && switches[entry.uid] === Boolean(entry.disable)) {
        ownerRecord = chat_metadata[CHAT_STATE_KEY] = withEntryOverride(state, book, entry.uid, undefined, entry.disable);
        observedOverrides = structuredClone(ownerRecord.entryOverrides);
        scheduleSave();
    }
}

/** Effective display value and marker, without ever assigning to entry.disable.
 * @param {string} book @param {object} entry
 */
export function getChatEntryState(book, entry) {
    normalizeChatEntryOverride(book, entry);
    const override = getEntryOverride(getChatState(), book, entry.uid, entry.disable);
    return { disabled: override ?? Boolean(entry.disable), overridden: override !== undefined };
}

/** First CHAT_CHANGED handler: protect the incoming record from auto-selection and other handlers. */
function beginChatChange() {
    restoring = true;
    clearTimeout(saveTimer);
    saveTimer = null;
    dirty = false;
    ownerKey = currentKey();
    if (ownerKey && !Object.hasOwn(chat_metadata, CHAT_STATE_KEY)) {
        chat_metadata[CHAT_STATE_KEY] = createChatState(oai_settings.preset_settings_openai, selected_world_info);
    }
    ownerRecord = chat_metadata[CHAT_STATE_KEY];
}

/** Last CHAT_CHANGED handler: the chat record wins over other automatic selection handlers. */
async function restoreChatState() {
    const record = chat_metadata[CHAT_STATE_KEY];
    const key = currentKey();
    try {
        // The normal UI handler applies CC presets asynchronously.
        await getPresetApplicationPromise();
        if (record !== chat_metadata[CHAT_STATE_KEY] || key !== currentKey()) return;
        const state = getChatState();
        if (!state) return;
        const options = [...document.querySelectorAll('#settings_preset_openai option')];
        const diff = diffChatState(state, oai_settings.preset_settings_openai, selected_world_info,
            options.map(option => option.textContent), world_names ?? []);
        const changes = [];
        if (!sameEntryOverrides(observedOverrides, state.entryOverrides)) changes.push('条目开关');
        const missing = [];
        if (diff.preset !== null) {
            const option = options.find(option => option.textContent === diff.preset);
            $('#settings_preset_openai').val(option.value).trigger('change');
            await getPresetApplicationPromise();
            if (record !== chat_metadata[CHAT_STATE_KEY] || key !== currentKey()) return;
            changes.push(`预设 ${diff.preset}`);
        }
        if (diff.booksChanged) {
            setGlobalWorldInfoSelection(diff.globalBooks);
            changes.push(`世界书 ${diff.globalBooks.join('、') || '无'}`);
        }
        if (diff.missingPreset !== null) missing.push(`预设 ${diff.missingPreset}`);
        if (diff.missingBooks.length) missing.push(`世界书 ${diff.missingBooks.join('、')}`);
        const message = changes.length ? `已恢复本会话设置：${changes.join('；')}` : '本会话设置';
        if (missing.length) {
            toastr.warning(escapeHtml(`${message}；未找到 ${missing.join('；')}（已保留记录）`));
        } else if (changes.length) {
            toastr.info(escapeHtml(message));
        }
    } finally {
        if (record === chat_metadata[CHAT_STATE_KEY] && key === currentKey()) {
            observedBooks = [...selected_world_info];
            observedPreset = oai_settings.preset_settings_openai;
            observedOverrides = structuredClone(getChatState()?.entryOverrides ?? {});
            restoring = false;
            refreshWorldInfoChatState();
        }
    }
}

/** Install after built-in handlers; APP_READY also accounts for extension registration during startup. */
export function initChatState() {
    const orderHandlers = () => {
        eventSource.makeFirst(event_types.CHAT_CHANGED, beginChatChange);
        eventSource.makeLast(event_types.CHAT_CHANGED, restoreChatState);
    };
    orderHandlers();
    eventSource.on(event_types.APP_READY, orderHandlers);
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, recordPreset);
    eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, recordGlobalBooks);
    eventSource.on(event_types.WORLDINFO_UPDATED, (book, data) => {
        for (const entry of Object.values(data?.entries ?? {})) normalizeChatEntryOverride(book, entry);
        refreshWorldInfoChatState();
    });
}
