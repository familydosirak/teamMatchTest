// src/io.js
import { normLine, uid } from './state.js';
import { winRate } from './state.js';

/** 팀 텍스트 생성(순수 함수) */
export function buildTeamsText(roster, currentTeams) {
    const nameById = new Map(roster.map(p => [p.id, p.name]));
    const n1 = currentTeams.team1.map(id => nameById.get(id)).filter(Boolean);
    const n2 = currentTeams.team2.map(id => nameById.get(id)).filter(Boolean);
    return `1팀 ${n1.length ? n1.join(', ') : '(비어있음)'}\n2팀 ${n2.length ? n2.join(', ') : '(비어있음)'}`;
}

export async function copyToClipboard(text) {
    try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch { }
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
}

/** 내보내기용 정렬 (순수 함수) */
export function sortRosterForExport(roster, { key = 'name', asc = true } = {}) {
    const s = roster.slice().sort((a, b) => {
        const byName = a.name.localeCompare(b.name, 'ko');
        if (key === 'name') return (asc ? 1 : -1) * byName;

        if (key === 'line') {
            const la = (normLine(a.mainLine) + '/' + normLine(a.subLine));
            const lb = (normLine(b.mainLine) + '/' + normLine(b.subLine));
            const cmp = la.localeCompare(lb); return (asc ? 1 : -1) * (cmp || byName);
        }
        if (key === 'score') { const cmp = (a.score - b.score); return (asc ? 1 : -1) * (cmp || byName); }
        if (key === 'wl') {
            const wa = +a.wins || 0, wb = +b.wins || 0;
            const la2 = +a.losses || 0, lb2 = +b.losses || 0;
            const cmp = (wa - wb) || (lb2 - la2); return (asc ? 1 : -1) * (cmp || byName);
        }
        if (key === 'wr') { const cmp = (winRate(a) - winRate(b)); return (asc ? 1 : -1) * (cmp || byName); }
        if (key === 'games') { const cmp = ((+a.games || 0) - (+b.games || 0)); return (asc ? 1 : -1) * (cmp || byName); }
        return byName;
    });
    return s;
}

