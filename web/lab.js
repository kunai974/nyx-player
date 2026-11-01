/* ============================================================================
   Nyx Player — page d'accueil du site : comportements et animations
   GSAP + ScrollTrigger + Lenis (copiés dans vendor/). Sans eux, la page reste entière et lisible.
   Même script pour la page anglaise (index.html) et la page française (accueil.html) :
   les rares textes écrits ici suivent la langue de la page (<html lang>).
   ============================================================================ */
(() => {
  const html = document.documentElement;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const gsap = window.gsap;
  const ST = window.ScrollTrigger;
  const anim = !!(gsap && ST) && !reduce;
  const fr = html.lang === 'fr';

  html.classList.toggle('anim', anim);
  if (anim) gsap.registerPlugin(ST);

  /* ------------------------------------------------------------------
     Données de démonstration
     ------------------------------------------------------------------ */
  const P = (n) => `assets/posters/${n}.jpg`;
  const POSTERS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'w1', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10', 'w11', 'w12'];

  const RAW = [
    ['FR| CHANNEL 1 FHD', 'FR ENTERTAINMENT', 'ts'],
    ['VOD| PEAKY.BLINDERS.THE.IMMORTAL.MAN.2026.MULTI.1080p', 'VOD MULTI', 'mkv'],
    ['SRS| INVINCIBLE S02E04 VOSTFR', 'SERIES VOSTFR', 'mkv'],
    ['SRS| INVINCIBLE S02E05 VOSTFR', 'SERIES VOSTFR', 'mkv'],
    ['|||||| ━━ CINEMA ━━ ||||||', '—', '—'],
    ['VOD| SCREAM 7 (2026) [MULTI] 4K', 'VOD 4K', 'mp4'],
    ['UK| CINEMA ACTION HD', 'UK MOVIES', 'ts'],
    ['US| SPORTS 2 HD ◉', 'US SPORTS', 'ts'],
    ['VOD| ONE.PIECE.S02E01.1080p.WEB', 'SERIES MULTI', 'mkv'],
    ['VOD| AGENT ZETA 2026 HDCAM', 'VOD NEW', 'mp4'],
    ['DE| KANAL 1 HD', 'DE GENERAL', 'ts'],
    ['SRS| JUJUTSU KAISEN S03E07 [JP]', 'ANIME', 'mkv'],
    ['VOD| THE.MADISON.S01E01.MULTI', 'SERIES MULTI', 'mkv'],
    ['4K| NATURE UHD 2160p ◉', '4K UHD', 'm3u8'],
    ['VOD| WAR MACHINE (2026) FHD', 'VOD NEW', 'mp4'],
    ['FR| INFO 24', 'FR NEWS', 'ts'],
    ['|||||| ━━ UK SPORTS ━━ ||||||', '—', '—'],
    ['VOD| ZOOTOPIA 2 (2025) TRUEFRENCH', 'VOD KIDS', 'mkv'],
    ['SRS| YOU S05E10 MULTI', 'SERIES MULTI', 'mkv'],
    ['VOD| GEMINI MAN 2019 BluRay', 'VOD MULTI', 'mkv'],
    ['IT| CANALE 5 HD', 'IT GENERAL', 'ts'],
    ['VOD| TERMINATOR SALVATION [VF]', 'VOD CLASSIC', 'avi'],
    ['SRS| WARRIOR S03E02', 'SERIES MULTI', 'mkv'],
    ['VOD| CODE 8 PART II (2024) FR', 'VOD MULTI', 'mp4'],
    ['ES| DEPORTES 3 HD', 'ES SPORTS', 'ts'],
    ['VOD| FUTUREWORLD (1976) SD', 'VOD CLASSIC', 'avi'],
    ['SRS| ONE PIECE S01E1089 VOSTFR', 'ANIME', 'mkv'],
    ['VOD| THE CHRISTMAS CHRONICLES 2018', 'VOD KIDS', 'mp4'],
  ];

  const EPG = fr ? [
    ['N1', 'Nyx Info', [[0, 22, 'Le journal du soir'], [22, 56, 'Grand reportage'], [56, 100, 'Dernière édition']]],
    ['C+', 'Ciné Un', [[0, 46, 'Le Casse — Inédit'], [46, 100, 'Train de nuit']]],
    ['SP', 'Sport HD', [[0, 34, 'Match en direct'], [34, 58, 'Les temps forts'], [58, 100, 'Plateau']]],
    ['DC', 'Docs', [[0, 51, 'Océans profonds'], [51, 100, 'Villes la nuit']]],
    ['KD', 'Jeunesse', [[0, 18, 'Dessins animés'], [18, 70, 'Astro-copains'], [70, 100, 'Histoires du soir']]],
  ] : [
    ['N1', 'Nyx News', [[0, 22, 'Evening News'], [22, 56, 'World Report'], [56, 100, 'Late Edition']]],
    ['C+', 'Cinema One', [[0, 46, 'The Heist — Premiere'], [46, 100, 'Night Train']]],
    ['SP', 'Sport HD', [[0, 34, 'Match Day Live'], [34, 58, 'Highlights'], [58, 100, 'Studio Talk']]],
    ['DC', 'Docs', [[0, 51, 'Deep Oceans'], [51, 100, 'Cities at Night']]],
    ['KD', 'Kids', [[0, 18, 'Cartoon Hour'], [18, 70, 'Space Pals'], [70, 100, 'Bedtime Tales']]],
  ];

  const img = (src, alt = '') => `<img src="${src}" alt="${alt}" loading="lazy" decoding="async">`;

  // Médiathèque (côté « après »)
  const lib = $('[data-lib]');
  if (lib) {
    lib.innerHTML = ['d1', 'd6', 'd3', 'd4', 'd2', 'd7', 'w4', 'w6', 'd5', 'w1', 'w7', 'w10']
      .map((n) => `<div class="lib__card">${img(P(n))}</div>`).join('');
  }

  // Liste brute (côté « avant »), doublée pour boucler
  const raw = $('[data-raw]');
  if (raw) {
    const rows = RAW.map(([name, group, ext], i) =>
      `<div class="raw__row${i === 2 ? ' is-sel' : ''}"><span>${String(1024 + i * 7).padStart(5, '0')}</span><span>${name}</span><span>${group}</span><span>.${ext}</span></div>`).join('');
    raw.innerHTML = rows + rows;
  }

  // Mur d'affiches
  $$('.wall__row').forEach((row, i) => {
    const shift = (i * 5) % POSTERS.length;
    const list = [...POSTERS.slice(shift), ...POSTERS.slice(0, shift)];
    const cells = list.map((n) => `<div class="poster">${img(P(n))}</div>`).join('');
    row.innerHTML = cells + cells;
  });

  // Guide TV
  const epgBody = $('[data-epg]');
  if (epgBody) {
    epgBody.innerHTML = EPG.map(([code, name, progs]) => `
      <div class="epg__row">
        <div class="epg__chan"><b>${code}</b><span>${name}</span></div>
        <div class="epg__track">${progs.map(([a, b, t]) =>
          `<div class="epg__prog" data-a="${a}" data-b="${b}" style="left:calc(${a}% + 2px);width:calc(${b - a}% - 4px)">${t}</div>`).join('')}</div>
      </div>`).join('');
  }

  /* ------------------------------------------------------------------
     Découpage des textes
     ------------------------------------------------------------------ */
  function srOnly(el, text) {
    const s = document.createElement('span');
    s.className = 'sr-only';
    s.textContent = text;
    el.before(s);
  }

  function splitChars(el) {
    const text = el.textContent.trim();
    el.innerHTML = text.split(/\s+/)
      .map((w) => `<span class="w">${[...w].map((c) => `<span class="c">${c}</span>`).join('')}</span>`)
      .join(' ');
    el.setAttribute('aria-hidden', 'true');
    srOnly(el, text);
  }

  function splitLines(el) {
    el.innerHTML = el.innerHTML
      .split(/<br\s*\/?>/i)
      .map((part) => `<span class="ln"><span class="ln__in">${part.trim()}</span></span>`)
      .join('');
  }

  function splitWords(root) {
    const walk = (node) => {
      [...node.childNodes].forEach((child) => {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          // Espaces ordinaires seulement : l'espace insécable (« d'elle&nbsp;: ») reste dans le mot.
          child.textContent.split(/([^\S\u00a0]+)/).forEach((part) => {
            if (!part) return;
            if (/^[^\S\u00a0]+$/.test(part)) frag.append(' ');
            else {
              const s = document.createElement('span');
              s.className = 'mw';
              s.textContent = part;
              frag.append(s);
            }
          });
          child.replaceWith(frag);
        } else if (child.nodeType === 1) walk(child);
      });
    };
    walk(root);
    root.classList.add('is-split');
  }

  if (anim) {
    $$('.hero__title [data-split]').forEach(splitChars);
    $$('.display, .finale__title').forEach((el) => {
      el.removeAttribute('data-reveal');
      splitLines(el);
    });
    $$('[data-words]').forEach(splitWords);
  }

  /* ------------------------------------------------------------------
     Nébuleuse WebGL (fond de toute la page)
     ------------------------------------------------------------------ */
  const nebula = (() => {
    const canvas = $('.nebula');
    const gl = canvas && canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
    if (!gl) {
      if (canvas) canvas.style.background =
        'radial-gradient(ellipse 70% 50% at 20% 0%, rgba(40,40,163,.35), transparent 60%), radial-gradient(ellipse 60% 50% at 85% 30%, rgba(104,23,23,.3), transparent 55%), #020a19';
      return null;
    }

    const vs = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
    const fs = `
      precision mediump float;
      uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse; uniform float uScroll;
      float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}
      float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<5;i++){v+=a*noise(p);p=m*p;a*=.5;}return v;}
      void main(){
        vec2 p=(gl_FragCoord.xy-.5*uRes)/uRes.y;
        p.y+=uScroll*.35;
        float t=uTime*.035;
        vec2 q=vec2(fbm(p*1.3+t),fbm(p*1.3-t+5.2));
        vec2 r=vec2(fbm(p*1.7+3.*q+vec2(1.7,9.2)+t*1.3),fbm(p*1.7+3.*q+vec2(8.3,2.8)-t));
        float f=fbm(p*1.1+2.4*r);
        vec3 night=vec3(.008,.039,.098);
        vec3 blue=vec3(.157,.157,.64);
        vec3 red=vec3(.41,.09,.09);
        vec3 purple=vec3(.21,0.,.2);
        vec3 col=night;
        float wb=smoothstep(.38,.95,f)*(.55+.45*smoothstep(.7,-.7,p.x));
        float wr=smoothstep(.5,1.,r.x)*(.45+.55*smoothstep(-.5,.8,p.x));
        col=mix(col,blue,wb*.55);
        col=mix(col,red,wr*.5);
        col+=purple*q.y*.28;
        vec2 m=(uMouse-.5*uRes)/uRes.y; m.y+=uScroll*.35;
        float d=length(p-m);
        col+=vec3(.37,.43,.92)*.09*exp(-d*d*5.);
        col*=smoothstep(1.35,.15,length(p*vec2(.75,1.)-vec2(0.,uScroll*.35)));
        vec2 sp=p*16.; vec2 id=floor(sp); vec2 fp=fract(sp)-.5;
        float h=hash(id);
        if(h>.72){vec2 o=vec2(hash(id+1.3),hash(id+7.1))-.5;float sd=length(fp-o*.7);
          float tw=.5+.5*sin(uTime*(.8+h*2.5)+h*60.);
          col+=vec3(.85,.88,1.)*smoothstep(.06,0.,sd)*tw*(h-.72)*3.;}
        gl_FragColor=vec4(col,1.);
      }`;

    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const u = {
      res: gl.getUniformLocation(prog, 'uRes'),
      time: gl.getUniformLocation(prog, 'uTime'),
      mouse: gl.getUniformLocation(prog, 'uMouse'),
      scroll: gl.getUniformLocation(prog, 'uScroll'),
    };

    const SCALE = 0.5;
    let w = 0, h = 0;
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const resize = () => {
      w = Math.max(1, Math.round(innerWidth * SCALE));
      h = Math.max(1, Math.round(innerHeight * SCALE));
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      mouse.x = mouse.tx = w * 0.5;
      mouse.y = mouse.ty = h * 0.6;
    };
    resize();
    addEventListener('resize', resize);
    addEventListener('pointermove', (e) => {
      mouse.tx = e.clientX * SCALE;
      mouse.ty = (innerHeight - e.clientY) * SCALE;
    }, { passive: true });

    const start = performance.now();
    const draw = () => {
      mouse.x += (mouse.tx - mouse.x) * 0.05;
      mouse.y += (mouse.ty - mouse.y) * 0.05;
      gl.uniform2f(u.res, w, h);
      gl.uniform1f(u.time, (performance.now() - start) / 1000);
      gl.uniform2f(u.mouse, mouse.x, mouse.y);
      gl.uniform1f(u.scroll, scrollY / innerHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    return { draw };
  })();

  if (nebula) {
    if (reduce) {
      nebula.draw();
      addEventListener('resize', () => nebula.draw());
    } else {
      const loop = () => { nebula.draw(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
  }

  /* ------------------------------------------------------------------
     Comparateur avant / après (fonctionne même sans animations)
     ------------------------------------------------------------------ */
  const compare = $('.compare');
  const compareState = { pos: 50, tween: null };
  if (compare) {
    const handle = $('.compare__handle', compare);
    const setPos = (v) => {
      compareState.pos = Math.min(100, Math.max(0, v));
      compare.style.setProperty('--pos', `${compareState.pos}%`);
      handle.setAttribute('aria-valuenow', Math.round(compareState.pos));
    };
    const fromEvent = (e) => {
      const r = compare.getBoundingClientRect();
      setPos(((e.clientX - r.left) / r.width) * 100);
    };
    compare.addEventListener('pointerdown', (e) => {
      if (compareState.tween) compareState.tween.kill();
      compare.setPointerCapture(e.pointerId);
      compare.classList.add('is-dragging');
      fromEvent(e);
    });
    compare.addEventListener('pointermove', (e) => {
      if (compare.classList.contains('is-dragging')) fromEvent(e);
    });
    const stop = () => compare.classList.remove('is-dragging');
    compare.addEventListener('pointerup', stop);
    compare.addEventListener('pointercancel', stop);
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 4;
      if (e.key === 'ArrowLeft') setPos(compareState.pos - step);
      else if (e.key === 'ArrowRight') setPos(compareState.pos + step);
      else if (e.key === 'Home') setPos(0);
      else if (e.key === 'End') setPos(100);
      else return;
      e.preventDefault();
      if (compareState.tween) compareState.tween.kill();
    });
    compareState.set = setPos;
  }

  /* ------------------------------------------------------------------
     FAQ (une seule réponse ouverte à la fois)
     ------------------------------------------------------------------ */
  $$('.qa').forEach((qa) => {
    const btn = $('.qa__q', qa);
    btn.addEventListener('click', () => {
      const open = !qa.classList.contains('is-open');
      $$('.qa.is-open').forEach((o) => {
        o.classList.remove('is-open');
        $('.qa__q', o).setAttribute('aria-expanded', 'false');
      });
      qa.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
  });

  /* ------------------------------------------------------------------
     Galerie (onglets, avance automatique quand elle est à l'écran)
     ------------------------------------------------------------------ */
  const gallery = $('.gallery');
  if (gallery) {
    const tabs = $$('.gallery__tab', gallery);
    const stage = $('.gallery__stage', gallery);
    let busy = false;

    const show = (tab) => {
      if (busy || tab.classList.contains('is-on')) return;
      tabs.forEach((t) => {
        const on = t === tab;
        t.classList.toggle('is-on', on);
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
      });
      const old = $('.gallery__img.is-on', stage);
      const next = document.createElement('img');
      next.className = 'gallery__img is-on';
      next.src = tab.dataset.src;
      next.alt = tab.dataset.alt;
      if (!anim) {
        old.replaceWith(next);
        return;
      }
      busy = true;
      stage.append(next);
      old.classList.remove('is-on');
      const run = () => {
        gsap.timeline({ onComplete: () => { old.remove(); busy = false; } })
          .fromTo(next, { clipPath: 'inset(0 0 0 100%)', scale: 1.12 }, { clipPath: 'inset(0 0 0 0%)', scale: 1, duration: 1.2, ease: 'expo.inOut' })
          .to(old, { scale: 0.94, opacity: 0.3, duration: 1.2, ease: 'expo.inOut' }, 0);
      };
      if (next.complete) run(); else next.onload = run;
    };

    tabs.forEach((tab, i) => {
      tab.tabIndex = i === 0 ? 0 : -1;
      tab.addEventListener('click', () => show(tab));
      tab.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        const t = tabs[(i + d + tabs.length) % tabs.length];
        t.focus();
        show(t);
      });
      if (anim) {
        $('.gallery__fill', tab).addEventListener('animationend', () => {
          show(tabs[(i + 1) % tabs.length]);
        });
      }
    });

    if (anim) {
      gallery.classList.add('is-paused');
      new IntersectionObserver(([e]) => {
        gallery.classList.toggle('is-paused', !e.isIntersecting);
      }, { threshold: 0.5 }).observe(gallery);
      gallery.addEventListener('pointerenter', () => gallery.classList.add('is-hover'));
      gallery.addEventListener('pointerleave', () => gallery.classList.remove('is-hover'));
    }
  }

  /* ------------------------------------------------------------------
     Coffre : identifiants qui se chiffrent et se déchiffrent
     ------------------------------------------------------------------ */
  const codes = $$('[data-scramble]');
  if (codes.length && anim) {
    const HEX = '0123456789abcdef';
    const encOf = (s) => [...s].map((c, i) => (c === ' ' ? ' ' : (i % 5 === 4 ? '·' : HEX[(Math.random() * 16) | 0]))).join('');
    const scramble = (el, target, dur = 900) => {
      const from = el.textContent;
      const len = Math.max(from.length, target.length);
      const t0 = performance.now();
      const tick = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const done = Math.floor(k * len);
        let out = '';
        for (let i = 0; i < len; i++) {
          if (i < done) out += target[i] || '';
          else out += HEX[(Math.random() * 16) | 0];
        }
        el.textContent = out;
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    let encrypted = false;
    let timer = null;
    const cycle = () => {
      encrypted = !encrypted;
      codes.forEach((el, i) => {
        const plain = el.dataset.scramble;
        el.classList.toggle('is-enc', encrypted);
        setTimeout(() => scramble(el, encrypted ? encOf(plain) : plain), i * 140);
      });
    };
    new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !timer) {
        cycle();
        timer = setInterval(cycle, 3200);
      } else if (!e.isIntersecting && timer) {
        clearInterval(timer);
        timer = null;
      }
    }, { threshold: 0.4 }).observe($('.vault'));
  }

  // Sans animations : on s'arrête ici, tout est visible et utilisable.
  if (!anim) {
    $$('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      const t = id === '#top' ? null : $(id);
      if (id !== '#top' && !t) return;
      e.preventDefault();
      if (t) t.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
      else scrollTo({ top: 0 });
    }));
    return;
  }

  /* ==================================================================
     À partir d'ici : expérience animée complète
     ================================================================== */

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  scrollTo(0, 0);

  // Défilement fluide
  let lenis = null;
  if (window.Lenis) {
    lenis = new window.Lenis({ lerp: 0.085, wheelMultiplier: 0.95 });
    lenis.on('scroll', ST.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
    lenis.stop();
  }

  $$('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    const target = id === '#top' ? 0 : $(id);
    if (target === null) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(target, { offset: -90, duration: 1.8, easing: (t) => 1 - Math.pow(1 - t, 4) });
    else if (target === 0) scrollTo({ top: 0, behavior: 'smooth' });
    else target.scrollIntoView({ behavior: 'smooth' });
  }));

  /* ---------- Boutons aimantés ---------- */
  if (fine) {
    $$('[data-magnetic]').forEach((el) => {
      const xTo = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'power3.out' });
      const yTo = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'power3.out' });
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        xTo((e.clientX - (r.left + r.width / 2)) * 0.28);
        yTo((e.clientY - (r.top + r.height / 2)) * 0.38);
      });
      el.addEventListener('pointerleave', () => {
        gsap.to(el, { x: 0, y: 0, duration: 1.1, ease: 'elastic.out(1, 0.35)', overwrite: true });
      });
    });
  }

  /* ---------- Cartes : projecteur sur la bordure + inclinaison ---------- */
  $$('.card').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      card.style.setProperty('--mx', `${x}px`);
      card.style.setProperty('--my', `${y}px`);
      if (fine && card.hasAttribute('data-tilt')) {
        gsap.to(card, {
          rotationY: ((x / r.width) - 0.5) * 7,
          rotationX: -((y / r.height) - 0.5) * 7,
          transformPerspective: 1000,
          duration: 0.6,
          ease: 'power3.out',
        });
      }
    });
    card.addEventListener('pointerleave', () => {
      if (card.hasAttribute('data-tilt')) gsap.to(card, { rotationX: 0, rotationY: 0, duration: 1, ease: 'power3.out' });
    });
  });

  /* ---------- Boucles infinies accélérées par le défilement ---------- */
  const loops = [];
  const band = $('.band__track');
  if (band) loops.push({ tl: gsap.to(band, { xPercent: -50, duration: 38, ease: 'none', repeat: -1 }) });
  $$('.wall__row').forEach((row, i) => {
    const dur = 70 + i * 12;
    const tl = i % 2
      ? gsap.fromTo(row, { xPercent: -50 }, { xPercent: 0, duration: dur, ease: 'none', repeat: -1 })
      : gsap.to(row, { xPercent: -50, duration: dur, ease: 'none', repeat: -1 });
    loops.push({ tl });
  });
  let lastY = scrollY;
  let boost = 0;
  gsap.ticker.add(() => {
    const y = scrollY;
    const v = Math.abs(y - lastY);
    lastY = y;
    boost += (Math.min(v * 0.35, 9) - boost) * 0.08;
    loops.forEach((l) => l.tl.timeScale(1 + boost));
  });

  /* ---------- Guide TV : la ligne « maintenant » avance ---------- */
  const epg = $('.epg');
  if (epg) {
    const nowLine = $('.epg__now', epg);
    const progs = $$('.epg__prog', epg);
    const state = { t: 0.2 };
    const update = () => {
      nowLine.style.setProperty('--t-num', state.t);
      const pct = state.t * 100;
      progs.forEach((p) => p.classList.toggle('is-now', pct >= +p.dataset.a && pct < +p.dataset.b));
    };
    update();
    gsap.to(state, {
      t: 0.85, duration: 16, ease: 'sine.inOut', repeat: -1, yoyo: true, onUpdate: update,
      scrollTrigger: { trigger: epg, start: 'top bottom', toggleActions: 'play pause resume pause' },
    });
  }

  /* ---------- Lampe torche du final ---------- */
  const finale = $('.finale');
  if (finale) {
    const light = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, inside: false };
    finale.addEventListener('pointermove', (e) => {
      const r = finale.getBoundingClientRect();
      light.tx = (e.clientX - r.left) / r.width;
      light.ty = (e.clientY - r.top) / r.height;
      light.inside = e.pointerType === 'mouse';
    });
    finale.addEventListener('pointerleave', () => { light.inside = false; });
    let active = false;
    ST.create({ trigger: finale, start: 'top bottom', end: 'bottom top', onToggle: (s) => { active = s.isActive; } });
    gsap.ticker.add((time) => {
      if (!active) return;
      if (!light.inside) {
        light.tx = 0.5 + Math.sin(time * 0.45) * 0.28;
        light.ty = 0.42 + Math.sin(time * 0.7 + 1) * 0.16;
      }
      light.x += (light.tx - light.x) * 0.07;
      light.y += (light.ty - light.y) * 0.07;
      finale.style.setProperty('--fx', `${(light.x * 100).toFixed(2)}%`);
      finale.style.setProperty('--fy', `${(light.y * 100).toFixed(2)}%`);
    });
    gsap.fromTo(finale, { '--fr': '0rem' }, {
      '--fr': '26rem', ease: 'none',
      scrollTrigger: { trigger: finale, start: 'top 85%', end: 'center 55%', scrub: 0.6 },
    });
  }

  /* ---------- Chargement « projecteur » puis entrée du héros ---------- */
  const heroChars = $$('.hero__title .c');
  gsap.set(heroChars, { yPercent: 115, rotate: 8 });
  gsap.set('[data-hero-serif]', { opacity: 0 });
  gsap.set('.screen', { opacity: 0, y: 140 });
  gsap.set('.nav', { autoAlpha: 0 });

  const heroIntro = () => {
    gsap.timeline()
      .to(heroChars, { yPercent: 0, rotate: 0, duration: 1.2, ease: 'expo.out', stagger: 0.022 })
      .fromTo('[data-hero-serif]', { opacity: 0, filter: 'blur(20px)', scale: 1.1 },
        { opacity: 1, filter: 'blur(0px)', scale: 1, duration: 1.5, ease: 'power3.out', clearProps: 'filter' }, 0.3)
      .to('[data-hero]', { opacity: 1, duration: 1.1, ease: 'power3.out', stagger: 0.09 }, 0.5)
      .from('[data-hero]', { y: 26, duration: 1.1, ease: 'power3.out', stagger: 0.09 }, 0.5)
      .to('.screen', { opacity: 1, y: 0, duration: 1.8, ease: 'expo.out' }, 0.55)
      .to('.nav', { autoAlpha: 1, duration: 1, ease: 'power2.out' }, 0.7);
  };

  const loader = $('.loader');
  const countEl = $('[data-count]');
  const path = $('.loader__path');
  const len = path.getTotalLength();
  document.body.classList.add('is-loading');
  gsap.set(path, { strokeDasharray: len, strokeDashoffset: len });
  const counter = { v: 0 };
  const intro = gsap.timeline({ delay: 0.2, defaults: { ease: 'power3.inOut' } })
    .to(path, { strokeDashoffset: 0, duration: 1.4 })
    .to(counter, {
      v: 100, duration: 1.4, ease: 'power2.inOut',
      onUpdate: () => { countEl.textContent = String(Math.round(counter.v)).padStart(3, '0'); },
    }, 0)
    .to(path, { fillOpacity: 1, strokeOpacity: 0, duration: 0.5 }, '-=0.25')
    .to('.loader__meta', { opacity: 0, y: 8, duration: 0.4 }, '<')
    .to('.loader__mark', { scale: 0.7, opacity: 0, duration: 0.5, ease: 'power2.in' }, '+=0.15')
    .to('.loader__line', { scaleX: 1, duration: 0.7, ease: 'expo.out' }, '-=0.2')
    .add(() => {
      document.body.classList.remove('is-loading');
      if (lenis) lenis.start();
      heroIntro();
    }, '+=0.05')
    .to(loader, { clipPath: 'inset(50% 0% 50% 0%)', duration: 1, ease: 'expo.inOut' }, '<')
    .set(loader, { display: 'none' });
  loader.addEventListener('click', () => intro.timeScale(4));

  /* ---------- Défilement : barre de progression, nav, héros ---------- */
  const progress = $('.progress');
  const nav = $('.nav');
  ST.create({
    start: 0,
    end: 'max',
    onUpdate: (s) => {
      progress.style.transform = `scaleX(${s.progress})`;
      nav.classList.toggle('is-hidden', s.direction === 1 && scrollY > 240);
    },
  });

  gsap.to('.hero__inner', {
    y: -90, opacity: 0.15, ease: 'none',
    scrollTrigger: { trigger: '.hero', start: 'top top', end: '60% top', scrub: true },
  });

  const screenST = { trigger: '.screen', start: 'top 88%', end: 'top 12%', scrub: 0.8 };
  gsap.fromTo('.screen__tilt', { '--rx': '26deg', '--sc': 0.88 }, { '--rx': '0deg', '--sc': 1, ease: 'none', scrollTrigger: screenST });
  gsap.fromTo('.screen .window__sheen', { '--sheen': '-45%' }, { '--sheen': '70%', ease: 'none', scrollTrigger: screenST });
  gsap.fromTo('.screen__beam', { '--beam': 0.35 }, {
    '--beam': 0.95, ease: 'none',
    scrollTrigger: { trigger: '.screen', start: 'top 90%', end: 'center center', scrub: true },
  });

  /* ---------- Apparitions ---------- */
  gsap.set('.ln__in', { yPercent: 108 });
  $$('.display, .finale__title').forEach((el) => {
    gsap.to($$('.ln__in', el), {
      yPercent: 0, duration: 1.25, ease: 'expo.out', stagger: 0.12,
      scrollTrigger: { trigger: el, start: 'top 86%', once: true },
    });
  });

  ST.batch('[data-reveal]', {
    start: 'top 88%',
    once: true,
    onEnter: (items) => gsap.to(items, { opacity: 1, y: 0, duration: 1.2, ease: 'expo.out', stagger: 0.08, overwrite: 'auto' }),
  });

  // Comparateur : le rideau s'ouvre tout seul à l'arrivée
  if (compare && compareState.set) {
    compareState.set(94);
    const o = { v: 94 };
    compareState.tween = gsap.to(o, {
      v: 50, duration: 2.2, ease: 'expo.inOut', delay: 0.3,
      onUpdate: () => compareState.set(o.v),
      scrollTrigger: { trigger: compare, start: 'top 65%', once: true },
    });
  }

  // Mur d'affiches : parallaxe par rangée
  $$('.wall__row').forEach((row, i) => {
    gsap.fromTo(row, { y: (i - 1.5) * 70 }, {
      y: (i - 1.5) * -70, ease: 'none',
      scrollTrigger: { trigger: '.wall', start: 'top bottom', end: 'bottom top', scrub: true },
    });
  });

  // Reprise : la barre se remplit
  gsap.fromTo('.resume__bar i', { scaleX: 0 }, {
    scaleX: 1, duration: 2.4, ease: 'power3.out',
    scrollTrigger: { trigger: '.card--resume', start: 'top 80%', once: true },
  });

  // Prix : 12.99 → 0 (12,99 en français)
  const price = $('[data-price]');
  if (price) {
    const o = { v: 12.99 };
    gsap.to(o, {
      v: 0, duration: 2.2, ease: 'power4.inOut',
      onUpdate: () => { price.textContent = fr ? o.v.toFixed(2).replace('.', ',') : o.v.toFixed(2); },
      onComplete: () => { price.textContent = '0'; },
      scrollTrigger: { trigger: price, start: 'top 85%', once: true },
    });
  }

  // Manifeste : les mots s'allument au fil du défilement
  const words = $$('.manifesto .mw');
  if (words.length) {
    gsap.to(words, {
      opacity: 1, ease: 'none', stagger: 0.1,
      scrollTrigger: { trigger: '.manifesto', start: 'top 72%', end: 'bottom 62%', scrub: true },
    });
  }

  // Le logo du pied de page remonte
  gsap.fromTo('.footer__word img', { yPercent: 40 }, {
    yPercent: 0, ease: 'none',
    scrollTrigger: { trigger: '.footer', start: 'top bottom', end: 'bottom bottom', scrub: true },
  });

  addEventListener('load', () => ST.refresh());
})();
