// src/state.js
export const LINES = ['T', 'J', 'M', 'B', 'S', 'A'];
export const LINE_TITLE = { T: 'Top', J: 'Jungle', M: 'Mid', B: 'Bottom', S: 'Supporter', A: 'All' };

export const SYNC = {
    enabled: false, roomId: null, uid: null,
    isOwner: false, readOnly: false, writing: false, unsub: null,
    applying: false, lastLocalTs: 0, lastWinTs: 0, lastEmittedTs: 0
};


export let roster = [];
export let matchHistory = [];
export let currentTeams = { team1: [], team2: [] };
export let teamHistory = []; export const HISTORY_LIMIT = 5;
export let lastTeams = { team1: [], team2: [] };
export let lastResultUndo = null;

export function setRoster(v) { roster = v; }
export function setCurrentTeams(v) { currentTeams = v; }
export function setLastTeams(v) { lastTeams = v; }
export function setLastResultUndo(v) { lastResultUndo = v; }

export const uid = () => Math.random().toString(36).slice(2, 10);
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export const avg = a => a.length ? (a.reduce((s, x) => s + x, 0) / a.length) : 0;
export const isPlacement = g => (Number(g) || 0) <= 10;
export const winRate = p => { const w = +p.wins || 0, l = +p.losses || 0, t = w + l; return t ? Math.round((w / t) * 100) : 0; };
export const wrClass = r => r >= 53 ? 'wr-good' : (r <= 47 ? 'wr-bad' : '');
export const normLine = v => { v = String(v || 'A').toUpperCase(); return LINES.includes(v) ? v : 'A'; };
export const linePair = p => `${normLine(p.mainLine)}/${normLine(p.subLine)}`;
export const escapeHtml = s => String(s || '').replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
}[ch]));
