// src/app.js
import { SYNC_MODE, PLACEMENT_MULTIPLIER, APP_VERSION, DISPLAY_VERSION } from './config.js';
import {
    SYNC, roster, setRoster, currentTeams, setCurrentTeams,
    lastTeams, setLastTeams, lastResultUndo, setLastResultUndo,
    avg, clamp, isPlacement, winRate, wrClass, normLine, linePair
} from './state.js';
import { loadLocal, saveLocal, loadLocalTeams, loadLocalPrefs, saveLocalPrefs, loadTeamSort, saveTeamSort } from './storage.js';
import { buildBalancedTeams } from './teams.js';
import { copyToClipboard, buildTeamsText, sortRosterForExport, exportRosterXLSX, parseTextToRoster, parseXlsxToRoster } from './io.js';
import { canEdit, requireOwner, touchSync, startRoomSync, createRoomIfNeeded, ensureRoomAndGetUrl, addIdToTeam, lockWinButtons, setUiBridge, getRoomIdFromURL, writeRoomNow, isWinLocked, persistTeamsLocalIfNeeded } from './sync.js';
import { launchConfetti } from './confetti.js';

/** ===== DOM 캐시 ===== */
const $ = id => document.getElementById(id);
export const els = {
    rosterBody: $('rosterBody'), checkAll: $('checkAll'),
    nameInput: $('nameInput'), scoreInput: $('scoreInput'),
    winBonusInput: $('winBonusInput'), scoringModeSel: $('scoringMode'),
    eloKInput: $('eloK'), fileInput: $('fileInput'),
    team1UL: $('team1'), team2UL: $('team2'),
    team1Box: $('team1Box'), team2Box: $('team2Box'),
    linePrimaryInput: $('linePrimaryInput'), lineSecondaryInput: $('lineSecondaryInput'),
    balanceModeSel: $('balanceMode'), teamSortSel: $('teamSort'),
    mmrToleranceInput: $('mmrTolerance'), mixStrengthSel: $('mixStrength'),
    rosterSearchInput: $('rosterSearch'), rosterSearchClear: $('rosterSearchClear'),
    rosterSearchCount: $('rosterSearchCount'), selectedNamesEl: $('selectedNames'),
    eloKWrap: $('eloKWrap'), winBonusWrap: $('winBonusWrap'),
    managePanel: $('managePanel'), btnUndo: $('btnUndo'),
    avg1: $('avg1'), avg2: $('avg2'), viewModeBadge: $('viewModeBadge'),
    btnShareRoom: $('btnShareRoom'), btnExportXLSX: $('btnExportXLSX'),
    btnCopyTeamsText: $('btnCopyTeamsText'),
    btnAdd: $('btnAdd'), btnDelete: $('btnDelete'), btnSave: $('btnSave'), btnLoad: $('btnLoad'),
    btnMakeTeams: $('btnMakeTeams'), btnRemakeTeams: $('btnRemakeTeams'), btnClearTeams: $('btnClearTeams'),
    btnToTeam1: $('btnToTeam1'), btnToTeam2: $('btnToTeam2'), btnRemoveFromTeams: $('btnRemoveFromTeams'),
    btnWin1: $('btnWin1'), btnWin2: $('btnWin2'),
};

/** ===== 렌더 ===== */
let rosterSortKey = 'name';
let rosterSortAsc = true;
let rosterSearchTerm = '';

export function updateRosterHeaderIndicators() {
    document.querySelectorAll('.rhead thead th.sortable').forEach(th => {
        const key = th.getAttribute('data-sort');
        const ind = th.querySelector('.sort-ind');
        if (!ind) return;
        if (key === rosterSortKey) { ind.textContent = rosterSortAsc ? '▲' : '▼'; ind.style.opacity = '1'; }
        else { ind.textContent = ''; ind.style.opacity = '.5'; }
    });
}

