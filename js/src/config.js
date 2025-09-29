// src/config.js
export const APP_CONFIG = {
    SYNC_MODE: true, //온라인 동기화 모드
    PLACEMENT_GAMES: 10, // 배치(점수 2배) 적용할 경기 수: N 미만일 때 배치 적용됨
    PLACEMENT_MULTIPLIER: 2, // 배치 적용 배수

      // 퍼블리시 스로틀/최대대기
    PUBLISH_MIN_INTERVAL_MS: 2000,  // 기존 MIN_INTERVAL
    PUBLISH_MAX_WAIT_MS: 5000,      // 기존 MAX_WAIT

    // 승리 버튼 보호 타이밍
    WIN_DEBOUNCE_MS: 220,           // 더블클릭 묶기
    WIN_THROTTLE_MS: 2000,          // 쿨다운(퍼블리시와 보통 맞춤)
};

export const APP_VERSION = '1.0.1';        // 내부 표기(semver)
export const DISPLAY_VERSION = '1.0';      // UI에 보이는 짧은 표기(원하면 APP_VERSION에서 파생해도 OK)
export const SYNC_MODE = !!APP_CONFIG.SYNC_MODE;
export const PLACEMENT_GAMES = Math.max(0, Math.floor(+APP_CONFIG.PLACEMENT_GAMES || 0));
export const PLACEMENT_MULTIPLIER = Math.max(1, Math.floor(+APP_CONFIG.PLACEMENT_MULTIPLIER || 2));
export const PUBLISH_MIN_INTERVAL_MS = Math.max(250, +APP_CONFIG.PUBLISH_MIN_INTERVAL_MS || 2000);
export const PUBLISH_MAX_WAIT_MS = Math.max(PUBLISH_MIN_INTERVAL_MS, +APP_CONFIG.PUBLISH_MAX_WAIT_MS || 5000);

export const WIN_DEBOUNCE_MS = Math.max(0, +APP_CONFIG.WIN_DEBOUNCE_MS || 220);
// 기본값은 퍼블리시 스로틀과 동일하게
export const WIN_THROTTLE_MS = Math.max(300, +APP_CONFIG.WIN_THROTTLE_MS || PUBLISH_MIN_INTERVAL_MS);

