// src/teams.js
import { avg, winRate, normLine, clamp } from './state.js';
import { currentTeams, lastTeams, teamHistory } from './state.js';

/**
 * === [팀 생성/균형 튜닝 가이드] ==========================================
 * 외부 설정(사용자/호스트가 바꾸는 값):
 *  - mode (balanceMode): 'prefer_line' | 'prefer_mmr' | 'ignore_line'
 *      · prefer_line : 라인 커버/주라인 배정을 강하게 고려
 *      · prefer_mmr  : MMR 균형을 더 강하게(라인 영향 낮춤, 약간의 점수 지터 추가)
 *      · ignore_line : 라인을 거의 무시(현재 분기 로직은 prefer_mmr 계열과 유사 가중치)
 *  - allowDiff (mmrTolerance): 두 팀 평균 점수 허용 편차(초과 시 강한 패널티)
 *  - strength (mixStrength): 'normal' | 'strong'
 *      · strong = 시도 횟수/스왑 라운드/초기 온도 상향(더 집요하게 섞음)
 *
 * 내부 튜닝(경험값·가중치):
 *  - wCover, wPrimary : 라인 커버 수/주라인 배정 수에 주는 보너스 가중치
 *  - diversityW       : 같은 편성 유지 인원당(히스토리 기준) 다양성 패널티 가중치
 *  - mmrDiv           : 허용치 초과 MMR 패널티의 분모(클수록 패널티 완만)
 *  - wFair            : 라인 공정성 보정(주라인 배정 수가 많은 팀의 평균 MMR이 불리하면 보완)
 *  - wWR, wrScale     : 팀 승률 격차 기반 보정 강도(WR gap 커질수록 약간 더 보정)
 *  - hardPenalty      : 허용치 초과 시 매우 큰 제약으로 동일 편성/큰 편차를 강하게 금지
 *  - jitterAmp        : 결과 무작위성(지터) 세기 — 동일 입력에서도 약간의 변화를 줌
 *  - spreadPenalty    : 두 팀 점수 분산(표준편차) 차이에 대한 패널티(분포가 비슷하도록)
 *  - identicalPenalty : 지난 편성과 완전히 동일하면 사실상 불허(매우 큰 패널티)
 * ========================================================================
 */

// 팀 멤버들의 주/부/A 라인을 기준으로 T/J/M/B/S 커버 수와 주라인 배정 수(primaryAssigned)를 계산.
export function assignRoles(team) {
    const roles = ['T', 'J', 'M', 'B', 'S'], used = new Set(), assignment = {}; let primaryAssigned = 0;
    for (const r of roles) { const i = team.findIndex(p => !used.has(p.id) && normLine(p.mainLine) === r); if (i >= 0) { used.add(team[i].id); assignment[r] = team[i].id; primaryAssigned++; } }
    for (const r of roles) { if (assignment[r]) continue; const i = team.findIndex(p => !used.has(p.id) && normLine(p.subLine) === r); if (i >= 0) { used.add(team[i].id); assignment[r] = team[i].id; } }
    for (const r of roles) { if (assignment[r]) continue; const i = team.findIndex(p => !used.has(p.id) && (normLine(p.mainLine) === 'A' || normLine(p.subLine) === 'A')); if (i >= 0) { used.add(team[i].id); assignment[r] = team[i].id; } }
    return { coveredRoles: Object.keys(assignment).length, primaryAssigned };
}

// 직전 팀(lastTeams) 기준으로 동일 편성(스왑 허용)된 인원 수를 계산해 최대치를 반환.
export function countSameSideEither(t1Ids, t2Ids, base = lastTeams) {
    const last1 = new Set(base.team1 || []), last2 = new Set(base.team2 || []);
    let c1 = 0; for (const id of t1Ids) if (last1.has(id)) c1++; for (const id of t2Ids) if (last2.has(id)) c1++;
    let c2 = 0; for (const id of t1Ids) if (last2.has(id)) c2++; for (const id of t2Ids) if (last1.has(id)) c2++;
    return Math.max(c1, c2);
}