export function renderRoster() {
    const key = rosterSortKey, asc = rosterSortAsc ? 1 : -1, term = (rosterSearchTerm || '').trim().toLowerCase();
    const t1Set = new Set(currentTeams.team1 || []), t2Set = new Set(currentTeams.team2 || []);
    const sorted = roster.slice().sort((a, b) => {
        const byName = a.name.localeCompare(b.name, 'ko');
        if (key === 'name') return asc * byName;
        if (key === 'line') {
            const la = (normLine(a.mainLine) + '/' + normLine(a.subLine));
            const lb = (normLine(b.mainLine) + '/' + normLine(b.subLine));
            const cmp = la.localeCompare(lb); return asc * (cmp || byName);
        }
        if (key === 'score') { const cmp = (a.score - b.score); return asc * (cmp || byName); }
        if (key === 'wl') {
            const wa = +a.wins || 0, wb = +b.wins || 0;
            const la2 = +a.losses || 0, lb2 = +b.losses || 0;
            const cmp = (wa - wb) || (lb2 - la2); return asc * (cmp || byName);
        }
        if (key === 'wr') { const cmp = (winRate(a) - winRate(b)); return asc * (cmp || byName); }
        if (key === 'games') { const cmp = ((+a.games || 0) - (+b.games || 0)); return asc * (cmp || byName); }
        return byName;
    });
    const list = term ? sorted.filter(p => p.name.toLowerCase().includes(term)) : sorted;

    if (els.rosterSearchCount) {
        els.rosterSearchCount.textContent = term ? `검색 결과 ${list.length}명 / 전체 ${roster.length}명` : `전체 ${roster.length}명`;
    }

    els.rosterBody.innerHTML = '';
    list.forEach(p => {
        const tr = document.createElement('tr'); tr.setAttribute('draggable', 'true'); tr.dataset.id = p.id;
        if (t1Set.has(p.id)) tr.classList.add('in-team1'); else if (t2Set.has(p.id)) tr.classList.add('in-team2');
        const rate = winRate(p);
        const p1 = normLine(p.mainLine || 'A'), p2 = normLine(p.subLine || 'A');
        const safe = p.name.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[ch]));
        const termRE = term ? new RegExp(`(${term.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')})`, 'gi') : null;
        const highlighted = termRE ? safe.replace(termRE, '<mark>$1</mark>') : safe;

        tr.innerHTML = `
      <td><input type="checkbox" data-id="${p.id}" class="rowcheck"></td>
      <td class="cell-name" data-id="${p.id}" title="더블클릭으로 이름 수정">${highlighted}</td>
      <td class="cell-line">
        <select class="line-select cell-line1" data-id="${p.id}" title="주 라인">${['T', 'J', 'M', 'B', 'S', 'A'].map(k => `<option value="${k}" ${p1 === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
        <span class="line-slash">/</span>
        <select class="line-select cell-line2" data-id="${p.id}" title="부 라인">${['T', 'J', 'M', 'B', 'S', 'A'].map(k => `<option value="${k}" ${p2 === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
      </td>
      <td class="tabnum"><input data-id="${p.id}" class="cell-score" type="number" value="${p.score}" /></td>
      <td class="tabnum"><input data-id="${p.id}" class="cell-games" type="number" min="0" value="${p.games || 0}" /></td>
      <td class="tabnum"><span class="wl-badge" data-id="${p.id}">${p.wins || 0}/${p.losses || 0}</span></td>
      <td class="tabnum"><span class="wr-badge ${wrClass(rate)}" data-id="${p.id}">${rate}%</span></td>
    `;
        els.rosterBody.appendChild(tr);
    });
    if (els.checkAll) els.checkAll.checked = false;
    updateSelectedUI();
    updateRosterHeaderIndicators();
}

export function renderTeams() {
    const t1 = currentTeams.team1.map(id => roster.find(p => p.id === id)).filter(Boolean);
    const t2 = currentTeams.team2.map(id => roster.find(p => p.id === id)).filter(Boolean);
    const a1 = avg(t1.map(p => p.score)), a2 = avg(t2.map(p => p.score));
    els.avg1.innerHTML = `평균 <span class="${a1 >= a2 ? 'good' : 'bad'}">${a1.toFixed(1)}</span>`;
    els.avg2.innerHTML = `평균 <span class="${a2 >= a1 ? 'good' : 'bad'}">${a2.toFixed(1)}</span>`;

    const sortKey = loadTeamSort();
    const cmp = (a, b) => {
        if (sortKey === 'name') return a.name.localeCompare(b.name, 'ko');
        if (sortKey === 'line') return linePair(a).localeCompare(linePair(b));
        if (sortKey === 'wr') return (winRate(b) - winRate(a)) || a.name.localeCompare(b.name, 'ko');
        if (sortKey === 'score') return (b.score - a.score) || a.name.localeCompare(b.name, 'ko');
        return 0;
    };
    t1.sort(cmp); t2.sort(cmp);

    els.team1UL.innerHTML = ''; els.team2UL.innerHTML = '';
    const makeRow = p => {
        const wr = winRate(p);
        const li = document.createElement('li'); li.className = 'teamRow'; li.setAttribute('draggable', 'true'); li.dataset.id = p.id;
        li.addEventListener('dragstart', (e) => { if (!canEdit()) e.preventDefault(); });
        const deltaHTML = (typeof p.lastDelta === 'number' && p.lastDelta !== 0)
            ? `<span class="delta" style="color:${p.lastDelta > 0 ? '#22c55e' : '#ef4444'};">${p.lastDelta > 0 ? '+' : ''}${p.lastDelta}</span>` : '';
        li.innerHTML = `
      <span class="cell-name" title="${p.name}">${p.name}</span>
      <span class="cell-line tabnum">${linePair(p)}</span>
      <span class="cell-wr tabnum ${wrClass(wr)}">${wr}%</span>
      <span class="cell-score tabnum"><span class="score-num">${p.score}</span>${deltaHTML}</span>
    `;
        li.addEventListener('dragstart', e => {
            if (!canEdit()) { e.preventDefault(); return; }
            e.dataTransfer.setData('text/plain', p.id);
            e.dataTransfer.effectAllowed = 'move';
        });
        return li;
    };
    t1.forEach(p => els.team1UL.appendChild(makeRow(p)));
    t2.forEach(p => els.team2UL.appendChild(makeRow(p)));
}

export function setUndoEnabled(on) {
    if (!els.btnUndo) return;
    els.btnUndo.disabled = !on;
    els.btnUndo.title = on ? '마지막 결과 되돌리기' : '되돌릴 결과가 없습니다';
}

export function toggleScoringControls() {
    const mode = (els.scoringModeSel && els.scoringModeSel.value) || 'elo';
    if (mode === 'elo') { if (els.eloKWrap) els.eloKWrap.style.display = ''; if (els.winBonusWrap) els.winBonusWrap.style.display = 'none'; }
    else { if (els.eloKWrap) els.eloKWrap.style.display = 'none'; if (els.winBonusWrap) els.winBonusWrap.style.display = ''; }
}

/** ===== 검색/선택 ===== */
function getSelectedIds() { return [...document.querySelectorAll('.rowcheck:checked')].map(cb => cb.dataset.id); }
function updateSelectedUI() {
    const ids = getSelectedIds(); const total = roster.length;
    if (els.rosterSearchCount) {
        const visibleCount = document.querySelectorAll('#rosterBody tr').length;
        const term = (rosterSearchTerm || '').trim();
        els.rosterSearchCount.textContent = term ? `검색 결과 ${visibleCount}명 / 전체 ${total}명` : `전체 ${total}명`;
    }
    if (els.selectedNamesEl) { els.selectedNamesEl.textContent = ids.length ? ` | 선택 ${ids.length}명` : ''; }
}

/** ===== 드래그&드롭 ===== */
function bindDropTarget(ulEl, boxEl, teamNo) {
    const onDragOver = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
    const onDragEnter = () => boxEl.classList.add('drop-target');
    const onDragLeave = e => { if (!boxEl.contains(e.relatedTarget)) boxEl.classList.remove('drop-target'); };
    const onDrop = e => {
        if (!canEdit()) { e.preventDefault(); return; }
        e.preventDefault(); boxEl.classList.remove('drop-target');
        const id = e.dataTransfer.getData('text/plain'); if (!id) return;
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
function bindDragAndDrop() {
    bindDropTarget(els.team1UL, els.team1Box, 1);
    bindDropTarget(els.team2UL, els.team2Box, 2);

    els.rosterBody.addEventListener('dragover', e => { e.preventDefault(); els.rosterBody.classList.add('drop-target'); });
    els.rosterBody.addEventListener('dragleave', e => { if (!els.rosterBody.contains(e.relatedTarget)) els.rosterBody.classList.remove('drop-target'); });
    els.rosterBody.addEventListener('drop', e => {
        e.preventDefault(); els.rosterBody.classList.remove('drop-target');
        if (!canEdit()) { e.preventDefault(); return; }
        const id = e.dataTransfer.getData('text/plain'); if (!id) return;
        setCurrentTeams({ team1: currentTeams.team1.filter(x => x !== id), team2: currentTeams.team2.filter(x => x !== id) });
        renderTeams(); renderRoster();
        persistTeamsLocalIfNeeded();
        touchSync();

    });
    els.rosterBody.addEventListener('dragstart', e => {
        if (!canEdit()) { e.preventDefault(); return; }
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return;
        const tr = e.target.closest('tr[draggable="true"]'); if (!tr) return;
        const id = tr.dataset.id; if (id && e.dataTransfer) { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; }
    });

    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
        if (!(e.target && els.managePanel && els.managePanel.contains(e.target))) { e.preventDefault(); }
    });

    // ===== 인원 관리 패널 파일 드래그/드롭 불러오기 =====
    if (els.managePanel) {
        els.managePanel.addEventListener('dragenter', (e) => {
            if (isFileDrag(e)) {
                e.preventDefault();
                els.managePanel.classList.add('drop-target'); // 이미 쓰는 강조 클래스를 재사용
            }
        });
        els.managePanel.addEventListener('dragover', (e) => {
            if (isFileDrag(e)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            }
        });
        els.managePanel.addEventListener('dragleave', (e) => {
            if (!els.managePanel.contains(e.relatedTarget)) {
                els.managePanel.classList.remove('drop-target');
            }
        });
        els.managePanel.addEventListener('drop', (e) => {
            if (isFileDrag(e)) {
                e.preventDefault();
                e.stopPropagation(); // rosterBody의 팀 이동 드롭과 충돌 방지
                els.managePanel.classList.remove('drop-target');

                const file = e.dataTransfer.files && e.dataTransfer.files[0];
                importRosterFromFile(file);
            }
        });
    }


}

function maybeCreateShareButton() {
    if (!SYNC_MODE) return; // SYNC_MODE가 true일 때만 생성
    // 이미 있으면 재사용
    let btn = document.getElementById('btnShareRoom');
    if (btn) { els.btnShareRoom = btn; return; }

    const badge = document.getElementById('viewModeBadge');
    if (!badge) return;

    btn = document.createElement('button');
    btn.className = 'btn ghost';
    btn.id = 'btnShareRoom';
    btn.title = '같이 보기 링크 생성';
    btn.textContent = '공유 링크';

    // viewModeBadge 앞에 삽입
    badge.insertAdjacentElement('beforebegin', btn);

    // els 참조 갱신(기존 코드의 이벤트 바인딩에서 씀)
    els.btnShareRoom = btn;
}

// 파일 드래그 여부 판별
function isFileDrag(e) {
    try {
        return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    } catch { return false; }
}

// 파일 1개를 받아 로스터로 불러오기 (btnLoad 로직 재사용)
function importRosterFromFile(file) {
    if (!file) { alert('불러올 파일을 찾지 못했습니다.'); return; }
    const name = (file.name || '').toLowerCase();

    if (name.endsWith('.xlsx')) {
        const reader = new FileReader();
        reader.onload = () => {
            const { imported, error } = parseXlsxToRoster(reader.result);
            if (error) { alert(error); return; }
            setRoster(imported);
            setCurrentTeams({ team1: [], team2: [] });
            saveLocal(roster);
            renderRoster(); renderTeams();
            touchSync(); // 방에 있으면 전파, 아니면 무시
            alert(`${imported.length}명의 데이터를 XLSX에서 불러와 인원 목록을 교체했습니다.`);
        };
        reader.readAsArrayBuffer(file);
        return;
    }

    if (name.endsWith('.txt') || name.endsWith('.json')) {
        const reader = new FileReader();
        reader.onload = () => {
            const { imported, error } = parseTextToRoster(String(reader.result || ''));
            if (error) { alert(error); return; }
            setRoster(imported);
            setCurrentTeams({ team1: [], team2: [] });
            saveLocal(roster);
            renderRoster(); renderTeams();
            touchSync();
            alert(`${imported.length}명의 데이터를 불러와 인원 목록을 교체했습니다.`);
        };
        reader.readAsText(file, 'utf-8');
        return;
    }

    alert('지원하지 않는 형식입니다. .txt, .json 또는 .xlsx 파일을 사용하세요.');
}


/** ===== 이벤트 바인딩 ===== */
function registerEventHandlers() {
    // 로스터 변경
    els.rosterBody.addEventListener('change', e => {
        if (!canEdit()) {
            if (!e.target.classList.contains('rowcheck')) { alert('읽기 전용 모드입니다. (호스트만 조작 가능)'); e.preventDefault(); return; }
        }
        const t = e.target, id = t.dataset.id, p = roster.find(x => x.id === id);
        if (!p) { if (t.classList.contains('rowcheck')) updateSelectedUI(); return; }
        if (t.classList.contains('rowcheck')) { updateSelectedUI(); return; }
        if (t.classList.contains('cell-line1')) p.mainLine = normLine(t.value);
        else if (t.classList.contains('cell-line2')) p.subLine = normLine(t.value);
        else if (t.classList.contains('cell-score')) p.score = isFinite(+t.value) ? +t.value : p.score;
        else if (t.classList.contains('cell-games')) p.games = Math.max(0, Math.floor(+t.value || 0));
        saveLocal(roster); renderTeams(); touchSync();
    });

    // 승패 초기화
    els.rosterBody.addEventListener('dblclick', e => {
        if (!canEdit()) return;
        const wl = e.target.closest('.wl-badge'); if (!wl) return;
        const p = roster.find(x => x.id === wl.dataset.id); if (!p) return;
        if (confirm(`"${p.name}"의 승패를 초기화하시겠습니까?`)) {
            p.wins = 0; p.losses = 0; saveLocal(roster); renderRoster(); renderTeams();
        }
    });

    // 전체선택
    els.checkAll.addEventListener('change', () => {
        document.querySelectorAll('.rowcheck').forEach(cb => cb.checked = els.checkAll.checked);
        updateSelectedUI();
    });

    // 검색
    let _searchTimer = null;
    function setSearchTerm(v) { rosterSearchTerm = (v || '').slice(0, 50); renderRoster(); }
    if (els.rosterSearchInput) {
        els.rosterSearchInput.addEventListener('input', e => {
            const v = e.target.value; clearTimeout(_searchTimer);
            _searchTimer = setTimeout(() => { setSearchTerm(v); updateSelectedUI(); }, 120);
        });
    }
    if (els.rosterSearchClear) {
        els.rosterSearchClear.addEventListener('click', () => {
            els.rosterSearchInput.value = ''; setSearchTerm(''); els.rosterSearchInput.focus(); updateSelectedUI();
        });
    }

    // 헤더 정렬
    document.querySelectorAll('.rhead thead th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.getAttribute('data-sort'); if (!key) return;
            if (rosterSortKey === key) rosterSortAsc = !rosterSortAsc; else { rosterSortKey = key; rosterSortAsc = true; }
            renderRoster();
        });
    });

    els.teamSortSel?.addEventListener('change', () => {
        saveTeamSort(els.teamSortSel.value || 'name');
        renderTeams();
    });

    // ===== Prefs 변경 시 저장/전파 (SYNC 인식) =====
    // - SYNC_MODE=false  : localStorage(team_prefs_v1)에 저장
    // - SYNC_MODE=true & 호스트 : Firestore로 전파(touchSync)
    // - SYNC_MODE=true & 읽기전용 : 컨트롤이 disable이라 보통 이벤트가 안 옴(와도 무시)
    function persistPrefsSyncAware() {
        const prefs = {
            scoringMode: els.scoringModeSel?.value || 'elo',
            eloK: +els.eloKInput?.value || 60,
            winBonus: +els.winBonusInput?.value || 30,
            balanceMode: els.balanceModeSel?.value || 'prefer_line',
            mmrTolerance: +els.mmrToleranceInput?.value || 120,
        };

        const rid = getRoomIdFromURL();
        if (SYNC_MODE && rid) {
            // 방에 있을 때만(그리고 편집 가능할 때만) Firestore 전파
            if (canEdit()) touchSync(); // packState()에 prefs가 포함되어 전파됨
        } else {
            // 방이 없으면 로컬처럼 저장
            saveLocalPrefs(prefs);
        }
    }


    // 컨트롤 변경 시 저장/전파 연결
    els.scoringModeSel?.addEventListener('change', () => {
        toggleScoringControls();   // UI 스위칭(ELO/고정감산)
        persistPrefsSyncAware();
    });
    els.eloKInput?.addEventListener('input', persistPrefsSyncAware);
    els.winBonusInput?.addEventListener('input', persistPrefsSyncAware);
    els.balanceModeSel?.addEventListener('change', persistPrefsSyncAware);
    els.mmrToleranceInput?.addEventListener('input', persistPrefsSyncAware);



    // 추가
    els.btnAdd.addEventListener('click', () => {
        let name = (els.nameInput.value || '').trim(); const score = +els.scoreInput.value || 0;
        const pLine = normLine(els.linePrimaryInput.value || 'A'), sLine = normLine(els.lineSecondaryInput.value || 'A');
        if (!name) { alert('이름을 입력하세요.'); els.nameInput.focus(); return; }
        if (name.length > 16) { alert('이름은 최대 16자까지만 가능합니다.'); name = name.slice(0, 16); }
        roster.push({ id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2), name, score, games: 0, wins: 0, losses: 0, mainLine: pLine, subLine: sLine });
        saveLocal(roster); renderRoster(); renderTeams();
        els.nameInput.value = ''; els.scoreInput.value = '1000'; els.linePrimaryInput.value = 'A'; els.lineSecondaryInput.value = 'A'; els.nameInput.focus();
    });

    // 삭제
    els.btnDelete.addEventListener('click', () => {
        const ids = new Set([...document.querySelectorAll('.rowcheck:checked')].map(cb => cb.dataset.id));
        if (!ids.size) { alert('삭제할 인원을 선택하세요.'); return; }
        const names = roster.filter(p => ids.has(p.id)).map(p => p.name).join(', ');
        if (!confirm(`정말 삭제하시겠습니까?\n${names}`)) return;
        const next = roster.filter(p => !ids.has(p.id));
        setCurrentTeams({ team1: currentTeams.team1.filter(id => !ids.has(id)), team2: currentTeams.team2.filter(id => !ids.has(id)) });
        setRoster(next); saveLocal(roster); renderRoster(); renderTeams(); persistTeamsLocalIfNeeded();
    });

    // 저장 (TXT)
    els.btnSave.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(roster, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a');
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const yy = String(now.getFullYear()).slice(-2), mm = pad(now.getMonth() + 1), dd = pad(now.getDate()), HH = pad(now.getHours()), MM = pad(now.getMinutes());
        a.href = url; a.download = `member_${yy}${mm}${dd}_${HH}${MM}.txt`; a.click(); URL.revokeObjectURL(url);
    });

    // 불러오기 버튼
    els.btnLoad.addEventListener('click', () => {
        const f = els.fileInput.files?.[0];
        if (!f) { alert('불러올 파일을 선택하세요.'); els.fileInput.click(); return; }
        const name = f.name.toLowerCase();
        if (name.endsWith('.xlsx')) {
            const reader = new FileReader();
            reader.onload = () => {
                const { imported, error } = parseXlsxToRoster(reader.result); if (error) { alert(error); return; }
                setRoster(imported);
                setCurrentTeams({ team1: [], team2: [] });
                saveLocal(roster); renderRoster(); renderTeams();
                persistTeamsLocalIfNeeded();
                alert(`${imported.length}명의 데이터를 XLSX에서 불러와 인원 목록을 교체했습니다.`);

            };
            reader.readAsArrayBuffer(f);
        } else if (name.endsWith('.txt') || name.endsWith('.json')) {
            const reader = new FileReader();
            reader.onload = () => {
                const { imported, error } = parseTextToRoster(String(reader.result || '')); if (error) { alert(error); return; }
                setRoster(imported);
                setCurrentTeams({ team1: [], team2: [] });
                saveLocal(roster); renderRoster(); renderTeams();
                persistTeamsLocalIfNeeded();
                alert(`${imported.length}명의 데이터를 불러와 인원 목록을 교체했습니다.`);
            };
            reader.readAsText(f, 'utf-8');
        } else {
            alert('지원하지 않는 형식입니다. .txt, .json 또는 .xlsx 파일을 사용하세요.');
        }
    });

    // XLSX 내보내기
    els.btnExportXLSX.addEventListener('click', () => {
        const ids = new Set(getSelectedIds());
        const key = rosterSortKey, asc = rosterSortAsc;
        let list = sortRosterForExport(roster, { key, asc });
        if (ids.size > 0) {
            const onlySelected = confirm('선택된 인원만 내보낼까요?\n(확인: 선택만, 취소: 전체)');
            if (onlySelected) list = list.filter(p => ids.has(p.id));
        }
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const yy = String(now.getFullYear()).slice(-2), mm = pad(now.getMonth() + 1), dd = pad(now.getDate()), HH = pad(now.getHours()), MM = pad(now.getMinutes());
        const filename = `member_${yy}${mm}${dd}_${HH}${MM}.xlsx`;
        exportRosterXLSX(list, filename);
    });

    // 팀 만들기
    els.btnMakeTeams.addEventListener('click', () => {
        if (!requireOwner()) return;
        const ids = [...document.querySelectorAll('.rowcheck:checked')].map(cb => cb.dataset.id);
        if (ids.length < 2 || ids.length % 2 !== 0) { alert('짝수 인원을 선택하세요. (현재 ' + ids.length + '명)'); return; }
        const players = ids.map(id => roster.find(p => p.id === id)).filter(Boolean);
        const mode = (els.balanceModeSel && els.balanceModeSel.value) || 'prefer_line';
        let pick = buildBalancedTeams(players, mode);
        if (teamsAlmostSame(pick, lastTeams) && mode !== 'prefer_line') {
            const bakT = els.mmrToleranceInput.value, bakS = els.mixStrengthSel.value;
            els.mmrToleranceInput.value = String(Math.floor(Number(bakT || 120) * 1.5)); els.mixStrengthSel.value = 'strong';
            pick = buildBalancedTeams(players, mode);
            els.mmrToleranceInput.value = bakT; els.mixStrengthSel.value = bakS;
        }
        setCurrentTeams(pick);
        renderTeams(); renderRoster();
        setLastTeams(JSON.parse(JSON.stringify(currentTeams)));
        persistTeamsLocalIfNeeded();
        touchSync();
    });

    // 리메이크
    els.btnRemakeTeams.addEventListener('click', () => {
        if (!requireOwner()) return;
        const all = [...currentTeams.team1, ...currentTeams.team2];
        if (all.length < 2 || all.length % 2 !== 0) { alert('먼저 짝수 인원으로 팀을 만들어주세요. (현재 ' + all.length + '명)'); return; }
        const players = all.map(id => roster.find(p => p.id === id)).filter(Boolean);
        if (players.length !== all.length) { alert('일부 멤버가 목록에서 사라졌습니다. 다시 선택해서 팀을 만들어주세요.'); return; }
        roster.forEach(p => p.lastDelta = 0);
        setCurrentTeams(buildBalancedTeams(players, (els.balanceModeSel && els.balanceModeSel.value) || 'prefer_line'));
        renderTeams(); renderRoster();
        setLastTeams(JSON.parse(JSON.stringify(currentTeams)));
        persistTeamsLocalIfNeeded();
        touchSync();

    });

    // 클리어
    els.btnClearTeams.addEventListener('click', () => {
        if (!requireOwner()) return;
        roster.forEach(p => p.lastDelta = 0);
        setCurrentTeams({ team1: [], team2: [] }); setLastTeams({ team1: [], team2: [] });
        renderTeams(); els.avg1.textContent = '평균 0'; els.avg2.textContent = '평균 0';
        persistTeamsLocalIfNeeded();
        touchSync();
    });

    // 선택 이동/제거
    els.btnToTeam1.addEventListener('click', () => {
        if (!requireOwner()) return;
        const ids = [...document.querySelectorAll('.rowcheck:checked')].map(cb => cb.dataset.id);
        if (!ids.length) { alert('팀에 넣을 인원을 체크하세요.'); return; }
        ids.forEach(id => addIdToTeam(1, id)); touchSync();
    });
    els.btnToTeam2.addEventListener('click', () => {
        if (!requireOwner()) return;
        const ids = [...document.querySelectorAll('.rowcheck:checked')].map(cb => cb.dataset.id);
        if (!ids.length) { alert('팀에 넣을 인원을 체크하세요.'); return; }
        ids.forEach(id => addIdToTeam(2, id)); touchSync();
    });
    els.btnRemoveFromTeams.addEventListener('click', () => {
        if (!requireOwner()) return;
        const ids = new Set([...document.querySelectorAll('.rowcheck:checked')].map(cb => cb.dataset.id));
        if (!ids.size) { alert('팀에서 제거할 인원을 체크하세요.'); return; }
        setCurrentTeams({ team1: currentTeams.team1.filter(id => !ids.has(id)), team2: currentTeams.team2.filter(id => !ids.has(id)) });
        renderTeams(); renderRoster();
        persistTeamsLocalIfNeeded();
        touchSync();
    });

    // 승리 반영
    function confirmAndApply(winTeam) {
        if (!requireOwner()) return;

        const n1 = currentTeams.team1.length, n2 = currentTeams.team2.length;
        if (n1 === 0 || n2 === 0 || n1 !== n2) {
            alert('먼저 짝수 인원으로 팀을 만들어주세요.');
            return;
        }

        // 이미 잠겨 있으면 무시 (연타 방지)
        if (isWinLocked && isWinLocked()) return;

        const msg = `${winTeam === 1 ? '1팀 승리' : '2팀 승리'}로 점수를 반영할까요?`;
        if (confirm(msg)) {
            applyResult(winTeam);
        }
    }

    els.btnWin1.addEventListener('click', () => confirmAndApply(1));
    els.btnWin2.addEventListener('click', () => confirmAndApply(2));

    async function applyResult(winTeam) {
        if (isWinLocked && isWinLocked()) return;
        lockWinButtons(true);
        const ids1 = new Set(currentTeams.team1), ids2 = new Set(currentTeams.team2);
        if (ids1.size === 0 || ids2.size === 0 || ids1.size !== ids2.size) { alert('먼저 짝수 인원으로 팀을 만들어주세요.'); return; }

        const affectedIds = [...ids1, ...ids2];
        const undoSnapshot = affectedIds.map(id => {
            const p = roster.find(x => x.id === id);
            return p ? { id: p.id, score: p.score, games: p.games || 0, wins: p.wins || 0, losses: p.losses || 0, lastDelta: p.lastDelta || 0 } : null;
        }).filter(Boolean);

        roster.forEach(p => p.lastDelta = 0);

        const targetBox = (winTeam === 1) ? els.team1Box : els.team2Box;
        launchConfetti(targetBox, { duration: 1800, count: 180 });

        const team1 = roster.filter(p => ids1.has(p.id)), team2 = roster.filter(p => ids2.has(p.id));
        const mode = (els.scoringModeSel && els.scoringModeSel.value) || 'fixed';

        if (mode === 'elo') {
            const R1 = avg(team1.map(p => p.score)), R2 = avg(team2.map(p => p.score));
            const E1 = 1 / (1 + Math.pow(10, (R2 - R1) / 400)), E2 = 1 - E1;
            const K = Math.round(Number(els.eloKInput && els.eloKInput.value ? els.eloKInput.value : 32)) || 32;
            const S1 = (winTeam === 1 ? 1 : 0), S2 = (winTeam === 2 ? 1 : 0);
            const d1 = K * (S1 - E1), d2 = K * (S2 - E2);

            team1.forEach(p => {
                const mult = isPlacement(p.games) ? PLACEMENT_MULTIPLIER : 1; const change = Math.round(d1 * mult);
                p.lastDelta = change; p.score = Math.round(clamp(p.score + change, -9999, 9999));
                p.games = (p.games || 0) + 1; if (winTeam === 1) p.wins = (p.wins || 0) + 1; else p.losses = (p.losses || 0) + 1;
            });
            team2.forEach(p => {
                const mult = isPlacement(p.games) ? PLACEMENT_MULTIPLIER : 1; const change = Math.round(d2 * mult);
                p.lastDelta = change; p.score = Math.round(clamp(p.score + change, -9999, 9999));
                p.games = (p.games || 0) + 1; if (winTeam === 2) p.wins = (p.wins || 0) + 1; else p.losses = (p.losses || 0) + 1;
            });
        } else {
            const delta = Math.round(Number(els.winBonusInput && els.winBonusInput.value ? els.winBonusInput.value : 10)) || 10;
            roster.forEach(p => {
                const in1 = ids1.has(p.id), in2 = ids2.has(p.id); if (!in1 && !in2) return;
                const mult = isPlacement(p.games) ? PLACEMENT_MULTIPLIER : 1; let change = 0;
                if (in1) change = (winTeam === 1 ? delta * mult : -delta * mult);
                if (in2) change = (winTeam === 2 ? delta * mult : -delta * mult);
                p.lastDelta = change; p.score = Math.round(clamp(p.score + change, -9999, 9999)); p.games = (p.games || 0) + 1;
                if (in1) { if (winTeam === 1) p.wins = (p.wins || 0) + 1; else p.losses = (p.losses || 0) + 1; }
                if (in2) { if (winTeam === 2) p.wins = (p.wins || 0) + 1; else p.losses = (p.losses || 0) + 1; }
            });
        }

        const deltaById = {};[...ids1, ...ids2].forEach(id => { const p = roster.find(x => x.id === id); if (p) deltaById[id] = p.lastDelta || 0; });

        window.matchHistory = (window.matchHistory || []);
        window.matchHistory.push({
            ts: Date.now(), roomId: null, team1: Array.from(ids1), team2: Array.from(ids2),
            winner: winTeam, mode: (els.scoringModeSel && els.scoringModeSel.value) || 'fixed',
            eloK: +els.eloKInput?.value || 60, winBonus: +els.winBonusInput?.value || 30, deltaById
        });
        if (window.matchHistory.length > 100) window.matchHistory.shift();

        saveLocal(roster); renderRoster(); renderTeams();

        if (SYNC_MODE && getRoomIdFromURL()) {
            const ts = Date.now();
            await writeRoomNow({
                winEvent: { ts, team: winTeam }
            });
        }

        setLastResultUndo({ snapshot: undoSnapshot }); setUndoEnabled(true); touchSync();
        setTimeout(() => lockWinButtons(false), 1500);
    }

    // 되돌리기
    function undoLastResult() {
        if (!requireOwner()) return;
        if (!lastResultUndo || !lastResultUndo.snapshot || !lastResultUndo.snapshot.length) { alert('되돌릴 결과가 없습니다.'); return; }
        const map = new Map(lastResultUndo.snapshot.map(s => [s.id, s]));
        roster.forEach(p => {
            const s = map.get(p.id); if (s) { p.score = s.score; p.games = s.games; p.wins = s.wins; p.losses = s.losses; p.lastDelta = 0; }
        });
        saveLocal(roster); renderRoster(); renderTeams(); setLastResultUndo(null); setUndoEnabled(false); touchSync();
    }
    if (els.btnUndo) els.btnUndo.addEventListener('click', undoLastResult);

    // 팀 텍스트 복사
    if (els.btnCopyTeamsText) {
        els.btnCopyTeamsText.addEventListener('click', async () => {
            const txt = buildTeamsText(roster, currentTeams);
            const ok = await copyToClipboard(txt);
            const old = els.btnCopyTeamsText.textContent;
            els.btnCopyTeamsText.textContent = ok ? '복사 완료!' : '복사 실패';
            setTimeout(() => { els.btnCopyTeamsText.textContent = old; }, 1200);
        });
    }

    // 공유
    els.btnShareRoom?.addEventListener('click', async () => {
        if (!SYNC_MODE) { alert('현재 동기화 기능이 비활성화된 로컬 모드입니다.'); return; }
        if (!window.firebase?.auth?.().currentUser) {
            try { await window.firebase.auth().signInAnonymously(); } catch { }
        }
        const url = await ensureRoomAndGetUrl();
        try { await navigator.clipboard.writeText(url); alert('공유 링크를 복사했습니다:\n' + url); }
        catch { prompt('이 URL을 복사하세요', url); }
    });

    // 읽기전용 모드에서 필요한 allowIds 외 요소들은 sync.setReadOnly가 처리
}

