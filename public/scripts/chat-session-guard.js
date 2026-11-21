/**
 * Keeps an in-flight generation bound to the chat it was started in.
 *
 * Switching to another chat while a reply is being generated "detaches" the generation: it keeps
 * running in the background against a snapshot of its original chat, and the result is saved into
 * that chat's file instead of whatever chat is currently open. Re-opening the original chat before
 * the generation is done re-attaches it to the UI.
 *
 * Generations go through these states:
 * - preparing: building the prompt. It still reads the open chat, so chat switches wait for it.
 * - running: the request is sent. A chat switch detaches it.
 * - finishing: the reply is being written into the open chat. Chat switches wait for it.
 * - finalizing: a detached generation is being written into its snapshot and saved.
 * - unsaved: the background save failed. The snapshot is kept until the chat is opened again.
 * - ended
 *
 * If waiting times out (e.g. a script run by the generation itself switches chats), the original chat
 * is saved as it is and the generation is "abandoned": it stops writing anything.
 */

import {
    characters,
    chat,
    chat_metadata,
    getRequestHeaders,
    reclaimGenerationForeground,
    releaseGenerationForeground,
    reloadCurrentChat,
    this_chid,
} from '../script.js';
import { event_types, eventSource } from './events.js';
import { groups, selected_group } from './group-chats.js';
import { compressRequest } from './request-compression.js';
import { waitUntilCondition } from './utils.js';

/** How long a chat switch waits for prompt building to finish. */
const PREPARE_TIMEOUT = 10_000;
/** How long a chat switch waits for a finished reply to be written into the open chat. */
const FINISH_TIMEOUT = 10_000;
/** Delay before telling the user that a generation moved to the background. Skipped if it comes right back (chat reload). */
const DETACH_NOTICE_DELAY = 800;

/**
 * @typedef {'preparing' | 'running' | 'finishing' | 'finalizing' | 'unsaved' | 'ended'} GenerationSessionState
 */

export class GenerationSession {
    /**
     * @param {object} init
     * @param {string} init.key Chat key, see {@link getChatKey}
     * @param {string} init.chatId Chat file name (character chats) or chat ID (group chats)
     * @param {string|null} init.groupId Group ID for group chats
     * @param {string|null} init.avatar Avatar of the generating character
     * @param {string} init.characterName Name of the generating character
     * @param {string} init.name2 Name used for the reply
     * @param {Date} init.generationStarted Time the generation was started
     * @param {number|null} init.groupGenerationId Group generation batch ID
     * @param {string} init.forceAvatar Avatar URL used for group chat replies
     */
    constructor(init) {
        this.key = init.key;
        this.chatId = init.chatId;
        this.groupId = init.groupId;
        this.avatar = init.avatar;
        this.characterName = init.characterName;
        this.name2 = init.name2;
        this.generationStarted = init.generationStarted;
        this.groupGenerationId = init.groupGenerationId;
        this.forceAvatar = init.forceAvatar;
        /** @type {GenerationSessionState} */
        this.state = 'preparing';
        this.detached = false;
        /** Set when the chat was deleted. The result is dropped. */
        this.discarded = false;
        /** Set when a chat switch could not wait for this generation. It must stop writing. */
        this.abandoned = false;
        /** @type {object[]} Messages of the original chat while detached */
        this.ownerChat = null;
        /** @type {object} Metadata of the original chat while detached */
        this.ownerMetadata = null;
        /** @type {any} StreamingProcessor of the generation, if streaming */
        this.processor = null;
        /** @type {AbortController|null} Abort controller of a non-streaming request */
        this.abortController = null;
        this.api = '';
        this.model = '';
    }
}

/** @type {GenerationSession|null} The generation that belongs to the open chat */
let foregroundSession = null;
/** @type {Map<string, GenerationSession>} Detached generations, keyed by chat key */
const backgroundSessions = new Map();
/** @type {Set<() => void>} Called when the foreground generation is detached or abandoned */
const releaseListeners = new Set();

