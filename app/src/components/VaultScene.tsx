import { useEffect, useRef, FC } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const asset = (name: string) => `${import.meta.env.BASE_URL}assets/${name}`;

export const VaultScene: FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;

    const renderer = new THREE.WebGLRenderer({
      canvas, alpha: true, antialias: true, powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.45;

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 400);
    // Will be re-aimed by auto-frame once the model loads
    camera.position.set(38, 22, 38);
    const lookTarget = new THREE.Vector3(0, 5, 0);
    camera.lookAt(lookTarget);

    scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const key = new THREE.DirectionalLight(0xfff1d6, 3.4);
    key.position.set(12, 18, 9);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xc9d8ff, 1.4);
    rim.position.set(-9, 6, -12);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffe9b3, 1.0);
    fill.position.set(0, -8, 10);
    scene.add(fill);

    const resize = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener("resize", resize);
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const draco = new DRACOLoader();
    draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);

    type ActionEntry = { action: THREE.AnimationAction; clip: THREE.AnimationClip };
    let mixer: THREE.AnimationMixer | null = null;
    const actionEntries: ActionEntry[] = [];
    let clipDuration = 0;
    let modelReady = false;
    let smoothedTime = 0;
    let baseCamPos = camera.position.clone();
    let baseTarget = lookTarget.clone();

    const frameToBox = (root: THREE.Object3D) => {
      // Compute bbox of the static vault only — excluding flying coins which
      // start far above the vault and would balloon the framing distance.
      const box = new THREE.Box3();
      let any = false;
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (obj.name.startsWith("SolCoin_fly")) return;
        const mBox = new THREE.Box3().setFromObject(mesh);
        if (!mBox.isEmpty()) {
          box.union(mBox);
          any = true;
        }
      });
      if (!any) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const fovRad = camera.fov * Math.PI / 180;
      const distance = (maxDim / (2 * Math.tan(fovRad / 2))) * 3.2;
      const dir = new THREE.Vector3(1.0, 0.12, 0.0).normalize();
      camera.position.copy(center).addScaledVector(dir, distance);
      lookTarget.copy(center);
      camera.lookAt(lookTarget);
      baseCamPos = camera.position.clone();
      baseTarget = lookTarget.clone();
    };

    loader.load(
      asset("vault.glb"),
      (gltf) => {
        scene.add(gltf.scene);
        console.log("[vault] animations:", gltf.animations.map(a => `${a.name} (${a.duration.toFixed(2)}s)`));
        if (gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(gltf.scene);
          gltf.animations.forEach((clip) => {
            clipDuration = Math.max(clipDuration, clip.duration);
            const action = mixer!.clipAction(clip);
            action.setLoop(THREE.LoopRepeat, Infinity);
            action.clampWhenFinished = false;
            action.play();
            actionEntries.push({ action, clip });
          });
          mixer.update(0);
        }
        frameToBox(gltf.scene);
        modelReady = true;
      },
      undefined,
      (err) => console.error("vault.glb load failed:", err),
    );

    let targetProgress = 0;
    const updateScroll = () => {
      const section = wrap.closest("section");
      if (!section) return;
      const r = section.getBoundingClientRect();
      targetProgress = Math.max(0, Math.min(1, (window.innerHeight / 2 - r.top) / r.height));
    };
    window.addEventListener("scroll", updateScroll, { passive: true });
    window.addEventListener("resize", updateScroll);
    updateScroll();

    // Cursor parallax (very subtle — orbits camera around the scene a few degrees)
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMouseMove = (e: MouseEvent) => {
      mouse.tx = (e.clientX / window.innerWidth - 0.5) * 0.18;
      mouse.ty = (e.clientY / window.innerHeight - 0.5) * 0.08;
    };
    window.addEventListener("mousemove", onMouseMove);

    const t0 = performance.now();
    let raf = 0;
    const loop = () => {
      const t = (performance.now() - t0) / 1000;

      if (modelReady && mixer && clipDuration > 0) {
        const targetTime = targetProgress * clipDuration;
        smoothedTime += (targetTime - smoothedTime) * 0.18;
        smoothedTime = Math.max(0, Math.min(clipDuration, smoothedTime));
        // Drive each action to the smoothed master time, but clamp to its own
        // clip duration. Short clips (e.g. coins flying in) finish at their
        // end pose and stay there instead of looping while the gate closes.
        actionEntries.forEach(({ action, clip }) => {
          action.time = Math.min(smoothedTime, clip.duration);
        });
        mixer.update(0);
      }

      // Idle camera drift — orbits gently around the look target so it reads as 3D
      mouse.x += (mouse.tx - mouse.x) * 0.06;
      mouse.y += (mouse.ty - mouse.y) * 0.06;
      const yaw = Math.sin(t * 0.18) * 0.04 + mouse.x;
      const pitch = Math.sin(t * 0.13) * 0.02 - mouse.y;
      const offset = baseCamPos.clone().sub(baseTarget);
      const radius = offset.length();
      const baseYaw = Math.atan2(offset.x, offset.z);
      const baseHeight = offset.y;
      const newYaw = baseYaw + yaw;
      const horizR = Math.sqrt(radius * radius - baseHeight * baseHeight);
      camera.position.set(
        baseTarget.x + Math.sin(newYaw) * horizR,
        baseTarget.y + baseHeight + pitch * radius,
        baseTarget.z + Math.cos(newYaw) * horizR,
      );
      camera.lookAt(baseTarget);

      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", updateScroll);
      window.removeEventListener("resize", updateScroll);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      ro.disconnect();
      pmrem.dispose();
      renderer.dispose();
      draco.dispose();
    };
  }, []);

  return (
    <div ref={wrapRef} className="vault-scene">
      <canvas ref={canvasRef} className="vault-canvas" />
    </div>
  );
};
