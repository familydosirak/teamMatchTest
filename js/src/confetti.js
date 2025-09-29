// src/effects/confetti.js
export function launchConfetti(targetEl, opts = {}) {
    const duration = opts.duration ?? 1600;
    const count = opts.count ?? 150;
    const BOUNCE = 0.45, EDGE_FRICTION = 0.98, GROUND_FRICTION = 0.90;

    const rect = targetEl.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    targetEl.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    function resize() {
        const w = targetEl.clientWidth || rect.width;
        const h = targetEl.clientHeight || rect.height;
        canvas.width = Math.max(1, Math.floor(w * dpr));
        canvas.height = Math.max(1, Math.floor(h * dpr));
    }
    resize();

    const originX = canvas.width * 0.5, originY = canvas.height * 1;
    const POWER = 1.5, BASE_SPEED = 5, SPEED_VAR = 8, GRAVITY_MIN = 0.08, GRAVITY_VAR = 0.08, AIR_DRAG = 0.97;

    const particles = Array.from({ length: count }, () => {
        const CENTER_DEG = -90, SPREAD_DEG = 180;
        const theta = ((CENTER_DEG - SPREAD_DEG / 2) + Math.random() * SPREAD_DEG) * Math.PI / 180;
        const speed = (BASE_SPEED + Math.random() * SPEED_VAR) * POWER * dpr;
        return {
            x: originX, y: originY,
            vx: Math.cos(theta) * speed, vy: Math.sin(theta) * speed,
            g: (GRAVITY_MIN + Math.random() * GRAVITY_VAR) * dpr,
            w: (4 + Math.random() * 6) * dpr, h: (6 + Math.random() * 10) * dpr,
            rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
            color: ['#22c55e', '#4da3ff', '#f59e0b', '#ef4444', '#a78bfa', '#34d399'][(Math.random() * 6) | 0],
            alpha: 1
        };
    });

    const start = performance.now();
    function step(t) {
        const elapsed = t - start, progress = Math.min(1, elapsed / duration);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const p of particles) {
            p.x += p.vx; p.y += p.vy;
            p.vx *= AIR_DRAG; p.vy = p.vy * AIR_DRAG + p.g; p.rot += p.vr;

            if (p.x < 0) { p.x = 0; p.vx = -p.vx * BOUNCE; p.vy *= EDGE_FRICTION; p.vr *= EDGE_FRICTION; }
            else if (p.x > canvas.width) { p.x = canvas.width; p.vx = -p.vx * BOUNCE; p.vy *= EDGE_FRICTION; p.vr *= EDGE_FRICTION; }
            if (p.y < 0) { p.y = 0; p.vy = -p.vy * BOUNCE; p.vx *= EDGE_FRICTION; p.vr *= EDGE_FRICTION; }
            if (p.y > canvas.height) {
                p.y = canvas.height; p.vy = -Math.abs(p.vy) * BOUNCE;
                p.vx *= GROUND_FRICTION; p.vr *= GROUND_FRICTION;
                if (Math.abs(p.vy) < 0.25 * dpr) p.vy = 0;
                if (Math.abs(p.vx) < 0.15 * dpr) p.vx = 0;
            }
            p.alpha = 1 - progress;

            ctx.save();
            ctx.globalAlpha = p.alpha;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        }
        if (progress < 1) requestAnimationFrame(step);
        else targetEl.removeChild(canvas);
    }
    requestAnimationFrame(step);
}
