// src/config.js
export const APP_CONFIG = {
    SYNC_MODE: false, //온라인 동기화 모드
    PLACEMENT_GAMES: 10, // 배치(점수 2배) 적용할 경기 수: N 미만일 때 배치 적용됨
    PLACEMENT_MULTIPLIER: 2, // 배치 적용 배수
};

export const SYNC_MODE = !!APP_CONFIG.SYNC_MODE;
export const PLACEMENT_GAMES = Math.max(0, Math.floor(+APP_CONFIG.PLACEMENT_GAMES || 0));
export const PLACEMENT_MULTIPLIER = Math.max(1, Math.floor(+APP_CONFIG.PLACEMENT_MULTIPLIER || 2));
