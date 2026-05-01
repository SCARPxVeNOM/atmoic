import { useEffect, useRef, useState, FC } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import "./IntroPage.css";

const asset = (name: string) => `${import.meta.env.BASE_URL}assets/${name}`;
const PROGRAM_ID = "8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg";

const CHAPTERS = [
  { id: "c1", num: "01", label: "Overture" },
  { id: "c2", num: "02", label: "Premise" },
  { id: "c3", num: "03", label: "Yield" },
  { id: "c4", num: "04", label: "Proofs" },
  { id: "c5", num: "05", label: "Auction" },
  { id: "c6", num: "06", label: "Surface" },
  { id: "c7", num: "07", label: "Numbers" },
  { id: "c8", num: "08", label: "Threshold" },
];

const PHONE_FEATURES = [
  {
    num: "01",
    title: "Home — the verified surface",
    body: "Glance at SOL, BTC, ETH perp markets in one portfolio-margined account. Funding, oracle health, position carry — all on-chain.",
  },
  {
    num: "02",
    title: "Trade — linear or power-mode",
    body: "Long or short up to 10× on yield-bearing collateral. Toggle power mode for quadratic, options-like convexity.",
  },
];

const cornerSvg = (
  <svg viewBox="0 0 42 42" fill="none">
    <path d="M0 0 V18 M0 0 H18" stroke="rgba(255,225,138,0.5)" strokeWidth="1" />
  </svg>
);

interface IntroPageProps { onEnter: () => void; }

