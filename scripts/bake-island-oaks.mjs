import * as T from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// All variants share a neutral daylight atlas; the flight shader adds time-of-day tint.
function bakeViews(trees, mask) {
  const cell = 128, views = 8, atlas = document.createElement('canvas');
  atlas.width = views * cell; atlas.height = 6 * cell;
  const ctx = atlas.getContext('2d');
  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(cell * 2, cell * 2, false);
  renderer.setClearColor(0, 0);
  const camera = new T.OrthographicCamera(-18, 18, 18, -18, .1, 90);
  const scene = new T.Scene(), center = new T.Vector3(0, 10, 0);
  const material = new T.MeshBasicMaterial({ vertexColors: true, alphaMap: new T.CanvasTexture(mask), alphaTest: .32, side: T.DoubleSide });
  const models = trees.children.filter(o => o.name.endsWith('_near'));
  models.forEach((model, index) => {
    const g = model.geometry.clone(), rgb = g.attributes.color, normals = g.attributes.normal;
    for (let j = 0; j < rgb.count; j++) {
      const y = normals.getY(j);
      const upper = T.MathUtils.smoothstep(y, -.18, .18), tip = T.MathUtils.smoothstep(y, .54, .8);
      rgb.setXYZ(j, rgb.getX(j) * (.44 + .48 * upper + .28 * tip), rgb.getY(j) * (.60 + .35 * upper + .16 * tip), rgb.getZ(j) * (.9 + .10 * upper - .12 * tip));
    }
    const mesh = new T.Mesh(g, material);
    scene.add(mesh);
    for (let band = 0; band < 2; band++) for (let v = 0; v < views; v++) {
      const a = v * Math.PI / 4, el = (band ? 48 : 12) * Math.PI / 180;
      camera.position.set(Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el)).multiplyScalar(45).add(center);
      camera.lookAt(center); renderer.render(scene, camera);
      ctx.drawImage(renderer.domElement, v * cell, (index * 2 + band) * cell, cell, cell);
    }
    scene.remove(mesh);
  });
  renderer.dispose();
  return atlas.toDataURL();
}

// Call in the browser through the project Vite server. upstream is the served directory
// of a local Just a Simple Tree checkout (see the asset note for the revision).
export async function bakeIslandOaks(upstream) {
  const base = new URL(upstream.replace(/\/?$/, '/'), location.href);
  const [{ oak }, { mulberry32 }] = await Promise.all(['oak.js', 'wood.js'].map(file =>
    import(/* @vite-ignore */ new URL(file, base).href)));
  const trees = new T.Group();
  const white = new T.MeshStandardMaterial({ vertexColors: true });
  const texture = await new T.TextureLoader().loadAsync(new URL('../assets/island-trees/oak-mask.png', import.meta.url).href);
  const atlas = texture.image;
  const records = [];
  for (const [id, seed, limbs, spread, size, skew] of [
    ['wide', 983, 4, .99, 10, -.03], ['lean', 7301, 3, .84, 10.4, .26], ['twin', 1522, 2, 1.02, 9.1, -.05]]) {

    const { geometry: wood, clumps } = oak.grow({
      seed, size, mainLimbs: limbs, spread,
      levels: 1, branches: 2, splitHeight: .30, splitScatter: .52, trunkHeight: 1.8,
      trunkThickness: .67, baseFlare: .18, crookedness: .20, clumpSize: 1.55, variety: .65,
      sides: 4, ringStep: 4, capRings: 0, thinnest: .25, smoothness: 1
    });
    const bark = new T.Color('#705545');
    const green = new T.Color(['#77a75d', '#739e5b', '#83ac60'][records.length]);
    const opaqueUV = [.014, .986];
    function surface(geo, color) {
      for (const k of Object.keys(geo.attributes)) if (!['position', 'normal'].includes(k)) geo.deleteAttribute(k);
      const n = geo.attributes.position.count;
      geo.setAttribute('color', new T.Float32BufferAttribute(Array.from({ length: n }, () => color.toArray()).flat(), 3));
      geo.setAttribute('uv', new T.Float32BufferAttribute(Array.from({ length: n }, () => opaqueUV).flat(), 2));
      return geo.index ? geo.toNonIndexed() : geo;
    }
    const parts = [surface(wood, bark)];
    const random = mulberry32(seed + 317);
    for (const { position: p, radius: r } of clumps) {
      const core = new T.OctahedronGeometry(1, 0);
      const pts = core.attributes.position;
      core.setAttribute('normal', pts.clone());
      const color = green.clone().multiplyScalar(.84 + .24 * random());
      surface(core, color);
      for (let j = 0; j < pts.count; j++) {
        const x = pts.getX(j), y = pts.getY(j), z = pts.getZ(j);
        core.attributes.color.setXYZ(j, color.r * (.76 + .23 * y), color.g * (.82 + .18 * y), color.b * (.9 + .1 * y));
        pts.setXYZ(j, p.x + x * r * .74, p.y + y * r * .60, p.z + z * r * .76);
      }
      parts.push(core);

      const phase = random() * Math.PI * 2;
      for (let i = 0; i < 7; i++) {
        const y = 1 - 2 * (i + .5) / 7, a = phase + i * 2.39996, h = Math.sqrt(1 - y * y);
        const normal = new T.Vector3(h * Math.cos(a), y, h * Math.sin(a));
        const card = surface(new T.PlaneGeometry(r * 2.15, r * 1.92), color);
        card.rotateZ(random() * 3);
        card.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, 1), normal));
        card.translate(p.x + r * .83 * normal.x, p.y + r * .69 * y, p.z + r * .83 * normal.z);
        const tile = i % 4;
        for (let j = 0; j < 6; j++) {
          const [u, v] = [[0, 1], [0, 0], [1, 1], [0, 0], [1, 0], [1, 1]][j];
          card.attributes.uv.setXY(j, ((tile % 2) + u) * .5, ((tile >> 1) + v) * .5);
          const pos = new T.Vector3().fromBufferAttribute(card.attributes.position, j);
          const n = pos.sub(p).normalize();
          card.attributes.normal.setXYZ(j, n.x, n.y, n.z);
          const t = .9 + .2 * n.y;
          card.attributes.color.setXYZ(j, color.r * t, color.g * t, color.b * t);
        }
        parts.push(card);
      }
    }
    const geometry = mergeGeometries(parts);
    const positions = geometry.attributes.position;
    for (let j = 0; j < positions.count; j++) positions.setX(j, positions.getX(j) + skew * positions.getY(j));
    const mesh = new T.Mesh(geometry, white);
    mesh.name = id + '_near'; trees.add(mesh);
    records.push([mesh.name, positions.count / 3]);
  }
  const glb = await new GLTFExporter().parseAsync(trees, { binary: true });
  return { glb, views: bakeViews(trees, atlas), records };
}
