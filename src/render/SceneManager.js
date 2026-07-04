// 3층: 렌더/뷰 — 씬·카메라·조명·하늘·지면 등 "그리기" 전담.
// 코어(core)/시뮬레이션(sim) 상태를 받아 표시만 하고, 상태를 변경하지 않는다.
//
// P7.9: 대기 산란 하늘(Sky)+ACES 톤매핑, 시드 고정 절차 지면 텍스처, applySite()로
// 태양·그림자 카메라·포그·경계 펜스를 현장 크기에 맞춤 (S8 그림자 잘림 수정),
// 개발용 그리드·축은 기본 OFF(G 토글).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { seededRandom } from './parts.js';

const SUN_DIR = new THREE.Vector3(0.55, 0.72, 0.42).normalize(); // 태양 방향 (현장 무관 고정)

export class SceneManager {
  constructor(container) {
    this.container = container;

    // --- Renderer ---
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; // Sky 휘도 매핑
    this.renderer.toneMappingExposure = 0.85;
    container.appendChild(this.renderer.domElement);

    // --- Scene ---
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xbccbd6, 150, 520); // 지평선 톤 (applySite에서 스케일)

    // --- Camera ---
    this.camera = new THREE.PerspectiveCamera(
      55,
      container.clientWidth / container.clientHeight,
      0.1,
      2500,
    );
    this.camera.position.set(35, 25, 35);

    // --- Controls ---
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 8, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495; // 지면 아래로 못 내려감
    this.controls.minDistance = 5;
    this.controls.maxDistance = 400;

    this.siteEnv = null; // applySite가 만드는 현장 전용 그룹 (펜스 등)

    this.#setupSky();
    this.#setupLights();
    this.#setupGround();

    window.addEventListener('resize', () => this.#onResize());
  }

