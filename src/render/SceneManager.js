// 3층: 렌더/뷰 — 씬·카메라·조명·그리드 등 "그리기" 전담.
// 코어(core)/시뮬레이션(sim) 상태를 받아 표시만 하고, 상태를 변경하지 않는다.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class SceneManager {
  constructor(container) {
    this.container = container;

    // --- Renderer ---
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // --- Scene ---
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87a9c4); // 흐린 하늘색
    this.scene.fog = new THREE.Fog(0x87a9c4, 120, 400);

    // --- Camera ---
    this.camera = new THREE.PerspectiveCamera(
      55,
      container.clientWidth / container.clientHeight,
      0.1,
      1000,
    );
    this.camera.position.set(35, 25, 35);

    // --- Controls ---
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 8, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495; // 지면 아래로 못 내려감
    this.controls.minDistance = 5;
    this.controls.maxDistance = 250;

    this.#setupLights();
    this.#setupGround();

    window.addEventListener('resize', () => this.#onResize());
  }

  #setupLights() {
    const hemi = new THREE.HemisphereLight(0xdfeaf5, 0x54452e, 0.9);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(60, 90, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -80;
    sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80;
    sun.shadow.camera.bottom = -80;
    sun.shadow.camera.far = 250;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
  }

  #setupGround() {
    // 지면
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x8f8a7d, // 현장 흙바닥 톤
      roughness: 0.95,
      metalness: 0.0,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // 그리드 (10m 간격 굵은 선, 1m는 생략해 시야 확보)
    const grid = new THREE.GridHelper(200, 20, 0x445566, 0x667788);
    grid.material.opacity = 0.35;
    grid.material.transparent = true;
    grid.position.y = 0.01;
    this.scene.add(grid);

    // 원점 축 표시 (개발용)
    const axes = new THREE.AxesHelper(5);
    axes.position.y = 0.02;
    this.scene.add(axes);
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
