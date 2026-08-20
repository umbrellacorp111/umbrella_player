(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const hasGsap = typeof window.gsap !== 'undefined';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

  // ── Spring Physics ──
  class Spring {
    constructor(value, cfg = {}) {
      this.from = value;
      this.to = value;
      this.value = value;
      this.velocity = 0;
      this.mass = cfg.mass ?? 1;
      this.stiffness = cfg.stiffness ?? 180;
      this.damping = cfg.damping ?? 12;
      this.precision = cfg.precision ?? 0.005;
    }
    setTarget(to) { this.to = to; }
    step(dt) {
      const displacement = this.value - this.to;
      const springForce = -this.stiffness * displacement;
      const dampingForce = -this.damping * this.velocity;
      const acceleration = (springForce + dampingForce) / this.mass;
      this.velocity += acceleration * dt;
      this.value += this.velocity * dt;
      if (Math.abs(this.value - this.to) < this.precision && Math.abs(this.velocity) < this.precision) {
        this.value = this.to;
        this.velocity = 0;
        return false;
      }
      return true;
    }
  }

  // ── Active Animations Registry ──
  const activeEls = new Map();
  let mainTicking = false;
  const BASE_DT = 1 / 60;

  function ensureLoop() {
    if (mainTicking) return;
    mainTicking = true;
    requestAnimationFrame(tick);
  }

  function tick(now) {
    let anyActive = false;
    activeEls.forEach((props, el) => {
      let elActive = false;
      for (const [prop, spring] of Object.entries(props)) {
        if (spring.step(BASE_DT)) {
          elActive = true;
          applyProp(el, prop, spring.value);
        } else {
          // Spring settled: keep applying its final value so the
          // transform is never rebuilt without it (prevents snapping).
          applyProp(el, prop, spring.value);
          delete props[prop];
        }
      }
      if (elActive) anyActive = true;
      else activeEls.delete(el);
    });
    if (anyActive) requestAnimationFrame(tick);
    else mainTicking = false;
  }

  // ── Persistent last-applied values (so settled axes are never lost) ──
  function lastOf(el, prop, fallback) {
    const last = el.__springLast || {};
    return last[prop] != null ? last[prop] : fallback;
  }

  function setLast(el, prop, val) {
    if (!el.__springLast) el.__springLast = {};
    el.__springLast[prop] = val;
  }

  function applyProp(el, prop, val) {
    switch (prop) {
      case 'scaleX': case 'scaleY': {
        const sx = prop === 'scaleX' ? val : (activeEls.get(el)?.scaleX?.value ?? lastOf(el, 'scaleX', 1));
        const sy = prop === 'scaleY' ? val : (activeEls.get(el)?.scaleY?.value ?? lastOf(el, 'scaleY', 1));
        setLast(el, 'scaleX', sx); setLast(el, 'scaleY', sy);
        el.style.transform = buildTransform(el, { scale: `${sx} ${sy}` });
        break;
      }
      case 'scale': {
        setLast(el, 'scale', val);
        el.style.transform = buildTransform(el, { scale: `${val} ${val}` });
        break;
      }
      case 'rotateX': case 'rotateY': {
        const rx = prop === 'rotateX' ? val : (activeEls.get(el)?.rotateX?.value ?? lastOf(el, 'rotateX', 0));
        const ry = prop === 'rotateY' ? val : (activeEls.get(el)?.rotateY?.value ?? lastOf(el, 'rotateY', 0));
        setLast(el, 'rotateX', rx); setLast(el, 'rotateY', ry);
        el.style.transform = buildTransform(el, { rotateX: rx, rotateY: ry });
        break;
      }
      case 'x': case 'y': {
        const x = prop === 'x' ? val : (activeEls.get(el)?.x?.value ?? lastOf(el, 'x', 0));
        const y = prop === 'y' ? val : (activeEls.get(el)?.y?.value ?? lastOf(el, 'y', 0));
        setLast(el, 'x', x); setLast(el, 'y', y);
        el.style.transform = buildTransform(el, { x, y });
        break;
      }
      case 'translateY': {
        setLast(el, 'translateY', val);
        el.style.transform = buildTransform(el, { translateY: val });
        break;
      }
      case 'translateX': {
        setLast(el, 'translateX', val);
        el.style.transform = buildTransform(el, { translateX: val });
        break;
      }
      case 'opacity': {
        setLast(el, 'opacity', val);
        el.style.opacity = val;
        break;
      }
      case 'shadowBlur': {
        const a = activeEls.get(el);
        const spread = a?.shadowSpread?.value ?? lastOf(el, 'shadowSpread', 0);
        const alpha = a?.shadowAlpha?.value ?? lastOf(el, 'shadowAlpha', 0);
        setLast(el, 'shadowBlur', val);
        el.style.boxShadow = `0 ${val * 0.5}px ${val}px rgba(0,0,0,${alpha.toFixed(3)})`;
        break;
      }
      default:
        el.style[prop] = val;
    }
  }

  function buildTransform(el, overrides = {}) {
    const props = activeEls.get(el) || {};
    const last = el.__springLast || {};
    const parts = [];
    const x = overrides.x ?? props.x?.value ?? last.x ?? 0;
    const y = overrides.y ?? props.y?.value ?? last.y ?? 0;
    const ty = overrides.translateY ?? props.translateY?.value ?? last.translateY ?? 0;
    const tx = overrides.translateX ?? props.translateX?.value ?? last.translateX ?? 0;
    const rx = overrides.rotateX ?? props.rotateX?.value ?? last.rotateX ?? 0;
    const ry = overrides.rotateY ?? props.rotateY?.value ?? last.rotateY ?? 0;
    const sc = overrides.scale ?? (props.scale?.value != null ? `${props.scale.value} ${props.scale.value}` : (last.scale != null ? `${last.scale} ${last.scale}` : null));

    if (x || tx) parts.push(`translateX(${(x + tx).toFixed(2)}px)`);
    if (y || ty) parts.push(`translateY(${(y + ty).toFixed(2)}px)`);
    if (rx) parts.push(`rotateX(${rx.toFixed(2)}deg)`);
    if (ry) parts.push(`rotateY(${ry.toFixed(2)}deg)`);
    if (sc) parts.push(`scale(${sc})`);
    return parts.join(' ') || 'none';
  }

  function springTo(el, props, cfg = {}) {
    if (!el) return;
    let map = activeEls.get(el);
    if (!map) { map = {}; activeEls.set(el, map); }
    for (const [prop, target] of Object.entries(props)) {
      if (!map[prop]) {
        const current = getCurrentVal(el, prop);
        map[prop] = new Spring(current, cfg);
      }
      map[prop].mass = cfg.mass ?? 1;
      map[prop].stiffness = cfg.stiffness ?? 180;
      map[prop].damping = cfg.damping ?? 12;
      map[prop].precision = cfg.precision ?? 0.005;
      map[prop].setTarget(target);
    }
    ensureLoop();
  }

  function stopSpring(el, prop) {
    const map = activeEls.get(el);
    if (!map) return;
    if (prop) delete map[prop];
    else activeEls.delete(el);
  }

  function getCurrentVal(el, prop) {
    const last = el.__springLast || {};
    switch (prop) {
      case 'scale': case 'scaleX': case 'scaleY': return last[prop] != null ? last[prop] : 1;
      case 'rotateX': case 'rotateY': return last[prop] != null ? last[prop] : 0;
      case 'x': case 'y': case 'translateY': case 'translateX': return last[prop] != null ? last[prop] : 0;
      case 'opacity': return last[prop] != null ? last[prop] : (parseFloat(el.style.opacity) || 1);
      case 'shadowBlur': return 0;
      default: return 0;
    }
  }

  // ── Preset Spring Configs ──
  const SPRING = {
    gentle:  { mass: 1, stiffness: 120, damping: 14 },
    tilt:    { mass: 1, stiffness: 140, damping: 23 },
    snappy:  { mass: 0.8, stiffness: 200, damping: 18 },
    bouncy:  { mass: 1, stiffness: 150, damping: 10 },
    stiff:   { mass: 1.2, stiffness: 280, damping: 22 },
    elastic: { mass: 0.6, stiffness: 180, damping: 8 },
    button:  { mass: 0.5, stiffness: 320, damping: 16 },
    card:    { mass: 0.8, stiffness: 160, damping: 14 },
    heavy:   { mass: 1.5, stiffness: 100, damping: 16 },
  };

  // ── Button Spring Interactions ──
  function initButtons() {
    const SELECTOR = '.np-btn, .track-action, .card-play, .primary, .sort-button, .text-button, .add-track, .profile-pill, .toggle, .danger';

    document.addEventListener('pointerenter', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(SELECTOR) : null;
      if (!btn || btn.disabled) return;
      springTo(btn, { scale: 1.03, y: -2 }, SPRING.snappy);
      btn.style.boxShadow = '0 6px 20px rgba(0,0,0,0.25)';
    }, true);

    document.addEventListener('pointerleave', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(SELECTOR) : null;
      if (!btn) return;
      springTo(btn, { scale: 1, y: 0 }, SPRING.button);
      btn.style.boxShadow = '';
    }, true);

    document.addEventListener('pointerdown', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(SELECTOR) : null;
      if (!btn || btn.disabled) return;
      springTo(btn, { scale: 0.96 }, SPRING.stiff);
      btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
      spawnRipple(btn, e.clientX, e.clientY);
    }, true);

    document.addEventListener('pointerup', () => {
      $$('.np-btn, .track-action, .card-play, .primary, .sort-button, .text-button, .add-track, .profile-pill, .toggle, .danger').forEach(btn => {
        if (btn.matches(':hover')) {
          springTo(btn, { scale: 1.03, y: -2 }, SPRING.snappy);
          btn.style.boxShadow = '0 6px 20px rgba(0,0,0,0.25)';
        } else {
          springTo(btn, { scale: 1, y: 0 }, SPRING.button);
          btn.style.boxShadow = '';
        }
      });
    }, true);
  }

  // ── Ripple ──
  function spawnRipple(el, cx, cy) {
    const rect = el.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'spring-ripple';
    ripple.style.left = `${cx - rect.left}px`;
    ripple.style.top = `${cy - rect.top}px`;
    const prevPosition = el.style.position;
    const prevOverflow = el.style.overflow;
    el.style.position = prevPosition || 'relative';
    el.style.overflow = 'hidden';
    el.__ripples = (el.__ripples || 0) + 1;
    el.appendChild(ripple);
    ripple.addEventListener('animationend', () => {
      ripple.remove();
      el.__ripples = Math.max(0, (el.__ripples || 1) - 1);
      if (!el.__ripples && el.style.overflow === 'hidden') {
        el.style.overflow = prevOverflow;
      }
    }, { once: true });
  }

  // ── Card 3D Tilt ──
  function initCardTilt() {
    const TILT_MAX = 3;
    // Only cards tilt; `.track-row` was removed — rows retargeted the
    // springs on every pointermove and visibly trembled.
    const SELECTOR = '.playlist-card';

    document.addEventListener('pointermove', (e) => {
      const card = e.target && e.target.closest ? e.target.closest(SELECTOR) : null;
      if (!card || e.pointerType === 'touch') return;
      const rect = card.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      springTo(card, { rotateY: x * TILT_MAX * 2, rotateX: -y * TILT_MAX * 2 }, SPRING.tilt);
    }, true);

    document.addEventListener('pointerleave', (e) => {
      const card = e.target && e.target.closest ? e.target.closest(SELECTOR) : null;
      if (!card) return;
      springTo(card, { rotateY: 0, rotateX: 0 }, SPRING.bouncy);
    }, true);
  }

  // ── Card Entrance Overshoot ──
  function springEntrance(elements, cfg = {}) {
    if (!elements || !elements.length) return;
    const stagger = cfg.stagger ?? 60;
    const sCfg = cfg.spring ?? SPRING.bouncy;
    [...elements].forEach((el, i) => {
      el.style.opacity = '0';
      el.style.transform = 'scale(0.92) translateY(20px)';
      setTimeout(() => {
        el.style.opacity = '';
        el.style.transform = '';
        springTo(el, { scale: 1, y: 0, opacity: 1 }, sCfg);
      }, i * stagger);
    });
  }

  // ── Inertial Scroll ──
  function initInertialScroll() {
    const containers = $$('.track-list');
    containers.forEach(list => {
      list.style.overscrollBehavior = 'contain';
      let scrollVel = 0;
      let lastY = 0;
      let scrolling = false;

      list.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaY) < 1) return;
        // Only consume the wheel if the list can actually scroll in that
        // direction; otherwise let the event bubble so the page scrolls.
        const canDown = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
        const canUp = list.scrollTop > 1;
        if ((e.deltaY > 0 && !canDown) || (e.deltaY < 0 && !canUp)) return;
        e.preventDefault();
        list.scrollTop += e.deltaY;
        scrollVel = e.deltaY;
        if (!scrolling) {
          scrolling = true;
          requestAnimationFrame(scrollTick);
        }
      }, { passive: false });

      function scrollTick() {
        if (Math.abs(scrollVel) < 0.5) { scrolling = false; return; }
        scrollVel *= 0.95;
        list.scrollTop += scrollVel;
        const maxScroll = list.scrollHeight - list.clientHeight;
        if (list.scrollTop <= 0 && scrollVel < 0) { scrollVel *= -0.3; }
        if (list.scrollTop >= maxScroll && scrollVel > 0) { scrollVel *= -0.3; }
        requestAnimationFrame(scrollTick);
      }
    });
  }

  // ── CTA Breathing via JS (enhanced gradient shift) ──
  function initCTABreathing() {
    $$('.primary.wide, .np-play').forEach(el => {
      let phase = Math.random() * Math.PI * 2;
      const breathe = () => {
        phase += 0.015;
        const s = 1 + Math.sin(phase) * 0.005;
        const existing = activeEls.get(el);
        const hasActiveSpring = existing && (existing.scale || existing.rotateX || existing.rotateY);
        const gsapBusy = hasGsap && window.gsap.getTweensOf(el).length > 0;
        if (!hasActiveSpring && !gsapBusy) {
          el.style.transform = `scale(${s.toFixed(4)})`;
        }
        requestAnimationFrame(breathe);
      };
      breathe();
    });
  }

  // ── Stats Counter Spring ──
  function springCount(el, target) {
    if (!el) return;
    const current = parseInt(el.textContent) || 0;
    if (current === target) return;
    const s = new Spring(current, { mass: 1, stiffness: 120, damping: 14 });
    s.setTarget(target);
    const animate = () => {
      if (s.step(BASE_DT)) {
        el.textContent = Math.round(s.value);
        requestAnimationFrame(animate);
      } else {
        el.textContent = target;
      }
    };
    requestAnimationFrame(animate);
  }

  // ── Toast Spring ──
  function springToast(el) {
    if (!el) return;
    springTo(el, { y: 0, opacity: 1, scale: 1 }, SPRING.bouncy);
  }

  // ── NP Art Wrap tilt (enhanced) ──
  function initNPTilt() {
    const wrap = $('.np-art-wrap');
    if (!wrap) return;
    let hovering = false;

    wrap.addEventListener('pointerenter', () => { hovering = true; });
    wrap.addEventListener('pointerleave', () => {
      hovering = false;
      springTo(wrap, { rotateY: 0, rotateX: 0, scale: 1 }, SPRING.bouncy);
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!hovering) return;
      const rect = wrap.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      springTo(wrap, { rotateY: x * 25, rotateX: -y * 20 }, SPRING.tilt);
    });
  }

  // ── Expose API ──
  window.SpringUI = {
    springTo,
    stopSpring,
    springEntrance,
    springCount,
    springToast,
    SPRING,
    spawnRipple,
    initButtons,
    initCardTilt,
    initInertialScroll,
    initCTABreathing,
    initNPTilt,
  };

  // ── Auto-init ──
  function autoInit() {
    initButtons();
    initCardTilt();
    initNPTilt();
    // initInertialScroll() is intentionally disabled: `.track-list` is
    // `overflow: hidden` (never scrolls itself), and its wheel handler +
    // `overscroll-behavior: contain` swallowed page scrolling over the list.
    if (hasGsap) {
      const login = $('.login-view');
      if (login && !login.hidden) {
        gsap.fromTo('.login-view .eyebrow, .login-view h1, .login-view .lead, .login-view .login-card, .login-view .terms',
          { autoAlpha: 0, y: 22 },
          { autoAlpha: 1, y: 0, stagger: 0.09, duration: 0.65, ease: 'power3.out', clearProps: 'opacity,visibility,transform' });
      }
    }
  }
  document.addEventListener('DOMContentLoaded', autoInit);
  if (document.readyState !== 'loading') autoInit();
})();