// 팀 히스토리 배열 중 어떤 스냅샷과 비교해도 가장 많이 같은 편에 남아있는 인원 수의 최대치를 계산.
export function countSameSideMultiEither(t1Ids, t2Ids, histories = teamHistory.length ? teamHistory : [lastTeams]) {
    let m = 0; for (const h of histories) { const c = countSameSideEither(t1Ids, t2Ids, h); if (c > m) m = c; } return m;
}

// 두 팀의 균형 점수를 계산(라인 커버/주라인 보너스, 승률 보정, MMR 차이·분산 패널티, 중복 편성 패널티, 허용치 초과 하드 패널티, 지터 포함).
export function scoreSplit(t1, t2, mode, allowDiff) {
    // m1/m2: 각 팀 평균 점수(MMR), diff: 평균 차이
    const m1 = avg(t1.map(p => p.score)), m2 = avg(t2.map(p => p.score)), diff = Math.abs(m1 - m2);

    // sdev(): 표준편차, s1/s2: 두 팀 점수 분산(분포) — 분포가 비슷하도록 spreadPenalty로 제약
    const sdev = a => { const m = avg(a); return a.length ? Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length) : 0 };
    const s1 = sdev(t1.map(p => p.score)), s2 = sdev(t2.map(p => p.score));

    // prefer_line 모드일 때 라인 관련 보너스를 활성화
    let a1 = { coveredRoles: 0, primaryAssigned: 0 }, a2 = { coveredRoles: 0, primaryAssigned: 0 };
    if (mode === 'prefer_line') { a1 = assignRoles(t1); a2 = assignRoles(t2); }

    // 가중치/튜닝값: 모드에 따라 조정
    //  - wCover : 라인 커버 수 보너스
    //  - wPrimary : 주라인 배정 수 보너스
    //  - jitterAmp : 결과 무작위성
    //  - diversityW : 히스토리 기반 동일 편성 패널티 가중
    //  - mmrDiv : 허용치 초과 soft 패널티 분모
    let wCover = 0, wPrimary = 0, jitterAmp = 1.5, diversityW = 1.5, mmrDiv = 180;
    if (mode === 'prefer_line') { wCover = 12; wPrimary = 4; jitterAmp = 0.8; diversityW = 1.2; mmrDiv = 120; }
    else { jitterAmp = 4.0; diversityW = 4.0; mmrDiv = 200; }

    // lineFairBonus: 주라인 배정 수가 더 많은 팀이 평균 MMR에서 불리하면 보정
    let lineFairBonus = 0;
    if (mode === 'prefer_line') {
        const gap = (a1.primaryAssigned || 0) - (a2.primaryAssigned || 0);
        if (gap !== 0) {
            const favSign = Math.sign(gap);
            const fairRaw = favSign * (m2 - m1);
            const wFair = 0.25;
            lineFairBonus = clamp(fairRaw * wFair * Math.abs(gap), -60, 60);
        }
    }

    // wrCompBonus: 평균 승률(WR) 격차가 클 때 MMR 보정
    let wrCompBonus = 0;
    {
        const wr1 = avg(t1.map(winRate)), wr2 = avg(t2.map(winRate));
        const wrGap = wr2 - wr1;
        if (Math.abs(wrGap) > 0) {
            const favSign = Math.sign(wrGap);
            const compRaw = favSign * (m1 - m2);
            const wWR = 0.30;
            const wrScale = clamp(Math.abs(wrGap) / 20, 0, 1);
            wrCompBonus = clamp(compRaw * wWR * (1 + wrScale * 0.5), -80, 80);
        }
    }

    // 허용치 관련 패널티
    const over = Math.max(0, diff - allowDiff);
    const mmrPenalty = (over * over) / mmrDiv;        // 약한 페널티
    const spreadPenalty = Math.abs(s1 - s2) * 0.18;    // 분산(표준편차) 차이 제약

    // 다양성/동일성 패널티
    const ids1 = t1.map(p => p.id), ids2 = t2.map(p => p.id);
    const sameSideMax = countSameSideMultiEither(ids1, ids2);
    const total = (ids1.length + ids2.length) || 1;
    const identicalPenalty = (sameSideMax === total) ? 1e6 : 0; // 완전 동일 편성은 사실상 금지
    const diversityPenalty = sameSideMax * diversityW;

    // 허용치 초과 하드 패널티 + 지터
    const hardPenalty = over > 0 ? over * over * 250 : 0; // 크게 초과하면 강력 제약
    const jitter = (Math.random() - 0.5) * jitterAmp;     // 결과에 소량 무작위성 부여

    return ((a1.coveredRoles + a2.coveredRoles) * wCover + (a1.primaryAssigned + a2.primaryAssigned) * wPrimary
        + lineFairBonus + wrCompBonus)
        - mmrPenalty - spreadPenalty - diversityPenalty - identicalPenalty - hardPenalty
        + jitter;
}

