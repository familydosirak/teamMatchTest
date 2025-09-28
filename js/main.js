
/* =========================
    상태/상수/유틸 (필요한 것만)
========================= */

/* === [SYNC] 실시간 동기화 + 호스트 전용 편집 === */
const SYNC = {
    enabled: false,
    roomId: null,
    uid: null,
    isOwner: false,
    readOnly: false,
    writing: false,
    unsub: null,
    applying: false,
    lastLocalTs: 0,
    lastWinTs: 0,      // 마지막으로 처리한 winEvent 타임스탬프(중복 재생 방지)
    lastEmittedTs: 0   // 내가 방금 쏜 이벤트 ts(내 화면 중복 방지용)
};

let WIN_LOCK = false;
const WIN_COOLDOWN_MS = 1500; // 원하는 쿨다운(ms)

function lockWinButtons(on) {
    WIN_LOCK = on;
    const b1 = document.getElementById('btnWin1');
    const b2 = document.getElementById('btnWin2');
    if (b1) b1.disabled = on;
    if (b2) b2.disabled = on;
}
// === Host key (ownerKey) : 방을 만든 브라우저만 아는 비밀키로 호스트 판별 고정 ===
function lsKeyForOwner(roomId) { return `room_owner_key_${roomId}`; }
function getLocalOwnerKey(roomId) { try { return localStorage.getItem(lsKeyForOwner(roomId)); } catch { return null; } }
function setLocalOwnerKey(roomId, key) { try { localStorage.setItem(lsKeyForOwner(roomId), key); } catch { } }
function makeOwnerKey() { return 'ok_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }


function getRoomIdFromURL() { const m = location.hash.match(/room=([a-zA-Z0-9_-]{4,})/); return m ? m[1] : null; }

function setReadOnly(on) {
    SYNC.readOnly = !!on;
    document.body.classList.toggle('readonly', SYNC.readOnly);

    // 모든 조작 요소 잠금(보기/내보내기/검색 몇 개만 허용)
    const allowIds = new Set(['rosterSearch', 'rosterSearchClear', 'btnCopyTeamsText', 'btnExportXLSX', 'btnShareRoom', 'btnSave', 'teamSort']);
    document.querySelectorAll('button, input, select, textarea').forEach(el => {
        const id = el.id || '';
        el.disabled = SYNC.readOnly && !allowIds.has(id);
    });

    const badge = document.getElementById('viewModeBadge');
    if (badge) badge.textContent = SYNC.isOwner ? '호스트' : '읽기전용';
}

function canEdit() { return !SYNC.enabled || SYNC.isOwner; }
function requireOwner() {
    if (canEdit()) return true;
    alert('읽기 전용 모드입니다. (호스트만 조작 가능)');
    return false;
}

async function createRoomIfNeeded(roomId) {
    const ref = db.collection('rooms').doc(roomId);
    const snap = await ref.get();

    if (!snap.exists) {
        const ownerKey = makeOwnerKey();
        setLocalOwnerKey(roomId, ownerKey);
        await ref.set({
            ownerUid: SYNC.uid,
            ownerKey,
            ts: Date.now(),
            expireAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7), // 지금+7일
            ...packState()
        }, { merge: false });
        return;
    }

    // 레거시 방(예전 문서)에 ownerKey가 없고 내가 원래 ownerUid라면 키 보강
    const data = snap.data() || {};
    if (!data.ownerKey && data.ownerUid && SYNC.uid && data.ownerUid === SYNC.uid) {
        const ownerKey = getLocalOwnerKey(roomId) || makeOwnerKey();
        setLocalOwnerKey(roomId, ownerKey);
        await ref.set({ ownerKey }, { merge: true });
    }
}

async function ensureRoomAndGetUrl() {
    let room = getRoomIdFromURL();
    if (!room) {
        room = Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
        const url = new URL(location.href);
        url.hash = 'room=' + room;
        history.replaceState(null, '', url.toString());
    }
    if (SYNC.uid) await createRoomIfNeeded(room);
    return location.href;
}



function packState() {
    return {
        roster,
        currentTeams,
        matchHistory,
        prefs: {
            scoringMode: scoringModeSel?.value || 'elo',
            eloK: +eloKInput?.value || 60,
            winBonus: +winBonusInput?.value || 30,
            balanceMode: balanceModeSel?.value || 'prefer_line',
            mmrTolerance: +mmrToleranceInput?.value || 120,
        }
    };
}


function applyRemoteState(data) {
    try {
        if (!data) return;
        SYNC.applying = true;
        try {
            if (data.winEvent && typeof data.winEvent.ts === 'number' && data.winEvent.ts > SYNC.lastWinTs) {
                SYNC.lastWinTs = data.winEvent.ts;
                if (data.winEvent.ts !== SYNC.lastEmittedTs) {
                    const targetBox = (data.winEvent.team === 1) ? document.getElementById('team1Box') : document.getElementById('team2Box');
                    if (targetBox) launchConfetti(targetBox, { duration: 1800, count: 180 });
                }
            }
        } catch (e) { console.warn('[SYNC] winEvent apply error', e); }

        // 1) 내가 더 최신 상태를 방금 저장했다면(로컬 시각 기준) 구식 스냅샷은 무시
        if (typeof data.ts === 'number' && SYNC.lastLocalTs && data.ts < SYNC.lastLocalTs) {
            return; // 이 스냅샷은 이전 버전이므로 상태 덮어쓰지 않음 (이펙트는 위에서 이미 처리)
        }

        if (data.winEvent && typeof data.winEvent.ts === 'number' && SYNC.lastWinTs === 0) {
            SYNC.lastWinTs = data.winEvent.ts;
        }

        // 호스트 판정 및 UI 잠금
        if (data) {
            const rid = SYNC.roomId || getRoomIdFromURL();
            const localKey = rid ? getLocalOwnerKey(rid) : null;

            if (data.ownerKey && localKey && data.ownerKey === localKey) {
                SYNC.isOwner = true;
            } else if (data.ownerKey && localKey && data.ownerKey !== localKey) {
                SYNC.isOwner = false;
            } else if (data.ownerUid && SYNC.uid) {
                SYNC.isOwner = (data.ownerUid === SYNC.uid);
            } else {
                SYNC.isOwner = false;
            }

            setReadOnly(!SYNC.isOwner);
        }

        if (Array.isArray(data.roster)) {
            roster = data.roster.map(p => ({
                id: p.id, name: p.name, score: +p.score || 0,
                games: +p.games || 0, wins: +p.wins || 0, losses: +p.losses || 0,
                mainLine: normLine(p.mainLine), subLine: normLine(p.subLine),
                lastDelta: Number.isFinite(+p.lastDelta) ? (+p.lastDelta) : 0
            }));
        }
        if (data.currentTeams) {
            currentTeams = {
                team1: Array.isArray(data.currentTeams.team1) ? data.currentTeams.team1.slice() : [],
                team2: Array.isArray(data.currentTeams.team2) ? data.currentTeams.team2.slice() : []
            };
        }

        if (Array.isArray(data.matchHistory)) {
            matchHistory = data.matchHistory.slice();
        }

        if (data.prefs) {
            const p = data.prefs;
            if (scoringModeSel && p.scoringMode) scoringModeSel.value = p.scoringMode;
            if (eloKInput && Number.isFinite(+p.eloK)) eloKInput.value = String(p.eloK);
            if (winBonusInput && Number.isFinite(+p.winBonus)) winBonusInput.value = String(p.winBonus);
            if (balanceModeSel && p.balanceMode) balanceModeSel.value = p.balanceMode;
            if (mmrToleranceInput && Number.isFinite(+p.mmrTolerance)) mmrToleranceInput.value = String(p.mmrTolerance);
            toggleScoringControls();
        }

        saveLocal();
        renderRoster();
        renderTeams();
        // 원격 승리 신호 수신 시 폭죽 재생 (읽기 전용도 동일하게)
        try {
            if (data.winEvent && typeof data.winEvent.ts === 'number' && data.winEvent.ts > SYNC.lastWinTs) {
                // 내가 방금 보낸 이벤트와 동일한 ts면(호스트 본인) 한 번만 재생하고 넘어가도 됨
                SYNC.lastWinTs = data.winEvent.ts;
                // 호스트가 로컬로 이미 한 번 재생했더라도, ts가 다르면 재생
                if (data.winEvent.ts !== SYNC.lastEmittedTs) {
                    const targetBox = (data.winEvent.team === 1) ? document.getElementById('team1Box') : document.getElementById('team2Box');
                    if (targetBox) launchConfetti(targetBox, { duration: 1800, count: 180 });
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
        if (SYNC.applying) return;
        if (!SYNC.enabled || SYNC.writing || !SYNC.roomId) return;
        if (!canEdit()) return;
        clearTimeout(t);
        t = setTimeout(async () => {
            try {
                SYNC.writing = true;
                await db.collection('rooms').doc(SYNC.roomId).set({
                    ts: Date.now(),
                    expireAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7), // 매 활동 시 7일 뒤로 연장
                    ...packState()
                }, { merge: true });
            } catch (e) { console.warn('[SYNC] publish error', e); }
            finally { setTimeout(() => { SYNC.writing = false; }, 40); }
        }, 400);
    };
})();

async function writeRoomNow(extra = {}) {
    if (!SYNC.enabled || !SYNC.roomId) return;
    const now = Date.now();
    SYNC.lastLocalTs = now;
    // 활동 시 만료 7일 연장
    const payload = {
        ts: now,
        expireAt: new Date(now + 1000 * 60 * 60 * 24 * 7),
        ...packState(),
        ...extra
    };
    try {
        SYNC.writing = true;
        await db.collection('rooms').doc(SYNC.roomId).set(payload, { merge: true });
    } catch (e) {
        console.warn('[SYNC] writeRoomNow error', e);
    } finally {
        setTimeout(() => { SYNC.writing = false; }, 40);
    }
}


function touchSync() {
    if (SYNC.applying) return;
    publishState();
}

function startRoomSync(roomId) {
    if (SYNC.enabled) return;
    SYNC.enabled = true;
    SYNC.roomId = roomId;
    let firstSnap = true;
    db.collection('rooms').doc(roomId).onSnapshot(snap => {
        const data = snap.data();

        // 첫 구독 스냅샷에 문서에 남아있던 과거 winEvent가 있으면
        // 그 ts를 바로 기록해서(이미 본 것으로 간주) 재생 안 하게 함
        if (firstSnap) {
            firstSnap = false;
            if (data && data.winEvent && typeof data.winEvent.ts === 'number') {
                SYNC.lastWinTs = data.winEvent.ts;
            }
        }

        if (data) applyRemoteState(data);
    });

}

const STORAGE_KEY = 'team_roster_v1', WIN_BONUS_KEY = 'win_bonus_v1', MODE_KEY = 'scoring_mode_v1', ELO_K_KEY = 'elo_k_v1';
let roster = [];
let matchHistory = [];
let currentTeams = { team1: [], team2: [] };
let teamHistory = []; const HISTORY_LIMIT = 5;
let lastTeams = { team1: [], team2: [] };
let lastResultUndo = null; // 승리 반영 전 스냅샷

const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const avg = a => a.length ? (a.reduce((s, x) => s + x, 0) / a.length) : 0;
const isPlacement = g => (Number(g) || 0) <= 10;
const winRate = p => { const w = +p.wins || 0, l = +p.losses || 0, t = w + l; return t ? Math.round((w / t) * 100) : 0 };
const wrClass = r => r >= 53 ? 'wr-good' : (r <= 47 ? 'wr-bad' : '');
const LINES = ['T', 'J', 'M', 'B', 'S', 'A'];
const LINE_TITLE = { T: 'Top', J: 'Jungle', M: 'Mid', B: 'Bottom', S: 'Supporter', A: 'All' };
const normLine = v => { v = String(v || 'A').toUpperCase(); return LINES.includes(v) ? v : 'A'; };
const linePair = p => `${normLine(p.mainLine)}/${normLine(p.subLine)}`;
const escapeHtml = s => String(s || '').replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[ch]));

