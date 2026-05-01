import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import "./IntroPage.css";

const assetPath = (name: string) => `${import.meta.env.BASE_URL}assets/${name}`;

function isMesh(object: THREE.Object3D): object is THREE.Mesh {
  return (object as THREE.Mesh).isMesh === true;
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((node) => {
    const anyNode = node as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    anyNode.geometry?.dispose();
    if (anyNode.material) {
      const materials = Array.isArray(anyNode.material) ? anyNode.material : [anyNode.material];
      materials.forEach((material) => material.dispose());
    }
  });
}

function initHeroScene(canvas: HTMLCanvasElement, loading: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 2.05;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;
  scene.environment = environment;

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
  camera.position.set(0, 0, 10.8);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.48));

  const key = new THREE.DirectionalLight(0xffffff, 4.2);
  key.position.set(2.8, 3.2, 5.2);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xf2f2f2, 2.4);
  rim.position.set(-4.4, 1.8, 2.2);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0xd8d8d8, 1.25);
  fill.position.set(0, -3.4, 3.4);
  scene.add(fill);

  const backRim = new THREE.DirectionalLight(0xffffff, 1.65);
  backRim.position.set(3.6, -2.2, -2.4);
  scene.add(backRim);

  const shimmer = new THREE.PointLight(0xffffff, 5.2, 18, 1.6);
  shimmer.position.set(0, 1.5, 4.5);
  scene.add(shimmer);

  const front = new THREE.DirectionalLight(0xffffff, 1.45);
  front.position.set(0, 0, 6);
  scene.add(front);

  const titleGroup = new THREE.Group();
  const titleInner = new THREE.Group();
  titleInner.rotation.x = Math.PI / 2;
  titleGroup.add(titleInner);
  scene.add(titleGroup);

  let titleReady = false;
  let titleRevealStart = 0;
  let raf = 0;
  let disposed = false;

  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);

  const loader = new GLTFLoader();
  loader.load(
    assetPath("brand-title.glb"),
    (gltf) => {
      if (disposed) {
        disposeObject(gltf.scene);
        return;
      }

      const model = gltf.scene;
      const rawBox = new THREE.Box3().setFromObject(model);
      const rawCenter = rawBox.getCenter(new THREE.Vector3());
      model.position.sub(rawCenter);
      titleInner.add(model);

      const box = new THREE.Box3().setFromObject(titleInner);
      const size = box.getSize(new THREE.Vector3());
      const fovRad = (camera.fov * Math.PI) / 180;
      const visibleHeight = 2 * Math.tan(fovRad / 2) * camera.position.z;
      const visibleWidth = visibleHeight * camera.aspect;
      const scaleByWidth = (visibleWidth * 0.74) / Math.max(0.001, size.x);
      const scaleByHeight = (visibleHeight * 0.4) / Math.max(0.001, size.y);
      titleInner.scale.setScalar(Math.min(scaleByWidth, scaleByHeight));

      const finalBox = new THREE.Box3().setFromObject(titleInner);
      const finalCenter = finalBox.getCenter(new THREE.Vector3());
      titleInner.position.sub(finalCenter);

      const titleMat = new THREE.MeshPhysicalMaterial({
        color: 0xf7f7f7,
        metalness: 1,
        roughness: 0.045,
        clearcoat: 1,
        clearcoatRoughness: 0.015,
        envMapIntensity: 3.8,
        emissive: 0xdcdcdc,
        emissiveIntensity: 0.08,
        reflectivity: 1,
        iridescence: 0.06,
        iridescenceIOR: 1.55,
        iridescenceThicknessRange: [120, 220],
        anisotropy: 0.72,
        anisotropyRotation: Math.PI / 2,
        sheen: 0.18,
        sheenRoughness: 0.36,
        sheenColor: 0xffffff,
      });
      const subMat = new THREE.MeshPhysicalMaterial({
        color: 0xd8d8d8,
        metalness: 0.88,
        roughness: 0.16,
        clearcoat: 0.95,
        clearcoatRoughness: 0.06,
        envMapIntensity: 2.45,
        emissive: 0xbdbdbd,
        emissiveIntensity: 0.1,
        reflectivity: 0.9,
        iridescence: 0.04,
        iridescenceIOR: 1.35,
        iridescenceThicknessRange: [120, 220],
      });

      model.traverse((object) => {
        if (!isMesh(object)) return;
        const materialName = Array.isArray(object.material)
          ? object.material.map((material) => material.name).join(" ")
          : object.material?.name ?? "";
        const name = `${object.name} ${object.parent?.name ?? ""} ${materialName}`;
        object.material = /sub/i.test(name) ? subMat : titleMat;
        object.castShadow = false;
        object.receiveShadow = false;
      });

      loading.classList.add("hidden");
      titleReady = true;
      titleRevealStart = performance.now();
    },
    undefined,
    () => {
      loading.textContent = "Scene fallback";
      loading.classList.add("hidden");
    },
  );

  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  const onMouseMove = (event: MouseEvent) => {
    mouse.tx = (event.clientX / window.innerWidth - 0.5) * 0.12;
    mouse.ty = (event.clientY / window.innerHeight - 0.5) * 0.06;
  };
  window.addEventListener("mousemove", onMouseMove);

  const easeOutExpo = (x: number) => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x));
  const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
  const startedAt = performance.now();

  const loop = () => {
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    mouse.x += (mouse.tx - mouse.x) * 0.05;
    mouse.y += (mouse.ty - mouse.y) * 0.05;

    let reveal = 1;
    if (titleReady) {
      reveal = Math.min(1, (performance.now() - titleRevealStart) / 2400);
    }
    const eased = easeOutExpo(reveal);
    const easedC = easeOutCubic(reveal);
    const introScale = 1 + (1 - eased) * 0.55;
    const introRotY = (1 - easedC) * 0.62;
    const introRotX = (1 - easedC) * -0.24;
    const introZ = (1 - eased) * -1.55;
    const introOpacity = titleReady ? eased : 1;
    const idleMix = easedC;

    titleGroup.scale.setScalar(introScale);
    titleGroup.position.z = introZ;
    titleGroup.rotation.y = introRotY + (mouse.x + Math.sin(elapsedSeconds * 0.35) * 0.014) * idleMix;
    titleGroup.rotation.x = introRotX + (-mouse.y + Math.sin(elapsedSeconds * 0.25) * 0.008) * idleMix;
    titleGroup.position.y = 0.98 + Math.sin(elapsedSeconds * 0.45) * 0.028 * idleMix;

    shimmer.position.x = Math.sin(elapsedSeconds * 0.35) * 4;
    shimmer.position.y = 1.4 + Math.sin(elapsedSeconds * 0.5) * 0.5;
    shimmer.position.z = 4.2 + Math.cos(elapsedSeconds * 0.35) * 0.4;
    shimmer.intensity = (4.4 + Math.sin(elapsedSeconds * 0.6) * 0.55) * idleMix;

    titleInner.traverse((object) => {
      if (!isMesh(object)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        material.transparent = introOpacity < 1;
        material.opacity = introOpacity;
        if (material instanceof THREE.MeshPhysicalMaterial) {
          material.emissiveIntensity = 0.08 + Math.sin(elapsedSeconds * 0.7) * 0.018;
          material.envMapIntensity = 3.1 + Math.sin(elapsedSeconds * 0.4) * 0.18;
        }
      });
    });

    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    window.removeEventListener("mousemove", onMouseMove);
    disposeObject(scene);
    environment.dispose();
    pmrem.dispose();
    renderer.dispose();
  };
}