/** XLSX 내보내기 (list: 정렬된 배열) */
export async function exportRosterXLSX(list, filename) {
    if (typeof window.ExcelJS === 'undefined') { alert('ExcelJS 로더를 찾을 수 없습니다.'); return; }
    const wb = new window.ExcelJS.Workbook();
    const ws = wb.addWorksheet('멤버목록', { properties: { defaultRowHeight: 18 } });

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

    list.forEach(p => {
        ws.addRow({
            name: p.name, score: p.score, games: p.games || 0, wins: p.wins || 0, losses: p.losses || 0,
            wr: winRate(p), main: normLine(p.mainLine), sub: normLine(p.subLine)
        });
    });

    const headerRow = ws.getRow(1);
    headerRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF20304A' } };
        cell.font = { bold: true, color: { argb: 'FFE6EEF8' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FF1C2B45' } } };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        [1, 7, 8].forEach(c => row.getCell(c).alignment = { vertical: 'middle', horizontal: 'center' });
        [2, 3, 4, 5, 6].forEach(c => row.getCell(c).alignment = { vertical: 'middle', horizontal: 'right' });
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
}

/** TXT/JSON → 데이터 파싱(순수) */
export function parseTextToRoster(text) {
    try {
        let data;
        const trimmed = String(text || '').trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            data = JSON.parse(trimmed);
        } else {
            data = trimmed.split(/\r?\n/).map(line => {
                if (!line.trim()) return null;
                const a = line.split(',').map(s => s.trim());
                if (!a[0]) return null;
                return { name: a[0], score: +a[1] || 0, games: a[2] ? Math.floor(+a[2] || 0) : 0, wins: a[3] ? Math.floor(+a[3] || 0) : 0, losses: a[4] ? Math.floor(+a[4] || 0) : 0, mainLine: a[5], subLine: a[6] };
            }).filter(Boolean);
        }
        if (!Array.isArray(data)) data = [data];

        const imported = []; const errs = [];
        data.forEach((it, i) => {
            const rowNo = i + 1;
            let name = String(it.name || '').slice(0, 16);
            if (!name) return;
            if (/^[=+\-@]/.test(name)) name = "'" + name;

            const score = Number(it.score) || 0;
            const games = Math.floor(Number(it.games) || 0);
            const wins = Math.floor(Number(it.wins) || 0);
            const losses = Math.floor(Number(it.losses) || 0);
            if (games < 0 || wins < 0 || losses < 0) { errs.push(`행 ${rowNo}: 음수 값(games/wins/losses)`); }

            const toLetter = v => String(v || 'A').trim().toUpperCase().slice(0, 1);
            const mainLine = normLine(toLetter(it.mainLine || 'A'));
            const subLine = normLine(toLetter(it.subLine || 'A'));

            imported.push({ id: uid(), name, score, games, wins, losses, mainLine, subLine });
        });

        if (errs.length) { return { error: `텍스트/JSON 불러오기 실패: 음수 값이 감지되었습니다.\n${errs.slice(0, 5).join('\n')}${errs.length > 5 ? `\n...외 ${errs.length - 5}건` : ''}` }; }
        if (!imported.length) { return { error: '유효한 데이터 행을 찾지 못했습니다.' }; }
        return { imported };
    } catch (e) {
        return { error: '불러오기 실패: 파일 형식을 확인하세요.' };
    }
}

/** XLSX → 데이터 파싱(순수) */
export function parseXlsxToRoster(arrayBuffer) {
    try {
        const wb = window.XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
        const first = wb.SheetNames && wb.SheetNames[0];
        if (!first) return { error: '시트를 찾을 수 없습니다.' };
        const ws = wb.Sheets[first];
        const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
        if (!rows.length) return { error: '빈 시트입니다.' };

        const header = rows[0].map(x => String(x || '').trim());
        const dataRows = rows.slice(1);
        const norm = s => String(s || '').replace(/\s+/g, '').replace(/[^가-힣a-zA-Z0-9]/g, '').toLowerCase();
        const headerIdx = {}; header.forEach((h, i) => { headerIdx[norm(h)] = i; });
        const pick = (...alts) => { for (const a of alts) { const i = headerIdx[norm(a)]; if (i !== undefined) return i; } return null; };

        const idxName = pick('이름', 'name'); if (idxName === null) return { error: '엑셀에 "이름" 열이 필요합니다. (내보낸 형식을 사용해주세요)' };
        const idxScore = pick('점수', 'score');
        const idxGames = pick('판수', 'games');
        const idxWins = pick('승', 'wins');
        const idxLosses = pick('패', 'losses');
        const idxMain = pick('주라인', '주 라인', 'mainline');
        const idxSub = pick('부라인', '부 라인', 'subline');

        const get = (row, i, d = '') => (i === null || row[i] === undefined || row[i] === null) ? d : String(row[i]).trim();
        const toInt = (v, def = 0) => { const n = Number(String(v).trim()); return Number.isFinite(n) ? Math.floor(n) : def; };
        const toLetter = v => String(v || 'A').trim().toUpperCase().slice(0, 1);

        const imported = []; const errs = [];
        dataRows.forEach((r, idx) => {
            const rowNo = idx + 2;
            let name = get(r, idxName, ''); if (!name) return;
            name = name.slice(0, 16); if (/^[=+\-@]/.test(name)) name = "'" + name;

            const score = Number(get(r, idxScore, 0)) || 0;
            const games = toInt(get(r, idxGames, 0), 0);
            const wins = toInt(get(r, idxWins, 0), 0);
            const losses = toInt(get(r, idxLosses, 0), 0);
            if (games < 0 || wins < 0 || losses < 0) { errs.push(`행 ${rowNo}: 음수 값(games/wins/losses)`); }

            const mainLine = normLine(toLetter(get(r, idxMain, 'A')));
            const subLine = normLine(toLetter(get(r, idxSub, 'A')));

            imported.push({ id: uid(), name, score, games, wins, losses, mainLine, subLine });
        });

        if (errs.length) { return { error: `엑셀 불러오기 실패: 음수 값이 감지되었습니다.\n${errs.slice(0, 5).join('\n')}${errs.length > 5 ? `\n...외 ${errs.length - 5}건` : ''}` }; }
        if (!imported.length) { return { error: '유효한 데이터 행을 찾지 못했습니다.' }; }
        return { imported };
    } catch (e) {
        return { error: 'XLSX 불러오기 중 오류가 발생했습니다.' };
    }
}