/**
 * Resolves when the foreground generation stops blocking the open chat (detached or abandoned).
 * Lets input handlers that await the whole generation unlock early.
 * @returns {{ promise: Promise<void>, cancel: () => void }}
 */
export function waitForForegroundRelease() {
    let listener = () => {};
    const promise = new Promise((resolve) => {
        listener = () => resolve();
        releaseListeners.add(listener);
    });
    return { promise, cancel: () => releaseListeners.delete(listener) };
}

function notifyForegroundReleased() {
    const listeners = [...releaseListeners];
    releaseListeners.clear();
    listeners.forEach(fn => fn());
}

/**
 * Builds a key identifying a chat file.
 * @param {string|null} groupId Group ID, or null for character chats
 * @param {string|null} avatar Character avatar, used for character chats
 * @param {string} chatId Chat file name or group chat ID
 * @returns {string}
 */
function getChatKey(groupId, avatar, chatId) {
    return groupId ? `group:${groupId}:${chatId}` : `char:${avatar}:${chatId}`;
}

/**
 * @returns {string|null} Key of the open chat, or null if no chat file is open
 */
function getCurrentChatKey() {
    if (selected_group) {
        const group = groups.find(x => x.id == selected_group);
        return group?.chat_id ? getChatKey(selected_group, null, group.chat_id) : null;
    }
    const character = characters[this_chid];
    return character?.chat ? getChatKey(null, character.avatar, character.chat) : null;
}

/**
 * @param {GenerationSession} session
 * @returns {string} Label of the chat shown in notifications
 */
function getSessionLabel(session) {
    return session.groupId ? `${groups.find(x => x.id === session.groupId)?.name ?? ''} / ${session.chatId}` : session.chatId;
}

/**
 * Registers a generation that will write a reply into the open chat.
 * @param {Omit<ConstructorParameters<typeof GenerationSession>[0], 'key' | 'chatId' | 'groupId'>} init
 * @returns {GenerationSession|null} The session, or null if no chat file is open
 */
export function beginGenerationSession(init) {
    const groupId = selected_group || null;
    const chatId = groupId ? groups.find(x => x.id == groupId)?.chat_id : characters[this_chid]?.chat;
    if (!chatId) {
        return null;
    }

    const session = new GenerationSession({ ...init, key: getChatKey(groupId, init.avatar, chatId), chatId, groupId });
    foregroundSession = session;
    return session;
}

/**
 * Marks that the prompt is built and the request is about to be sent.
 * @param {GenerationSession} session
 * @param {object} params
 * @param {AbortController} params.abortController Abort controller of a non-streaming request
 * @param {string} params.api Generating API
 * @param {string} params.model Generating model
 */
export function commitGenerationSession(session, { abortController, api, model }) {
    session.abortController = abortController;
    session.api = api;
    session.model = model;
    session.state = 'running';
}

/**
 * Marks that the reply is being written into the open chat.
 * @param {GenerationSession} session
 */
export function markGenerationFinishing(session) {
    session.state = 'finishing';
}

/**
 * Marks that a detached reply is being written into its snapshot.
 * @param {GenerationSession} session
 */
export function markGenerationFinalizing(session) {
    session.state = 'finalizing';
}

/**
 * Called when Generate() returns, however it ended.
 * @param {GenerationSession} session
 */
export function endGenerationSession(session) {
    if (foregroundSession === session) {
        foregroundSession = null;
    }

    // Detached, but Generate() exited without saving the snapshot. Save what we have.
    if (backgroundSessions.get(session.key) === session && session.ownerChat && !['finalizing', 'unsaved'].includes(session.state)) {
        persistDetachedSession(session, { error: new Error('生成意外中断') });
    }

    if (session.state !== 'unsaved') {
        session.state = 'ended';
    }
}


