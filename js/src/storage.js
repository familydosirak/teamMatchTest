// src/storage.js
import { normLine, uid } from './state.js';

const STORAGE_KEY = 'team_roster_v1';

export function saveLocal(roster) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(roster));
}

export function loadLocal() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) return [];
        return data.filter(x => x && x.name).map(x => ({
            id: x.id || uid(),
            name: String(x.name || '').trim(),
            score: +x.score || 0,
            games: Math.max(0, Math.floor(+x.games || 0)),
            wins: Math.max(0, Math.floor(+x.wins || 0)),
            losses: Math.max(0, Math.floor(+x.losses || 0)),
            mainLine: normLine(x.mainLine),
            subLine: normLine(x.subLine),
            lastDelta: 0
        }));
    } catch {
        return [];
    }
}

// === Preferences local persistence ===
const PREFS_KEY = 'team_prefs_v1';

export function saveLocalPrefs(prefs) {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch { }
}

export function loadLocalPrefs() {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw) || {};
        // 정규화
        const inList = (v, list) => (list.includes(v) ? v : list[0]);
        return {
            scoringMode: inList(p.scoringMode, ['elo', 'fixed']),
            eloK: Number.isFinite(+p.eloK) ? +p.eloK : 60,
            winBonus: Number.isFinite(+p.winBonus) ? +p.winBonus : 30,
            balanceMode: inList(p.balanceMode, ['prefer_line', 'prefer_mmr', 'ignore_line']),
            mmrTolerance: Number.isFinite(+p.mmrTolerance) ? +p.mmrTolerance : 120,
        };
    } catch {
        return null;
    }
}


const TEAMS_KEY = 'team_current_v1';

export function saveLocalTeams(currentTeams) {
    try {
        localStorage.setItem(TEAMS_KEY, JSON.stringify({
            team1: Array.isArray(currentTeams?.team1) ? currentTeams.team1 : [],
            team2: Array.isArray(currentTeams?.team2) ? currentTeams.team2 : []
        }));
    } catch { }
}

export function loadLocalTeams() {
    try {
        const raw = localStorage.getItem(TEAMS_KEY);
        if (!raw) return { team1: [], team2: [] };
        const t = JSON.parse(raw);
        return {
            team1: Array.isArray(t.team1) ? t.team1 : [],
            team2: Array.isArray(t.team2) ? t.team2 : []
        };
    } catch {
        return { team1: [], team2: [] };
    }
}

