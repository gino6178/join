import { useState, useRef, useEffect } from "react";
import * as THREE from "three"; // the renderer, the scene and the meshes
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
// 3D muscles + skeleton (BodyParts3D via Human Atlas). Muscles in a listed region take that region's colour;
// a click on a muscle selects its region. The model stands facing +Z, Y up, in metres. The model files and their
// attribution are in public/body/ (ATTRIBUTION.md).
const CREDIT = "https://dbarchive.biosciencedbc.jp/en/bodyparts3d/";
// --- the model ------------------------------------------------------------------------------------------------------
// body.json lists the parts (name, kind, region, vertex and index counts, and where each part's arrays start in
// body.bin); body.bin holds the positions (float32 xyz), normals (int16 xyz, normalised) and indices (uint16, or uint32
// for a part marked wide). It is fetched once a page load and shared; the progress is the share of body.bin received.
let modelOnce = null;
const loadModel = (onProgress) => (modelOnce ??= (async () => {
  const [meta, res] = await Promise.all([fetch("/body/body.json").then((r) => r.json()), fetch("/body/body.bin")]);
  if (!res.ok || !res.body) throw new Error(`body.bin: ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0, chunks = [];
  let got = 0;
  for (const reader = res.body.getReader(); ;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length; onProgress?.(total ? got / total : 0);
  } // (no length given: the bar waits at 0 until the model is in)
  const bytes = new Uint8Array(got);
  chunks.reduce((at, c) => (bytes.set(c, at), at + c.length), 0);
  return { meta, buffer: bytes.buffer };
})());
// one part's geometry, as typed views on the shared buffer (nothing is copied)
const geometryOf = ({ pos, nor, idx, n, m, wide }, buffer) => {
  const on = (Type, at, count) => new Type(buffer, at, count);
  return new THREE.BufferGeometry()
    .setAttribute("position", new THREE.BufferAttribute(on(Float32Array, pos, n * 3), 3))
    .setAttribute("normal", new THREE.BufferAttribute(on(Int16Array, nor, n * 3), 3, true))
    .setIndex(new THREE.BufferAttribute(on(wide ? Uint32Array : Uint16Array, idx, m), 1));
};
// --- colour ---------------------------------------------------------------------------------------------------------
// The muscles' resting grey, the two kinds of score (s: sore, the body log's own, in red; m, in blue) and the bones.
const SHADE = { rest: 0x4a4447, s: 0xff5a48, m: 0x5aaeff, bone: 0xe8e0d0 };
// A score's look: high glows in its full colour (more with a higher value), medium is a muted tint, low or none stays grey.
const lookOf = (score) => {
  const rest = new THREE.Color(SHADE.rest);
  if (!score || score.level === "low") return { c: rest, e: 0 };
  const hue = new THREE.Color(score.kind === "m" ? SHADE.m : SHADE.s);
  if (score.level !== "high") return { c: rest.lerp(hue, .38), e: .06 };
  return { c: rest.lerp(hue, .75 + .25 * score.v), e: .25 + .3 * score.v };
};
// a body-log marker: on the front of the body unless the region is on the back; at the top, bottom or middle of it
const BACK = new Set(["traps", "lowback", "glutes", "hams", "calves", "cuff", "lats", "triceps"]);
const MARK = (level) => (level >= 4 ? 0xff5a48 : level >= 3 ? 0xff8a3d : level >= 1 ? 0xf2c14e : 0x4fd18b);
const ANGLE = { front: 0, back: Math.PI, side: Math.PI / 2 }; // where the camera stands for each view
const SELECTED = 0xf2e6c9, THROB = 0xff5a48, THROB_SELECTED = 0xfff1d6;
// --- the scene ------------------------------------------------------------------------------------------------------
// The renderer (antialiased, see-through), a cool sky over a warm floor with a key light from the front right and a
// blue rim from behind on the left, a narrow camera, and an orbit that turns and zooms but does not pan.
function stage(canvas) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, canvas });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6), rim = new THREE.DirectionalLight(0x9fc8ff, 1.0);
  key.position.set(1.5, 2.5, 2.5); rim.position.set(-2, 1.5, -2.5);
  const scene = new THREE.Scene().add(new THREE.HemisphereLight(0xdfe9ff, 0x1a1210, 1.0), key, rim);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 20); // 28 degrees high; from 5 cm to 20 m
  const controls = Object.assign(new OrbitControls(camera, canvas), { enableDamping: true, enablePan: false, minDistance: .8, maxDistance: 5 });
  return { renderer, scene, camera, controls };
}
// Everything the canvas shows, set up once per Body3D. `api.current` is how the component hands it the latest props
// (scores, sel, onSel, pulse) and calls it back (paint, frame, mark); the function returned takes it all down.
function mount(canvas, api, { setProg, setReady, setErr }) {
  const my = api.current, { renderer, scene, camera, controls } = stage(canvas);
  const group = new THREE.Group(), muscles = [];
  scene.add(group);
  // how far the camera stands to see the whole body, head to feet, in this canvas's shape (with a margin)
  my.fit = () => {
    if (!my.size) return 3.1;
    const { x, y, z } = my.size, t = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), across = Math.max(x, z);
    return Math.max(y * .56 / t, across * .62 / (t * camera.aspect)) + across / 2;
  }; // fit
  const reach = (d) => { controls.maxDistance = Math.max(5, d * 1.6); };
  my.frame = (v) => {
    const d = my.fit(), a = ANGLE[v] ?? 0;
    reach(d);
    camera.position.set(Math.sin(a) * d, .05, Math.cos(a) * d);
    controls.update();
  }; // frame
  // a score keyed "region:side" colours that side only (the body log knows which knee)
  my.paint = (scores, sel) => muscles.forEach(({ userData: { region: r, side }, material }) => {
    const { c, e } = lookOf(scores[`${r}:${side}`] ?? scores[r]), picked = !!r && r === sel;
    material.color.copy(c);
    material.emissive.copy(picked ? new THREE.Color(SELECTED) : c);
    material.emissiveIntensity = picked ? .45 : e;
  }); // (the bones keep their own colour)
  let gone = false; // set when the component unmounts before the model arrives
  loadModel(setProg).then(({ meta, buffer }) => {
    if (gone) return;
    const boneMat = new THREE.MeshStandardMaterial({ color: SHADE.bone, roughness: .8, transparent: true, opacity: .55 }), bones = [];
    for (const p of meta.parts) {
      if (p.kind === "bone") { bones.push(new THREE.Mesh(geometryOf(p, buffer), boneMat)); continue; }
      const mesh = new THREE.Mesh(geometryOf(p, buffer), new THREE.MeshStandardMaterial({ color: SHADE.rest, roughness: .55, metalness: .05 }));
      mesh.userData = { region: p.region, name: p.name, side: /\bright\b/i.test(p.name) ? "right" : /\bleft\b/i.test(p.name) ? "left" : null };
      muscles.push(mesh);
    }
    group.add(...bones, ...muscles);
    // stand the body on the orbit's centre
    const box = new THREE.Box3().setFromObject(group);
    group.position.sub(box.getCenter(new THREE.Vector3()));
    controls.target.set(0, 0, 0);
    my.size = box.getSize(new THREE.Vector3());
    my.frame("front");
    setReady(true); // from here the props paint, mark and frame it
  }).catch(() => setErr("The 3D body could not be loaded (the anatomy model in /body/)."));
  // body-log markers: a dot on the spot and a ring that pulses, one per part and side
  const markGroup = new THREE.Group(); group.add(markGroup);
  const halos = [];
  api.current.mark = (list) => {
    markGroup.children.slice().forEach((o) => { markGroup.remove(o); o.geometry.dispose(); o.material.dispose(); });
    halos.length = 0;
    // a central part (the lower back) gets one marker in the middle; a sided one, one per side it hurts on
    for (const mk of list || []) for (const side of !mk.sided ? [null] : mk.side === "left" || mk.side === "right" ? [mk.side] : ["left", "right"]) {
      const ms = muscles.filter((m) => m.userData.region === mk.region && (side == null || m.userData.side === side));
      if (!ms.length) continue;
      const box = new THREE.Box3();
      ms.forEach((m) => { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox); });
      const c = box.getCenter(new THREE.Vector3()), back = BACK.has(mk.region);
      const y = mk.at === "top" ? box.max.y - .02 : mk.at === "bottom" ? box.min.y + .025 : c.y;
      const pos = new THREE.Vector3(c.x, y, back ? box.min.z - .012 : box.max.z + .012);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(.026, 20, 14), new THREE.MeshBasicMaterial({ color: MARK(mk.level) }));
      dot.position.copy(pos); markGroup.add(dot);
      const ring = new THREE.Mesh(new THREE.RingGeometry(.036, .047, 40), new THREE.MeshBasicMaterial({ color: MARK(mk.level), transparent: true, opacity: .8, side: THREE.DoubleSide, depthWrite: false }));
      ring.position.copy(pos); markGroup.add(ring); halos.push(ring);
    }
  };
  api.current.halos = (now) => halos.forEach((h, i) => {
    const k = (now / 1400 + i * .17) % 1;
    h.quaternion.copy(camera.quaternion); h.scale.setScalar(1 + k * 1.6); h.material.opacity = .85 * (1 - k);
  });
  // A click picks the region under the pointer; a drag (more than 5 px) only turns the body.
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), off = new AbortController();
  let pressedAt = null;
  canvas.addEventListener("pointerdown", (e) => { pressedAt = [e.clientX, e.clientY]; }, { signal: off.signal });
  canvas.addEventListener("pointerup", (e) => {
    if (!pressedAt || Math.hypot(e.clientX - pressedAt[0], e.clientY - pressedAt[1]) > 5) return;
    const box = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - box.left) / box.width) * 2 - 1, 1 - ((e.clientY - box.top) / box.height) * 2);
    ray.setFromCamera(ndc, camera);
    const region = ray.intersectObjects(muscles, false).find((h) => h.object.userData.region)?.object.userData.region;
    if (region) my.onSel?.(region);
  }, { signal: off.signal });
  // the drawing buffer follows the canvas's size, and the whole body stays in view when its shape changes
  const fitCanvas = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    if (my.size) { const d = my.fit(); reach(d); camera.position.setLength(d); controls.update(); }
  }; // fitCanvas
  const sizes = new ResizeObserver(fitCanvas);
  sizes.observe(canvas); fitCanvas(); // now, before the first frame, and on every change after
  // pulse: muscles in the listed regions throb, so the body log can point at them
  let throbbing = false;
  const pulseTick = (now) => { // every frame, from the loop below
    const set = my.pulse;
    if (set?.length) {
      throbbing = true;
      const k = .5 + .5 * Math.sin((now / 1000) * Math.PI * 2 * 1.1), lit = .15 + .85 * k;
      for (const m of muscles) if (set.includes(m.userData.region)) { m.material.emissive.set(m.userData.region === my.sel ? THROB_SELECTED : THROB); m.material.emissiveIntensity = lit; }
    } else if (throbbing) { throbbing = false; my.paint?.(my.scores || {}, my.sel); } // back to the scores' own colours
  }; // pulseTick
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let raf; const loop = (now) => { controls.update(); pulseTick(now || 0); if (!still) api.current.halos?.(now || 0); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop); // and on, a frame at a time, until the component goes
  return () => { // taken down: the loop stops and the GPU memory goes back
    gone = true;
    cancelAnimationFrame(raf); sizes.disconnect(); off.abort();
    group.traverse((o) => o.isMesh && (o.geometry.dispose(), o.material.dispose()));
    controls.dispose(); renderer.dispose();
  }; // the cleanup
} // mount
export default function Body3D({ scores, sel, onSel, view, pulse = null, height, marks = null }) {
  const canvasRef = useRef(null), api = useRef({});
  const [prog, setProg] = useState(0), [ready, setReady] = useState(false), [err, setErr] = useState("");
  useEffect(() => mount(canvasRef.current, api, { setProg, setReady, setErr }), []);
  // the latest props, for the scene's own callbacks; a change of scores or selection repaints at once
  useEffect(() => { Object.assign(api.current, { onSel, pulse }); }, [onSel, pulse]);
  useEffect(() => { Object.assign(api.current, { scores, sel }); if (ready) api.current.paint(scores, sel); }, [ready, scores, sel]);
  useEffect(() => { if (ready) api.current.mark(marks); }, [ready, marks]);
  useEffect(() => void (ready && api.current.frame(view)), [ready, view]);
  const loading = !ready && !err, size = height ? { height } : undefined;
  return <div className="body3d" style={size}>
    <canvas ref={canvasRef} aria-label="3D muscle model; click a muscle to see why it matters" />
    {loading && <div className="body3d-load"><span className="mono">Loading anatomy · {Math.round(prog * 100)}%</span><i style={{ transform: `scaleX(${prog})` }} /></div>}
    {err ? <div className="body3d-load err">{err}</div> : null}
    {ready && <p className="body3d-credit">Anatomy: <a href={CREDIT} target="_blank" rel="noreferrer">BodyParts3D</a>, © The Database Center for Life Science, CC BY 4.0, adapted</p>}
  </div>;
} // Body3D
