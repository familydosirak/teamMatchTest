// src/sync.js
import { SYNC_MODE } from './config.js';
import { SYNC, setCurrentTeams, setRoster, roster, currentTeams } from './state.js';
import { normLine } from './state.js';
import { saveLocal, saveLocalTeams } from './storage.js';

/** === UI 브리지: app.js가 주입해줌 === */
let UI = {
    renderRoster() { }, renderTeams() { }, toggleScoringControls() { },
    launchConfetti() { },
    getPrefs() { return { scoringMode: 'elo', eloK: 60, winBonus: 30, balanceMode: 'prefer_line', mmrTolerance: 120 }; },
    setPrefs() { },
    setReadOnlyBadge(isOwner) { const badge = document.getElementById('viewModeBadge'); if (badge) badge.textContent = isOwner ? '호스트' : '읽기전용'; }
};
export function setUiBridge(bridge) { UI = { ...UI, ...bridge }; }

/** === 버튼 쿨다운 === */
let WIN_LOCK = false;
export function lockWinButtons(on) {
    WIN_LOCK = on;
    const b1 = document.getElementById('btnWin1'); const b2 = document.getElementById('btnWin2');
    if (b1) b1.disabled = on; if (b2) b2.disabled = on;
}

export function isWinLocked() { return WIN_LOCK; }

