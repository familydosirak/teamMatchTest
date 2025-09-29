// src/sync.js
import { SYNC_MODE, PUBLISH_MIN_INTERVAL_MS, PUBLISH_MAX_WAIT_MS } from './config.js';
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
        try { saveLocalTeams(currentTeams); } catch { }
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
    const MIN_INTERVAL = PUBLISH_MIN_INTERVAL_MS; // 최소 간격(스로틀)
    const MAX_WAIT = PUBLISH_MAX_WAIT_MS;         // 최대 대기시간
    let timer = null;
    let maxTimer = null;
    let lastSentAt = 0;
    let writing = false;
    let pending = false;
    let lastPayloadHash = null;
    let backoffMs = 0;
    let pendingExtra = null;

    function hash(obj) {
        // 가벼운 해시 (충분히 효과적)
        const s = JSON.stringify(obj);
        let h = 0;
        for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
        return h;
    }

    async function doWrite() {
        if (!SYNC_MODE || !SYNC.enabled || !SYNC.roomId || !canEdit()) return;
        const now = Date.now();

        // 스로틀: 최소 간격 미만이면 다음 타이밍으로 미룸
        if (now - lastSentAt < MIN_INTERVAL || writing) { pending = true; schedule(); return; }

        // 상태 패킹 & 동일 데이터 중복 방지
        const payload = {
            ts: now,
            expireAt: new Date(now + 1000 * 60 * 60 * 24 * 7),
            ...packState(),
            ...(pendingExtra || {})
        };
        const h = hash(payload);
        if (h === lastPayloadHash) { // 내용 동일 → 쓰기 생략
            pending = false;
            pendingExtra = null;
            return;
        }

        // 오프라인/백그라운드 처리: 나중에 묶어서 쓰기
        if (document.hidden || navigator.onLine === false) {
            pending = true;
            schedule(); // 복귀 시 flush
            return;
        }

        // 실제 쓰기
        try {
            writing = true;
            const db = window.firebase?.firestore?.(); if (!db) return;
            await db.collection('rooms').doc(SYNC.roomId).set(payload, { merge: true });

            lastPayloadHash = h;
            lastSentAt = Date.now();
            pending = false;
            backoffMs = 0; // 성공 시 백오프 초기화
        } catch (e) {
            console.warn('[SYNC] publish error', e);
            // 지수 백오프(최대 10초)
            backoffMs = Math.min(backoffMs ? backoffMs * 2 : 500, 10000);
            pending = true;
            setTimeout(schedule, backoffMs);
        } finally {
            writing = false;
        }
    }

    function flush() { clearTimeout(timer); timer = null; clearTimeout(maxTimer); maxTimer = null; doWrite(); }

    function schedule() {
        // trailing 디바운스
        if (!timer) timer = setTimeout(flush, MIN_INTERVAL);
        // 너무 오래 안 나가면 강제 flush
        if (!maxTimer) maxTimer = setTimeout(flush, MAX_WAIT);
    }

    // 가시성/온라인 복귀 시 즉시 flush
    document.addEventListener('visibilitychange', () => { if (!document.hidden && pending) flush(); });
    window.addEventListener('online', () => { if (pending) flush(); });

    // 외부에서 호출되는 publishState()
    return function (extra = null) {
        if (!SYNC_MODE || SYNC.applying || !SYNC.enabled || !SYNC.roomId || !canEdit()) return;
        pending = true;
        if (extra) {
            // 마지막 extra로 덮어쓰되, 객체 merge로 키 충돌은 최신값 유지
            pendingExtra = { ...(pendingExtra || {}), ...extra };
        }
        schedule();
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

export function touchSync(extra = null) {
    if (!SYNC_MODE) return;
    if (SYNC.applying) return;
    if (extra && extra.winEvent && typeof extra.winEvent.ts === 'number') SYNC.lastEmittedTs = extra.winEvent.ts;
    publishState(extra);
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