// 교차 스왑(유사 SA)으로 scoreSplit를 최대화; 허용 MMR 차이 위반/변화량(minChange) 미만은 패널티 적용.
export function improveBySwaps(pick, map, mode, allowDiff, rounds = 260, temp = 1.4, minChange = 2) {
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

// 주어진 ID 목록의 평균 점수(MMR)를 계산하는 내부 헬퍼.
function teamMeanByIds(ids, map) { if (!ids.length) return 0; let s = 0; for (const id of ids) s += map.get(id).score; return s / ids.length; }

// pick의 양 팀 평균 점수 차이(절대값)를 계산하는 내부 헬퍼.
function mmrDiffOfPick(pick, map) { return Math.abs(teamMeanByIds(pick.team1, map) - teamMeanByIds(pick.team2, map)); }

// 탐욕적 교환으로 팀 간 평균 MMR 차이를 targetDiff 이하로 줄임(최대 maxIters).
export function reduceMMRGap(pick, map, targetDiff, maxIters = 120) {
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
        if (bestGain > 0) { const a = pick.team1[bi], b = pick.team2[bj]; [pick.team1[bi], pick.team2[bj]] = [b, a]; } else break;
    }
    return pick;
}

// 팀 생성 엔트리—다수 시도→최적 pick 선택→스왑 최적화→변화량/다양성 보장→MMR 차이 축소까지 수행.
export function buildBalancedTeams(players, mode = 'prefer_line') {
    const n = players.length, half = n / 2, idx = [...Array(n).keys()];

    // mmrToleranceInput: UI 입력에서 허용 MMR 편차를 읽음(allowDiff = mmrTolerance)
    const mmrToleranceInput = document.getElementById('mmrTolerance');

    // mixStrengthSel: 'normal' | 'strong' — strong은 더 많은 시도/스왑/온도
    const mixStrengthSel = document.getElementById('mixStrength');

    // allowDiff: 평균 점수 차이 허용치(이 범위를 넘으면 패널티 적용)
    const allowDiff = Math.max(0, Math.round(Number(mmrToleranceInput?.value || 120)));

    // strength: 섞기 강도 — 'strong'이면 아래 시도 횟수/스왑 라운드/온도를 상향
    const strength = (mixStrengthSel?.value || 'normal');

    // attemptsBase : 초기 무작위 분할 시도 수의 기본값(모드별 상이, 인원수에 비례해 확대)
    // swapBase     : 스왑 기반 개선 라운드 수의 기본값
    // tempBase     : 스왑 탐색의 초기 온도(나쁜 해 수용 확률에 영향)
    // minChangeDiv : '최소 변화 인원' 계산의 분모(인원수/분모 = 최소 변화 인원)
    let attemptsBase, swapBase, tempBase, minChangeDiv;
    if (mode === 'prefer_line') { attemptsBase = 900;  swapBase = 320; tempBase = 1.5; minChangeDiv = 4; }
    else {                         attemptsBase = 2000; swapBase = 800; tempBase = 3.0; minChangeDiv = 2; }

    // attempts   : 무작위 초기 분할을 평가하는 총 횟수(상한 30,000)
    // swapRounds : 스왑 최적화 반복 횟수
    // initTemp   : 스왑 과정의 초기 온도
    // minChange  : 지난 편성과 비교해 최소 바뀌어야 하는 인원 수(= floor(n / minChangeDiv), 최소 2)
    const attempts = Math.min((strength === 'strong' ? attemptsBase * 2 : attemptsBase) * n, 30000);
    const swapRounds = (strength === 'strong' ? Math.round(swapBase * 1.4) : swapBase);
    const initTemp = (strength === 'strong' ? tempBase * 1.2 : tempBase);
    const minChange = Math.max(2, Math.floor(n / minChangeDiv));

    // evalPlayers: prefer_mmr 모드일 때 약간의 점수 지터 도입(국소 최적 탈출/동률 해소)
    let evalPlayers = players;
    if (mode === 'prefer_mmr') evalPlayers = players.map(p => ({ ...p, score: p.score + (Math.random() - 0.5) * 20 }));
    const map = new Map(evalPlayers.map(p => [p.id, p]));

    // 다수 시도 중 최고 점수 pick을 선택
    let best = null, bestScore = -Infinity;
    for (let a = 0; a < attempts; a++) {
        shuffle(idx);
        const t1 = idx.slice(0, half).map(i => evalPlayers[i]);
        const t2 = idx.slice(half).map(i => evalPlayers[i]);
        let sc = scoreSplit(t1, t2, mode, allowDiff);

        // 초기 분할 직후에도 허용치 초과는 강하게 기각
        const d0 = Math.abs(avg(t1.map(p => p.score)) - avg(t2.map(p => p.score)));
        if (d0 > allowDiff) sc -= (d0 - allowDiff) * 1e6;

        // same / changed: 지난 편성과 얼마나 다른가 → 변화가 적으면 페널티로 다양성 확보
        const same = countSameSideMultiEither(t1.map(p => p.id), t2.map(p => p.id));
        const changed = (t1.length + t2.length) - same;
        if (changed < minChange) sc -= (minChange - changed) * 20;

        if (sc > bestScore) { bestScore = sc; best = { team1: t1.map(p => p.id), team2: t2.map(p => p.id) }; }
    }
    if (!best) return { team1: evalPlayers.slice(0, half).map(p => p.id), team2: evalPlayers.slice(half).map(p => p.id) };

    // 스왑 최적화
    best = improveBySwaps(best, map, mode, allowDiff, swapRounds, initTemp, minChange);

    // 최소 변화량 보장(필요 시 강제 스왑) + prefer_mmr 추가 무작위 스왑
    const total = best.team1.length + best.team2.length;
    let changed = total - countSameSideMultiEither(best.team1, best.team2);
    if (changed < minChange) {
        const need = minChange - changed;
        for (let k = 0; k < need; k++) { const i = (Math.random() * best.team1.length) | 0, j = (Math.random() * best.team2.length) | 0; [best.team1[i], best.team2[j]] = [best.team2[j], best.team1[i]]; }
        if (mode === 'prefer_mmr') {
            for (let k = 0; k < best.team1.length; k++) {
                if (Math.random() < 0.3) { const i = (Math.random() * best.team1.length) | 0, j = (Math.random() * best.team2.length) | 0; [best.team1[i], best.team2[j]] = [best.team2[j], best.team1[i]]; }
            }
        }
    }

    // 평균 MMR 차이 축소(목표: allowDiff 이하)
    best = reduceMMRGap(best, map, allowDiff);
    return best;
}

// Fisher–Yates 방식으로 배열을 제자리 섞기(내부 유틸).
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } }
