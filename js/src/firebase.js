// /src/firebase.js
import { SYNC_MODE } from './config.js';

export function initFirebase() {
  // 동기화/온라인 기능 미사용 시 noop
  if (!SYNC_MODE) {
    window.db = undefined;
    return { ok: true, reason: 'disabled', db: null };
  }

  const fb = window.firebase;
  if (!fb || !fb.initializeApp) {
    console.warn('[Firebase] SDK가 아직 로드되지 않았습니다. CDN 스크립트 순서를 확인하세요.');
    return { ok: false, reason: 'sdk-missing', db: null };
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

  if (!fb.apps || !fb.apps.length) {
    fb.initializeApp(firebaseConfig);
  }


  try {
    const appCheck = fb.appCheck();
    appCheck.activate(
      new fb.appCheck.ReCaptchaEnterpriseProvider('6LeJ6tcrAAAAAPiIe8gylieZ4u7GFL4WmCgBWwxy'),
      true // auto refresh
    );
  } catch (e) {
    console.warn('[Firebase] AppCheck activate 실패(무시 가능):', e);
  }

  const db = fb.firestore();
  window.db = db;
  return { ok: true, reason: 'initialized', db };
}
