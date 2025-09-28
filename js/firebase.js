// === Firebase 초기화 (main.js로 이동) ===
(function initFirebaseIfNeeded() {

    const SYNC_MODE = !!(window.APP_CONFIG && window.APP_CONFIG.SYNC_MODE);
    
  // 동기화 OFF면 아무 것도 안 함
  if (!SYNC_MODE) {
    // 혹시 모를 참조를 대비해 db를 비워둠
    window.db = undefined;
    return;
  }

  // SDK 안전 확인
  if (typeof firebase === 'undefined' || !firebase.initializeApp) {
    console.warn('[Firebase] SDK가 아직 로드되지 않았습니다. 스크립트 순서를 확인하세요.');
    return;
  }

  const firebaseConfig = {
    apiKey: "AIzaSyD03wiOiIKWg1JCv8pDSCzKDxaTY73JjbY",
    authDomain: "teammaker-9b01e.firebaseapp.com",
    projectId: "teammaker-9b01e",
    storageBucket: "teammaker-9b01e.firebasestorage.app",
    messagingSenderId: "208384601983",
    appId: "1:208384601983:web:5f2298dd2e06bebee5b44a",
    measurementId: "G-RWX3W2203B"
  };

  // 중복 초기화 방지
  if (!firebase.apps || !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }

  // 로컬에서 App Check 디버그
  if (location.hostname === 'localhost') {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }

  try {
    const appCheck = firebase.appCheck();
    appCheck.activate(
      new firebase.appCheck.ReCaptchaEnterpriseProvider('6LeJ6tcrAAAAAPiIe8gylieZ4u7GFL4WmCgBWwxy'),
      true
    );
  } catch (e) {
    console.warn('[Firebase] AppCheck activate 실패(무시 가능):', e);
  }

  // Firestore 핸들
  window.db = firebase.firestore();
})();