  #setupSky() {
    const sky = new Sky();
    sky.scale.setScalar(2000);
    const u = sky.material.uniforms;
    u.turbidity.value = 6;
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.75;
    u.sunPosition.value.copy(SUN_DIR);
    this.scene.add(sky);
  }

  #setupLights() {
    const hemi = new THREE.HemisphereLight(0xdfeaf5, 0x54452e, 0.75);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
    this.sun.position.copy(SUN_DIR).multiplyScalar(140);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.#fitShadow(0, 0, 130);
  }

  /** 태양 그림자 카메라를 현장 중심·크기에 맞춘다 (잘림 방지 + 해상도 낭비 방지) */
  #fitShadow(cx, cz, span) {
    const half = span * 0.62 + 18;
    this.sun.position.set(cx + SUN_DIR.x * span * 1.6, SUN_DIR.y * span * 1.6, cz + SUN_DIR.z * span * 1.6);
    this.sun.target.position.set(cx, 0, cz);
    const cam = this.sun.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = span * 4 + 150;
    cam.updateProjectionMatrix();
  }

  /** 시드 고정 절차 지면 텍스처 — 흙·자갈 얼룩 (재현성: Math.random 금지) */
  #groundTexture() {
    if (typeof document === 'undefined') return null;
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#8f8a7d';
    ctx.fillRect(0, 0, size, size);
    const rand = seededRandom(20260705);
    const tones = ['#7d766a', '#989284', '#a39b8b', '#867f70', '#9c9484'];
    for (let i = 0; i < 1400; i++) {
      const r = 4 + rand() * 26;
      ctx.globalAlpha = 0.05 + rand() * 0.06;
      ctx.fillStyle = tones[Math.floor(rand() * tones.length) % tones.length];
      ctx.beginPath();
      ctx.ellipse(rand() * size, rand() * size, r, r * (0.4 + rand() * 0.6), rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    // 차량 궤적 느낌의 옅은 줄
    for (let i = 0; i < 22; i++) {
      ctx.globalAlpha = 0.045;
      ctx.strokeStyle = rand() > 0.5 ? '#797367' : '#7d7669';
      ctx.lineWidth = 5 + rand() * 9;
      ctx.beginPath();
      const y0 = rand() * size;
      ctx.moveTo(0, y0);
      ctx.bezierCurveTo(size * 0.3, y0 + (rand() - 0.5) * 180, size * 0.7, y0 + (rand() - 0.5) * 180, size, y0 + (rand() - 0.5) * 120);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(5, 5);
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  #setupGround() {
    const tex = this.#groundTexture();
    const groundMat = new THREE.MeshStandardMaterial({
      color: tex ? 0xffffff : 0x8f8a7d, // 텍스처가 색을 가짐 (헤드리스 폴백은 단색)
      map: tex,
      roughness: 0.95,
      metalness: 0.0,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // 개발용 그리드·축 — 기본 숨김 (G 키 토글)
    this.devHelpers = new THREE.Group();
    const grid = new THREE.GridHelper(200, 20, 0x445566, 0x667788);
    grid.material.opacity = 0.35;
    grid.material.transparent = true;
    grid.position.y = 0.01;
    this.devHelpers.add(grid);
    const axes = new THREE.AxesHelper(5);
    axes.position.y = 0.02;
    this.devHelpers.add(axes);
    this.devHelpers.visible = false;
    this.scene.add(this.devHelpers);
  }

  /** 개발용 그리드·축 표시 토글 */
  toggleGrid() {
    this.devHelpers.visible = !this.devHelpers.visible;
    return this.devHelpers.visible;
  }

  /**
   * 현장 크기에 맞춰 그림자·포그·경계 펜스를 재구성한다. 시나리오 로드마다 호출.
   * @param {Object} scenario site: { width, depth, minX, minZ } (없으면 프레임 점 범위 사용)
   * @param {Array<number[]>} [points] site 부재 시 범위 추정용 좌표들
   */
  applySite(scenario, points = []) {
    if (this.siteEnv) {
      this.scene.remove(this.siteEnv);
      this.siteEnv = null;
    }
    const s = scenario.site;
    let minX;
    let maxX;
    let minZ;
    let maxZ;
    if (s) {
      minX = s.minX ?? -(s.width ?? 120) / 2;
      maxX = minX + (s.width ?? 120);
      minZ = s.minZ ?? -(s.depth ?? 120) / 2;
      maxZ = minZ + (s.depth ?? 120);
    } else if (points.length) {
      const xs = points.map((p) => p[0]);
      const zs = points.map((p) => (p.length === 3 ? p[2] : p[1]));
      minX = Math.min(...xs) - 15;
      maxX = Math.max(...xs) + 15;
      minZ = Math.min(...zs) - 15;
      maxZ = Math.max(...zs) + 15;
    } else {
      minX = -60;
      maxX = 60;
      minZ = -60;
      maxZ = 60;
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(80, maxX - minX, maxZ - minZ);

    this.#fitShadow(cx, cz, span);
    this.scene.fog.near = Math.max(150, span * 1.3);
    this.scene.fog.far = Math.max(520, span * 3.4);

    // 현장 경계 펜스 (site가 명시된 시나리오만)
    if (s) {
      this.siteEnv = new THREE.Group();
      this.#buildFence(minX, maxX, minZ, maxZ);
      this.scene.add(this.siteEnv);
    }
  }

  /** 경계 펜스: 포스트(Instanced) + 반투명 메시 스트립 — 체인링크 근사 */
  #buildFence(minX, maxX, minZ, maxZ) {
    const postGeo = new THREE.BoxGeometry(0.09, 1.9, 0.09);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x7d838a, roughness: 0.6, metalness: 0.4 });
    const spacing = 4;
    const runs = [
      { from: [minX, minZ], to: [maxX, minZ] },
      { from: [maxX, minZ], to: [maxX, maxZ] },
      { from: [maxX, maxZ], to: [minX, maxZ] },
      { from: [minX, maxZ], to: [minX, minZ] },
    ];
    let total = 0;
    const positions = [];
    for (const run of runs) {
      const dx = run.to[0] - run.from[0];
      const dz = run.to[1] - run.from[1];
      const len = Math.hypot(dx, dz);
      const n = Math.max(1, Math.floor(len / spacing));
      for (let i = 0; i < n; i++) {
        positions.push([run.from[0] + (dx * i) / n, run.from[1] + (dz * i) / n]);
      }
      total += n;
    }
    const posts = new THREE.InstancedMesh(postGeo, postMat, total);
    const m = new THREE.Matrix4();
    positions.forEach(([x, z], i) => posts.setMatrixAt(i, m.makeTranslation(x, 0.95, z)));
    posts.instanceMatrix.needsUpdate = true;
    this.siteEnv.add(posts);

    const meshMat = new THREE.MeshStandardMaterial({
      color: 0xcdd3d8,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.5, metalness: 0.4 });
    for (const run of runs) {
      const dx = run.to[0] - run.from[0];
      const dz = run.to[1] - run.from[1];
      const len = Math.hypot(dx, dz);
      const angle = Math.atan2(dz, dx);
      const midX = (run.from[0] + run.to[0]) / 2;
      const midZ = (run.from[1] + run.to[1]) / 2;
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(len, 1.6), meshMat);
      strip.position.set(midX, 0.95, midZ);
      strip.rotation.y = -angle;
      this.siteEnv.add(strip);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.05), railMat);
      rail.position.set(midX, 1.82, midZ);
      rail.rotation.y = -angle;
      this.siteEnv.add(rail);
    }
  }

  #onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** 현장 점들을 화면에 맞춰 카메라와 OrbitControls 중심을 조정한다. */
  framePoints(points = []) {
    if (!points.length) return;
    const xs = points.map((p) => p[0]);
    const zs = points.map((p) => p.length === 3 ? p[2] : p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(30, maxX - minX, maxZ - minZ);
    this.controls.target.set(cx, Math.min(15, span * 0.12), cz);
    this.camera.position.set(cx + span * 0.72, span * 0.62, cz + span * 0.72);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  /** 캔버스 더블클릭 지점을 지면(y=0)의 [x,z] 좌표로 전달한다. */
  onGroundDoubleClick(handler) {
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    this.renderer.domElement.addEventListener('dblclick', (event) => {
      const rect = this.renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, this.camera);
      if (raycaster.ray.intersectPlane(ground, hit)) handler([hit.x, hit.z]);
    });
  }
}