/** === Owner Key LocalStorage === */
function lsKeyForOwner(roomId) { return `room_owner_key_${roomId}`; }
function getLocalOwnerKey(roomId) { try { return localStorage.getItem(lsKeyForOwner(roomId)); } catch { return null; } }
function setLocalOwnerKey(roomId, key) { try { localStorage.setItem(lsKeyForOwner(roomId), key); } catch { } }
function makeOwnerKey() { return 'ok_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }

export function getRoomIdFromURL() { const m = location.hash.match(/room=([a-zA-Z0-9_-]{4,})/); return m ? m[1] : null; }

function setReadOnly(on) {
    SYNC.readOnly = !!on;
    document.body.classList.toggle('readonly', SYNC.readOnly);
    const allowIds = new Set(['rosterSearch', 'rosterSearchClear', 'btnCopyTeamsText', 'btnExportXLSX', 'btnShareRoom', 'btnSave', 'teamSort']);
    document.querySelectorAll('button, input, select, textarea').forEach(el => {
        const id = el.id || ''; el.disabled = SYNC.readOnly && !allowIds.has(id);
    });
    UI.setReadOnlyBadge(SYNC.isOwner);
}

export function canEdit() { return !SYNC.enabled || SYNC.isOwner; }
export function requireOwner() { if (canEdit()) return true; alert('읽기 전용 모드입니다. (호스트만 조작 가능)'); return false; }

export async function createRoomIfNeeded(roomId) {
    const db = window.firebase?.firestore?.();
    if (!db) return;
    const ref = db.collection('rooms').doc(roomId);
    const snap = await ref.get();

    if (!snap.exists) {
        const ownerKey = makeOwnerKey();
        setLocalOwnerKey(roomId, ownerKey);
        await ref.set({
            ownerUid: SYNC.uid,
            ownerKey,
            ts: Date.now(),
            expireAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
            ...packState()
        }, { merge: false });
        return;
    }
    const data = snap.data() || {};
    if (!data.ownerKey && data.ownerUid && SYNC.uid && data.ownerUid === SYNC.uid) {
        const ownerKey = getLocalOwnerKey(roomId) || makeOwnerKey();
        setLocalOwnerKey(roomId, ownerKey);
        await ref.set({ ownerKey }, { merge: true });
    }
}

export async function ensureRoomAndGetUrl() {
    let room = getRoomIdFromURL();
    if (!room) {
        room = Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
        const url = new URL(location.href); url.hash = 'room=' + room; history.replaceState(null, '', url.toString());
    }
    if (SYNC.uid) await createRoomIfNeeded(room);
    return location.href;
}

function packState() {
    return {
        roster,
        currentTeams,
        matchHistory: window.matchHistory || [],
        prefs: UI.getPrefs()
    };
}

export function persistTeamsLocalIfNeeded() {
    const rid = getRoomIdFromURL();
    // 방이 없으면 로컬에 저장 (SYNC_MODE 여부 무관)
    if (!rid) {
        try { saveLocalTeams(currentTeams); } catch {}
    }
}


function applyRemoteState(data) {
    try {
        if (!data) return;
        SYNC.applying = true;
        try {
            if (data.winEvent && typeof data.winEvent.ts === 'number' && data.winEvent.ts > SYNC.lastWinTs) {
                SYNC.lastWinTs = data.winEvent.ts;
                if (data.winEvent.ts !== SYNC.lastEmittedTs) {
                    const target = (data.winEvent.team === 1) ? document.getElementById('team1Box') : document.getElementById('team2Box');
                    if (target) UI.launchConfetti(target, { duration: 1800, count: 180 });
                }
            }
        } catch (e) { console.warn('[SYNC] winEvent apply error', e); }

        if (typeof data.ts === 'number' && SYNC.lastLocalTs && data.ts < SYNC.lastLocalTs) {
            return;
        }
        if (data.winEvent && typeof data.winEvent.ts === 'number' && SYNC.lastWinTs === 0) SYNC.lastWinTs = data.winEvent.ts;

        if (data) {
            const rid = SYNC.roomId || getRoomIdFromURL();
            const localKey = rid ? getLocalOwnerKey(rid) : null;
            if (data.ownerKey && localKey && data.ownerKey === localKey) SYNC.isOwner = true;
            else if (data.ownerKey && localKey && data.ownerKey !== localKey) SYNC.isOwner = false;
            else if (data.ownerUid && SYNC.uid) SYNC.isOwner = (data.ownerUid === SYNC.uid);
            else SYNC.isOwner = false;
            setReadOnly(!SYNC.isOwner);
        }

        if (Array.isArray(data.roster)) {
            setRoster(data.roster.map(p => ({
                id: p.id, name: p.name, score: +p.score || 0,
                games: +p.games || 0, wins: +p.wins || 0, losses: +p.losses || 0,
                mainLine: normLine(p.mainLine), subLine: normLine(p.subLine),
                lastDelta: Number.isFinite(+p.lastDelta) ? (+p.lastDelta) : 0
            })));
        }
        if (data.currentTeams) {
            setCurrentTeams({
                team1: Array.isArray(data.currentTeams.team1) ? data.currentTeams.team1.slice() : [],
                team2: Array.isArray(data.currentTeams.team2) ? data.currentTeams.team2.slice() : []
            });
        }
        if (Array.isArray(data.matchHistory)) {
            window.matchHistory = data.matchHistory.slice();
        }
        if (data.prefs) { UI.setPrefs(data.prefs); UI.toggleScoringControls(); }

        saveLocal(roster); UI.renderRoster(); UI.renderTeams();

        try {
            if (data.winEvent && typeof data.winEvent.ts === 'number' && data.winEvent.ts > SYNC.lastWinTs) {
                SYNC.lastWinTs = data.winEvent.ts;
                if (data.winEvent.ts !== SYNC.lastEmittedTs) {
                    const target = (data.winEvent.team === 1) ? document.getElementById('team1Box') : document.getElementById('team2Box');
                    if (target) UI.launchConfetti(target, { duration: 1800, count: 180 });
                }
            }
        } catch (e) { console.warn('[SYNC] winEvent apply error', e); }

    } catch (e) {
        console.warn('[SYNC] apply error', e);
    } finally {
        SYNC.applying = false;
    }
}

const publishState = (() => {
    let t = null;
    return function () {
        if (!SYNC_MODE) return;
        if (SYNC.applying) return;
        if (!SYNC.enabled || SYNC.writing || !SYNC.roomId) return;
        if (!canEdit()) return;
        clearTimeout(t);
        t = setTimeout(async () => {
            try {
                SYNC.writing = true;
                const db = window.firebase?.firestore?.(); if (!db) return;
                await db.collection('rooms').doc(SYNC.roomId).set({
                    ts: Date.now(),
                    expireAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
                    ...packState()
                }, { merge: true });
            } catch (e) { console.warn('[SYNC] publish error', e); }
            finally { setTimeout(() => { SYNC.writing = false; }, 40); }
        }, 400);
    };
})();

export async function writeRoomNow(extra = {}) {
    if (!SYNC_MODE) return;
    if (!SYNC.enabled || !SYNC.roomId) return;
    const now = Date.now(); SYNC.lastLocalTs = now;
    const payload = { ts: now, expireAt: new Date(now + 1000 * 60 * 60 * 24 * 7), ...packState(), ...extra };
    try {
        SYNC.writing = true;
        const db = window.firebase?.firestore?.(); if (!db) return;
        await db.collection('rooms').doc(SYNC.roomId).set(payload, { merge: true });
    } catch (e) { console.warn('[SYNC] writeRoomNow error', e); }
    finally { setTimeout(() => { SYNC.writing = false; }, 40); }
}

export function touchSync() {
    if (!SYNC_MODE) return;
    if (SYNC.applying) return;
    publishState();
}

export function startRoomSync(roomId) {
    if (!SYNC_MODE) return;
    if (SYNC.enabled) return;
    SYNC.enabled = true; SYNC.roomId = roomId;
    let firstSnap = true;
    const db = window.firebase?.firestore?.(); if (!db) return;
    db.collection('rooms').doc(roomId).onSnapshot(snap => {
        const data = snap.data();
        if (firstSnap) {
            firstSnap = false;
            if (data && data.winEvent && typeof data.winEvent.ts === 'number') SYNC.lastWinTs = data.winEvent.ts;
        }
        if (data) applyRemoteState(data);
    });
}

export function addIdToTeam(teamNo, id, doSync = false) {
    if (!requireOwner()) return;
    if (!id) return;
    const other = teamNo === 1 ? currentTeams.team2 : currentTeams.team1;
    const target = teamNo === 1 ? currentTeams.team1 : currentTeams.team2;
    const otherSet = new Set(other), targetSet = new Set(target);
    if (otherSet.has(id)) otherSet.delete(id);
    targetSet.add(id);
    if (teamNo === 1) { setCurrentTeams({ team1: [...targetSet], team2: [...otherSet] }); }
    else { setCurrentTeams({ team1: [...otherSet], team2: [...targetSet] }); }

    roster.forEach(p => p.lastDelta = 0);
    UI.renderTeams(); UI.renderRoster();
    persistTeamsLocalIfNeeded();
    if (doSync) touchSync();
}