/**
 * Must be called before the open chat is cleared to load another one (or to reload it).
 * Waits for a generation that is building its prompt or writing its reply, then detaches it.
 * @returns {Promise<void>}
 */
export async function prepareChatSwitch() {
    const session = foregroundSession;
    if (!session) {
        return;
    }

    if (session.state === 'preparing' || session.state === 'finishing') {
        const timeout = session.state === 'preparing' ? PREPARE_TIMEOUT : FINISH_TIMEOUT;
        try {
            await waitUntilCondition(() => foregroundSession !== session || session.state === 'running', timeout, 50);
        } catch {
            console.warn('[ChatSessionGuard] Timed out waiting for the generation, abandoning it', session);
            abandonSession(session);
            return;
        }

        if (foregroundSession !== session) {
            // Ended, or replaced by a follow-up generation (tool calls, auto-swipe).
            return prepareChatSwitch();
        }
    }

    if (session.state !== 'running') {
        return;
    }

    detachSession(session);
}

/**
 * Saves the original chat as it is and stops the generation from writing anything else.
 * @param {GenerationSession} session
 */
function abandonSession(session) {
    session.abandoned = true;
    foregroundSession = null;
    stopSessionRequest(session);
    notifyForegroundReleased();

    if (getCurrentChatKey() !== session.key) {
        return;
    }

    session.ownerChat = chat.slice();
    session.ownerMetadata = structuredClone(chat_metadata);
    if (!session.groupId) {
        releaseGenerationForeground(session);
    }
    persistDetachedSession(session, { silent: true });
}

/**
 * Moves the foreground generation to the background.
 * @param {GenerationSession} session
 */
function detachSession(session) {
    if (getCurrentChatKey() !== session.key) {
        console.warn('[ChatSessionGuard] Open chat does not match the generation, not detaching', session);
        foregroundSession = null;
        return;
    }

    session.ownerChat = chat.slice();
    session.ownerMetadata = structuredClone(chat_metadata);
    session.detached = true;
    foregroundSession = null;
    backgroundSessions.set(session.key, session);

    // Group generation keeps the UI blocked until the current member is done.
    if (!session.groupId) {
        releaseGenerationForeground(session);
        notifyForegroundReleased();
    }

    setTimeout(() => {
        if (session.detached && session.state === 'running') {
            toastr.info('回复会在后台继续生成，完成后保存到原会话。', '已切换会话');
        }
    }, DETACH_NOTICE_DELAY);
}

/**
 * Moves a background generation back to the foreground.
 * @param {GenerationSession} session
 */
function reattachSession(session) {
    session.detached = false;
    session.ownerChat = null;
    session.ownerMetadata = null;
    backgroundSessions.delete(session.key);
    foregroundSession = session;
    reclaimGenerationForeground(session);
}

/**
 * Called by chat loaders after reading the chat file. If the chat has a background generation,
 * returns its in-memory snapshot, which must be used instead of the file content.
 * @returns {{ session: GenerationSession, chat: object[], metadata: object } | null}
 */
export function restoreBackgroundChat() {
    const key = getCurrentChatKey();
    const session = key ? backgroundSessions.get(key) : null;
    if (!session?.ownerChat) {
        return null;
    }

    if (session.state === 'unsaved') {
        // The open chat now holds the data, normal saving takes over.
        backgroundSessions.delete(key);
    }

    return { session, chat: session.ownerChat, metadata: session.ownerMetadata };
}

/**
 * Called by chat loaders after the restored chat is rendered. Re-attaches the generation if it is still running.
 * @param {ReturnType<typeof restoreBackgroundChat>} restored
 */
export function resumeBackgroundChat(restored) {
    const session = restored?.session;
    if (!session?.detached || session.state !== 'running' || foregroundSession || getCurrentChatKey() !== session.key) {
        return;
    }

    reattachSession(session);
}