/** ===== prefs bridge ===== */
function getPrefs() {
    return {
        scoringMode: els.scoringModeSel?.value || 'elo',
        eloK: +els.eloKInput?.value || 60,
        winBonus: +els.winBonusInput?.value || 30,
        balanceMode: els.balanceModeSel?.value || 'prefer_line',
        mmrTolerance: +els.mmrToleranceInput?.value || 120
    };
}
function setPrefs(p) {
    if (p.scoringMode && els.scoringModeSel) els.scoringModeSel.value = p.scoringMode;
    if (Number.isFinite(+p.eloK) && els.eloKInput) els.eloKInput.value = String(p.eloK);
    if (Number.isFinite(+p.winBonus) && els.winBonusInput) els.winBonusInput.value = String(p.winBonus);
    if (p.balanceMode && els.balanceModeSel) els.balanceModeSel.value = p.balanceMode;
    if (Number.isFinite(+p.mmrTolerance) && els.mmrToleranceInput) els.mmrToleranceInput.value = String(p.mmrTolerance);
    toggleScoringControls();
}

/** ===== helper ===== */
function teamsAlmostSame(a, b) {
    const A1 = new Set(a.team1), A2 = new Set(a.team2), tot = (a.team1.length + a.team2.length) || 1;
    let same = 0; for (const id of b.team1) if (A1.has(id)) same++; for (const id of b.team2) if (A2.has(id)) same++;
    let sameSwap = 0; for (const id of b.team1) if (A2.has(id)) sameSwap++; for (const id of b.team2) if (A1.has(id)) sameSwap++;
    return Math.max(same, sameSwap) / tot >= 0.85;
}