function pushHistory(split) {
    teamHistory.unshift({ team1: (split.team1 || []).slice(), team2: (split.team2 || []).slice() });
    if (teamHistory.length > HISTORY_LIMIT) teamHistory.pop();
}

/* ============ 다양성(스왑 고려) ============ */
function countSameSideEither(t1Ids, t2Ids, base = lastTeams) {
    const last1 = new Set(base.team1 || []), last2 = new Set(base.team2 || []);
    let c1 = 0; for (const id of t1Ids) if (last1.has(id)) c1++; for (const id of t2Ids) if (last2.has(id)) c1++;
    let c2 = 0; for (const id of t1Ids) if (last2.has(id)) c2++; for (const id of t2Ids) if (last1.has(id)) c2++;
    return Math.max(c1, c2);
}
function countSameSideMultiEither(t1Ids, t2Ids, histories = teamHistory.length ? teamHistory : [lastTeams]) {
    let m = 0; for (const h of histories) { const c = countSameSideEither(t1Ids, t2Ids, h); if (c > m) m = c; } return m;
}

/* ============ 저장/로드 ============ */
function saveLocal() { localStorage.setItem(STORAGE_KEY, JSON.stringify(roster)); }
function loadLocal() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const data = JSON.parse(raw);
            if (Array.isArray(data)) {
                roster = data.filter(x => x && x.name).map(x => ({
                    id: x.id || uid(),
                    name: String(x.name || '').trim(),
                    score: +x.score || 0,
                    games: Math.max(0, Math.floor(+x.games || 0)),
                    wins: Math.max(0, Math.floor(+x.wins || 0)),
                    losses: Math.max(0, Math.floor(+x.losses || 0)),
                    mainLine: normLine(x.mainLine),
                    subLine: normLine(x.subLine),
                }));
            }
        }
    } catch (e) { console.warn(e); }
}

/* ============ DOM ============ */
const rosterBody = document.getElementById('rosterBody');
const checkAll = document.getElementById('checkAll');
const nameInput = document.getElementById('nameInput');
const scoreInput = document.getElementById('scoreInput');
const winBonusInput = document.getElementById('winBonusInput');
const scoringModeSel = document.getElementById('scoringMode');
const eloKInput = document.getElementById('eloK');
const fileInput = document.getElementById('fileInput');
const team1UL = document.getElementById('team1');
const team2UL = document.getElementById('team2');
const team1Box = document.getElementById('team1Box');
const team2Box = document.getElementById('team2Box');
const linePrimaryInput = document.getElementById('linePrimaryInput');
const lineSecondaryInput = document.getElementById('lineSecondaryInput');
const balanceModeSel = document.getElementById('balanceMode');
const teamSortSel = document.getElementById('teamSort');
const mmrToleranceInput = document.getElementById('mmrTolerance');
const mixStrengthSel = document.getElementById('mixStrength');
const rosterSearchInput = document.getElementById('rosterSearch');
const rosterSearchClear = document.getElementById('rosterSearchClear');
const rosterSearchCount = document.getElementById('rosterSearchCount');
const selectedNamesEl = document.getElementById('selectedNames');
const eloKWrap = document.getElementById('eloKWrap');
const winBonusWrap = document.getElementById('winBonusWrap');
const managePanel = document.getElementById('managePanel');
const btnUndo = document.getElementById('btnUndo');
function setUndoEnabled(on) {
    if (!btnUndo) return;
    btnUndo.disabled = !on;
    btnUndo.title = on ? '마지막 결과 되돌리기' : '되돌릴 결과가 없습니다';
}
// 초기 비활성화
setUndoEnabled(false);

const BALANCE_MODE_KEY = 'balance_mode_v1';
const MMR_TOLERANCE_KEY = 'mmr_tolerance_v1';
const TEAM_SORT_LOCAL_KEY = 'team_sort_local_v1';

let teamSortLocal = 'name';

let rosterSortKey = 'name';   // name | line | score | wl | wr
let rosterSortAsc = true;     // true: 오름차순, false: 내림차순

let rosterSearchTerm = '';

const lineOptionsHTML = (sel) => ['T', 'J', 'M', 'B', 'S', 'A'].map(k => `<option value="${k}" ${sel === k ? 'selected' : ''} title="${LINE_TITLE[k]}">${k}</option>`).join('');

/* ============ 라인 배정 ============ */
function assignRoles(team) {
    const roles = ['T', 'J', 'M', 'B', 'S'], used = new Set(), assignment = {}; let primaryAssigned = 0;
    for (const r of roles) { const i = team.findIndex(p => !used.has(p.id) && normLine(p.mainLine) === r); if (i >= 0) { used.add(team[i].id); assignment[r] = team[i].id; primaryAssigned++; } }
    for (const r of roles) { if (assignment[r]) continue; const i = team.findIndex(p => !used.has(p.id) && normLine(p.subLine) === r); if (i >= 0) { used.add(team[i].id); assignment[r] = team[i].id; } }
    for (const r of roles) { if (assignment[r]) continue; const i = team.findIndex(p => !used.has(p.id) && (normLine(p.mainLine) === 'A' || normLine(p.subLine) === 'A')); if (i >= 0) { used.add(team[i].id); assignment[r] = team[i].id; } }
    return { coveredRoles: Object.keys(assignment).length, primaryAssigned };
}

/* ============ 평가 함수(핵심) ============ */
function scoreSplit(t1, t2, mode, allowDiff) {
    const m1 = avg(t1.map(p => p.score)), m2 = avg(t2.map(p => p.score)), diff = Math.abs(m1 - m2);
    const sdev = a => { const m = avg(a); return a.length ? Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length) : 0 };
    const s1 = sdev(t1.map(p => p.score)), s2 = sdev(t2.map(p => p.score));

    let a1 = { coveredRoles: 0, primaryAssigned: 0 }, a2 = { coveredRoles: 0, primaryAssigned: 0 };
    if (mode === 'prefer_line') { a1 = assignRoles(t1); a2 = assignRoles(t2); }

    // 파라미터
    let wCover = 0, wPrimary = 0, jitterAmp = 1.5, diversityW = 1.5, mmrDiv = 180;
    if (mode === 'prefer_line') { wCover = 12; wPrimary = 4; jitterAmp = 0.8; diversityW = 1.2; mmrDiv = 120; }
    else { jitterAmp = 4.0; diversityW = 4.0; mmrDiv = 200; }

    // ★ 라인 공정성 보너스: 주라인 더 많은 팀의 평균이 더 낮을수록 +
    let lineFairBonus = 0;
    if (mode === 'prefer_line') {
        const gap = (a1.primaryAssigned || 0) - (a2.primaryAssigned || 0); // +면 팀1이 주라인多
        if (gap !== 0) {
            const favSign = Math.sign(gap);                  // +1: 팀1 유리
            const fairRaw = favSign * (m2 - m1);            // 유리팀 평균이 낮을수록 +
            const wFair = 0.25;                             // 튜닝
            lineFairBonus = clamp(fairRaw * wFair * Math.abs(gap), -60, 60);
        }
    }

    // ★ 승률 보정 보너스: 평균 승률 낮은 팀의 평균 MMR이 더 높을수록 +
    let wrCompBonus = 0;
    {
        const wr1 = avg(t1.map(winRate)), wr2 = avg(t2.map(winRate));
        const wrGap = wr2 - wr1;                            // >0: 팀1 승률 낮음
        if (Math.abs(wrGap) > 0) {
            const favSign = Math.sign(wrGap);               // +1: 팀1 낮은 승률
            const compRaw = favSign * (m1 - m2);            // 낮은 승률 팀 평균이 높을수록 +
            const wWR = 0.30;                               // 튜닝
            const wrScale = clamp(Math.abs(wrGap) / 20, 0, 1); // 0~20% 구간 가중
            wrCompBonus = clamp(compRaw * wWR * (1 + wrScale * 0.5), -80, 80);
        }
    }

    // 페널티들
    const over = Math.max(0, diff - allowDiff);
    const mmrPenalty = (over * over) / mmrDiv;
    const spreadPenalty = Math.abs(s1 - s2) * 0.18;

    const ids1 = t1.map(p => p.id), ids2 = t2.map(p => p.id);
    const sameSideMax = countSameSideMultiEither(ids1, ids2);
    const total = (ids1.length + ids2.length) || 1;
    const identicalPenalty = (sameSideMax === total) ? 1e6 : 0;
    const diversityPenalty = sameSideMax * diversityW;

    // 하드 가드: 허용치 초과 강제 제재
    const hardPenalty = over > 0 ? over * over * 250 : 0;

    const jitter = (Math.random() - 0.5) * jitterAmp;

    return ((a1.coveredRoles + a2.coveredRoles) * wCover + (a1.primaryAssigned + a2.primaryAssigned) * wPrimary
        + lineFairBonus + wrCompBonus)
        - mmrPenalty - spreadPenalty - diversityPenalty - identicalPenalty - hardPenalty
        + jitter;
}