/**
 * Saves the snapshot of a detached generation into its chat file.
 * @param {GenerationSession} session
 * @param {object} [options]
 * @param {any} [options.error] Generation error, if it failed
 * @param {boolean} [options.silent] Don't notify on success
 * @returns {Promise<void>}
 */
export async function persistDetachedSession(session, { error = null, silent = false } = {}) {
    const label = getSessionLabel(session);

    if (session.discarded) {
        backgroundSessions.delete(session.key);
        return;
    }

    try {
        /** @type {ChatHeader} */
        const header = { chat_metadata: session.ownerMetadata, user_name: 'unused', character_name: 'unused' };
        const body = session.groupId
            ? { id: session.chatId, chat: [header, ...session.ownerChat] }
            : { ch_name: session.characterName, file_name: session.chatId, chat: [header, ...session.ownerChat], avatar_url: session.avatar };
        const url = session.groupId ? '/api/chats/group/save' : '/api/chats/save';
        const response = await fetch(url, await compressRequest({
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        }));

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data?.error === 'integrity' ? 'integrity check failed' : response.statusText);
        }
    } catch (saveError) {
        console.error('[ChatSessionGuard] Failed to save background generation', session, saveError);
        session.state = 'unsaved';
        toastr.error(`「${label}」：${saveError.message}。重新打开该会话可找回内容。`, '后台回复保存失败', { timeOut: 0, extendedTimeOut: 0 });
        return;
    }

    backgroundSessions.delete(session.key);
    session.ownerChat = null;
    session.ownerMetadata = null;

    if (silent) {
        return;
    }

    if (error) {
        const message = error?.error?.message ?? error?.message ?? String(error);
        toastr.error(`「${label}」：${message}`, '后台生成失败');
    } else {
        toastr.success(`「${label}」`, '后台回复已保存');
    }

    // The chat was opened while the reply was being finished; show the saved version.
    if (getCurrentChatKey() === session.key) {
        await reloadCurrentChat();
    }
}

/**
 * Cancels the API request of a generation.
 * @param {GenerationSession} session
 */
function stopSessionRequest(session) {
    // Stops the stream without logging it as an error
    session.processor?.onStopStreaming();
    session.abortController?.abort();
}

/**
 * @param {GenerationSession} session
 */
function abortSession(session) {
    session.discarded = true;
    stopSessionRequest(session);
}

export function initChatSessionGuard() {
    eventSource.on(event_types.CHAT_DELETED, (/** @type {string} */ name) => {
        for (const session of backgroundSessions.values()) {
            if (!session.groupId && session.chatId === name) {
                abortSession(session);
                backgroundSessions.delete(session.key);
            }
        }
    });

    eventSource.on(event_types.GROUP_CHAT_DELETED, (/** @type {string} */ chatId) => {
        for (const session of backgroundSessions.values()) {
            if (session.groupId && session.chatId === chatId) {
                abortSession(session);
                backgroundSessions.delete(session.key);
            }
        }
    });

    eventSource.on(event_types.CHAT_RENAMED, (/** @type {{avatarId: string, groupId: string, oldFileName: string, newFileName: string}} */ data) => {
        const oldName = String(data?.oldFileName ?? '').replace(/\.jsonl$/, '');
        const newName = String(data?.newFileName ?? '').replace(/\.jsonl$/, '');
        for (const session of [...backgroundSessions.values()]) {
            const sameOwner = data.groupId ? session.groupId === data.groupId : (!session.groupId && session.avatar === data.avatarId);
            if (sameOwner && session.chatId === oldName) {
                backgroundSessions.delete(session.key);
                session.chatId = newName;
                session.key = getChatKey(session.groupId, session.avatar, newName);
                backgroundSessions.set(session.key, session);
            }
        }
    });

    window.addEventListener('beforeunload', (event) => {
        const hasPending = [...backgroundSessions.values()].some(x => x.state !== 'ended');
        if (hasPending) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
}