/** ===== init ===== */
export async function init() {
    // UI 브리지 주입
    setUiBridge({
        renderRoster, renderTeams, toggleScoringControls, launchConfetti,
        getPrefs, setPrefs,
        setReadOnlyBadge: (isOwner) => { if (els.viewModeBadge) els.viewModeBadge.textContent = isOwner ? '호스트' : '읽기전용'; }
    });

    const verEl = document.getElementById('appVersion');
    if (verEl) verEl.textContent = `v${DISPLAY_VERSION || APP_VERSION}`;

    // 로컬 로드 + 정규화
    const loaded = loadLocal();
    setRoster(loaded.map(p => ({ ...p, mainLine: normLine(p.mainLine || 'A'), subLine: normLine(p.subLine || 'A') })));
    saveLocal(roster);
    // 방에 없으면(= 로컬처럼 동작) 저장된 팀 복원 (존재하지 않는 id는 필터링)
    {
        const rid = getRoomIdFromURL();
        if (!rid) {
            const t = loadLocalTeams();
            const idSet = new Set(roster.map(p => p.id));
            setCurrentTeams({
                team1: (t.team1 || []).filter(id => idSet.has(id)),
                team2: (t.team2 || []).filter(id => idSet.has(id))
            });
        }
    }
    {
        const rid = getRoomIdFromURL();
        if (!rid) {
            const pref = loadLocalPrefs();
            if (pref) setPrefs(pref); // 컨트롤에 값 주입
        }
    }
    // UI
    if (els.teamSortSel) {
        els.teamSortSel.value = loadTeamSort(); // 유효성/기본값 처리 포함
    }

    renderRoster(); renderTeams();
    maybeCreateShareButton();
    bindDragAndDrop();
    registerEventHandlers();
    toggleScoringControls();

    // Firebase Auth + 방 구독
    if (SYNC_MODE && window.firebase?.auth) {
        window.firebase.auth().onAuthStateChanged(async (user) => {
            if (!user) { try { await window.firebase.auth().signInAnonymously(); } catch { } return; }
            SYNC.uid = user.uid;
            const rid = getRoomIdFromURL();
            if (rid) { await createRoomIfNeeded(rid); startRoomSync(rid); }
        });
    }
}