/* ============ 탐색/보정 ============ */
function improveBySwaps(pick, map, mode, allowDiff, rounds = 260, temp = 1.4, minChange = 2) {
    let best = JSON.parse(JSON.stringify(pick));
    let bestScore = scoreSplit(best.team1.map(id => map.get(id)), best.team2.map(id => map.get(id)), mode, allowDiff);
    let ids1 = best.team1.slice(), ids2 = best.team2.slice();

    for (let r = 0; r < rounds; r++) {
        const i = (Math.random() * ids1.length) | 0, j = (Math.random() * ids2.length) | 0;
        [ids1[i], ids2[j]] = [ids2[j], ids1[i]];
        const t1 = ids1.map(id => map.get(id)), t2 = ids2.map(id => map.get(id));
        let sc = scoreSplit(t1, t2, mode, allowDiff);

        const d1 = Math.abs(avg(t1.map(p => p.score)) - avg(t2.map(p => p.score)));
        if (d1 > allowDiff) sc -= (d1 - allowDiff) * 1e6;

        const changed = (ids1.length + ids2.length) - countSameSideEither(ids1, ids2, lastTeams);
        if (changed < minChange) sc -= (minChange - changed) * 15;

        const delta = sc - bestScore;
        if (delta >= 0 || Math.exp(delta / Math.max(0.001, temp)) > Math.random()) {
            bestScore = sc; best.team1 = ids1.slice(); best.team2 = ids2.slice();
        } else {
            [ids1[i], ids2[j]] = [ids2[j], ids1[i]];
        }
        temp *= 0.996;
    }
    return best;
}
function teamMeanByIds(ids, map) { if (!ids.length) return 0; let s = 0; for (const id of ids) s += map.get(id).score; return s / ids.length; }
function mmrDiffOfPick(pick, map) { return Math.abs(teamMeanByIds(pick.team1, map) - teamMeanByIds(pick.team2, map)); }
function reduceMMRGap(pick, map, targetDiff, maxIters = 120) {
    let iter = 0;
    while (iter++ < maxIters) {
        const before = mmrDiffOfPick(pick, map); if (before <= targetDiff) break;
        let bestGain = 0, bi = -1, bj = -1;
        for (let i = 0; i < pick.team1.length; i++) {
            for (let j = 0; j < pick.team2.length; j++) {
                const a = pick.team1[i], b = pick.team2[j];
                [pick.team1[i], pick.team2[j]] = [b, a];
                const after = mmrDiffOfPick(pick, map);
                [pick.team1[i], pick.team2[j]] = [a, b];
                const gain = before - after;
                if (gain > bestGain) { bestGain = gain; bi = i; bj = j; }
            }
        }
        if (bestGain > 0) { const a = pick.team1[bi], b = pick.team2[bj];[pick.team1[bi], pick.team2[bj]] = [b, a]; } else break;
    }
    return pick;
}

/* ============ 팀 빌드 ============ */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[a[i], a[j]] = [a[j], a[i]] } }
function buildBalancedTeams(players, mode = 'prefer_line') {
    const n = players.length, half = n / 2, idx = [...Array(n).keys()];
    const allowDiff = Math.max(0, Math.round(Number(mmrToleranceInput?.value || 120)));
    const strength = (mixStrengthSel?.value || 'normal');

    let attemptsBase, swapBase, tempBase, minChangeDiv;
    if (mode === 'prefer_line') { attemptsBase = 900; swapBase = 320; tempBase = 1.5; minChangeDiv = 4; }
    else { attemptsBase = 2000; swapBase = 800; tempBase = 3.0; minChangeDiv = 2; }

    const attempts = Math.min((strength === 'strong' ? attemptsBase * 2 : attemptsBase) * n, 30000);
    const swapRounds = (strength === 'strong' ? Math.round(swapBase * 1.4) : swapBase);
    const initTemp = (strength === 'strong' ? tempBase * 1.2 : tempBase);
    const minChange = Math.max(2, Math.floor(n / minChangeDiv));

    let evalPlayers = players;
    if (mode === 'prefer_mmr') evalPlayers = players.map(p => ({ ...p, score: p.score + (Math.random() - 0.5) * 20 }));
    const map = new Map(evalPlayers.map(p => [p.id, p]));

    let best = null, bestScore = -Infinity;
    for (let a = 0; a < attempts; a++) {
        shuffle(idx);
        const t1 = idx.slice(0, half).map(i => evalPlayers[i]);
        const t2 = idx.slice(half).map(i => evalPlayers[i]);
        let sc = scoreSplit(t1, t2, mode, allowDiff);

        const d0 = Math.abs(avg(t1.map(p => p.score)) - avg(t2.map(p => p.score)));
        if (d0 > allowDiff) sc -= (d0 - allowDiff) * 1e6;

        const same = countSameSideMultiEither(t1.map(p => p.id), t2.map(p => p.id));
        const changed = (t1.length + t2.length) - same;
        if (changed < minChange) sc -= (minChange - changed) * 20;

        if (sc > bestScore) { bestScore = sc; best = { team1: t1.map(p => p.id), team2: t2.map(p => p.id) }; }
    }
    if (!best) return { team1: evalPlayers.slice(0, half).map(p => p.id), team2: evalPlayers.slice(half).map(p => p.id) };

    best = improveBySwaps(best, map, mode, allowDiff, swapRounds, initTemp, minChange);

    // 다양성 최소 보장
    const total = best.team1.length + best.team2.length;
    let changed = total - countSameSideMultiEither(best.team1, best.team2);
    if (changed < minChange) {
        const need = minChange - changed;
        for (let k = 0; k < need; k++) {
            const i = (Math.random() * best.team1.length) | 0, j = (Math.random() * best.team2.length) | 0;
            [best.team1[i], best.team2[j]] = [best.team2[j], best.team1[i]];
        }
        if (mode === 'prefer_mmr') {
            for (let k = 0; k < best.team1.length; k++) {
                if (Math.random() < 0.3) {
                    const i = (Math.random() * best.team1.length) | 0, j = (Math.random() * best.team2.length) | 0;
                    [best.team1[i], best.team2[j]] = [best.team2[j], best.team1[i]];
                }
            }
        }
    }

    // 허용치 충족 보정
    best = reduceMMRGap(best, map, allowDiff);
    return best;
}

function updateRosterHeaderIndicators() {
    const ths = document.querySelectorAll('.rhead thead th.sortable');
    ths.forEach(th => {
        const key = th.getAttribute('data-sort');
        const ind = th.querySelector('.sort-ind');
        if (!ind) return;
        if (key === rosterSortKey) {
            ind.textContent = rosterSortAsc ? '▲' : '▼';
            ind.style.opacity = '1';
        } else {
            ind.textContent = '';
            ind.style.opacity = '.5';
        }
    });
}

