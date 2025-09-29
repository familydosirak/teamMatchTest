// /main.js
import { SYNC_MODE } from './src/config.js';
import { initFirebase } from './src/firebase.js';
import { init } from './src/app.js';

(function bootstrap() {
    // Firebase 초기화 (SYNC_MODE에 따라 자동 on/off)
    initFirebase();

    // 앱 시작
    init();
})();