function initPhoneScene(
  canvas: HTMLCanvasElement,
  section: HTMLElement,
  indicator: HTMLElement,
  features: NodeListOf<HTMLElement>,
  captionText: HTMLElement,
) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  scene.environment = environment;

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
  camera.position.set(0, 0, 8.6);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.46));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2.6, 3.4, 4.8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xe6e6e6, 1.55);
  rim.position.set(-3.4, 1.4, 2.4);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffffff, 0.65);
  fill.position.set(0, -2, 3);
  scene.add(fill);
  const edge = new THREE.DirectionalLight(0xffffff, 0.9);
  edge.position.set(2.6, -1.8, -2.4);
  scene.add(edge);

  const phoneOuter = new THREE.Group();
  const phoneInner = new THREE.Group();
  phoneOuter.add(phoneInner);
  scene.add(phoneOuter);

  const textureLoader = new THREE.TextureLoader();
  const screenTextures = [textureLoader.load(assetPath("screen1.jpeg")), textureLoader.load(assetPath("screen2.jpeg"))];
  screenTextures.forEach((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    texture.flipY = false;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.center.set(0.5, 0.5);
    texture.repeat.set(1, 1);
  });

  let screenMat: THREE.MeshBasicMaterial | null = null;
  let current = 0;
  let manualLock = 0;
  let raf = 0;
  let autoTimer = 0;
  let disposed = false;

  const setSlide = (index: number, manual = false) => {
    current = index;
    if (screenMat && screenTextures[index]) {
      screenMat.map = screenTextures[index];
      screenMat.needsUpdate = true;
    }
    indicator.querySelectorAll("button").forEach((button, buttonIndex) => {
      button.classList.toggle("active", buttonIndex === index);
    });
    features.forEach((feature, featureIndex) => {
      feature.classList.toggle("is-active", featureIndex === index);
    });
    captionText.textContent = `0${index + 1} / 02 · ${index === 0 ? "Home" : "Trade"}`;
    if (manual) manualLock = performance.now() + 2400;
  };

  const loader = new GLTFLoader();
  loader.load(
    assetPath("phone-model.glb"),
    (gltf) => {
      if (disposed) {
        disposeObject(gltf.scene);
        return;
      }

      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      model.position.sub(center);
      model.scale.setScalar(3.35 / Math.max(0.001, Math.max(size.x, size.y, size.z)));
      phoneInner.add(model);

      let bestScreen: THREE.Mesh | null = null;
      let bestArea = 0;
      const meshes: THREE.Mesh[] = [];

      model.traverse((object) => {
        if (!isMesh(object)) return;
        meshes.push(object);
        const materialName = Array.isArray(object.material)
          ? object.material.map((material) => material.name).join(" ")
          : object.material?.name ?? "";
        const name = `${object.name} ${materialName}`.toLowerCase();
        if (/screen|display|glass|lcd/.test(name)) {
          bestScreen = object;
        }

        const meshBox = new THREE.Box3().setFromObject(object);
        const meshSize = meshBox.getSize(new THREE.Vector3());
        const dims = [meshSize.x, meshSize.y, meshSize.z].sort((a, b) => b - a);
        const area = dims[0] * dims[1];
        const flatness = dims[2] / Math.max(0.001, dims[1]);
        if (!bestScreen && flatness < 0.15 && area > bestArea) {
          bestArea = area;
          bestScreen = object;
        }
      });

      const selectedScreen = bestScreen as THREE.Mesh | null;
      const phoneCaseMat = new THREE.MeshPhysicalMaterial({
        color: 0xf4f4f4,
        metalness: 1,
        roughness: 0.05,
        clearcoat: 1,
        clearcoatRoughness: 0.018,
        envMapIntensity: 3.5,
        emissive: 0xd8d8d8,
        emissiveIntensity: 0.06,
        reflectivity: 1,
        iridescence: 0.05,
        iridescenceIOR: 1.5,
        iridescenceThicknessRange: [120, 220],
        anisotropy: 0.68,
        anisotropyRotation: Math.PI / 2,
        sheen: 0.16,
        sheenRoughness: 0.36,
        sheenColor: 0xffffff,
      });

      meshes.forEach((mesh) => {
        if (mesh === selectedScreen) return;
        mesh.material = phoneCaseMat;
      });

      if (selectedScreen) {
        screenMat = new THREE.MeshBasicMaterial({
          map: screenTextures[0],
          toneMapped: false,
        });
        selectedScreen.material = screenMat;
      }
    },
    undefined,
    () => {
      if (disposed) return;
      const geometry = new THREE.PlaneGeometry(1.6, 3.3);
      screenMat = new THREE.MeshBasicMaterial({ map: screenTextures[0], toneMapped: false });
      phoneInner.add(new THREE.Mesh(geometry, screenMat));
    },
  );

  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);

  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  const responsive = { scale: 1, y: 0 };
  const updateResponsivePhone = () => {
    const width = canvas.clientWidth;
    if (width < 440) {
      responsive.scale = 0.72;
      responsive.y = -0.24;
    } else if (width < 760) {
      responsive.scale = 0.86;
      responsive.y = -0.12;
    } else {
      responsive.scale = 1;
      responsive.y = 0;
    }
  };
  updateResponsivePhone();
  const onMouseMove = (event: MouseEvent) => {
    mouse.tx = (event.clientX / window.innerWidth - 0.5) * 1.8;
    mouse.ty = (event.clientY / window.innerHeight - 0.5) * 0.82;
  };
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("resize", updateResponsivePhone);

  const startedAt = performance.now();
  const loop = () => {
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    mouse.x += (mouse.tx - mouse.x) * 0.2;
    mouse.y += (mouse.ty - mouse.y) * 0.2;
    phoneOuter.scale.setScalar(responsive.scale);
    phoneOuter.rotation.y = -0.22 + mouse.x + Math.sin(elapsedSeconds * 0.36) * 0.035;
    phoneOuter.rotation.x = -0.04 - mouse.y + Math.sin(elapsedSeconds * 0.28) * 0.015;
    phoneOuter.position.y = responsive.y + Math.sin(elapsedSeconds * 0.5) * 0.035;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();

  const buttons = Array.from(indicator.querySelectorAll<HTMLButtonElement>("button"));
  const onIndicatorClick = (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement;
    setSlide(Number(button.dataset.i ?? 0), true);
  };
  buttons.forEach((button) => button.addEventListener("click", onIndicatorClick));

  const onFeatureClick = (event: Event) => {
    const feature = event.currentTarget as HTMLElement;
    setSlide(Number(feature.dataset.step ?? 0), true);
  };
  features.forEach((feature) => feature.addEventListener("click", onFeatureClick));

  const onScroll = () => {
    if (performance.now() < manualLock) return;
    const rect = section.getBoundingClientRect();
    const total = section.offsetHeight - window.innerHeight;
    const progress = Math.max(0, Math.min(1, -rect.top / total));
    const target = progress < 0.5 ? 0 : 1;
    if (target !== current) setSlide(target, false);
  };
  const scrollContainer = section.closest(".intro-page");
  const scrollTarget: EventTarget = scrollContainer ?? window;
  scrollTarget.addEventListener("scroll", onScroll, { passive: true });
  if (scrollTarget !== window) {
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  autoTimer = window.setInterval(() => {
    const rect = section.getBoundingClientRect();
    const visible = rect.top < window.innerHeight * 0.4 && rect.bottom > window.innerHeight * 0.4;
    if (!visible || performance.now() < manualLock) return;
    setSlide(1 - current, false);
  }, 5200);

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    window.clearInterval(autoTimer);
    window.removeEventListener("resize", resize);
    window.removeEventListener("resize", updateResponsivePhone);
    window.removeEventListener("mousemove", onMouseMove);
    scrollTarget.removeEventListener("scroll", onScroll);
    if (scrollTarget !== window) {
      window.removeEventListener("scroll", onScroll);
    }
    buttons.forEach((button) => button.removeEventListener("click", onIndicatorClick));
    features.forEach((feature) => feature.removeEventListener("click", onFeatureClick));
    screenTextures.forEach((texture) => texture.dispose());
    disposeObject(scene);
    environment.dispose();
    pmrem.dispose();
    renderer.dispose();
  };
}

