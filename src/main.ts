import * as THREE from 'three';
import { createRenderer } from './renderer';
import { initSunsetSky } from './sky-sunset';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 9 / 16, 0.1, 2000);
camera.position.set(0, 3.2, 9);
camera.lookAt(0, 1.2, -20);

initSunsetSky(scene);
scene.fog = new THREE.Fog('#c96a7a', 60, 700);

function resize(renderer: any) {
  const h = window.innerHeight;
  const w = Math.min(window.innerWidth, (h * 9) / 16);
  renderer.setSize(w, h, false);
  camera.aspect = 9 / 16;
  camera.updateProjectionMatrix();
}

async function boot() {
const { renderer, backend } = await createRenderer(canvas);
resize(renderer);
window.addEventListener('resize', () => resize(renderer));
(renderer as any).setAnimationLoop(() => {
  (renderer as any).render(scene, camera);
});
console.log('[porco] backend=', backend);
}
void boot();
