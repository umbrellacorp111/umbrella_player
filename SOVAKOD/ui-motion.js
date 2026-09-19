(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasGsap = typeof window.gsap !== 'undefined';
  const selectAll = (selector, root = document) => [...root.querySelectorAll(selector)];

  function reveal(root) {
    if (reduced || !hasGsap || !root || root.hidden) return;
    const items = selectAll('.dash-header, .stats article, .content-section', root)
      .filter((item) => !item.closest('[hidden]'));
    if (!items.length) return;
    gsap.killTweensOf(items);
    gsap.fromTo(items, { autoAlpha: 0, y: 18 }, {
      autoAlpha: 1,
      y: 0,
      duration: 0.55,
      stagger: 0.07,
      ease: 'power3.out',
      clearProps: 'opacity,visibility,transform'
    });
  }

  function addRipple(event) {
    const button = event.target.closest('button, .primary, .add-track, .profile-pill');
    if (!button || button.disabled || reduced) return;
    const rect = button.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'ui-ripple';
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    button.append(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  }

  function enhanceCards(root = document) {
    if (reduced || !hasGsap) return;
    selectAll('.playlist-card:not([data-motion-ready])', root).forEach((card) => {
      card.dataset.motionReady = 'true';
      let tiltRaf = 0;
      let lastEvt = null;
      const applyTilt = () => {
        tiltRaf = 0;
        const event = lastEvt;
        lastEvt = null;
        if (!event || !card.isConnected) return;
        const rect = card.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width - 0.5;
        const y = (event.clientY - rect.top) / rect.height - 0.5;
        gsap.to(card, { x: x * 4, y: y * 4, duration: 0.35, ease: 'power2.out', overwrite: 'auto' });
      };
      card.addEventListener('pointermove', (event) => {
        if (event.pointerType === 'touch') return;
        lastEvt = event;
        if (!tiltRaf) tiltRaf = requestAnimationFrame(applyTilt);
      });
      card.addEventListener('pointerleave', () => {
        lastEvt = null;
        if (tiltRaf) { cancelAnimationFrame(tiltRaf); tiltRaf = 0; }
        gsap.to(card, { x: 0, y: 0, duration: 0.55, ease: 'elastic.out(1, .55)', overwrite: 'auto' });
      });
    });
  }

  document.addEventListener('pointerdown', addRipple, { passive: true });
  document.addEventListener('click', (event) => {
    const nav = event.target.closest('.nav-link');
    if (nav) {
      const target = document.querySelector(`#${nav.dataset.view}Content`) || document.querySelector('#libraryContent');
      requestAnimationFrame(() => reveal(target?.closest('.dashboard')));
    }
  });

  const dashboard = document.querySelector('#dashboard');
  if (dashboard) {
    new MutationObserver(() => {
      if (!dashboard.hidden) {
        reveal(dashboard);
        enhanceCards(dashboard);
      }
    }).observe(dashboard, { attributes: true, childList: true, subtree: true, attributeFilter: ['hidden'] });
  }

  const grid = document.querySelector('#playlistGrid');
  if (grid) new MutationObserver(() => enhanceCards(grid)).observe(grid, { childList: true });

  window.addEventListener('load', () => {
    if (!reduced && hasGsap) {
      const login = document.querySelector('.login-view');
      if (login && !login.hidden) {
        gsap.fromTo('.login-view .eyebrow, .login-view h1, .login-view .lead, .login-view .login-card, .login-view .terms',
          { autoAlpha: 0, y: 22 },
          { autoAlpha: 1, y: 0, stagger: 0.09, duration: 0.65, ease: 'power3.out', clearProps: 'opacity,visibility,transform' });
      }
    }
    enhanceCards();
  });
})();