function initSolanaScene(canvas: HTMLCanvasElement, section: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  scene.environment = environment;

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
  camera.position.set(0, 0, 8.6);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffd9a8, 0.55));
  const key = new THREE.DirectionalLight(0xfff1d8, 2.4);
  key.position.set(2.6, 3.4, 4.8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffae3a, 1.85);
  rim.position.set(-3.4, 1.4, 2.4);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffc071, 0.85);
  fill.position.set(0, -2, 3);
  scene.add(fill);
  const edge = new THREE.DirectionalLight(0xff8a1c, 1.1);
  edge.position.set(2.6, -1.8, -2.4);
  scene.add(edge);
  const uplight = new THREE.PointLight(0xffae3a, 1.6, 8, 1.4);
  uplight.position.set(0, -1.4, 1.6);
  scene.add(uplight);

  const modelOuter = new THREE.Group();
  const modelInner = new THREE.Group();
  modelInner.position.y = 1.55;
  modelOuter.add(modelInner);
  scene.add(modelOuter);

  const cosmicCount = 700;
  const cosmicPositions = new Float32Array(cosmicCount * 3);
  const cosmicColors = new Float32Array(cosmicCount * 3);
  const cosmicSpeeds = new Float32Array(cosmicCount);
  const cosmicSeeds = new Float32Array(cosmicCount);
  const cosmicTopY = 4.4;
  const cosmicBottomY = -0.6;
  for (let i = 0; i < cosmicCount; i++) {
    const r = 0.3 + Math.random() * 3.4;
    const theta = Math.random() * Math.PI * 2;
    cosmicPositions[i * 3 + 0] = Math.cos(theta) * r;
    cosmicPositions[i * 3 + 1] = cosmicBottomY + Math.random() * (cosmicTopY - cosmicBottomY);
    cosmicPositions[i * 3 + 2] = Math.sin(theta) * r;
    cosmicSpeeds[i] = 0.18 + Math.random() * 0.45;
    cosmicSeeds[i] = Math.random() * Math.PI * 2;
    cosmicColors[i * 3 + 0] = 1.0;
    cosmicColors[i * 3 + 1] = 0.92;
    cosmicColors[i * 3 + 2] = 0.4;
  }
  const cosmicGeom = new THREE.BufferGeometry();
  cosmicGeom.setAttribute("position", new THREE.BufferAttribute(cosmicPositions, 3));
  cosmicGeom.setAttribute("color", new THREE.BufferAttribute(cosmicColors, 3));
  const cosmicMat = new THREE.PointsMaterial({
    vertexColors: true,
    size: 0.075,
    sizeAttenuation: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const cosmic = new THREE.Points(cosmicGeom, cosmicMat);
  cosmic.renderOrder = 3;
  scene.add(cosmic);

  const cosmicHaloMat = new THREE.PointsMaterial({
    color: 0xffd24a,
    size: 0.22,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.45,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const cosmicHalo = new THREE.Points(cosmicGeom, cosmicHaloMat);
  cosmicHalo.renderOrder = 2;
  scene.add(cosmicHalo);

  let raf = 0;
  let disposed = false;
  let lastFrame = performance.now() / 1000;

  const loader = new GLTFLoader();
  loader.load(
    assetPath("solana-model.glb"),
    (gltf) => {
      if (disposed) {
        disposeObject(gltf.scene);
        return;
      }
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      model.position.sub(center);
      model.scale.setScalar(3.35 / Math.max(0.001, Math.max(size.x, size.y, size.z)));
      modelInner.add(model);

      const goldColor = new THREE.Color(0xf7d000);
      const goldEmissive = new THREE.Color(0x2a2000);
      const textBlack = new THREE.Color(0x000000);
      const textPattern = /(^|[^a-z])(text|label|caption|glyph)([^a-z]|$)/i;
      const cubeMeshes: THREE.Mesh[] = [];
      const debugMeshNames: string[] = [];
      const tmpSize = new THREE.Vector3();
      const looksLikeLabelGeometry = (mesh: THREE.Mesh) => {
        if (!mesh.geometry) return false;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox;
        if (!bb) return false;
        bb.getSize(tmpSize);
        const longest = Math.max(tmpSize.x, tmpSize.y, tmpSize.z);
        const shortest = Math.min(tmpSize.x, tmpSize.y, tmpSize.z);
        if (longest < 0.6) return true;
        const aspect = longest / Math.max(shortest, 1e-6);
        return aspect > 18 && longest < 1.6;
      };
      const looksLikeSphericalDot = (mesh: THREE.Mesh) => {
        if (!mesh.geometry) return false;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox;
        if (!bb) return false;
        bb.getSize(tmpSize);
        const longest = Math.max(tmpSize.x, tmpSize.y, tmpSize.z);
        const shortest = Math.min(tmpSize.x, tmpSize.y, tmpSize.z);
        const aspect = longest / Math.max(shortest, 1e-6);
        const vertexCount = (mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined)?.count ?? 0;
        return longest < 0.18 && aspect < 1.5 && vertexCount > 30;
      };
      model.traverse((object) => {
        if (!isMesh(object)) return;
        object.castShadow = false;
        object.receiveShadow = false;
        const meshName = `${object.name ?? ""}`.toLowerCase();
        const parentName = `${object.parent?.name ?? ""}`.toLowerCase();
        debugMeshNames.push(`${object.name}|parent=${object.parent?.name ?? ""}`);
        const mats = Array.isArray(object.material) ? object.material : [object.material];

        if (looksLikeSphericalDot(object)) {
          object.visible = false;
          return;
        }

        const looksLikeText =
          textPattern.test(meshName) ||
          textPattern.test(parentName) ||
          looksLikeLabelGeometry(object);

        if (looksLikeText) {
          mats.forEach((mat) => {
            if (!mat) return;
            const m = mat as THREE.MeshStandardMaterial;
            if (m.color) m.color.copy(textBlack);
            if (m.emissive) {
              m.emissive.set(0x000000);
              m.emissiveIntensity = 0;
            }
            m.metalness = 0;
            m.roughness = 0.6;
            m.transparent = false;
            m.depthTest = false;
            m.depthWrite = false;
            m.polygonOffset = true;
            m.polygonOffsetFactor = -8;
            m.polygonOffsetUnits = -8;
            m.toneMapped = false;
            m.needsUpdate = true;
          });
          object.renderOrder = 999;
          object.frustumCulled = false;
          return;
        }

        const hasTextureMap = mats.some((m) => {
          const sm = m as THREE.MeshStandardMaterial | null;
          return !!(sm && (sm.map || sm.emissiveMap));
        });

        if (hasTextureMap) {
          object.frustumCulled = false;
          return;
        }

        const replacement = new THREE.MeshStandardMaterial({
          color: goldColor,
          emissive: goldEmissive,
          emissiveIntensity: 0.22,
          metalness: 0.95,
          roughness: 0.22,
          envMapIntensity: 1.6,
          transparent: false,
          opacity: 1,
          alphaTest: 0,
          depthTest: true,
          depthWrite: true,
          side: THREE.FrontSide,
        });
        mats.forEach((mat) => mat?.dispose?.());
        if (Array.isArray(object.material)) {
          object.material = object.material.map(() => replacement);
        } else {
          object.material = replacement;
        }
        cubeMeshes.push(object);
      });

      const blackEdgeMat = new THREE.LineBasicMaterial({
        color: 0x000000,
        transparent: false,
        opacity: 1,
        toneMapped: false,
      });
      cubeMeshes.forEach((mesh) => {
        if (!mesh.geometry) return;
        const edges = new THREE.EdgesGeometry(mesh.geometry, 24);
        const line = new THREE.LineSegments(edges, blackEdgeMat);
        line.renderOrder = 5;
        mesh.add(line);
      });
      console.log("[solana-model meshes]", debugMeshNames);
    },
    undefined,
    (err) => console.warn("solana-model.glb load error:", err),
  );

  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);

  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  const responsive = { scale: 1, y: 0 };
  const updateResponsive = () => {
    const width = canvas.clientWidth;
    if (width < 440) {
      responsive.scale = 0.72;
      responsive.y = -0.24;
    } else if (width < 760) {
      responsive.scale = 0.86;
      responsive.y = -0.12;
    } else {
      responsive.scale = 1;
      responsive.y = 0;
    }
  };
  updateResponsive();
  const onMouseMove = (event: MouseEvent) => {
    mouse.tx = (event.clientX / window.innerWidth - 0.5) * 1.6;
    mouse.ty = (event.clientY / window.innerHeight - 0.5) * 0.7;
  };
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("resize", updateResponsive);

  const startedAt = performance.now();
  const loop = () => {
    const nowSeconds = performance.now() / 1000;
    const dt = Math.min(0.05, Math.max(0.001, nowSeconds - lastFrame));
    lastFrame = nowSeconds;
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    mouse.x += (mouse.tx - mouse.x) * 0.18;
    mouse.y += (mouse.ty - mouse.y) * 0.18;
    modelOuter.scale.setScalar(responsive.scale);
    modelOuter.rotation.y = mouse.x + Math.sin(elapsedSeconds * 0.32) * 0.04;
    modelOuter.rotation.x = -mouse.y + Math.sin(elapsedSeconds * 0.26) * 0.018;
    modelOuter.position.y = responsive.y + Math.sin(elapsedSeconds * 0.45) * 0.04;
    const cosmicArr = (cosmicGeom.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    const cosmicColorArr = (cosmicGeom.getAttribute("color") as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < cosmicCount; i++) {
      let y = cosmicArr[i * 3 + 1] + cosmicSpeeds[i] * dt;
      if (y > cosmicTopY) y = cosmicBottomY;
      cosmicArr[i * 3 + 1] = y;
      cosmicArr[i * 3 + 0] += Math.sin(elapsedSeconds * 0.9 + cosmicSeeds[i]) * 0.0008;
      cosmicArr[i * 3 + 2] += Math.cos(elapsedSeconds * 0.7 + cosmicSeeds[i]) * 0.0008;
      const tw = 0.4 + (Math.sin(elapsedSeconds * 4.2 + cosmicSeeds[i] * 1.7) * 0.5 + 0.5) * 0.6;
      cosmicColorArr[i * 3 + 0] = 1.0 * tw;
      cosmicColorArr[i * 3 + 1] = 0.92 * tw;
      cosmicColorArr[i * 3 + 2] = 0.4 * tw;
    }
    (cosmicGeom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (cosmicGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    cosmicHaloMat.opacity = 0.4 + Math.sin(elapsedSeconds * 2.1) * 0.15;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();

  void section;

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    window.removeEventListener("resize", updateResponsive);
    window.removeEventListener("mousemove", onMouseMove);
    disposeObject(scene);
    environment.dispose();
    pmrem.dispose();
    renderer.dispose();
  };
}

export function IntroPage({ onEnter }: { onEnter: () => void }) {
  const pageRef = useRef<HTMLElement>(null);
  const heroCanvasRef = useRef<HTMLCanvasElement>(null);
  const heroLoadingRef = useRef<HTMLDivElement>(null);
  const solanaCanvasRef = useRef<HTMLCanvasElement>(null);
  const solanaSectionRef = useRef<HTMLElement>(null);
  const phoneCanvasRef = useRef<HTMLCanvasElement>(null);
  const phoneSectionRef = useRef<HTMLElement>(null);
  const phoneIndicatorRef = useRef<HTMLDivElement>(null);
  const phoneFeaturesRef = useRef<HTMLDivElement>(null);
  const phoneCaptionRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = heroCanvasRef.current;
    const loading = heroLoadingRef.current;
    if (!canvas || !loading) return undefined;
    return initHeroScene(canvas, loading);
  }, []);

  useEffect(() => {
    const canvas = solanaCanvasRef.current;
    const section = solanaSectionRef.current;
    if (!canvas || !section) return undefined;
    return initSolanaScene(canvas, section);
  }, []);

  useEffect(() => {
    const canvas = phoneCanvasRef.current;
    const section = phoneSectionRef.current;
    const indicator = phoneIndicatorRef.current;
    const features = phoneFeaturesRef.current?.querySelectorAll<HTMLElement>(".intro-phone-feature");
    const caption = phoneCaptionRef.current;
    if (!canvas || !section || !indicator || !features || !caption) return undefined;
    return initPhoneScene(canvas, section, indicator, features, caption);
  }, []);

  useEffect(() => {
    const section = solanaSectionRef.current;
    if (!section) return undefined;
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => section.classList.toggle("in-view", e.isIntersecting)),
      { threshold: 0.12 },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const section = phoneSectionRef.current;
    if (!section) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          section.classList.toggle("in-view", entry.isIntersecting);
        });
      },
      { threshold: 0.15 },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  const scrollToPhone = () => {
    phoneSectionRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <main ref={pageRef} className="intro-page">
      <nav className="intro-nav">
        <button className="intro-brand" onClick={() => pageRef.current?.scrollTo({ top: 0, behavior: "smooth" })}>
          <span className="intro-brand-mark" aria-hidden="true" />
          <span className="intro-brand-text">IDLExchange</span>
        </button>
      </nav>

      <section className="intro-hero" aria-label="IDLExchange landing">
        <div className="intro-hero-bg" style={{ backgroundImage: `url("${assetPath("hero-bg.png")}")` }} />
        <canvas ref={heroCanvasRef} className="intro-hero-canvas" />
        <div ref={heroLoadingRef} className="intro-canvas-loading">
          Initializing scene · 3D
        </div>

        <div className="intro-frame-corner intro-frame-corner-tl" aria-hidden="true">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <path d="M0 0 L0 12 M0 0 L12 0" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
          </svg>
        </div>
        <div className="intro-frame-corner intro-frame-corner-br" aria-hidden="true">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <path d="M36 36 L36 24 M36 36 L24 36" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
          </svg>
        </div>

        <div className="intro-hero-content">
          <p className="intro-hero-sub">
            Eighteen machine-checked Lean 4 theorems guard every state transition. Discrete frequent batch
            auctions neutralize MEV. One transaction in, one out.
          </p>
          <div className="intro-hero-actions">
            <button className="intro-btn intro-btn-primary" onClick={onEnter}>
              Open the exchange
            </button>
            <button className="intro-btn" onClick={scrollToPhone}>
              View mobile app
            </button>
          </div>
        </div>

        <div className="intro-hero-meta" aria-label="Protocol metrics">
          <div className="intro-hero-meta-col">
            <strong>18 / 18</strong>
            <span>Lean theorems · zero sorry</span>
          </div>
          <div className="intro-hero-meta-col intro-align-center">
            <strong>DFBA</strong>
            <span>MEV-resistant execution</span>
          </div>
          <div className="intro-hero-meta-col intro-align-right">
            <strong>$148.4M · 24h</strong>
            <span>Verified volume</span>
          </div>
        </div>

        <div className="intro-scroll-cue" aria-hidden="true">
          <span>Scroll</span>
          <div className="intro-scroll-line" />
        </div>
      </section>

      <section ref={solanaSectionRef} className="intro-solana-section" aria-label="Protocol architecture">
        <div className="intro-solana-sticky">
          <div className="intro-solana-copy">
            <div className="intro-solana-eyebrow">Protocol · Architecture</div>
            <h2 className="intro-solana-title">
              Four primitives.<br /><b>One verified</b> stack.
            </h2>
            <p className="intro-solana-desc">
              Every module formally verified, MEV-resistant, and live on mainnet — built on Solana.
            </p>
            <ul className="intro-solana-pillars">
              <li><span>01</span>Yield Back</li>
              <li><span>02</span>Margin Gradual Deleveraging</li>
              <li><span>03</span>Portfolio Margin</li>
              <li><span>04</span>Power Perps</li>
            </ul>
          </div>
          <div className="intro-solana-stage">
            <canvas ref={solanaCanvasRef} className="intro-solana-canvas" />
            <div className="intro-solana-glow" aria-hidden="true" />
          </div>
        </div>
      </section>

      <section ref={phoneSectionRef} className="intro-phone-section" aria-label="IDLExchange mobile app">
        <div className="intro-phone-sticky">
          <div className="intro-phone-copy">
            <div className="intro-phone-eyebrow">Mobile · Native</div>
            <h2 className="intro-phone-title">
              The whole <b>desk</b>
              <br />
              in your pocket.
            </h2>
            <p className="intro-phone-desc">
              From discovery to position management, every primitive of the protocol is rebuilt for one thumb.
              Place orders, watch funding, and hold collateral on a verified vault.
            </p>

            <div ref={phoneFeaturesRef} className="intro-phone-features">
              <button className="intro-phone-feature is-active" data-step="0">
                <span className="intro-phone-num">01</span>
                <span className="intro-phone-label">
                  Home, verified surface
                  <small>Glance at SOL, scan signals, jump into a market.</small>
                </span>
                <span className="intro-phone-dot" />
              </button>
              <button className="intro-phone-feature" data-step="1">
                <span className="intro-phone-num">02</span>
                <span className="intro-phone-label">
                  Trade, long, short, leverage
                  <small>SOL collateral, 2x to 10x, batched fills with preview.</small>
                </span>
                <span className="intro-phone-dot" />
              </button>
            </div>
          </div>

          <div className="intro-phone-stage">
            <canvas ref={phoneCanvasRef} className="intro-phone-canvas" />
            <div className="intro-phone-glow" aria-hidden="true" />
          </div>

          <div ref={phoneIndicatorRef} className="intro-phone-indicator" aria-label="Mobile screen selector">
            <button className="active" data-i="0" aria-label="Screen 1" />
            <button data-i="1" aria-label="Screen 2" />
          </div>

          <div className="intro-phone-caption" aria-hidden="true">
            <span className="intro-caption-bar" />
            <span ref={phoneCaptionRef}>01 / 02 · Home</span>
            <span className="intro-caption-bar" />
          </div>
        </div>
      </section>
    </main>
  );
}