/* ============ 렌더: 로스터/팀 ============ */
function renderRoster() {
    const key = rosterSortKey;
    const asc = rosterSortAsc ? 1 : -1;
    const term = rosterSearchTerm.trim().toLowerCase();

    const t1Set = new Set(currentTeams.team1 || []);
    const t2Set = new Set(currentTeams.team2 || []);

    const sorted = roster.slice().sort((a, b) => {
        const byName = a.name.localeCompare(b.name, 'ko');
        if (key === 'name') return asc * byName;

        if (key === 'line') {
            const la = (normLine(a.mainLine) + '/' + normLine(a.subLine));
            const lb = (normLine(b.mainLine) + '/' + normLine(b.subLine));
            const cmp = la.localeCompare(lb);
            return asc * (cmp || byName);
        }

        if (key === 'score') {
            const cmp = (a.score - b.score);
            return asc * (cmp || byName);
        }

        if (key === 'wl') {
            const wa = +a.wins || 0, wb = +b.wins || 0;
            const la = +a.losses || 0, lb = +b.losses || 0;
            const cmp = (wa - wb) || (lb - la); // 승 많을수록↑, 승 같으면 패 적을수록↑
            return asc * (cmp || byName);
        }

        if (key === 'wr') {
            const ra = winRate(a), rb = winRate(b);
            const cmp = (ra - rb);
            return asc * (cmp || byName);
        }

        if (key === 'games') {
            const ga = +a.games || 0, gb = +b.games || 0;
            const cmp = (ga - gb);
            return asc * (cmp || byName);
        }

        return byName;
    });
    const list = term ? sorted.filter(p => p.name.toLowerCase().includes(term)) : sorted;

    if (rosterSearchCount) {
        rosterSearchCount.textContent = term ? `검색 결과 ${list.length}명 / 전체 ${roster.length}명` : `전체 ${roster.length}명`;
    }

    rosterBody.innerHTML = '';
    list.forEach(p => {
        const tr = document.createElement('tr'); tr.setAttribute('draggable', 'true'); tr.dataset.id = p.id;
        if (t1Set.has(p.id)) tr.classList.add('in-team1');
        else if (t2Set.has(p.id)) tr.classList.add('in-team2');
        const rate = winRate(p);
        const p1 = normLine(p.mainLine || 'A'), p2 = normLine(p.subLine || 'A');
        const safe = escapeHtml(p.name);
        const highlighted = term ? safe.replace(new RegExp(`(${term.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>') : safe;
        tr.innerHTML = `
                    <td><input type="checkbox" data-id="${p.id}" class="rowcheck"></td>
                    <td class="cell-name" data-id="${p.id}" title="더블클릭으로 이름 수정">${highlighted}</td>
                    <td class="cell-line">
                        <select class="line-select cell-line1" data-id="${p.id}" title="주 라인">${lineOptionsHTML(p1)}</select>
                        <span class="line-slash">/</span>
                        <select class="line-select cell-line2" data-id="${p.id}" title="부 라인">${lineOptionsHTML(p2)}</select>
                    </td>
                    <td class="tabnum"><input data-id="${p.id}" class="cell-score" type="number" value="${p.score}" /></td>
                    <td class="tabnum"><input data-id="${p.id}" class="cell-games" type="number" min="0" value="${p.games || 0}" /></td>
                    <td class="tabnum"><span class="wl-badge" data-id="${p.id}">${p.wins || 0}/${p.losses || 0}</span></td>
                    <td class="tabnum"><span class="wr-badge ${wrClass(rate)}" data-id="${p.id}">${rate}%</span></td>
                `;
        rosterBody.appendChild(tr);
    });
    if (checkAll) checkAll.checked = false;
    updateSelectedUI();
    updateRosterHeaderIndicators();

    //touchSync();
}


function renderTeams() {
    const t1 = currentTeams.team1.map(id => roster.find(p => p.id === id)).filter(Boolean);
    const t2 = currentTeams.team2.map(id => roster.find(p => p.id === id)).filter(Boolean);
    const a1 = avg(t1.map(p => p.score)), a2 = avg(t2.map(p => p.score));
    document.getElementById('avg1').innerHTML = `평균 <span class="${a1 >= a2 ? 'good' : 'bad'}">${a1.toFixed(1)}</span>`;
    document.getElementById('avg2').innerHTML = `평균 <span class="${a2 >= a1 ? 'good' : 'bad'}">${a2.toFixed(1)}</span>`;

    const sortKey = teamSortLocal || 'name';

    const cmp = (a, b) => {
        if (sortKey === 'name') return a.name.localeCompare(b.name, 'ko');
        if (sortKey === 'line') return linePair(a).localeCompare(linePair(b));
        if (sortKey === 'wr') return (winRate(b) - winRate(a)) || a.name.localeCompare(b.name, 'ko');
        if (sortKey === 'score') return (b.score - a.score) || a.name.localeCompare(b.name, 'ko');
        return 0;
    };
    t1.sort(cmp); t2.sort(cmp);

    team1UL.innerHTML = ''; team2UL.innerHTML = '';
    const makeRow = p => {
        const wr = winRate(p);
        const li = document.createElement('li');
        li.className = 'teamRow';
        li.setAttribute('draggable', 'true');
        li.dataset.id = p.id;
        // 읽기 전용이면 드래그 시작 금지
        li.addEventListener('dragstart', (e) => {
            if (!canEdit()) { e.preventDefault(); }
        });
        const deltaHTML = (typeof p.lastDelta === 'number' && p.lastDelta !== 0)
            ? `<span class="delta" style="color:${p.lastDelta > 0 ? '#22c55e' : '#ef4444'};">
         ${p.lastDelta > 0 ? '+' : ''}${p.lastDelta}
       </span>`
            : '';

        li.innerHTML = `
                    <span class="cell-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
                    <span class="cell-line tabnum" title="${LINE_TITLE[normLine(p.mainLine)]}/${LINE_TITLE[normLine(p.subLine)]}">
                        ${linePair(p)}
                    </span>
                    <span class="cell-wr tabnum ${wrClass(wr)}">${wr}%</span>
                    <span class="cell-score tabnum">
    <span class="score-num">${p.score}</span>${deltaHTML}
  </span>
                `;

        li.addEventListener('dragstart', e => {
            if (!canEdit()) { e.preventDefault(); return; }
            e.dataTransfer.setData('text/plain', p.id);
            e.dataTransfer.effectAllowed = 'move';
        });
        return li;
    };

    t1.forEach(p => team1UL.appendChild(makeRow(p)));
    t2.forEach(p => team2UL.appendChild(makeRow(p)));

    //touchSync();
}

/* ============ 드래그/드롭 ============ */
function bindDropTarget(ulEl, boxEl, teamNo) {
    const onDragOver = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
    const onDragEnter = () => boxEl.classList.add('drop-target');
    const onDragLeave = e => { if (!boxEl.contains(e.relatedTarget)) boxEl.classList.remove('drop-target'); };
    const onDrop = e => {
        if (!canEdit()) { e.preventDefault(); return; }
        e.preventDefault(); boxEl.classList.remove('drop-target');
        const id = e.dataTransfer.getData('text/plain');
        if (!id) return;
        addIdToTeam(teamNo, id, true);
    };
    ulEl.addEventListener('dragover', onDragOver);
    ulEl.addEventListener('dragenter', onDragEnter);
    ulEl.addEventListener('dragleave', onDragLeave);
    ulEl.addEventListener('drop', onDrop);
    boxEl.addEventListener('dragover', onDragOver);
    boxEl.addEventListener('dragenter', onDragEnter);
    boxEl.addEventListener('dragleave', onDragLeave);
    boxEl.addEventListener('drop', onDrop);
}
bindDropTarget(team1UL, team1Box, 1);
bindDropTarget(team2UL, team2Box, 2);

rosterBody.addEventListener('dragover', e => { e.preventDefault(); rosterBody.classList.add('drop-target'); });
rosterBody.addEventListener('dragleave', e => { if (!rosterBody.contains(e.relatedTarget)) rosterBody.classList.remove('drop-target'); });
rosterBody.addEventListener('drop', e => {
    e.preventDefault(); rosterBody.classList.remove('drop-target');
    if (!canEdit()) { e.preventDefault(); return; }
    const id = e.dataTransfer.getData('text/plain'); if (!id) return;
    currentTeams.team1 = currentTeams.team1.filter(x => x !== id);
    currentTeams.team2 = currentTeams.team2.filter(x => x !== id);
    renderTeams();
    renderRoster();
    touchSync();
});
rosterBody.addEventListener('dragstart', e => {
    if (!canEdit()) { e.preventDefault(); return; }
    // 입력 요소에서 시작하면 드래그 취소 (편집 방해 방지)
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return;

    const tr = e.target.closest('tr[draggable="true"]');
    if (!tr) return;

    const id = tr.dataset.id;
    if (id && e.dataTransfer) {
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'move';
    }
});

function addIdToTeam(teamNo, id, doSync = false) {
    if (!requireOwner()) return;
    if (!id) return;
    const other = teamNo === 1 ? currentTeams.team2 : currentTeams.team1;
    const target = teamNo === 1 ? currentTeams.team1 : currentTeams.team2;
    const otherSet = new Set(other), targetSet = new Set(target);
    if (otherSet.has(id)) otherSet.delete(id);
    targetSet.add(id);
    if (teamNo === 1) { currentTeams.team2 = [...otherSet]; currentTeams.team1 = [...targetSet]; }
    else { currentTeams.team1 = [...otherSet]; currentTeams.team2 = [...targetSet]; }

    roster.forEach(p => p.lastDelta = 0);

    renderTeams();
    renderRoster();
    if (doSync) touchSync();
}

/* ============ 이벤트/액션 ============ */
// 로스터 셀 변경
rosterBody.addEventListener('change', e => {
    // 보기전용이면 체크박스(rowcheck) 외에는 막기
    if (!canEdit()) {
        if (!e.target.classList.contains('rowcheck')) {
            alert('읽기 전용 모드입니다. (호스트만 조작 가능)');
            e.preventDefault();
            return;
        }
    }
    const t = e.target, id = t.dataset.id, p = roster.find(x => x.id === id); if (!p) {
        if (t.classList.contains('rowcheck')) { updateSelectedUI(); }
        return;
    }
    if (t.classList.contains('rowcheck')) { updateSelectedUI(); return; }
    if (t.classList.contains('cell-line1')) p.mainLine = normLine(t.value);
    else if (t.classList.contains('cell-line2')) p.subLine = normLine(t.value);
    else if (t.classList.contains('cell-score')) p.score = isFinite(+t.value) ? +t.value : p.score;
    else if (t.classList.contains('cell-games')) p.games = Math.max(0, Math.floor(+t.value || 0));
    saveLocal(); renderTeams(); touchSync();
});


// 로스터 승패 초기화
rosterBody.addEventListener('dblclick', e => {
    if (!canEdit()) return;
    const wl = e.target.closest('.wl-badge'); if (!wl) return;
    const p = roster.find(x => x.id === wl.dataset.id); if (!p) return;
    if (confirm(`"${p.name}"의 승패를 초기화하시겠습니까?`)) {
        p.wins = 0; p.losses = 0; saveLocal(); renderRoster(); renderTeams();
    }
});

// 전체선택
checkAll.addEventListener('change', () => {
    document.querySelectorAll('.rowcheck').forEach(cb => cb.checked = checkAll.checked);
    updateSelectedUI(); // 추가
});

// 검색
let _searchTimer = null;
function setSearchTerm(v) { rosterSearchTerm = (v || '').slice(0, 50); renderRoster(); }
if (rosterSearchInput) {
    rosterSearchInput.addEventListener('input', (e) => {
        const v = e.target.value;
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(() => { setSearchTerm(v); updateSelectedUI(); }, 120);
    });
}
if (rosterSearchClear) {
    rosterSearchClear.addEventListener('click', () => {
        rosterSearchInput.value = '';
        setSearchTerm('');
        rosterSearchInput.focus();
        updateSelectedUI();
    });
}

function getSelectedIds() {
    return [...document.querySelectorAll('.rowcheck:checked')].map(cb => cb.dataset.id);
}

function updateSelectedUI() {
    const ids = getSelectedIds();
    const names = ids
        .map(id => (roster.find(p => p.id === id) || {}).name)
        .filter(Boolean);

    // 기존 "전체/검색 결과" 문구는 그대로 유지
    const total = roster.length;
    if (rosterSearchCount) {
        // 현재 화면에 표시된 행 수(검색 적용 후) 반영
        const visibleCount = document.querySelectorAll('#rosterBody tr').length;
        const term = (rosterSearchTerm || '').trim();
        const base = term
            ? `검색 결과 ${visibleCount}명 / 전체 ${total}명`
            : `전체 ${total}명`;
        rosterSearchCount.textContent = base;
    }

    // 선택 요약 출력 (이름은 많으면 접기)
    if (selectedNamesEl) {
        if (ids.length) {
            const MAX = 8;
            const shown = names.slice(0, MAX);
            const more = names.length - shown.length;
            selectedNamesEl.textContent =
                ` | 선택 ${ids.length}명`;
        } else {
            selectedNamesEl.textContent = '';
        }
    }
}

function toggleScoringControls() {
    const mode = (scoringModeSel && scoringModeSel.value) || 'elo';
    if (mode === 'elo') {
        if (eloKWrap) eloKWrap.style.display = '';
        if (winBonusWrap) winBonusWrap.style.display = 'none';
    } else { // fixed
        if (eloKWrap) eloKWrap.style.display = 'none';
        if (winBonusWrap) winBonusWrap.style.display = '';
    }
}

// 인원 추가/삭제
document.getElementById('btnAdd').addEventListener('click', () => {
    let name = (nameInput.value || '').trim(); const score = +scoreInput.value || 0;
    const pLine = normLine(linePrimaryInput.value || 'A'), sLine = normLine(lineSecondaryInput.value || 'A');
    if (!name) { alert('이름을 입력하세요.'); nameInput.focus(); return; }
    if (name.length > 16) { alert('이름은 최대 16자까지만 가능합니다.'); name = name.slice(0, 16); }
    roster.push({ id: uid(), name, score, games: 0, wins: 0, losses: 0, mainLine: pLine, subLine: sLine });
    saveLocal(); renderRoster(); renderTeams();
    nameInput.value = ''; scoreInput.value = '1000'; linePrimaryInput.value = 'A'; lineSecondaryInput.value = 'A'; nameInput.focus();
});

document.getElementById('btnDelete').addEventListener('click', () => {
    const ids = new Set([...document.querySelectorAll('.rowcheck:checked')].map(cb => cb.dataset.id));
    if (!ids.size) { alert('삭제할 인원을 선택하세요.'); return; }
    const names = roster.filter(p => ids.has(p.id)).map(p => p.name).join(', ');
    if (!confirm(`정말 삭제하시겠습니까?\n${names}`)) return;
    roster = roster.filter(p => !ids.has(p.id));
    currentTeams.team1 = currentTeams.team1.filter(id => !ids.has(id));
    currentTeams.team2 = currentTeams.team2.filter(id => !ids.has(id));
    saveLocal(); renderRoster(); renderTeams();
});

// 저장/불러오기
document.getElementById('btnSave').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(roster, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');

    // YYMMDD_HHMM 구성
    const yy = String(now.getFullYear()).slice(-2);
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const HH = pad(now.getHours());
    const MM = pad(now.getMinutes());

    a.href = url;
    a.download = `member_${yy}${mm}${dd}_${HH}${MM}.txt`; // 예: member_250926_1320.txt
    a.click();
    URL.revokeObjectURL(url);
});

// ===== XLSX 내보내기 (Excel) - 현재 정렬 상태 유지, 검색 필터 무시 =====

// 현재 테이블 정렬 상태(헤더 클릭으로 정한 rosterSortKey/rosterSortAsc)를 그대로 사용
function getSortedRosterForExport() {
    const key = rosterSortKey;
    const asc = rosterSortAsc ? 1 : -1;

    // 검색어 필터는 내보내지 않으므로 roster 전체를 정렬만 적용
    const sorted = roster.slice().sort((a, b) => {
        const byName = a.name.localeCompare(b.name, 'ko');

        if (key === 'name') return asc * byName;

        if (key === 'line') {
            const la = (normLine(a.mainLine) + '/' + normLine(a.subLine));
            const lb = (normLine(b.mainLine) + '/' + normLine(b.subLine));
            const cmp = la.localeCompare(lb);
            return asc * (cmp || byName);
        }

        if (key === 'score') {
            const cmp = (a.score - b.score);
            return asc * (cmp || byName);
        }

        if (key === 'wl') {
            const wa = +a.wins || 0, wb = +b.wins || 0;
            const la = +a.losses || 0, lb = +b.losses || 0;
            const cmp = (wa - wb) || (lb - la); // 승 많을수록↑, 승 같으면 패 적을수록↑
            return asc * (cmp || byName);
        }

        if (key === 'wr') {
            const ra = winRate(a), rb = winRate(b);
            const cmp = (ra - rb);
            return asc * (cmp || byName);
        }

        if (key === 'games') {
            const ga = +a.games || 0, gb = +b.games || 0;
            const cmp = (ga - gb);
            return asc * (cmp || byName);
        }

        return byName;
    });

    return sorted;
}

// ===== XLSX 내보내기 (ExcelJS) - 현재 정렬 상태 유지 + 스타일 =====
async function exportRosterXLSX({ onlySelected = false } = {}) {
    if (typeof ExcelJS === 'undefined') {
        alert('ExcelJS 로더를 찾을 수 없습니다. 스크립트 태그를 확인하세요.');
        return;
    }

    let list = getSortedRosterForExport(); // 현재 정렬 상태 그대로 사용

    if (onlySelected) {
        const ids = new Set(getSelectedIds());
        list = list.filter(p => ids.has(p.id));
    }

    // 워크북/시트 생성
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('멤버목록', {
        properties: { defaultRowHeight: 18 }
    });

    // 컬럼 정의 (이름 / 점수 / 판수 / 승 / 패 / 승률% / 주라인 / 부라인)
    ws.columns = [
        { header: '이름', key: 'name', width: 45 },
        { header: '점수', key: 'score', width: 10 },
        { header: '판수', key: 'games', width: 13 },
        { header: '승', key: 'wins', width: 12 },
        { header: '패', key: 'losses', width: 12 },
        { header: '승률(%)', key: 'wr', width: 10 },
        { header: '주라인', key: 'main', width: 10 },
        { header: '부라인', key: 'sub', width: 10 },
    ];

    // 데이터 행 추가
    list.forEach(p => {
        ws.addRow({
            name: p.name,
            score: p.score,
            games: p.games || 0,
            wins: p.wins || 0,
            losses: p.losses || 0,
            wr: winRate(p),
            main: normLine(p.mainLine),
            sub: normLine(p.subLine),
        });
    });

    // 헤더 스타일 (다크 톤 + 볼드 + 가운데 정렬)
    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell) => {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF20304A' } // #20304a
        };
        cell.font = { bold: true, color: { argb: 'FFE6EEF8' } }; // #e6eef8
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.border = {
            bottom: { style: 'thin', color: { argb: 'FF1C2B45' } }
        };
    });

    // 보기 옵션: 헤더 고정
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    // 본문 스타일: 이름(A), 주라인(G), 부라인(H) 가운데 정렬
    // 숫자 컬럼은 오른쪽 정렬
    for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);

        // 가운데: A(1), G(7), H(8)
        [1, 7, 8].forEach(c => {
            row.getCell(c).alignment = { vertical: 'middle', horizontal: 'center' };
        });

        // 오른쪽: 점수(B2), 판수(C3), 승(D4), 패(E5), 승률(F6)
        [2, 3, 4, 5, 6].forEach(c => {
            row.getCell(c).alignment = { vertical: 'middle', horizontal: 'right' };
        });
    }

    // 파일명: member_YYMMDD_HHMM.xlsx
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const HH = pad(now.getHours());
    const MM = pad(now.getMinutes());
    const filename = `member_${yy}${mm}${dd}_${HH}${MM}.xlsx`;

    // 저장
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}


// 버튼 클릭 → 선택된 인원만 내보낼지 확인
document.getElementById('btnExportXLSX').addEventListener('click', () => {
    const ids = getSelectedIds();
    if (ids.length > 0) {
        const onlySelected = confirm('선택된 인원만 내보낼까요?\n(확인: 선택만, 취소: 전체)');
        exportRosterXLSX({ onlySelected });
    } else {
        exportRosterXLSX({ onlySelected: false });
    }
});


window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
    // managePanel 외부에 드롭하면 네비게이션 방지
    if (!(e.target && managePanel && managePanel.contains(e.target))) {
        e.preventDefault();
    }
});

// 패널 하이라이트 on/off
['dragenter', 'dragover'].forEach(ev => {
    managePanel.addEventListener(ev, e => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
        e.preventDefault(); e.stopPropagation();
        managePanel.classList.add('dragover');
    });
});
['dragleave', 'drop'].forEach(ev => {
    managePanel.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation();
        managePanel.classList.remove('dragover');
    });
});

// 실제 드롭 처리
managePanel.addEventListener('drop', e => {
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return;
    const f = files[0];
    const name = (f.name || '').toLowerCase();

    if (name.endsWith('.xlsx')) {
        const reader = new FileReader();
        reader.onload = () => loadFromXLSX(reader.result);
        reader.readAsArrayBuffer(f);
        return;
    }

    if (name.endsWith('.txt') || name.endsWith('.json')) {
        const reader = new FileReader();
        reader.onload = () => loadFromText(String(reader.result || ''));
        reader.readAsText(f, 'utf-8');
        return;
    }

    alert('지원하지 않는 형식입니다. .txt, .json 또는 .xlsx 파일을 사용하세요.');
});
function loadFromText(text) {
    try {
        let data;
        const trimmed = String(text || '').trim();

        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            data = JSON.parse(trimmed);
        } else {
            // 텍스트(CSV풍): 이름, 점수, 판수, 승, 패, 주라인, 부라인
            data = trimmed.split(/\r?\n/).map(line => {
                if (!line.trim()) return null;
                const a = line.split(',').map(s => s.trim());
                if (!a[0]) return null;
                return {
                    name: a[0],
                    score: +a[1] || 0,
                    games: a[2] ? Math.floor(+a[2] || 0) : 0,
                    wins: a[3] ? Math.floor(+a[3] || 0) : 0,
                    losses: a[4] ? Math.floor(+a[4] || 0) : 0,
                    mainLine: a[5],
                    subLine: a[6]
                };
            }).filter(Boolean);
        }
        if (!Array.isArray(data)) data = [data];

        // 검증 + 보정
        const imported = [];
        const errs = [];

        data.forEach((it, i) => {
            const rowNo = i + 1; // 텍스트는 대략 행 번호만
            let name = String(it.name || '').slice(0, 16);
            if (!name) return; // 빈 이름은 스킵
            if (/^[=+\-@]/.test(name)) name = "'" + name;

            const score = Number(it.score) || 0; // 점수는 음수 허용 요청 없음
            const games = Math.floor(Number(it.games) || 0);
            const wins = Math.floor(Number(it.wins) || 0);
            const losses = Math.floor(Number(it.losses) || 0);

            if (games < 0 || wins < 0 || losses < 0) {
                errs.push(`행 ${rowNo}: 음수 값(games/wins/losses)`);
            }

            const toLetter = (v) => String(v || 'A').trim().toUpperCase().slice(0, 1);
            const mainLine = normLine(toLetter(it.mainLine || 'A')); // 허용 외 → A
            const subLine = normLine(toLetter(it.subLine || 'A'));

            imported.push({
                id: uid(),
                name,
                score,
                games,
                wins,
                losses,
                mainLine,
                subLine
            });
        });

        if (errs.length) {
            const preview = errs.slice(0, 5).join('\n');
            alert(`텍스트/JSON 불러오기 실패: 음수 값이 감지되었습니다.\n${preview}${errs.length > 5 ? `\n...외 ${errs.length - 5}건` : ''}`);
            return;
        }

        if (!imported.length) {
            alert('유효한 데이터 행을 찾지 못했습니다.');
            return;
        }

        const prevCount = roster.length; // ★ 기존 인원 수 저장

        roster = imported;
        const valid = new Set(roster.map(p => p.id));
        currentTeams.team1 = currentTeams.team1.filter(id => valid.has(id));
        currentTeams.team2 = currentTeams.team2.filter(id => valid.has(id));

        saveLocal(); renderRoster(); renderTeams();

        alert(`${imported.length}명의 데이터를 불러와 인원 목록을 교체했습니다.`);
    } catch (e) {
        console.error(e);
        alert('불러오기 실패: 파일 형식을 확인하세요.');
    }
}


function loadFromXLSX(arrayBuffer) {
    try {
        const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
        const first = wb.SheetNames && wb.SheetNames[0];
        if (!first) { alert('시트를 찾을 수 없습니다.'); return; }
        const ws = wb.Sheets[first];

        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
        if (!rows.length) { alert('빈 시트입니다.'); return; }

        const header = rows[0].map(x => String(x || '').trim());
        const dataRows = rows.slice(1);

        const norm = s => String(s || '')
            .replace(/\s+/g, '')
            .replace(/[^가-힣a-zA-Z0-9]/g, '')
            .toLowerCase();

        const headerIdx = {};
        header.forEach((h, i) => { headerIdx[norm(h)] = i; });

        const pick = (...alts) => {
            for (const a of alts) {
                const i = headerIdx[norm(a)];
                if (i !== undefined) return i;
            }
            return null;
        };

        const idxName = pick('이름', 'name');
        const idxScore = pick('점수', 'score');
        const idxGames = pick('판수', 'games');
        const idxWins = pick('승', 'wins');
        const idxLosses = pick('패', 'losses');
        const idxMain = pick('주라인', '주 라인', 'mainline');
        const idxSub = pick('부라인', '부 라인', 'subline');

        if (idxName === null) {
            alert('엑셀에 "이름" 열이 필요합니다. (내보낸 형식을 사용해주세요)');
            return;
        }

        const get = (row, i, d = '') =>
            (i === null || row[i] === undefined || row[i] === null) ? d : String(row[i]).trim();

        const toInt = (v, def = 0) => {
            const n = Number(String(v).trim());
            return Number.isFinite(n) ? Math.floor(n) : def;
        };

        const toLetter = (v) => String(v || 'A').trim().toUpperCase().slice(0, 1);

        const imported = [];
        const errs = [];

        dataRows.forEach((r, idx) => {
            const rowNo = idx + 2; // 헤더 다음줄이 2행
            let name = get(r, idxName, '');
            if (!name) return; // 빈 이름은 스킵

            // 이름 최대 16자 + 수식 주입 방지
            name = name.slice(0, 16);
            if (/^[=+\-@]/.test(name)) name = "'" + name;

            const score = Number(get(r, idxScore, 0)) || 0; // 점수는 음수 허용 요청 없음
            const games = toInt(get(r, idxGames, 0), 0);
            const wins = toInt(get(r, idxWins, 0), 0);
            const losses = toInt(get(r, idxLosses, 0), 0);

            if (games < 0 || wins < 0 || losses < 0) {
                errs.push(`행 ${rowNo}: 음수 값(games/wins/losses)`);
            }

            const mainLine = normLine(toLetter(get(r, idxMain, 'A'))); // 허용 외 → A
            const subLine = normLine(toLetter(get(r, idxSub, 'A'))); // 허용 외 → A

            imported.push({
                id: uid(),
                name,
                score,
                games,
                wins,
                losses,
                mainLine,
                subLine
            });
        });

        if (errs.length) {
            const preview = errs.slice(0, 5).join('\n');
            alert(`엑셀 불러오기 실패: 음수 값이 감지되었습니다.\n${preview}${errs.length > 5 ? `\n...외 ${errs.length - 5}건` : ''}`);
            return;
        }

        if (!imported.length) {
            alert('유효한 데이터 행을 찾지 못했습니다.');
            return;
        }

        roster = imported;
        const valid = new Set(roster.map(p => p.id));
        currentTeams.team1 = currentTeams.team1.filter(id => valid.has(id));
        currentTeams.team2 = currentTeams.team2.filter(id => valid.has(id));
        saveLocal(); renderRoster(); renderTeams();

        alert(`${imported.length}명의 데이터를 XLSX에서 불러와 인원 목록을 교체했습니다.`);
    } catch (e) {
        console.error(e);
        alert('XLSX 불러오기 중 오류가 발생했습니다.');
    }
}




document.getElementById('btnLoad').addEventListener('click', () => {
    const f = fileInput.files?.[0];
    if (!f) { alert('불러올 파일을 선택하세요.'); fileInput.click(); return; }

    const name = f.name.toLowerCase();

    // 확장자 분기
    if (name.endsWith('.xlsx')) {
        // XLSX는 이진이므로 ArrayBuffer로 읽기
        const reader = new FileReader();
        reader.onload = () => loadFromXLSX(reader.result);
        reader.readAsArrayBuffer(f);
    } else if (name.endsWith('.txt') || name.endsWith('.json')) {
        // 텍스트 계열은 문자열로 읽기
        const reader = new FileReader();
        reader.onload = () => loadFromText(String(reader.result || ''));
        reader.readAsText(f, 'utf-8');
    } else {
        alert('지원하지 않는 형식입니다. .txt, .json 또는 .xlsx 파일을 사용하세요.');
    }
});

// 팀 만들기/리메이크/정렬
function teamsAlmostSame(a, b) {
    const A1 = new Set(a.team1), A2 = new Set(a.team2), tot = (a.team1.length + a.team2.length) || 1;
    let same = 0; for (const id of b.team1) if (A1.has(id)) same++; for (const id of b.team2) if (A2.has(id)) same++;
    let sameSwap = 0; for (const id of b.team1) if (A2.has(id)) sameSwap++; for (const id of b.team2) if (A1.has(id)) sameSwap++;
    return Math.max(same, sameSwap) / tot >= 0.85;
}

document.getElementById('btnMakeTeams').addEventListener('click', () => {
    if (!requireOwner()) return;
    const ids = [...document.querySelectorAll('.rowcheck:checked')].map(cb => cb.dataset.id);
    if (ids.length < 2 || ids.length % 2 !== 0) { alert('짝수 인원을 선택하세요. (현재 ' + ids.length + '명)'); return; }
    const players = ids.map(id => roster.find(p => p.id === id)).filter(Boolean);
    const mode = (balanceModeSel && balanceModeSel.value) || 'prefer_line';
    let pick = buildBalancedTeams(players, mode);
    if (teamsAlmostSame(pick, lastTeams) && mode !== 'prefer_line') {
        const bakT = mmrToleranceInput.value, bakS = mixStrengthSel.value;
        mmrToleranceInput.value = String(Math.floor(Number(bakT || 120) * 1.5)); mixStrengthSel.value = 'strong';
        pick = buildBalancedTeams(players, mode);
        mmrToleranceInput.value = bakT; mixStrengthSel.value = bakS;
    }
    currentTeams = pick;
    renderTeams();
    renderRoster();
    lastTeams = JSON.parse(JSON.stringify(currentTeams));

    touchSync();
});

document.getElementById('btnRemakeTeams').addEventListener('click', () => {
    if (!requireOwner()) return;
    const all = [...currentTeams.team1, ...currentTeams.team2];
    if (all.length < 2 || all.length % 2 !== 0) {
        alert('먼저 짝수 인원으로 팀을 만들어주세요. (현재 ' + all.length + '명)');
        return;
    }
    const players = all.map(id => roster.find(p => p.id === id)).filter(Boolean);
    if (players.length !== all.length) {
        alert('일부 멤버가 목록에서 사라졌습니다. 다시 선택해서 팀을 만들어주세요.');
        return;
    }

    roster.forEach(p => p.lastDelta = 0);

    currentTeams = buildBalancedTeams(players, (balanceModeSel && balanceModeSel.value) || 'prefer_line');
    renderTeams();
    renderRoster();
    lastTeams = JSON.parse(JSON.stringify(currentTeams));

    touchSync();
});


document.getElementById('btnClearTeams').addEventListener('click', () => {
    if (!requireOwner()) return;
    roster.forEach(p => p.lastDelta = 0);

    currentTeams = { team1: [], team2: [] };
    lastTeams = { team1: [], team2: [] };
    renderTeams();
    document.getElementById('avg1').textContent = '평균 0';
    document.getElementById('avg2').textContent = '평균 0';
    touchSync();
});

// 선택 이동/제거
document.getElementById('btnToTeam1').addEventListener('click', () => {
    if (!requireOwner()) return;
    const ids = [...document.querySelectorAll('.rowcheck:checked')].map(cb => cb.dataset.id);
    if (!ids.length) { alert('팀에 넣을 인원을 체크하세요.'); return; }
    ids.forEach(id => addIdToTeam(1, id));
    touchSync();
});
document.getElementById('btnToTeam2').addEventListener('click', () => {
    if (!requireOwner()) return;
    const ids = [...document.querySelectorAll('.rowcheck:checked')].map(cb => cb.dataset.id);
    if (!ids.length) { alert('팀에 넣을 인원을 체크하세요.'); return; }
    ids.forEach(id => addIdToTeam(2, id));
    touchSync();
});
document.getElementById('btnRemoveFromTeams').addEventListener('click', () => {
    if (!requireOwner()) return;
    const ids = new Set([...document.querySelectorAll('.rowcheck:checked')].map(cb => cb.dataset.id));
    if (!ids.size) { alert('팀에서 제거할 인원을 체크하세요.'); return; }
    currentTeams.team1 = currentTeams.team1.filter(id => !ids.has(id));
    currentTeams.team2 = currentTeams.team2.filter(id => !ids.has(id));
    renderTeams();
    renderRoster();
    touchSync();
});

// 승패 반영
function confirmAndApply(winTeam) {
    if (!requireOwner()) return;
    const n1 = currentTeams.team1.length, n2 = currentTeams.team2.length;
    if (n1 === 0 || n2 === 0 || n1 !== n2) { alert('먼저 짝수 인원으로 팀을 만들어주세요.'); return; }

    if (typeof WIN_LOCK !== 'undefined' && WIN_LOCK) {
        return; // 아무 것도 하지 않음
    }
    
    const msg = `${winTeam === 1 ? '1팀 승리' : '2팀 승리'}로 점수를 반영할까요?`;
    if (confirm(msg)) applyResult(winTeam);
}
document.getElementById('btnWin1').addEventListener('click', () => confirmAndApply(1));
document.getElementById('btnWin2').addEventListener('click', () => confirmAndApply(2));

async function applyResult(winTeam) {
    if (WIN_LOCK) return;    // 연타 차단
    lockWinButtons(true);    // 잠금 시작

    const ids1 = new Set(currentTeams.team1), ids2 = new Set(currentTeams.team2);
    if (ids1.size === 0 || ids2.size === 0 || ids1.size !== ids2.size) { alert('먼저 짝수 인원으로 팀을 만들어주세요.'); return; }
    // === 되돌리기 스냅샷(변경 전) 저장 ===
    const affectedIds = [...ids1, ...ids2];
    const undoSnapshot = affectedIds.map(id => {
        const p = roster.find(x => x.id === id);
        return p ? {
            id: p.id,
            score: p.score,
            games: p.games || 0,
            wins: p.wins || 0,
            losses: p.losses || 0,
            lastDelta: p.lastDelta || 0
        } : null;
    }).filter(Boolean);

    roster.forEach(p => p.lastDelta = 0);

    const targetBox = (winTeam === 1) ? team1Box : team2Box;
    launchConfetti(targetBox, { duration: 1800, count: 180 });

    const team1 = roster.filter(p => ids1.has(p.id)), team2 = roster.filter(p => ids2.has(p.id));
    const mode = (scoringModeSel && scoringModeSel.value) || 'fixed';

    if (mode === 'elo') {
        const R1 = avg(team1.map(p => p.score)), R2 = avg(team2.map(p => p.score));
        const E1 = 1 / (1 + Math.pow(10, (R2 - R1) / 400)), E2 = 1 - E1;
        const K = Math.round(Number(eloKInput && eloKInput.value ? eloKInput.value : 32)) || 32;
        const S1 = (winTeam === 1 ? 1 : 0), S2 = (winTeam === 2 ? 1 : 0);
        const d1 = K * (S1 - E1), d2 = K * (S2 - E2);

        team1.forEach(p => {
            const mult = isPlacement(p.games) ? 2 : 1;
            const change = Math.round(d1 * mult);
            p.lastDelta = change;
            p.score = Math.round(clamp(p.score + change, -9999, 9999));
            p.games = (p.games || 0) + 1;
            if (winTeam === 1) p.wins = (p.wins || 0) + 1; else p.losses = (p.losses || 0) + 1;
        });

        team2.forEach(p => {
            const mult = isPlacement(p.games) ? 2 : 1;
            const change = Math.round(d2 * mult);
            p.lastDelta = change;
            p.score = Math.round(clamp(p.score + change, -9999, 9999));
            p.games = (p.games || 0) + 1;
            if (winTeam === 2) p.wins = (p.wins || 0) + 1; else p.losses = (p.losses || 0) + 1;
        });
    } else {
        const delta = Math.round(Number(winBonusInput && winBonusInput.value ? winBonusInput.value : 10)) || 10;
        roster.forEach(p => {
            const in1 = ids1.has(p.id), in2 = ids2.has(p.id);
            if (!in1 && !in2) return;

            const mult = isPlacement(p.games) ? 2 : 1;
            let change = 0;
            if (in1) change = (winTeam === 1 ? delta * mult : -delta * mult);
            if (in2) change = (winTeam === 2 ? delta * mult : -delta * mult);

            p.lastDelta = change; // ★ 기록
            p.score = Math.round(clamp(p.score + change, -9999, 9999));
            p.games = (p.games || 0) + 1;

            if (in1) { if (winTeam === 1) p.wins = (p.wins || 0) + 1; else p.losses = (p.losses || 0) + 1; }
            if (in2) { if (winTeam === 2) p.wins = (p.wins || 0) + 1; else p.losses = (p.losses || 0) + 1; }
        });
    }
    // 점수 변화 수집(플레이어별 delta)
    const deltaById = {};
    [...ids1, ...ids2].forEach(id => {
        const p = roster.find(x => x.id === id);
        if (p) deltaById[id] = p.lastDelta || 0;
    });

    // 히스토리 한 건 추가
    matchHistory.push({
        ts: Date.now(),
        roomId: SYNC.roomId || null,
        team1: Array.from(ids1),
        team2: Array.from(ids2),
        winner: winTeam,     // 1 또는 2
        mode: (scoringModeSel && scoringModeSel.value) || 'fixed',
        eloK: +eloKInput?.value || 60,
        winBonus: +winBonusInput?.value || 30,
        deltaById
    });
    // 너무 길어지지 않게 제한(예: 최근 100경기만 보관)
    if (matchHistory.length > 100) matchHistory.shift();

    saveLocal(); renderRoster(); renderTeams();

    // 승리 브로드캐스트: 상태 저장 + winEvent를 한 번의 set으로 처리 (삭제 없음)
    if (SYNC.enabled && SYNC.roomId) {
        const ts = Date.now();
        SYNC.lastEmittedTs = ts; // 내가 쏜 이벤트 ts 기억(중복 방지)
        try {
            await db.collection('rooms').doc(SYNC.roomId).set({
                ts,
                expireAt: new Date(ts + 1000 * 60 * 60 * 24 * 7),
                ...packState(),               // 최신 상태 통째로
                winEvent: { ts, team: winTeam } // 유지형 이벤트(삭제하지 않음)
            }, { merge: true });
        } catch (e) {
            console.warn('[SYNC] winEvent publish error', e);
        }
    }


    // === undo 가능 상태로 기록 ===
    lastResultUndo = { snapshot: undoSnapshot };
    setUndoEnabled(true);
    touchSync();

    setTimeout(() => lockWinButtons(false), WIN_COOLDOWN_MS);
}

function undoLastResult() {
    if (!requireOwner()) return;
    if (!lastResultUndo || !lastResultUndo.snapshot || !lastResultUndo.snapshot.length) {
        alert('되돌릴 결과가 없습니다.');
        return;
    }
    const map = new Map(lastResultUndo.snapshot.map(s => [s.id, s]));

    // 스냅샷으로 복구
    roster.forEach(p => {
        const s = map.get(p.id);
        if (s) {
            p.score = s.score;
            p.games = s.games;
            p.wins = s.wins;
            p.losses = s.losses;
            p.lastDelta = 0; // 되돌린 상태 표시
        }
    });

    saveLocal();
    renderRoster();
    renderTeams();

    lastResultUndo = null;     // 단일 단계 되돌리기
    setUndoEnabled(false);
    touchSync();
}

if (btnUndo) {
    btnUndo.addEventListener('click', undoLastResult);
}


/* ============ 환경설정 ============ */
function initPrefs() {
    try {
        const v = localStorage.getItem(WIN_BONUS_KEY);
        if (v) winBonusInput.value = String(Math.round(+v || 10));
    } catch { }
    if (winBonusInput) winBonusInput.addEventListener('change', () => {
        const v = Math.round(+winBonusInput.value || 10);
        winBonusInput.value = String(v);
        try { localStorage.setItem(WIN_BONUS_KEY, String(v)); } catch { }
    });

    // 점수 방식
    try {
        const m = localStorage.getItem(MODE_KEY);
        if (m && scoringModeSel) scoringModeSel.value = m;
        const k = localStorage.getItem(ELO_K_KEY);
        if (k && eloKInput) eloKInput.value = String(Math.round(+k || 32));
    } catch { }
    toggleScoringControls();
    if (scoringModeSel) scoringModeSel.addEventListener('change', () => {
        try { localStorage.setItem(MODE_KEY, scoringModeSel.value); } catch { }
        toggleScoringControls();
    });
    if (eloKInput) eloKInput.addEventListener('change', () => {
        const v = Math.round(+eloKInput.value || 32);
        eloKInput.value = String(v);
        try { localStorage.setItem(ELO_K_KEY, String(v)); } catch { }
    });

    // ★ 팀 섞기 기준
    try {
        const bm = localStorage.getItem(BALANCE_MODE_KEY);
        if (bm && balanceModeSel) balanceModeSel.value = bm;
    } catch { }
    if (balanceModeSel) balanceModeSel.addEventListener('change', () => {
        try { localStorage.setItem(BALANCE_MODE_KEY, balanceModeSel.value); } catch { }
    });

    // ★ 균형 허용치
    try {
        const mt = localStorage.getItem(MMR_TOLERANCE_KEY);
        if (mt && mmrToleranceInput) mmrToleranceInput.value = mt;
    } catch { }
    if (mmrToleranceInput) mmrToleranceInput.addEventListener('change', () => {
        try { localStorage.setItem(MMR_TOLERANCE_KEY, mmrToleranceInput.value); } catch { }
    });

    // ★ 팀 정렬: 로컬(개인별)로만 관리
    try {
        const ts = localStorage.getItem(TEAM_SORT_LOCAL_KEY);
        if (ts && ['name', 'line', 'wr', 'score'].includes(ts)) {
            teamSortLocal = ts;
        }
    } catch { }
    if (teamSortSel) {
        // UI 초기값 = 로컬값
        teamSortSel.value = teamSortLocal;
        // 변경 시 로컬에만 저장 & 렌더링, 절대 touchSync() 호출하지 않음
        teamSortSel.addEventListener('change', () => {
            const v = teamSortSel.value;
            teamSortLocal = ['name', 'line', 'wr', 'score'].includes(v) ? v : 'name';
            try { localStorage.setItem(TEAM_SORT_LOCAL_KEY, teamSortLocal); } catch { }
            renderTeams();
        });
    }
}
function buildTeamsText() {
    // id → 이름 매핑
    const nameById = new Map(roster.map(p => [p.id, p.name]));
    const n1 = currentTeams.team1.map(id => nameById.get(id)).filter(Boolean);
    const n2 = currentTeams.team2.map(id => nameById.get(id)).filter(Boolean);

    const s1 = n1.length ? n1.join(', ') : '(비어있음)';
    const s2 = n2.length ? n2.join(', ') : '(비어있음)';
    return `1팀 ${s1}\n2팀 ${s2}`;
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (e) { /* fallback으로 진행 */ }

    // Fallback (구형 브라우저)
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
}

const btnCopy = document.getElementById('btnCopyTeamsText');
if (btnCopy) {
    btnCopy.addEventListener('click', async () => {
        const text = buildTeamsText();
        const ok = await copyToClipboard(text);
        const old = btnCopy.textContent;
        btnCopy.textContent = ok ? '복사 완료!' : '복사 실패';
        setTimeout(() => { btnCopy.textContent = old; }, 1200);
    });
}

// 헤더 클릭으로 정렬 토글
document.querySelectorAll('.rhead thead th.sortable').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort');
        if (!key) return;
        if (rosterSortKey === key) {
            rosterSortAsc = !rosterSortAsc;      // 같은 키면 방향 토글
        } else {
            rosterSortKey = key;                 // 다른 키면 키 변경 + 기본 오름차순
            rosterSortAsc = true;
        }
        renderRoster(); // 목록 갱신 + 헤더 화살표 갱신
    });
});

// ====== 축하 폭죽 ======
function launchConfetti(targetEl, opts = {}) {
    const duration = opts.duration ?? 1600; // ms
    const count = opts.count ?? 150;

    const BOUNCE = 0.45;        // 바닥/벽 반발계수 (0~1)
    const EDGE_FRICTION = 0.98; // 벽에 닿을 때 살짝 감속
    const GROUND_FRICTION = 0.90; // 바닥에서 미끄러질 때 감속

    // 캔버스 생성 및 타깃 위에 올리기
    const rect = targetEl.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    targetEl.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    function resize() {
        // 타깃 사이즈 기준으로 캔버스 픽셀 크기 설정
        const w = targetEl.clientWidth || rect.width;
        const h = targetEl.clientHeight || rect.height;
        canvas.width = Math.max(1, Math.floor(w * dpr));
        canvas.height = Math.max(1, Math.floor(h * dpr));
    }
    resize();

    // 중심에서 살짝 위쪽에서 터지면 보기 좋음
    const originX = canvas.width * 0.5;
    const originY = canvas.height * 1;

    // 확~ 퍼지게 하는 튜닝값
    const POWER = 1.5;         // 초기속도 배율
    const BASE_SPEED = 5;      // 기본 속도
    const SPEED_VAR = 8;       // 속도 가변폭
    const GRAVITY_MIN = 0.08;  // 중력 범위(낮출수록 더 오래/멀리)
    const GRAVITY_VAR = 0.08;
    const AIR_DRAG = 0.97;    // 공기저항(1에 가까우면 오래감)

    // 파티클 생성(360도 확산)
    const particles = Array.from({ length: count }, () => {
        const CENTER_DEG = -90;
        const SPREAD_DEG = 180;
        const theta = ((CENTER_DEG - SPREAD_DEG / 2) + Math.random() * SPREAD_DEG) * Math.PI / 180;
        const speed = (BASE_SPEED + Math.random() * SPEED_VAR) * POWER * dpr;
        return {
            x: originX,
            y: originY,
            vx: Math.cos(theta) * speed,
            vy: Math.sin(theta) * speed,
            g: (GRAVITY_MIN + Math.random() * GRAVITY_VAR) * dpr,
            w: (4 + Math.random() * 6) * dpr,
            h: (6 + Math.random() * 10) * dpr,
            rot: Math.random() * Math.PI,
            vr: (Math.random() - 0.5) * 0.3,
            color: ['#22c55e', '#4da3ff', '#f59e0b', '#ef4444', '#a78bfa', '#34d399'][(Math.random() * 6) | 0],
            alpha: 1
        };
    });

    const start = performance.now();

    function step(t) {
        const elapsed = t - start;
        const progress = Math.min(1, elapsed / duration);

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        for (const p of particles) {
            // 이동 + 감속 + 중력
            p.x += p.vx;
            p.y += p.vy;
            p.vx *= AIR_DRAG;
            p.vy = p.vy * AIR_DRAG + p.g;
            p.rot += p.vr;

            // === 경계 충돌: 좌/우 벽 ===
            if (p.x < 0) {
                p.x = 0;
                p.vx = -p.vx * BOUNCE;
                p.vy *= EDGE_FRICTION;
                p.vr *= EDGE_FRICTION;
            } else if (p.x > canvas.width) {
                p.x = canvas.width;
                p.vx = -p.vx * BOUNCE;
                p.vy *= EDGE_FRICTION;
                p.vr *= EDGE_FRICTION;
            }

            // === 경계 충돌: 천장 ===
            if (p.y < 0) {
                p.y = 0;
                p.vy = -p.vy * BOUNCE;
                p.vx *= EDGE_FRICTION;
                p.vr *= EDGE_FRICTION;
            }

            // === 경계 충돌: 바닥(중력 방향) ===
            if (p.y > canvas.height) {
                p.y = canvas.height;
                // 아래로 내려오던 속도를 위로 튕기게
                p.vy = -Math.abs(p.vy) * BOUNCE;

                // 바닥에서 미끄러지며 감속
                p.vx *= GROUND_FRICTION;
                p.vr *= GROUND_FRICTION;

                // 아주 느려지면 멈춘 느낌 주기
                if (Math.abs(p.vy) < 0.25 * dpr) p.vy = 0;
                if (Math.abs(p.vx) < 0.15 * dpr) p.vx = 0;
            }

            // 점점 사라지기
            p.alpha = 1 - progress;

            // 그리기
            ctx.save();
            ctx.globalAlpha = p.alpha;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        }


        if (progress < 1) {
            requestAnimationFrame(step);
        } else {
            // 마무리
            targetEl.removeChild(canvas);
        }
    }

    requestAnimationFrame(step);
}




// ===== 초기화 =====

// [SYNC] Firebase Auth 준비 후 자동 접속/버튼 연결
firebase.auth().onAuthStateChanged(async (user) => {
    if (!user) {
        try { await firebase.auth().signInAnonymously(); } catch (e) { console.warn(e); }
        return;
    }
    SYNC.uid = user.uid;

    const rid = getRoomIdFromURL();
    if (rid) {
        await createRoomIfNeeded(rid); // ownerKey 보강
        if (!SYNC.enabled) startRoomSync(rid);
    }
});


document.getElementById('btnShareRoom')?.addEventListener('click', async () => {
    if (!firebase.auth().currentUser) {
        try { await firebase.auth().signInAnonymously(); } catch (e) { }
    }
    const url = await ensureRoomAndGetUrl();
    try { await navigator.clipboard.writeText(url); alert('공유 링크를 복사했습니다:\n' + url); }
    catch { prompt('이 URL을 복사하세요', url); }
});


loadLocal(); initPrefs();
roster = roster.map(p => ({ ...p, mainLine: normLine(p.mainLine || 'A'), subLine: normLine(p.subLine || 'A') }));
saveLocal();
renderRoster(); renderTeams();
toggleScoringControls();