export const IntroPage: FC<IntroPageProps> = ({ onEnter }) => {
  const sceneCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const phoneCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const trackerRef = useRef<HTMLElement | null>(null);
  const startedRef = useRef(false);
  const phoneSlideRef = useRef<(i: number, manual?: boolean) => void>(() => {});
  const [activeChapter, setActiveChapter] = useState(0);
  const [activeSlide, setActiveSlide] = useState(0);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    document.documentElement.classList.add("intro-active");

    const root = rootRef.current!;
    const tracker = trackerRef.current!;
    const sceneCanvas = sceneCanvasRef.current!;
    const phoneCanvas = phoneCanvasRef.current!;

    const chapters = Array.from(root.querySelectorAll<HTMLElement>(".chapter"));
    const state = { progress: 0, chapterProgress: 0, chapter: 0 };

    const updateScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      state.progress = Math.max(0, Math.min(1, window.scrollY / Math.max(1, max)));
      let bestIdx = 0;
      let bestScore = -Infinity;
      chapters.forEach((c, i) => {
        const r = c.getBoundingClientRect();
        const center = r.top + r.height / 2;
        const score = -Math.abs(center - window.innerHeight / 2);
        if (score > bestScore) { bestScore = score; bestIdx = i; }
        c.classList.toggle("in-view", r.top < window.innerHeight * 0.85 && r.bottom > window.innerHeight * 0.15);
      });
      state.chapter = bestIdx;
      setActiveChapter(bestIdx);
      const ch = chapters[bestIdx];
      const cr = ch.getBoundingClientRect();
      state.chapterProgress = Math.max(0, Math.min(1, (window.innerHeight / 2 - cr.top) / cr.height));
    };

    window.addEventListener("scroll", updateScroll, { passive: true });
    window.addEventListener("resize", updateScroll);
    updateScroll();

    // Tracker slide-out while scrolling
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const onScrollTracker = () => {
      tracker.classList.add("is-scrolling");
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => tracker.classList.remove("is-scrolling"), 220);
    };
    window.addEventListener("scroll", onScrollTracker, { passive: true });

    /* ── Shared scene: brand title ─────────────────────────── */
    const renderer = new THREE.WebGLRenderer({
      canvas: sceneCanvas, alpha: true, antialias: true, powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 2.0;

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;

    const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
    camera.position.set(0, 0, 11);

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xffffff, 4); key.position.set(2.8, 3.2, 5.2); scene.add(key);
    const rim = new THREE.DirectionalLight(0xf2f2f2, 2.4); rim.position.set(-4.4, 1.8, 2.2); scene.add(rim);
    const fill = new THREE.DirectionalLight(0xd8d8d8, 1.2); fill.position.set(0, -3.4, 3.4); scene.add(fill);
    const shimmer = new THREE.PointLight(0xffd58a, 5, 18, 1.6); shimmer.position.set(0, 1.5, 4.5); scene.add(shimmer);

    const titleGroup = new THREE.Group();
    const titleInner = new THREE.Group();
    titleInner.rotation.x = Math.PI / 2;
    titleGroup.add(titleInner);
    scene.add(titleGroup);

    const resizeScene = () => {
      const w = sceneCanvas.clientWidth, h = sceneCanvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resizeScene();
    window.addEventListener("resize", resizeScene);

    let titleReady = false;
    const titleLoader = new GLTFLoader();
    titleLoader.load(asset("brand-title.glb"), (gltf) => {
      const m = gltf.scene;
      const box = new THREE.Box3().setFromObject(m);
      const center = box.getCenter(new THREE.Vector3());
      m.position.sub(center);
      titleInner.add(m);

      const fb = new THREE.Box3().setFromObject(titleInner);
      const sz = fb.getSize(new THREE.Vector3());
      const fovRad = camera.fov * Math.PI / 180;
      const visH = 2 * Math.tan(fovRad / 2) * camera.position.z;
      const visW = visH * camera.aspect;
      titleInner.scale.setScalar(Math.min((visW * 0.7) / sz.x, (visH * 0.4) / sz.y));
      const cb = new THREE.Box3().setFromObject(titleInner);
      titleInner.position.sub(cb.getCenter(new THREE.Vector3()));

      const goldMat = new THREE.MeshPhysicalMaterial({
        color: 0xd8a84a, metalness: 1, roughness: 0.045,
        clearcoat: 1, clearcoatRoughness: 0.015, envMapIntensity: 3.6,
        emissive: 0x6f4300, emissiveIntensity: 0.18,
        iridescence: 0.04, iridescenceIOR: 1.55,
        sheen: 0.18, sheenColor: 0xffdfa0,
      });
      m.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = goldMat; });
      titleReady = true;
    });

    const sceneMouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onSceneMouse = (e: MouseEvent) => {
      sceneMouse.tx = (e.clientX / window.innerWidth - 0.5) * 0.14;
      sceneMouse.ty = (e.clientY / window.innerHeight - 0.5) * 0.06;
    };
    window.addEventListener("mousemove", onSceneMouse);

    const sceneT0 = performance.now();
    let sceneRaf = 0;
    const sceneLoop = () => {
      const t = (performance.now() - sceneT0) / 1000;
      sceneMouse.x += (sceneMouse.tx - sceneMouse.x) * 0.06;
      sceneMouse.y += (sceneMouse.ty - sceneMouse.y) * 0.06;
      titleGroup.scale.setScalar(1);
      titleGroup.position.x = 0;
      titleGroup.position.y = 0.9 + Math.sin(t * 0.4) * 0.04;
      titleGroup.position.z = 0;
      titleGroup.rotation.y = sceneMouse.x + Math.sin(t * 0.3) * 0.014;
      titleGroup.rotation.x = -sceneMouse.y + Math.sin(t * 0.22) * 0.008;
      shimmer.position.x = Math.sin(t * 0.35) * 4;
      shimmer.position.y = 1.4 + Math.sin(t * 0.5) * 0.5;
      shimmer.intensity = 4 + Math.sin(t * 0.6) * 0.5;
      if (titleReady) renderer.render(scene, camera);
      sceneRaf = requestAnimationFrame(sceneLoop);
    };
    sceneLoop();

    /* ── Phone scene ────────────────────────────────────────── */
    const pRenderer = new THREE.WebGLRenderer({ canvas: phoneCanvas, alpha: true, antialias: true });
    pRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    pRenderer.setClearColor(0x000000, 0);
    pRenderer.outputColorSpace = THREE.SRGBColorSpace;
    pRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    pRenderer.toneMappingExposure = 1.55;

    const pScene = new THREE.Scene();
    const pPmrem = new THREE.PMREMGenerator(pRenderer);
    pScene.environment = pPmrem.fromScene(new RoomEnvironment(), 0.005).texture;
    (pScene as unknown as { environmentIntensity?: number }).environmentIntensity = 2.2;
    const pCamera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
    pCamera.position.set(0, 0, 8.6);
    pScene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const pk = new THREE.DirectionalLight(0xffffff, 4.2); pk.position.set(2.6, 3.4, 4.8); pScene.add(pk);
    const pr = new THREE.DirectionalLight(0xf2f2f2, 2.6); pr.position.set(-3.4, 1.4, 2.4); pScene.add(pr);
    const pf = new THREE.DirectionalLight(0xd8d8d8, 1.4); pf.position.set(0, -3.4, 3.4); pScene.add(pf);
    const pShimmer = new THREE.PointLight(0xffd58a, 6, 22, 1.6); pShimmer.position.set(0, 1.5, 4.5); pScene.add(pShimmer);

    const outer = new THREE.Group();
    const inner = new THREE.Group();
    outer.add(inner); pScene.add(outer);

    const screens = [
      new THREE.TextureLoader().load(asset("screen1.jpeg")),
      new THREE.TextureLoader().load(asset("screen2.jpeg")),
    ];
    screens.forEach((tex) => { tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.anisotropy = 8; });

    let screenMat: THREE.MeshBasicMaterial | null = null;
    let currentSlide = 0;
    let manualLock = 0;

    const setSlide = (i: number, manual = false) => {
      currentSlide = i;
      if (screenMat) { screenMat.map = screens[i]; screenMat.needsUpdate = true; }
      setActiveSlide(i);
      if (manual) manualLock = performance.now() + 2400;
    };
    phoneSlideRef.current = setSlide;

    new GLTFLoader().load(asset("phone-model.glb"), (gltf) => {
      const m = gltf.scene;
      const box = new THREE.Box3().setFromObject(m);
      const c = box.getCenter(new THREE.Vector3());
      const sz = box.getSize(new THREE.Vector3());
      m.position.sub(c);
      m.scale.setScalar(3.35 / Math.max(sz.x, sz.y, sz.z));
      inner.add(m);

      let bestScreen: THREE.Mesh | null = null;
      let bestArea = 0;
      const meshes: THREE.Mesh[] = [];
      m.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        const mesh = o as THREE.Mesh;
        meshes.push(mesh);
        const matName = (mesh.material as THREE.Material | undefined)?.name ?? "";
        const n = `${mesh.name} ${matName}`.toLowerCase();
        if (/screen|display|glass|lcd/.test(n)) bestScreen = mesh;
        const mb = new THREE.Box3().setFromObject(mesh);
        const ms = mb.getSize(new THREE.Vector3());
        const dims = [ms.x, ms.y, ms.z].sort((a, b) => b - a);
        const area = dims[0] * dims[1];
        const flat = dims[2] / Math.max(0.001, dims[1]);
        if (!bestScreen && flat < 0.15 && area > bestArea) { bestArea = area; bestScreen = mesh; }
      });

      const caseMat = new THREE.MeshPhysicalMaterial({
        color: 0xe5b657, metalness: 1, roughness: 0.04,
        clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 3.6,
        emissive: 0x6f4300, emissiveIntensity: 0.16, reflectivity: 1,
        iridescence: 0.05, iridescenceIOR: 1.5, iridescenceThicknessRange: [120, 220],
        sheen: 0.2, sheenRoughness: 0.34, sheenColor: 0xffdfa0,
      });
      const silverMat = new THREE.MeshPhysicalMaterial({
        color: 0xc8ccd0, metalness: 1, roughness: 0.18,
        clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 2.8, reflectivity: 1,
        sheen: 0.08, sheenRoughness: 0.5, sheenColor: 0xeef0f3,
      });

      const SILVER_NAMES = new Set(["BezelMask", "Btn_Action", "Btn_Power", "Btn_VolDown", "Btn_VolUp"]);

      meshes.forEach((mesh) => {
        if (mesh === bestScreen) return;
        mesh.material = SILVER_NAMES.has(mesh.name) ? silverMat : caseMat;
        const mat = mesh.material as THREE.Material;
        mat.transparent = false;
        mat.opacity = 1;
        mat.side = THREE.FrontSide;
        mat.depthWrite = true;
        mat.needsUpdate = true;
      });

      if (bestScreen) {
        screenMat = new THREE.MeshBasicMaterial({ map: screens[0], toneMapped: false });
        (bestScreen as THREE.Mesh).material = screenMat;
      }
    });

    const resizePhone = () => {
      const w = phoneCanvas.clientWidth, h = phoneCanvas.clientHeight;
      if (!w || !h) return;
      pRenderer.setSize(w, h, false);
      pCamera.aspect = w / h;
      pCamera.updateProjectionMatrix();
    };
    resizePhone();
    window.addEventListener("resize", resizePhone);

    const phoneMouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onPhoneMouse = (e: MouseEvent) => {
      phoneMouse.tx = (e.clientX / window.innerWidth - 0.5) * 1.8;
      phoneMouse.ty = (e.clientY / window.innerHeight - 0.5) * 0.82;
    };
    window.addEventListener("mousemove", onPhoneMouse);

    const phoneT0 = performance.now();
    let phoneRaf = 0;
    const phoneLoop = () => {
      const t = (performance.now() - phoneT0) / 1000;
      phoneMouse.x += (phoneMouse.tx - phoneMouse.x) * 0.18;
      phoneMouse.y += (phoneMouse.ty - phoneMouse.y) * 0.18;
      outer.rotation.y = -0.22 + phoneMouse.x + Math.sin(t * 0.36) * 0.035;
      outer.rotation.x = -0.04 - phoneMouse.y + Math.sin(t * 0.28) * 0.015;
      outer.position.y = Math.sin(t * 0.5) * 0.035;
      pRenderer.render(pScene, pCamera);
      phoneRaf = requestAnimationFrame(phoneLoop);
    };
    phoneLoop();

    // scroll-driven slide swap when chapter 6 is active
    const slideInterval = window.setInterval(() => {
      if (state.chapter !== 5) return;
      if (performance.now() < manualLock) return;
      const target = state.chapterProgress > 0.5 ? 1 : 0;
      if (target !== currentSlide) setSlide(target, false);
    }, 400);

    return () => {
      window.removeEventListener("scroll", updateScroll);
      window.removeEventListener("resize", updateScroll);
      window.removeEventListener("scroll", onScrollTracker);
      window.removeEventListener("resize", resizeScene);
      window.removeEventListener("resize", resizePhone);
      window.removeEventListener("mousemove", onSceneMouse);
      window.removeEventListener("mousemove", onPhoneMouse);
      if (idleTimer) clearTimeout(idleTimer);
      window.clearInterval(slideInterval);
      cancelAnimationFrame(sceneRaf);
      cancelAnimationFrame(phoneRaf);
      screens.forEach((tex) => tex.dispose());
      renderer.dispose();
      pRenderer.dispose();
      pmrem.dispose();
      pPmrem.dispose();
      document.documentElement.classList.remove("intro-active");
      startedRef.current = false;
    };
  }, []);

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="intro-root" ref={rootRef}>
      <div className="scene-bg" aria-hidden="true" />
      <div className="scene-vignette" aria-hidden="true" />
      <div className="scene-grain" aria-hidden="true" />

      <aside className="tracker" aria-label="Chapter tracker" ref={trackerRef}>
        {CHAPTERS.map((c, i) => (
          <button
            key={c.id}
            className={`tracker-tick${activeChapter === i ? " active" : ""}`}
            onClick={() => jump(c.id)}
          >
            <span className="num">{c.num}</span>
            <span className="bar" />
            <span className="label">{c.label}</span>
          </button>
        ))}
      </aside>

      <main className="story">
        {/* ═ 01 · OVERTURE ═══════════════════════════════════════ */}
        <section id="c1" className="chapter c-overture" data-chapter="1">
          <canvas id="scene-canvas" className="scene-canvas" aria-hidden="true" ref={sceneCanvasRef} />
          <div className="corner corner-tl">{cornerSvg}</div>
          <div className="corner corner-tr">{cornerSvg}</div>
          <div className="corner corner-bl">{cornerSvg}</div>
          <div className="corner corner-br">{cornerSvg}</div>

          <div className="chapter-inner overture-stack">
            <div className="engraved fade-up d1">— PERPETUALS, PROVEN —</div>
            <div className="overture-actions fade-up d2">
              <button className="btn btn-primary" onClick={onEnter}>Open terminal →</button>
            </div>
          </div>

          <div className="overture-meta">
            <div className="overture-meta-col"><strong>18 / 18</strong>Lean 4 theorems · zero sorry</div>
            <div className="overture-meta-col"><strong>4</strong>Primitives · in one program</div>
            <div className="overture-meta-col"><strong>DFBA</strong>Uniform clearing · MEV-resistant</div>
            <div className="overture-meta-col"><strong>2 / 2</strong>Pyth + Switchboard · 2% halt</div>
          </div>

          <div className="scroll-cue" aria-hidden="true">Scroll<div className="scroll-line" /></div>
        </section>

        {/* ═ TICKER A ════════════════════════════════════════════ */}
        <div className="ticker" aria-hidden="true">
          <div className="ticker-track">
            <span>Mainnet · live</span>
            <span><em>18 / 18</em> Lean 4 theorems · zero sorry</span>
            <span>Self-repaying margin · JLP · mSOL · SOL</span>
            <span><em>DFBA</em> · uniform clearing price</span>
            <span>Portfolio margin · 15-scenario engine</span>
            <span>Power perpetuals · quadratic payoff</span>
            <span>Verified · spec is law</span>
            <span>Mainnet · live</span>
            <span><em>18 / 18</em> Lean 4 theorems · zero sorry</span>
            <span>Self-repaying margin · JLP · mSOL · SOL</span>
            <span><em>DFBA</em> · uniform clearing price</span>
            <span>Portfolio margin · 15-scenario engine</span>
            <span>Power perpetuals · quadratic payoff</span>
            <span>Verified · spec is law</span>
          </div>
        </div>

        {/* ═ 02 · PREMISE ═══════════════════════════════════════ */}
        <section id="c2" className="chapter c-premise" data-chapter="2">
          <div className="chapter-inner">
            <div className="grid-2">
              <div>
                <div className="kicker fade-up d1"><span className="kicker-num">02 ·</span>The premise</div>
                <h2 className="display display-l fade-up d2">
                  Solana perps haven't<br />moved in <span className="em">a decade</span>.
                </h2>
                <p className="lede fade-up d3">
                  Capital sits idle while the same asset earns yield elsewhere. A wick liquidates an intact
                  position. Correlated legs are margined as if traded on separate exchanges. <em>Convex
                  exposure</em> doesn't exist on-chain. Each gap is a known problem with a known solution
                  in traditional finance — none had been brought on-chain in verified, production form.
                </p>
                <ul className="failure-list fade-up d4">
                  <li><span className="fnum">01 ·</span><span><strong>Dead collateral.</strong>~$4B of idle margin across Solana perps. JLP pays 20%+. mSOL pays 7%+. The opportunity cost leaks away.</span></li>
                  <li><span className="fnum">02 ·</span><span><strong>Binary liquidation.</strong>A 30-second wick wipes a fully-collateralized position and assesses a ~5% penalty.</span></li>
                  <li><span className="fnum">03 ·</span><span><strong>No risk offset.</strong>Long SOL, short ETH — 70% correlated. Margined in isolation. SPAN has existed since 1988.</span></li>
                  <li><span className="fnum">04 ·</span><span><strong>No convex payoff.</strong>Linear perps only. Power perpetuals introduced in 2021. Solana had no equivalent.</span></li>
                </ul>
              </div>

              <aside className="premise-quote fade-up d4">
                <div className="premise-quote-mark">"</div>
                <p>
                  Tiny numerical errors becoming material under adversarially engineered conditions. Treat
                  runtime enforcement of mathematical invariants as a first-class design requirement, not
                  a post-hoc audit task.
                </p>
                <cite>— a16z crypto, on the Balancer V2 exploit · Nov 2025</cite>
              </aside>
            </div>
          </div>
        </section>

        {/* ═ 03 · YIELD ═════════════════════════════════════════ */}
        <section id="c3" className="chapter c-vault" data-chapter="3">
          <div className="chapter-inner">
            <div className="grid-2">
              <div>
                <div className="kicker fade-up d1"><span className="kicker-num">03 ·</span>Self-repaying margin</div>
                <h2 className="display display-l fade-up d2">
                  Margin that <span className="em">pays you</span>.<br />Not the other way around.
                </h2>
                <p className="lede fade-up d3">
                  Yield-bearing collateral — <em>JLP, mSOL, SOL</em> — accrues its native yield while
                  serving as margin. The 8-hour funding crank computes a per-position yield offset and
                  nets it against funding. When yield exceeds the funding cost, the position has
                  <em> negative net carry</em>: it accrues value to the trader merely by remaining open.
                </p>
                <div className="actions fade-up d4">
                  <a className="btn" onClick={() => jump("c4")}>See the proofs →</a>
                </div>
              </div>

              <div className="col-vault fade-up d3">
                <div className="vault-emblem">
                  <span className="vault-emblem-tick t-top">— Yield —</span>
                  <span className="vault-emblem-tick t-bot">— Self-repaying —</span>
                  <span className="vault-emblem-tick t-l">JLP · mSOL · SOL</span>
                  <span className="vault-emblem-tick t-r">Funding · offset</span>
                  <span className="vault-emblem-inner">∮ yield</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ═ 04 · PROOFS ════════════════════════════════════════ */}
        <section id="c4" className="chapter c-proofs" data-chapter="4">
          <div className="chapter-inner">
            <div className="kicker fade-up d1"><span className="kicker-num">04 ·</span>Spec is law</div>

            <div className="proofs-headline-row">
              <h2 className="display display-l fade-up d2">
                Eighteen theorems.<br /><span className="em">Zero</span> sorry.
              </h2>
              <div className="proofs-counter fade-up d3">
                18<span style={{ opacity: 0.4 }}>/18</span>
                <small>Lean 4 · machine-checked</small>
              </div>
            </div>

            <p className="lede fade-up d4">
              The risk engine is not a confidence game. Every safety property — leverage caps, collateral
              conservation, fee routing, funding bounds — is proven in <em>Lean 4</em> before the code
              compiles. If the proof breaks, the deploy breaks. <em>Six independent findings</em>,
              caught and closed in internal review, are documented in the audit log.
            </p>

            <div className="proofs-grid fade-up d5">
              <div className="proof-cell">
                <div className="proof-cell-num">T-01 → T-06</div>
                <div className="proof-cell-check">✓ proven</div>
                <h3 className="proof-cell-title">Collateral conservation</h3>
                <p className="proof-cell-body">
                  Total collateral in equals total collateral out across every open-then-close pair,
                  modulo realized PnL and explicit fees. Total collateral is always non-negative.
                </p>
              </div>
              <div className="proof-cell">
                <div className="proof-cell-num">T-07 → T-11</div>
                <div className="proof-cell-check">✓ proven</div>
                <h3 className="proof-cell-title">Open interest &amp; leverage</h3>
                <p className="proof-cell-body">
                  Open interest is tracked per side, never negative, and never exceeds vault capacity.
                  Leverage is bounded after the fee deduction — caught a real off-by-fee drift.
                </p>
              </div>
              <div className="proof-cell">
                <div className="proof-cell-num">T-12 → T-18</div>
                <div className="proof-cell-check">✓ proven</div>
                <h3 className="proof-cell-title">Funding &amp; arithmetic safety</h3>
                <p className="proof-cell-body">
                  Funding rate stays within ±1% per 8h epoch. Collateral and size arithmetic cannot wrap.
                  The class of bug that drained Balancer is eliminated by construction, not patched.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ═ 05 · AUCTION ═══════════════════════════════════════ */}
        <section id="c5" className="chapter c-auction" data-chapter="5">
          <div className="chapter-inner">
            <div className="grid-2">
              <div>
                <div className="kicker fade-up d1"><span className="kicker-num">05 ·</span>The auction</div>
                <h2 className="display display-m fade-up d2">
                  <span className="em">Discrete</span> frequent<br />batch auctions.
                </h2>
                <p className="lede fade-up d3">
                  Orders don't race. Each batch freezes the book, computes a single clearing price, and
                  prints every matched fill at exactly that price. <em>No queue jumping. No sandwich.
                  No latency tax.</em> Maker quotes come from an Avellaneda–Stoikov optimal-MM model;
                  a CUSUM circuit breaker halts new positions when realized vol drifts beyond bounds.
                </p>
                <div className="body fade-up d4" style={{ marginTop: 24 }}>
                  DFBA — Discrete Frequent Batch Auctions — is the only execution path on the desk.
                  Funding flows route through a reinforcement-learning-inspired predictive controller
                  that adjusts <em>ahead of</em> inventory imbalances rather than reacting to them.
                </div>
              </div>

              <div className="auction-stage fade-up d3">
                <div className="auction-axis">
                  <div className="auction-bars">
                    <div className="auction-bar"   style={{ animationDelay: "0s",   height: "62%" }} />
                    <div className="auction-bar"   style={{ animationDelay: ".2s",  height: "74%" }} />
                    <div className="auction-bar"   style={{ animationDelay: ".4s",  height: "88%" }} />
                    <div className="auction-bar"   style={{ animationDelay: ".6s",  height: "78%" }} />
                    <div className="auction-bar"   style={{ animationDelay: ".8s",  height: "96%" }} />
                    <div className="auction-bar"   style={{ animationDelay: "1.0s", height: "82%" }} />
                    <div className="auction-bar s" style={{ animationDelay: "1.2s", height: "90%" }} />
                    <div className="auction-bar s" style={{ animationDelay: "1.4s", height: "74%" }} />
                    <div className="auction-bar s" style={{ animationDelay: "1.6s", height: "86%" }} />
                    <div className="auction-bar s" style={{ animationDelay: "1.8s", height: "64%" }} />
                    <div className="auction-bar s" style={{ animationDelay: "2.0s", height: "52%" }} />
                    <div className="auction-bar s" style={{ animationDelay: "2.2s", height: "40%" }} />
                  </div>
                  <div className="auction-clearing" />
                  <div className="auction-axis-labels">
                    <span>BIDS · LONG</span><span>· · ·</span><span>ASKS · SHORT</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ═ TICKER B ════════════════════════════════════════════ */}
        <div className="ticker rev slim" aria-hidden="true">
          <div className="ticker-track">
            <span>Power perpetuals · live</span>
            <span>Gradual deleveraging · <em>4 tiers</em></span>
            <span>Insolvencies <em>0</em> · by construction</span>
            <span>Funding · 8h · ±1% cap</span>
            <span>Dual oracle · Pyth + Switchboard · 2% halt</span>
            <span>Native Rust · no Anchor</span>
            <span>Power perpetuals · live</span>
            <span>Gradual deleveraging · <em>4 tiers</em></span>
            <span>Insolvencies <em>0</em> · by construction</span>
            <span>Funding · 8h · ±1% cap</span>
            <span>Dual oracle · Pyth + Switchboard · 2% halt</span>
            <span>Native Rust · no Anchor</span>
          </div>
        </div>

        {/* ═ 06 · SURFACE ═══════════════════════════════════════ */}
        <section id="c6" className="chapter c-surface" data-chapter="6">
          <div className="surface-headlines" aria-hidden="true">
            <div className="surface-headlines-row top">
              {Array.from({ length: 6 }).map((_, i) => (
                <span key={`top-${i}`}>IDLEXCHANGE · PERPETUALS PROVEN</span>
              ))}
            </div>
            <div className="surface-headlines-row mid">
              {Array.from({ length: 6 }).map((_, i) => (
                <span key={`mid-${i}`}>IDLEXCHANGE · PERPETUALS PROVEN</span>
              ))}
            </div>
          </div>
          <div className="chapter-inner">
            <div className="grid-2">
              <div>
                <div className="kicker fade-up d1"><span className="kicker-num">06 ·</span>The surface</div>
                <h2 className="display display-l fade-up d2">
                  The whole desk,<br />in your <span className="em">pocket</span>.
                </h2>
                <p className="lede fade-up d3">
                  SOL-PERP, BTC-PERP, ETH-PERP — all under one portfolio-margined account. Toggle power
                  mode for quadratic payoff. Inspect funding net of yield offset. Gradual deleveraging
                  closes only the slice required to restore margin — <em>your wick doesn't kill you</em>.
                </p>

                <div className="phone-features fade-up d4">
                  {PHONE_FEATURES.map((f, i) => (
                    <button
                      key={f.num}
                      className={`phone-feature${activeSlide === i ? " is-active" : ""}`}
                      onClick={() => phoneSlideRef.current(i, true)}
                    >
                      <span className="phone-feature-num">{f.num}</span>
                      <span className="phone-feature-label">
                        {f.title}
                        <small>{f.body}</small>
                      </span>
                      <span className="phone-feature-dot" />
                    </button>
                  ))}
                </div>
              </div>

              <div className="phone-stage fade-up d2">
                <canvas id="phone-canvas" className="phone-canvas" ref={phoneCanvasRef} />
                <div className="phone-glow" />
              </div>
            </div>
          </div>
        </section>

        {/* ═ 07 · NUMBERS ═══════════════════════════════════════ */}
        <section id="c7" className="chapter c-numbers" data-chapter="7">
          <div className="chapter-inner">
            <div className="kicker fade-up d1"><span className="kicker-num">07 ·</span>The numbers</div>
            <h2 className="display display-l fade-up d2">
              Verified, on-chain,<br /><span className="em">to the comma</span>.
            </h2>
            <p className="lede fade-up d3">
              Not metrics that drift with the tape — invariants that hold across every state transition.
              Each one is mechanically checked before any line of execution code is allowed to ship.
            </p>

            <div className="numbers-table fade-up d4">
              <div className="numbers-cell">
                <div className="numbers-cell-label">Lean theorems</div>
                <div className="numbers-cell-value">18 / 18</div>
                <div className="numbers-cell-foot">machine-checked · zero <code>sorry</code></div>
              </div>
              <div className="numbers-cell">
                <div className="numbers-cell-label">Liquidation tiers</div>
                <div className="numbers-cell-value">4</div>
                <div className="numbers-cell-foot">25% · 50% · 75% · full at 2% margin</div>
              </div>
              <div className="numbers-cell">
                <div className="numbers-cell-label">Margin scenarios</div>
                <div className="numbers-cell-value">15</div>
                <div className="numbers-cell-foot">SPAN-style portfolio engine</div>
              </div>
              <div className="numbers-cell">
                <div className="numbers-cell-label">Markets · live</div>
                <div className="numbers-cell-value">3</div>
                <div className="numbers-cell-foot">SOL · BTC · ETH · perp + power</div>
              </div>
            </div>
          </div>
        </section>

        {/* ═ 08 · THRESHOLD ═════════════════════════════════════ */}
        <section id="c8" className="chapter c-threshold" data-chapter="8">
          <div className="chapter-inner">
            <div className="threshold-rule fade-up d1" />
            <div className="engraved fade-up d2">— THE THRESHOLD —</div>
            <h2 className="display display-xl fade-up d3" style={{ marginTop: 24 }}>
              Step <span className="em">in</span>.
            </h2>
            <p className="overture-sub fade-up d4" style={{ maxWidth: 560 }}>
              Four primitives. Eighteen proofs. Zero trust assumptions. Connect a wallet, post yield-bearing
              collateral, and place your first batched fill — every line you've just read is enforced by
              the chain on the other side of this button.
            </p>
            <div className="threshold-actions fade-up d5">
              <button className="btn btn-primary" onClick={onEnter}>Open terminal →</button>
              <button className="btn" onClick={() => jump("c1")}>Return to overture</button>
            </div>

            <div className="footnote fade-up d6">
              <div>© IDLExchange · 2026</div>
              <div className="center">— Perpetuals, proven —</div>
              <div className="right">{PROGRAM_ID}</div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};
