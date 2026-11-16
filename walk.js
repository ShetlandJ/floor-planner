// 3D first-person walk-through of the current plan. Loaded on demand from index.html.
// Plan units are centimetres (x right, y down). The scene is built in cm inside a root group
// scaled to metres, so three.js lighting values behave physically. Plan (x, y) -> 3D (x, up, z=y).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const WALL_H = 240, EYE = 160, RADIUS = 20, DOOR_H = 210, SILL = 90;
const PI = Math.PI;

let active = null;   // only one walk-through open at a time

export function openWalk(ctx){
  if (active) return;
  active = new Walk(ctx);
}

/* ---------------- materials ---------------- */
const matCache = new Map();
function mat(color, o = {}){
  const key = color + JSON.stringify(o);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({color, roughness:.85, metalness:0, ...o}));
  return matCache.get(key);
}
const C = {
  wall:'#f3f0ea', skirting:'#fbfaf7', ceiling:'#fbfaf8', ground:'#d8d3ca',
  oak:'#c8a27a', walnut:'#7a5a40', paint:'#f4f1ec', fabric:'#8c9a94', fabricDark:'#76847e',
  linen:'#fbf8f3', throw:'#b8a68f', headboard:'#a8a39a', kitchen:'#e4e9ec', worktop:'#3a3835',
  white:'#f7f7f5', steel:'#c4c8cb', black:'#1d1d1f', ceramic:'#fbfbfa', pot:'#b9704d', leaf:'#5f8a4e', rug:'#c9b79c',
};
const GLASS = () => mat('#dcebf2', {transparent:true, opacity:.18, roughness:.05, metalness:.1, depthWrite:false});

function woodTexture(){
  const cv = document.createElement('canvas'); cv.width = cv.height = 512;
  const g = cv.getContext('2d'), planks = 4, pw = 512/planks;
  let seed = 7; const rnd = () => (seed = (seed*16807) % 2147483647) / 2147483647;
  for (let i = 0; i < planks; i++){
    let y = -rnd()*300;
    while (y < 512){
      const len = 200 + rnd()*300, l = 60 + rnd()*7, hue = 30 + rnd()*5;
      g.fillStyle = `hsl(${hue} 38% ${l}%)`; g.fillRect(i*pw, y, pw, len);
      for (let k = 0; k < 14; k++){   // grain
        g.strokeStyle = `hsla(${hue} 35% ${l - 8 - rnd()*8}% / .35)`; g.lineWidth = .6 + rnd();
        const x = i*pw + rnd()*pw; g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + rnd()*6 - 3, y + len/3, x + rnd()*6 - 3, y + 2*len/3, x + rnd()*4 - 2, y + len); g.stroke();
      }
      g.fillStyle = 'rgba(60,40,25,.45)'; g.fillRect(i*pw, y, pw, 1.5);
      y += len;
    }
    g.fillStyle = 'rgba(60,40,25,.5)'; g.fillRect(i*pw, 0, 1.5, 512);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(1/80, 1/180);   // one tile = 80 cm across (four 20 cm planks) by 180 cm long
  return t;
}
function artTexture(seed){
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256;
  const g = cv.getContext('2d');
  let s = seed; const rnd = () => (s = (s*16807) % 2147483647) / 2147483647;
  const pal = [['#e9dfcf','#c8775a','#36505e','#d9b26f'], ['#eef0ea','#7f9c8b','#2e3b36','#c9a27a'], ['#f1e8dc','#a3b8c8','#3f5a73','#e2b4a0']][Math.floor(rnd()*3)];
  g.fillStyle = pal[0]; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5; i++){
    g.fillStyle = pal[1 + Math.floor(rnd()*3)]; g.globalAlpha = .75 + rnd()*.25;
    if (rnd() < .5){ g.beginPath(); g.arc(rnd()*256, rnd()*256, 20 + rnd()*70, 0, 2*PI); g.fill(); }
    else g.fillRect(rnd()*200, rnd()*200, 30 + rnd()*120, 20 + rnd()*90);
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* ---------------- geometry helpers (all in cm, local to a group) ---------------- */
function mesh(geo, m, shadow = true){ const o = new THREE.Mesh(geo, m); o.castShadow = shadow; o.receiveShadow = true; return o; }
// box with its bottom at y0, centred on (cx, cz)
function bx(g, w, h, d, cx, y0, cz, m, r = 0){
  w = Math.max(w, .3); h = Math.max(h, .3); d = Math.max(d, .3);
  const rr = Math.min(r, w/2 - .05, h/2 - .05, d/2 - .05);
  const o = mesh(rr > .2 ? new RoundedBoxGeometry(w, h, d, 2, rr) : new THREE.BoxGeometry(w, h, d), m);
  o.position.set(cx, y0 + h/2, cz); g.add(o); return o;
}
function cyl(g, rt, rb, h, cx, y0, cz, m, seg = 28, open = false){
  const o = mesh(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), m);
  o.position.set(cx, y0 + h/2, cz); g.add(o); return o;
}
function sphere(g, r, cx, cy, cz, m, detail = 1){
  const o = mesh(new THREE.IcosahedronGeometry(r, detail), m); o.position.set(cx, cy, cz); g.add(o); return o;
}
const hash = s => { let h = 9; for (const c of String(s)) h = (h*31 + c.charCodeAt(0)) % 2147483647; return h || 1; };

/* ---------------- furniture ---------------- */
// Real-world heights (cm). Labels refine the generic shapes, e.g. "Coffee table" vs "Dining table".
function spec(it){
  const L = (it.label || '').toLowerCase(), has = s => L.includes(s), m = Math.min(it.w, it.h);
  switch (it.shape){
    case 'bed': return {H:55};
    case 'wardrobe': return {H:200};
    case 'drawers': return {H:has('book') || has('shel') ? 180 : 90};
    case 'box': return {H:has('bedside') || has('night') ? 55 : has('tv') || has('media') ? 50 : 75};
    case 'sofa': case 'cornersofa': return {H:85};
    case 'table': return {H:has('coffee') || has('side') ? 45 : 75};
    case 'roundtable': return {H:has('coffee') ? 45 : 75};
    case 'chair': return {H:88};
    case 'tv': return {H:Math.round(it.w*.58), stack:true, wallElev:100};
    case 'rug': return {H:1.2};
    case 'kbase':
      if (has('fridge')) return {H:has('american') ? 178 : 185};
      if (has('tall') || has('larder')) return {H:210};
      if (has('boiler')) return {H:72, elev:140};
      return {H:90};
    case 'kwall': return {H:72, elev:145};
    case 'sink': case 'oven': return {H:90};
    case 'hob': return {H:90, stack:true};
    case 'washer': return {H:85};
    case 'bath': return {H:56};
    case 'shower': return {H:200};
    case 'toilet': return {H:78};
    case 'basin': return {H:85};
    case 'radiator': return has('towel') || it.w <= 60 ? {H:110, elev:15} : {H:60, elev:15};
    case 'plant': return m >= 40 ? {H:Math.round(m*2.4)} : {H:Math.round(m*1.4), stack:true};
    case 'lamp': return m >= 35 ? {H:160} : {H:45, stack:true};
    case 'coffee': return {H:36, stack:true};
    case 'vase': return {H:30, stack:true};
    case 'picture': return it.w <= 50 ? {H:Math.round(it.w*1.25), elev:140} : {H:Math.round(it.w*.7), elev:125};
    case 'mirror': return has('full') || has('length') ? {H:150, elev:20} : {H:Math.round(it.w*1.3), elev:105};
    case 'stairs': return {H:WALL_H};
    default: return {H:75};
  }
}
function inFootprint(p, o){
  const r = -o.rot*PI/180, dx = p.x - o.x, dy = p.y - o.y;
  const u = dx*Math.cos(r) - dy*Math.sin(r), v = dx*Math.sin(r) + dy*Math.cos(r);
  return Math.abs(u) <= o.w/2 && Math.abs(v) <= o.h/2;
}
// Builds one item in local space: width along x, depth along z (back at -d/2), floor at y=0.
function buildItem(it, s, lights){
  const g = new THREE.Group(), w = it.w, d = it.h, H = s.H, m = Math.min(w, d);
  const L = (it.label || '').toLowerCase(), has = x => L.includes(x);
  const legs = (h, inset, r, mm) => [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([sx, sz]) => cyl(g, r, r, h, sx*(w/2 - inset), 0, sz*(d/2 - inset), mm, 10));
  const worktop = (y = 86) => bx(g, w, 4, d + 1, 0, y, .5, mat(C.worktop, {roughness:.4}));
  const baseUnit = (front = C.kitchen) => {
    bx(g, w, 10, d - 6, 0, 0, -3, mat('#5b5955'));
    bx(g, w - .4, 76, d - 3, 0, 10, -1.5, mat(front, {roughness:.5}));
    bx(g, w - 8, 1.2, .6, 0, 72, d/2 - 2.6, mat('#9aa0a4', {metalness:.7, roughness:.3}));   // handle rail
  };
  switch (it.shape){
    case 'bed': {
      const ph = Math.min(28, d*.15), n = w >= 110 ? 2 : 1, pw = (w - 16 - (n - 1)*6)/n;
      bx(g, w, 28, d, 0, 0, 0, mat(C.oak), 2);
      bx(g, w - 4, 22, d - 8, 0, 28, 2, mat(C.linen), 5);
      bx(g, w - 1, 5, d*.62, 0, 46, d/2 - d*.31 + 1, mat(C.throw), 2.4);
      for (let i = 0; i < n; i++) bx(g, pw, 12, ph + 6, -w/2 + 8 + pw/2 + i*(pw + 6), 48, -d/2 + 10 + ph/2, mat('#ffffff'), 5);
      bx(g, w + 2, 110, 7, 0, 0, -d/2 + 3.5, mat(C.headboard, {roughness:.95}), 3);
      break;
    }
    case 'sofa': {
      const arm = Math.min(18, w*.18), back = Math.min(20, d*.25), F = mat(C.fabric, {roughness:.95}), Fd = mat(C.fabricDark, {roughness:.95});
      legs(8, 6, 2, mat(C.walnut));
      bx(g, w, 22, d, 0, 8, 0, Fd, 3);
      const n = Math.max(1, Math.round((w - 2*arm)/65)), cw = (w - 2*arm)/n;
      for (let i = 0; i < n; i++) bx(g, cw - 1, 15, d - back - 2, -w/2 + arm + cw*(i + .5), 30, back/2 + 1, F, 5);
      bx(g, w, 77, back, 0, 8, -d/2 + back/2, Fd, 5);
      if (w - 2*arm > 30) for (let i = 0; i < n; i++) bx(g, cw - 3, 38, 12, -w/2 + arm + cw*(i + .5), 44, -d/2 + back + 5, F, 5);
      bx(g, arm, 54, d, -w/2 + arm/2, 8, 0, Fd, 5); bx(g, arm, 54, d, w/2 - arm/2, 8, 0, Fd, 5);
      break;
    }
    case 'cornersofa': {
      const dd = Math.min(90, w*.45, d*.5), back = 20, F = mat(C.fabric, {roughness:.95}), Fd = mat(C.fabricDark, {roughness:.95});
      bx(g, w, 30, dd, 0, 0, -d/2 + dd/2, Fd, 3); bx(g, dd, 30, d - dd, -w/2 + dd/2, 0, -d/2 + dd + (d - dd)/2, Fd, 3);
      bx(g, w - back - 18, 15, dd - back, -w/2 + back + (w - back - 18)/2, 30, -d/2 + back + (dd - back)/2, F, 5);
      bx(g, dd - back, 15, d - dd - 18, -w/2 + back + (dd - back)/2, 30, -d/2 + dd + (d - dd - 18)/2, F, 5);
      bx(g, w, 85, back, 0, 0, -d/2 + back/2, Fd, 5); bx(g, back, 85, d, -w/2 + back/2, 0, 0, Fd, 5);
      bx(g, 18, 62, dd, w/2 - 9, 0, -d/2 + dd/2, Fd, 5); bx(g, dd, 62, 18, -w/2 + dd/2, 0, d/2 - 9, Fd, 5);
      break;
    }
    case 'table': {
      const W = mat(has('desk') ? C.walnut : C.oak, {roughness:.6});
      bx(g, w, 3.5, d, 0, H - 3.5, 0, W, 1); legs(H - 3.5, 5, 2.4, W);
      break;
    }
    case 'roundtable': {
      if (has('chair')){   // office chair
        const F = mat('#3b3d3f', {roughness:.8}), r = m*.42;
        cyl(g, r, r*.9, 3, 0, 0, 0, mat('#2b2b2b', {metalness:.4}), 5);
        cyl(g, 2, 2, 40, 0, 3, 0, mat(C.steel, {metalness:.8, roughness:.3}));
        bx(g, r*1.8, 7, r*1.7, 0, 43, 0, F, 3); bx(g, r*1.7, 50, 6, 0, 52, -r*.85, F, 3);
        break;
      }
      const W = mat(C.oak, {roughness:.6});
      const top = cyl(g, w/2, w/2, 3.5, 0, H - 3.5, 0, W, 48); top.scale.z = d/w;
      cyl(g, 5, 6, H - 3.5, 0, 0, 0, W); const foot = cyl(g, m*.28, m*.3, 2.5, 0, 0, 0, W); foot.scale.z = d/w;
      break;
    }
    case 'chair': {
      const W = mat(C.oak, {roughness:.6});
      legs(44, 3, 1.6, W); bx(g, w - 2, 4, d - 2, 0, 44, 0, W, 1);
      bx(g, w - 4, 40, 3, 0, 48, -d/2 + 2.5, W, 1);
      break;
    }
    case 'wardrobe': {
      bx(g, w, H, d, 0, 0, 0, mat(C.paint, {roughness:.6}), .8);
      bx(g, .6, H - 8, .6, 0, 4, d/2, mat('#c9c4bc'));
      for (const sx of [-1, 1]) bx(g, 1.4, 22, 2, sx*3, H/2 - 11, d/2 + 1, mat(C.steel, {metalness:.8, roughness:.3}));
      break;
    }
    case 'drawers': {
      const W = mat(has('book') || has('shel') ? C.walnut : C.paint, {roughness:.6});
      if (H > 120){   // bookcase: open shelves with books
        bx(g, 2, H, d, -w/2 + 1, 0, 0, W); bx(g, 2, H, d, w/2 - 1, 0, 0, W); bx(g, w, H, 1.5, 0, 0, -d/2 + .75, W);
        let r = hash(it.id); const rnd = () => (r = (r*16807) % 2147483647)/2147483647;
        const cols = ['#8a3b2e','#2f4b5e','#c7a24a','#4e6b4a','#d9d0c1','#a5652f','#36302b'];
        for (let y = 0; y < H; y += 36){
          bx(g, w - 4, 2, d - 2, 0, y, .5, W);
          if (y + 36 > H) break;
          for (let x = -w/2 + 3; x < w/2 - 6;){
            const bw = 2 + rnd()*3, bh = 20 + rnd()*12;
            if (rnd() > .1) bx(g, bw, bh, d*.7, x + bw/2, y + 2, 0, mat(cols[Math.floor(rnd()*cols.length)]));
            x += bw + .3;
          }
        }
        bx(g, w, 2, d, 0, H - 2, 0, W);
      } else {
        bx(g, w, H, d, 0, 0, 0, W, .8);
        const n = 3;
        for (let i = 1; i < n; i++) bx(g, w - 2, .5, .4, 0, H*i/n, d/2, mat('#c9c4bc'));
        for (let i = 0; i < n; i++) bx(g, 14, 1.2, 1.8, 0, H*(i + .5)/n, d/2 + .9, mat(C.steel, {metalness:.8, roughness:.3}));
      }
      break;
    }
    case 'box': {
      bx(g, w, H, d, 0, 0, 0, mat(has('tv') ? C.walnut : C.paint, {roughness:.6}), .8);
      if (H < 100) bx(g, w*.4, 1.2, 1.6, 0, H - 10, d/2 + .8, mat(C.steel, {metalness:.8, roughness:.3}));
      break;
    }
    case 'tv': {
      const t = Math.max(2.5, Math.min(5, d*.5));
      if (s.onTop){ bx(g, w*.3, 1.5, Math.max(d, 18), 0, 0, 0, mat('#222')); bx(g, 4, 6, 3, 0, 1.5, 0, mat('#222')); }
      const scr = bx(g, w, H, t, 0, s.onTop ? 7 : 0, s.onTop ? 0 : -d/2 + t/2, mat(C.black, {roughness:.25, metalness:.2}), .5);
      scr.userData.noFloor = true;
      break;
    }
    case 'rug': {
      bx(g, w, 1, d, 0, 0, 0, mat(C.rug, {roughness:1}), 0);
      bx(g, w - 12, 1.2, d - 12, 0, 0, 0, mat('#ddd0bb', {roughness:1}), 0);
      break;
    }
    case 'kbase': {
      if (H > 150){   // fridge / tall unit
        const fridge = has('fridge');
        bx(g, w - .4, H, d - 2, 0, 0, -1, mat(fridge ? (has('american') ? C.steel : C.white) : C.kitchen, {roughness:fridge ? .35 : .5, metalness:has('american') ? .6 : 0}), .6);
        if (has('american')){ bx(g, .5, H - 4, .5, 0, 2, d/2 - 1.8, mat('#777')); for (const sx of [-1, 1]) bx(g, 2, 60, 3, sx*4, H/2 - 10, d/2, mat(C.steel, {metalness:.9, roughness:.25})); }
        else { bx(g, w - 2, .5, .5, 0, H*.62, d/2 - 1.8, mat('#888')); bx(g, 2, 35, 3, w/2 - 6, H*.62 + 10, d/2, mat(C.steel, {metalness:.9, roughness:.25})); bx(g, 2, 35, 3, w/2 - 6, H*.62 - 45, d/2, mat(C.steel, {metalness:.9, roughness:.25})); }
      } else if (s.elev > 0){   // boiler
        bx(g, w, H, d, 0, 0, 0, mat(C.white, {roughness:.4}), 2);
        bx(g, w*.5, 6, 1, 0, 8, d/2, mat('#333'));
      } else {
        baseUnit(has('dishwasher') ? C.white : C.kitchen); worktop();
        if (has('island')) bx(g, w, 4, d + 20, 0, 86, 0, mat(C.worktop, {roughness:.4}));
      }
      break;
    }
    case 'kwall': {
      bx(g, w - .4, H, d, 0, 0, 0, mat(C.kitchen, {roughness:.5}));
      bx(g, w - 8, 1.2, .6, 0, 2, d/2 + .3, mat('#9aa0a4', {metalness:.7, roughness:.3}));
      break;
    }
    case 'sink': {
      baseUnit(); worktop();
      const bw = Math.min(w*.5, 50), bh = d*.6, st = mat('#b9bec2', {metalness:.85, roughness:.25});
      bx(g, bw, .4, bh, -w/2 + 6 + bw/2, 90, -d/2 + d*.22 + bh/2, st);
      bx(g, bw - 4, .5, bh - 4, -w/2 + 6 + bw/2, 90, -d/2 + d*.22 + bh/2, mat('#6d7275', {metalness:.6, roughness:.3}));
      const tx = -w/2 + 6 + bw/2;
      cyl(g, 1.4, 1.6, 28, tx, 90, -d/2 + 6, st, 16);
      bx(g, 2.4, 2.4, 16, tx, 114, -d/2 + 13, st, .8);
      break;
    }
    case 'hob': {
      if (s.onTop){
        bx(g, w - 6, .8, d - 8, 0, 0, 0, mat(C.black, {roughness:.15, metalness:.3}));
        const n = w >= 90 ? 3 : 2;
        for (let i = 0; i < n; i++) for (let j = 0; j < 2; j++) cyl(g, Math.min(w/n, d/2)*.3, Math.min(w/n, d/2)*.3, .3, -w/2 + w*(i + .5)/n, .8, -d/2 + d*(j + .5)/2, mat('#3a3a3a', {roughness:.4}));
      } else {   // range cooker
        bx(g, w, 90, d, 0, 0, 0, mat('#ece6da', {roughness:.4}), 1);
        bx(g, w - 2, 2, d - 2, 0, 90, 0, mat(C.black, {roughness:.3}));
        bx(g, w*.42, 40, 1, -w*.24, 18, d/2, mat('#222', {roughness:.15})); bx(g, w*.42, 40, 1, w*.24, 18, d/2, mat('#222', {roughness:.15}));
        const n = w >= 90 ? 3 : 2;
        for (let i = 0; i < n; i++) for (let j = 0; j < 2; j++) cyl(g, Math.min(w/n, d/2)*.28, Math.min(w/n, d/2)*.28, 2, -w/2 + w*(i + .5)/n, 92, -d/2 + d*(j + .5)/2, mat('#333', {metalness:.5}));
      }
      break;
    }
    case 'oven': {
      baseUnit(); worktop();
      bx(g, w - 4, 58, 1, 0, 14, d/2 - 1, mat('#1f1f21', {roughness:.15}));
      bx(g, w - 14, 1.6, 3, 0, 66, d/2 + .5, mat(C.steel, {metalness:.9, roughness:.25}));
      break;
    }
    case 'washer': {
      bx(g, w - 1, H, d - 2, 0, 0, -1, mat(C.white, {roughness:.35}), 1.5);
      const door = cyl(g, m*.28, m*.28, 2, 0, 0, 0, mat('#3a4248', {roughness:.1, metalness:.3}), 36);
      door.rotation.x = PI/2; door.position.set(0, H*.45, d/2 - 1);
      const ring = cyl(g, m*.32, m*.32, 1.4, 0, 0, 0, mat(C.steel, {metalness:.8, roughness:.3}), 36);
      ring.rotation.x = PI/2; ring.position.set(0, H*.45, d/2 - 1.6);
      bx(g, w - 6, 8, .5, 0, H - 10, d/2 - 1.8, mat('#e2e2e0'));
      break;
    }
    case 'bath': {
      const ins = Math.min(7, m*.1);
      bx(g, w, H, d, 0, 0, 0, mat(C.ceramic, {roughness:.2}), 3);
      bx(g, w - 2*ins, .6, d - 2*ins, 0, H - .3, 0, mat('#dde8ec', {roughness:.15}), 0);
      const tx = w >= d ? -w/2 + 4 : 0, tz = w >= d ? 0 : -d/2 + 4;
      cyl(g, 1.5, 1.5, 14, tx, H, tz, mat(C.steel, {metalness:.9, roughness:.2}), 16);
      break;
    }
    case 'shower': {
      bx(g, w, 5, d, 0, 0, 0, mat(C.ceramic, {roughness:.25}), 1);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(w*.6, 195, 1), GLASS()); glass.position.set(w*.2, 5 + 97.5, d/2 - .5); g.add(glass);
      bx(g, w*.6, 2, 2, w*.2, 199, d/2 - .5, mat(C.steel, {metalness:.9, roughness:.2}));
      cyl(g, 1, 1, 195, 0, 5, -d/2 + 3, mat(C.steel, {metalness:.9, roughness:.2}), 12);
      const head = cyl(g, 10, 10, 1.5, 0, 198, -d/2 + 14, mat(C.steel, {metalness:.9, roughness:.2}), 24);
      bx(g, 2, 2, 12, 0, 199, -d/2 + 7, mat(C.steel, {metalness:.9, roughness:.2})); head.castShadow = false;
      break;
    }
    case 'toilet': {
      const ch = Math.min(18, d*.3), Cm = mat(C.ceramic, {roughness:.2});
      bx(g, w - 2, 40, ch, 0, 38, -d/2 + ch/2, Cm, 3);
      const bowl = cyl(g, w/2 - 2, w/2 - 6, 40, 0, 0, -d/2 + ch + (d - ch)/2 - 2, Cm, 32); bowl.scale.z = (d - ch)/(w - 4);
      const seat = cyl(g, w/2 - 1.5, w/2 - 1.5, 2.5, 0, 40, -d/2 + ch + (d - ch)/2 - 2, mat('#ffffff', {roughness:.3}), 32); seat.scale.z = (d - ch)/(w - 3);
      break;
    }
    case 'basin': {
      const Cm = mat(C.ceramic, {roughness:.2});
      if (has('vanity') || w >= 70){ bx(g, w, 70, d, 0, 0, 0, mat(C.paint, {roughness:.5}), .8); bx(g, w, 15, d, 0, 70, 0, Cm, 3); }
      else { cyl(g, 7, 9, 70, 0, 0, -d/2 + 14, Cm, 20); bx(g, w, 15, d, 0, 70, 0, Cm, 4); }
      const b = cyl(g, Math.min(w*.4, 24), Math.min(w*.4, 24), .6, 0, 85, d*.08, mat('#e3ecef', {roughness:.15}), 32); b.scale.z = (d*.64)/(2*Math.min(w*.4, 24));
      cyl(g, 1.2, 1.4, 14, 0, 85, -d/2 + 5, mat(C.steel, {metalness:.9, roughness:.2}), 14);
      break;
    }
    case 'radiator': {
      const Wm = mat(C.white, {roughness:.4});
      if (H > 90){ for (const sx of [-1, 1]) cyl(g, 1.6, 1.6, H, sx*(w/2 - 2), 0, 0, Wm, 12); for (let y = 6; y < H; y += 10) { const r = cyl(g, 1.1, 1.1, w - 4, 0, 0, 0, Wm, 10); r.rotation.z = PI/2; r.position.y = y; } }
      else { bx(g, w, H, Math.max(4, d*.5), 0, 0, 0, Wm, .8); for (let x = -w/2 + 4; x < w/2 - 2; x += 6) bx(g, 2, H - 2, Math.max(4, d*.5) + 1, x, 1, 0, Wm); }
      break;
    }
    case 'plant': {
      const ph = Math.min(40, H*.3), pr = m*.22;
      cyl(g, pr, pr*.75, ph, 0, 0, 0, mat(C.pot, {roughness:.8}), 20);
      let r = hash(it.id); const rnd = () => (r = (r*16807) % 2147483647)/2147483647;
      const Lm = mat(C.leaf, {roughness:.8, flatShading:true}), Lm2 = mat('#4f7a44', {roughness:.8, flatShading:true});
      if (H > 80) cyl(g, 1.2, 1.6, H*.6, 0, ph, 0, mat('#6b5440'), 8);
      const n = H > 80 ? 9 : 5;
      for (let i = 0; i < n; i++){
        const y = H > 80 ? ph + (H - ph)*(.35 + .65*rnd()) : ph + (H - ph)*(.3 + .5*rnd());
        const rad = m*(H > 80 ? .22 : .28)*(.7 + .5*rnd()), a = rnd()*2*PI, off = m*.18*rnd();
        sphere(g, rad, Math.cos(a)*off, y, Math.sin(a)*off, i % 2 ? Lm : Lm2, 0).rotation.set(rnd()*3, rnd()*3, 0);
      }
      break;
    }
    case 'lamp': {
      const B = mat('#3a3734', {metalness:.5, roughness:.4});
      const shadeM = new THREE.MeshStandardMaterial({color:'#f6ecd6', emissive:'#ffdca8', emissiveIntensity:.6, roughness:.9, side:THREE.DoubleSide});
      const sh = H > 100 ? 28 : 16, sr = H > 100 ? m*.38 : m*.42;
      cyl(g, H > 100 ? 13 : sr*.5, H > 100 ? 14 : sr*.6, H > 100 ? 2 : 10, 0, 0, 0, B, 24);
      cyl(g, .9, .9, H - sh*.6, 0, 0, 0, B, 10);
      const shade = cyl(g, sr*.7, sr, sh, 0, H - sh, 0, shadeM, 28, true); shade.castShadow = false;
      lights.push({x:0, y:H - sh*.5, z:0, power:H > 100 ? 1.6 : .8, group:g, lamp:true});
      break;
    }
    case 'coffee': {
      bx(g, w, H, d, 0, 0, 0, mat('#2d2c2b', {roughness:.4, metalness:.3}), 2);
      bx(g, w*.5, 1, d*.35, 0, 8, d/2 - d*.35/2, mat(C.steel, {metalness:.8, roughness:.3}));
      break;
    }
    case 'vase': {
      cyl(g, m*.3, m*.38, H*.7, 0, 0, 0, mat('#dfe8ec', {roughness:.15}), 20);
      const fl = ['#e2a3a3','#e6c97a','#f4f0e8','#d98f6f'];
      for (let i = 0; i < 5; i++){ const a = i*1.3; sphere(g, m*.16, Math.cos(a)*m*.15, H*.75 + (i % 3)*3, Math.sin(a)*m*.15, mat(fl[i % 4], {roughness:.9, flatShading:true}), 0); }
      break;
    }
    case 'picture': {
      const t = Math.max(2, Math.min(4, d));
      bx(g, w, H, t, 0, 0, -d/2 + t/2, mat('#3d3029', {roughness:.6}));
      const art = new THREE.Mesh(new THREE.PlaneGeometry(w - 8, H - 8), new THREE.MeshStandardMaterial({map:artTexture(hash(it.id)), roughness:.9}));
      art.position.set(0, H/2, -d/2 + t + .05); g.add(art);
      break;
    }
    case 'mirror': {
      const t = Math.max(2, Math.min(4, d));
      bx(g, w, H, t, 0, 0, -d/2 + t/2, mat('#b49a6a', {metalness:.6, roughness:.35}));
      const mir = new THREE.Mesh(new THREE.PlaneGeometry(w - 6, H - 6), new THREE.MeshStandardMaterial({color:'#ffffff', metalness:1, roughness:.03}));
      mir.position.set(0, H/2, -d/2 + t + .05); g.add(mir);
      break;
    }
    case 'stairs': {
      const vertical = d >= w, len = vertical ? d : w, n = Math.max(3, Math.round(len/25)), run = len/n, rise = H/n;
      const T = mat(C.oak, {roughness:.6}), R = mat(C.paint);
      for (let i = 0; i < n; i++){
        const h = rise*(i + 1);
        if (vertical){ bx(g, w, h - 3, run, 0, 0, d/2 - run*(i + .5), R); bx(g, w, 3, run + 2, 0, h - 3, d/2 - run*(i + .5) - 1, T); }
        else { bx(g, run, h - 3, d, -w/2 + run*(i + .5), 0, 0, R); bx(g, run + 2, 3, d, -w/2 + run*(i + .5) + 1, h - 3, 0, T); }
      }
      break;
    }
    default: bx(g, w, H, d, 0, 0, 0, mat(C.paint, {roughness:.6}), .8);
  }
  return g;
}

/* ---------------- the walk-through ---------------- */
class Walk {
  constructor(ctx){
    this.ctx = ctx;
    const doc = ctx.doc;
    this.keys = new Set();
    this.dirty = true;
    this.buildDOM();
    this.renderer = new THREE.WebGLRenderer({antialias:true});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.el.querySelector('.walk-stage').appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#cfdde6');
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), .04).texture;
    this.scene.environmentIntensity = .45;
    pm.dispose();
    this.camera = new THREE.PerspectiveCamera(72, 1, .05, 400);

    this.rects = [];   // collision rectangles, in cm
    this.build(doc);
    this.placeStart();
    this.bindEvents();
    this.resize();
    this.last = performance.now();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  buildDOM(){
    const el = document.createElement('div');
    el.className = 'walk';
    el.innerHTML = `
      <style>
        .walk{position:fixed;inset:0;z-index:50;background:#cfdde6;font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#23211e;user-select:none;-webkit-user-select:none}
        .walk-stage{position:absolute;inset:0;touch-action:none;cursor:grab}
        .walk-stage.dragging{cursor:grabbing}
        .walk-stage canvas{display:block}
        .walk-help{position:absolute;left:12px;top:12px;background:rgba(251,250,248,.92);border:1px solid #ddd8d0;border-radius:8px;padding:8px 11px;color:#6f6a63;max-width:calc(100vw - 180px)}
        .walk-help b{color:#23211e}
        .walk-close{position:absolute;right:12px;top:12px;background:#0f766e;color:#fff;border:1px solid #0f766e;border-radius:6px;padding:7px 12px;font:inherit;cursor:pointer}
        .walk-close:hover{background:#0c5f59}
        .walk-map{position:absolute;right:12px;bottom:12px;background:rgba(255,255,255,.93);border:1px solid #ddd8d0;border-radius:8px;cursor:crosshair;max-width:34vw;max-height:40vh}
        .walk-map svg{display:block}
        .walk-stick{position:absolute;width:110px;height:110px;margin:-55px 0 0 -55px;border-radius:50%;border:2px solid rgba(255,255,255,.8);background:rgba(15,118,110,.15);pointer-events:none;display:none}
        @media (max-width:700px){ .walk-help{font-size:12px} .walk-map{max-width:40vw} }
      </style>
      <div class="walk-stage"></div>
      <div class="walk-help"><b>Walk:</b> W A S D or arrow keys (Shift = faster) · <b>Look:</b> drag · <b>Jump:</b> click the map${matchMedia('(pointer:coarse)').matches ? '<br>Touch: drag the left side to walk, the right side to look' : ''}</div>
      <button class="walk-close">Back to plan (Esc)</button>
      <div class="walk-map"></div>
      <div class="walk-stick"></div>`;
    document.body.appendChild(el);
    this.el = el;
  }

  build(doc){
    const ctx = this.ctx, root = new THREE.Group();
    root.scale.setScalar(.01);   // cm -> m
    this.scene.add(root); this.root = root;
    const b = ctx.bounds() || {x0:0, y0:0, x1:400, y1:300};
    this.b = b;
    const cx = (b.x0 + b.x1)/2, cy = (b.y0 + b.y1)/2, span = Math.max(b.x1 - b.x0, b.y1 - b.y0, 300);

    // ground + room floors + ceilings
    const ground = mesh(new THREE.PlaneGeometry(span*6, span*6), mat(C.ground, {roughness:1}), false);
    ground.rotation.x = -PI/2; ground.position.set(cx, -1, cy); root.add(ground);
    const wood = woodTexture(); wood.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const floorM = new THREE.MeshStandardMaterial({map:wood, roughness:.55});
    this.rooms = ctx.findRooms();
    for (const r of this.rooms){
      const sh = new THREE.Shape(r.pts.map(p => new THREE.Vector2(p.x, -p.y)));
      const f = mesh(new THREE.ShapeGeometry(sh), floorM, false); f.rotation.x = -PI/2; f.position.y = .3; root.add(f);
      const cs = new THREE.Shape(r.pts.map(p => new THREE.Vector2(p.x, p.y)));
      const c = mesh(new THREE.ShapeGeometry(cs), mat(C.ceiling, {roughness:.95})); c.rotation.x = PI/2; c.position.y = WALL_H - .3; root.add(c);
    }

    // walls, cut around doors and windows
    const wallM = mat(C.wall, {roughness:.92}), skirtM = mat(C.skirting, {roughness:.5});
    for (const w of doc.walls){
      const L = ctx.wallLen(w); if (L < 1) continue;
      const d = ctx.wallDir(w), n = ctx.wallNormal(w), ang = Math.atan2(d.y, d.x);
      const ea = ctx.joinAt(w, w.a), eb = ctx.joinAt(w, w.b);
      const ops = doc.openings.filter(o => o.wallId === w.id).map(o => ({o, s0:Math.max(-ea, o.offset - o.width/2), s1:Math.min(L + eb, o.offset + o.width/2)})).sort((p, q) => p.s0 - q.s0);
      const piece = (s0, s1, y0, y1, skirt, collide) => {
        if (s1 - s0 < .2 || y1 - y0 < .2) return;
        const mid = (s0 + s1)/2, c = {x:w.a.x + d.x*mid, y:w.a.y + d.y*mid};
        const m = mesh(new THREE.BoxGeometry(s1 - s0, y1 - y0, w.t), wallM);
        m.position.set(c.x, (y0 + y1)/2, c.y); m.rotation.y = -ang; root.add(m);
        if (skirt){ const k = mesh(new THREE.BoxGeometry(s1 - s0, 10, w.t + 1.8), skirtM, false); k.position.set(c.x, 5, c.y); k.rotation.y = -ang; root.add(k); }
        if (collide) this.rects.push({c, d, hl:(s1 - s0)/2, ht:w.t/2});
      };
      let s = -ea;
      for (const {o, s0, s1} of ops){
        piece(s, s0, 0, WALL_H, true, true);
        const win = o.type === 'window', top = DOOR_H;
        piece(s0, s1, top, WALL_H, false, false);
        if (win){ piece(s0, s1, 0, SILL, true, true); }
        this.buildOpening(o, w, s0, s1, d, n, ang);
        s = Math.max(s, s1);
      }
      piece(s, L + eb, 0, WALL_H, true, true);
    }

    // furniture
    const specs = doc.items.map(it => ({it, s:spec(it)}));
    for (const x of specs) if (x.s.stack){
      let base = 0;
      for (const y of specs){
        if (y === x || y.s.stack || y.it.shape === 'rug' || y.it.shape === 'kwall' || y.s.elev) continue;
        if (inFootprint(x.it, y.it)) base = Math.max(base, y.s.H);
      }
      x.s.onTop = base > 0;
      x.s.elev = base > 0 ? base : (x.s.wallElev || 0);
    }
    const lights = [];
    for (const {it, s} of specs){
      const local = [];
      const g = buildItem(it, s, local);
      g.position.set(it.x, (s.elev || 0) + (it.shape === 'rug' ? .5 : 0), it.y);
      g.rotation.y = -it.rot*PI/180;
      root.add(g);
      local.forEach(l => lights.push({...l, g}));
    }

    // electrics
    this.buildElec(doc, root, lights);
    root.updateMatrixWorld(true);   // light positions below are read from the placed groups

    // lighting: a sun through the windows, soft sky fill, and warm ceiling lights in each room
    this.scene.add(new THREE.HemisphereLight('#f4f1ea', '#b8ad9e', .55));
    const sun = new THREE.DirectionalLight('#fff3e0', 2.6);
    const sd = new THREE.Vector3(-.55, .62, -.55).normalize(), R = span/100;
    sun.position.set(cx/100 + sd.x*R*2, sd.y*R*2, cy/100 + sd.z*R*2);
    sun.target.position.set(cx/100, 0, cy/100);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, {left:-R, right:R, top:R, bottom:-R, near:.1, far:R*5});
    sun.shadow.bias = -.0004; sun.shadow.normalBias = .02;
    this.scene.add(sun, sun.target);

    const ceilingLights = doc.elec.filter(e => !e.wall && (e.type === 'clight' || e.type === 'spot'));
    for (const r of this.rooms){
      if (!ceilingLights.some(e => ctx.pointInPoly(ctx.elecPos(e), r.pts))) lights.push({world:{x:r.c.x, y:WALL_H - 25, z:r.c.y}, power:5});
    }
    lights.sort((a, b) => b.power - a.power).slice(0, 12).forEach(l => {
      const pl = new THREE.PointLight('#ffe9cc', l.power, 0, 2);
      if (l.world) pl.position.set(l.world.x/100, l.world.y/100, l.world.z/100);
      else { const v = new THREE.Vector3(l.x, l.y, l.z); l.g.localToWorld(v); pl.position.copy(v); }
      this.scene.add(pl);
    });
  }

  buildOpening(o, w, s0, s1, d, n, ang){
    const g = new THREE.Group(), root = this.root;
    g.position.set(w.a.x + d.x*o.offset, 0, w.a.y + d.y*o.offset); g.rotation.y = -ang; root.add(g);
    // local: x along the wall, z along the wall normal (matches the 2D drawing's y)
    const hw = (s1 - s0)/2, t = w.t, frameM = mat('#fbfbf9', {roughness:.45});
    if (o.type === 'window'){
      const fw = 5, fd = Math.min(8, t);
      bx(g, o.width, fw, fd, 0, SILL, 0, frameM); bx(g, o.width, fw, fd, 0, DOOR_H - fw, 0, frameM);
      bx(g, fw, DOOR_H - SILL, fd, -hw + fw/2, SILL, 0, frameM); bx(g, fw, DOOR_H - SILL, fd, hw - fw/2, SILL, 0, frameM);
      const panes = o.width > 100 ? 2 : 1;
      if (panes === 2) bx(g, fw, DOOR_H - SILL, fd, 0, SILL, 0, frameM);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(o.width - 2*fw, DOOR_H - SILL - 2*fw, .8), GLASS());
      glass.position.set(0, (SILL + DOOR_H)/2, 0); g.add(glass);
      bx(g, o.width + 8, 2.5, t/2 + 4, 0, SILL - 2.5, (t/4 + 2)*(o.flipY ? -1 : 1), mat('#ffffff', {roughness:.4}));   // inside sill board
      return;
    }
    if (o.type === 'gap') return;
    // door linings
    const lw = 3;
    bx(g, lw, DOOR_H, t + 1, -hw + lw/2, 0, 0, frameM); bx(g, lw, DOOR_H, t + 1, hw - lw/2, 0, 0, frameM); bx(g, o.width, lw, t + 1, 0, DOOR_H - lw, 0, frameM);
    if (o.type === 'sliding'){
      const pw = o.width*.55, gm = GLASS();
      for (const [x, z] of [[-hw + pw/2, -t*.2], [-hw + pw/2 + 8, t*.2]]){   // both panels slid open to one side
        bx(g, pw, 4, 4, x, 0, z, mat('#3b3b3b')); bx(g, pw, 4, 4, x, DOOR_H - 8, z, mat('#3b3b3b'));
        bx(g, 4, DOOR_H - 4, 4, x - pw/2 + 2, 0, z, mat('#3b3b3b')); bx(g, 4, DOOR_H - 4, 4, x + pw/2 - 2, 0, z, mat('#3b3b3b'));
        const gl = new THREE.Mesh(new THREE.BoxGeometry(pw - 8, DOOR_H - 12, .8), gm); gl.position.set(x, DOOR_H/2 - 2, z); g.add(gl);
      }
      return;
    }
    // hinged leaves, drawn open at about 75° toward the swing side (like the 2D arc)
    const sy = o.flipY ? -1 : 1, open = 75*PI/180, leafM = mat('#ffffff', {roughness:.4}), handleM = mat(C.steel, {metalness:.9, roughness:.25});
    const leaf = (hx, toward, W) => {
      const dir = Math.sign(toward - hx);
      const lg = new THREE.Group(); lg.position.set(hx, 0, sy*t/2); g.add(lg);
      // rotate about the hinge: closed points along +-x, open swings toward +-z
      lg.rotation.y = -Math.atan2(sy*Math.sin(open), dir*Math.cos(open));
      bx(lg, W - 1, DOOR_H - 4, 4, (W - 1)/2, 1, 0, leafM);
      bx(lg, 12, 2, 2, W - 10, 100, 3, handleM); bx(lg, 12, 2, 2, W - 10, 100, -3, handleM);
    };
    if (o.type === 'door') o.flipX ? leaf(hw, -hw, o.width) : leaf(-hw, hw, o.width);
    else if (o.type === 'double'){ leaf(-hw, 0, hw); leaf(hw, 0, hw); }
  }

  buildElec(doc, root, lights){
    const ctx = this.ctx, plate = mat('#fbfbf9', {roughness:.35}), dark = mat('#4a4a4a');
    for (const e of doc.elec){
      const T = ctx.ELEC[e.type]; if (!T) continue;
      const p = ctx.elecPos(e), g = new THREE.Group();
      g.position.set(p.x, 0, p.y); g.rotation.y = -p.rot*PI/180; root.add(g);
      if (e.wall){
        // local x runs along the wall; +z is out of the wall face
        const h = e.height ?? T.h, wide = e.type === 'dsocket' || e.type === 'usb';
        if (e.type === 'wlight'){
          bx(g, 12, 18, 6, 0, h - 9, 3, new THREE.MeshStandardMaterial({color:'#f8eedc', emissive:'#ffd9a0', emissiveIntensity:.8}));
          lights.push({world:null, x:0, y:h, z:15, power:1.2, g});
          continue;
        }
        bx(g, wide ? 14.6 : 8.6, 8.6, 1, 0, h - 4.3, .5, plate);
        if (e.group === 'Lighting' || e.type.startsWith('switch') || e.type === 'dimmer') bx(g, 2.5, 3.5, .8, 0, h - 1.75, 1.2, plate);
        else if (e.type === 'thermo') bx(g, 5, 5, .6, 0, h - 2.5, 1.2, mat('#222'));
        else if (T.group === 'Power' && e.type !== 'cooker' && e.type !== 'spur') { const k = wide ? [-3.6, 3.6] : [0]; k.forEach(x => bx(g, 3, 2.6, .4, x, h - 1.3, 1.1, dark)); }
        else bx(g, 3, 3, .5, 0, h - 1.5, 1.1, dark);
      } else if (e.type === 'floor'){
        bx(g, 14, .6, 14, 0, .1, 0, mat(C.steel, {metalness:.7, roughness:.35}));
      } else {
        const y = WALL_H - .3;
        if (e.type === 'clight'){
          cyl(g, .4, .4, 40, 0, y - 40, 0, dark, 6);
          const shade = cyl(g, 6, 18, 18, 0, y - 58, 0, new THREE.MeshStandardMaterial({color:'#efe8dc', emissive:'#ffdcae', emissiveIntensity:.35, roughness:.6, side:THREE.DoubleSide}), 28, true);
          shade.castShadow = false;
          lights.push({x:0, y:y - 62, z:0, power:5, g});
        } else if (e.type === 'spot'){
          const s = cyl(g, 4.5, 4.5, .8, 0, y - .8, 0, new THREE.MeshStandardMaterial({color:'#fff', emissive:'#fff1d8', emissiveIntensity:1.5}), 20); s.castShadow = false;
          lights.push({x:0, y:y - 10, z:0, power:1.4, g});
        } else {
          cyl(g, e.type === 'fan' ? 10 : 6, e.type === 'fan' ? 10 : 6, 3, 0, y - 3, 0, plate, 20).castShadow = false;
        }
      }
    }
  }

  placeStart(){
    const ctx = this.ctx, v = ctx.view, here = {x:v.cx, y:v.cy};
    const rooms = [...this.rooms].sort((a, b) => b.area - a.area);
    const room = rooms.find(r => ctx.pointInPoly(here, r.pts)) || rooms[0];
    const p = room ? room.c : {x:(this.b.x0 + this.b.x1)/2, y:(this.b.y0 + this.b.y1)/2};
    this.pos = {x:p.x, y:p.y};
    // look along the room's longer side
    let yaw = -PI/2;
    if (room){ const xs = room.pts.map(q => q.x), ys = room.pts.map(q => q.y); if (Math.max(...xs) - Math.min(...xs) > Math.max(...ys) - Math.min(...ys)) yaw = 0; }
    this.yaw = yaw; this.pitch = -.05;
    this.collide();
    this.buildMap();
  }

  buildMap(){
    const b = this.b, m = 40, W = b.x1 - b.x0 + 2*m, H = b.y1 - b.y0 + 2*m;
    const width = Math.min(240, innerWidth*.34), px = width/W;
    const box = this.el.querySelector('.walk-map');
    box.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x0 - m} ${b.y0 - m} ${W} ${H}" width="${Math.round(width)}" height="${Math.round(H*px)}">${this.ctx.sceneSVG(px)}<g class="me"></g></svg>`;
    this.mapPx = px;
    this.mapSvg = box.querySelector('svg');
    this.updateMap();
  }
  updateMap(){
    const px = this.mapPx, r = 7/px, L = 26/px, a = .6, p = this.pos;
    const f = yaw => ({x:p.x + Math.cos(yaw)*L, y:p.y + Math.sin(yaw)*L});
    const l = f(this.yaw - a), rr = f(this.yaw + a);
    this.mapSvg.querySelector('.me').innerHTML =
      `<path d="M${p.x} ${p.y}L${l.x} ${l.y}A${L} ${L} 0 0 1 ${rr.x} ${rr.y}Z" fill="#0f766e" fill-opacity=".25"/>` +
      `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="#0f766e" stroke="#fff" stroke-width="${2/px}"/>`;
  }

  bindEvents(){
    const stage = this.el.querySelector('.walk-stage'), stick = this.el.querySelector('.walk-stick');
    this.onKeyDown = e => {
      if (e.metaKey || e.ctrlKey) return;   // leave browser shortcuts alone
      e.stopImmediatePropagation();          // keep the plan editor from seeing keys while walking
      if (e.key === 'Escape'){ e.preventDefault(); this.close(); return; }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (['w','a','s','d','q','e','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Shift',' '].includes(k)){ e.preventDefault(); this.keys.add(k); }
    };
    this.onKeyUp = e => { e.stopImmediatePropagation(); this.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); if (e.key === 'Shift') this.keys.delete('Shift'); };
    this.onBlur = () => this.keys.clear();
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
    this.onResize = () => { this.resize(); this.buildMap(); };
    window.addEventListener('resize', this.onResize);

    // drag to look (grab the view, like Street View); on touch, the left half is a walk stick
    this.ptrs = new Map(); this.move = {x:0, y:0};
    stage.addEventListener('pointerdown', e => {
      stage.setPointerCapture(e.pointerId);
      const touchWalk = e.pointerType === 'touch' && e.clientX < innerWidth/2;
      this.ptrs.set(e.pointerId, {x:e.clientX, y:e.clientY, sx:e.clientX, sy:e.clientY, walk:touchWalk});
      if (touchWalk){ stick.style.display = 'block'; stick.style.left = e.clientX + 'px'; stick.style.top = e.clientY + 'px'; }
      else stage.classList.add('dragging');
    });
    stage.addEventListener('pointermove', e => {
      const p = this.ptrs.get(e.pointerId); if (!p) return;
      if (p.walk){
        const dx = e.clientX - p.sx, dy = e.clientY - p.sy, k = 1/50;
        this.move = {x:Math.max(-1, Math.min(1, dx*k)), y:Math.max(-1, Math.min(1, -dy*k))};
      } else {
        const s = e.pointerType === 'touch' ? .006 : .0045;
        this.yaw -= (e.clientX - p.x)*s;
        this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch + (e.clientY - p.y)*s));
        this.dirty = true;
      }
      p.x = e.clientX; p.y = e.clientY;
    });
    const end = e => {
      const p = this.ptrs.get(e.pointerId); this.ptrs.delete(e.pointerId);
      if (p && p.walk){ this.move = {x:0, y:0}; stick.style.display = 'none'; }
      if (![...this.ptrs.values()].some(q => !q.walk)) stage.classList.remove('dragging');
    };
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
    stage.addEventListener('contextmenu', e => e.preventDefault());

    this.el.querySelector('.walk-close').addEventListener('click', () => this.close());
    this.el.querySelector('.walk-map').addEventListener('pointerdown', e => {
      const pt = this.mapSvg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const w = pt.matrixTransform(this.mapSvg.getScreenCTM().inverse());
      this.pos = {x:w.x, y:w.y}; this.collide(); this.dirty = true;
    });
  }

  resize(){
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h); this.camera.aspect = w/h;
    // keep about 70° of view across, so a portrait phone doesn't feel like looking through a slot
    this.camera.fov = w >= h ? 72 : Math.min(105, 2*Math.atan(Math.tan(35*PI/180)*h/w)*180/PI);
    this.camera.updateProjectionMatrix(); this.dirty = true;
  }

  // keep the player out of walls (and window sills); doorways are open
  collide(){
    for (let iter = 0; iter < 3; iter++) for (const r of this.rects){
      const n = {x:-r.d.y, y:r.d.x}, rel = {x:this.pos.x - r.c.x, y:this.pos.y - r.c.y};
      const u = rel.x*r.d.x + rel.y*r.d.y, v = rel.x*n.x + rel.y*n.y;
      const cu = Math.max(-r.hl, Math.min(r.hl, u)), cv = Math.max(-r.ht, Math.min(r.ht, v));
      let du = u - cu, dv = v - cv, dist = Math.hypot(du, dv);
      if (dist >= RADIUS) continue;
      if (dist < 1e-6){   // centre is inside the wall: push out the short way
        const pu = r.hl - Math.abs(u), pv = r.ht - Math.abs(v);
        if (pv < pu){ dv = Math.sign(v) || 1; du = 0; dist = 0; const k = r.ht - Math.abs(v) + RADIUS; this.pos.x += n.x*dv*k; this.pos.y += n.y*dv*k; }
        else { du = Math.sign(u) || 1; const k = r.hl - Math.abs(u) + RADIUS; this.pos.x += r.d.x*du*k; this.pos.y += r.d.y*du*k; }
        continue;
      }
      const k = (RADIUS - dist)/dist;
      this.pos.x += (r.d.x*du + n.x*dv)*k; this.pos.y += (r.d.y*du + n.y*dv)*k;
    }
  }

  loop(now){
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(.05, (now - this.last)/1000); this.last = now;
    const K = this.keys, run = K.has('Shift') ? 2.2 : 1;
    let f = 0, s = 0, turn = 0;
    if (K.has('w') || K.has('ArrowUp')) f += 1;
    if (K.has('s') || K.has('ArrowDown')) f -= 1;
    if (K.has('d') || K.has('e')) s += 1;
    if (K.has('a') || K.has('q')) s -= 1;
    if (K.has('ArrowRight')) turn += 1;
    if (K.has('ArrowLeft')) turn -= 1;
    f += this.move.y; s += this.move.x;
    if (turn){ this.yaw += turn*1.9*dt; this.dirty = true; }
    if (f || s){
      const sp = 140*run*dt, fx = Math.cos(this.yaw), fy = Math.sin(this.yaw);
      this.pos.x += (fx*f - fy*s)*sp; this.pos.y += (fy*f + fx*s)*sp;
      this.collide(); this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const cp = Math.cos(this.pitch);
    this.camera.position.set(this.pos.x/100, EYE/100, this.pos.y/100);
    this.camera.lookAt(this.pos.x/100 + Math.cos(this.yaw)*cp, EYE/100 + Math.sin(this.pitch), this.pos.y/100 + Math.sin(this.yaw)*cp);
    this.renderer.render(this.scene, this.camera);
    this.updateMap();
  }

  close(){
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('resize', this.onResize);
    const cached = new Set(matCache.values());
    this.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && !cached.has(o.material)){ if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
    this.scene.environment && this.scene.environment.dispose();
    this.renderer.dispose();
    this.el.remove();
    active = null;
  }
}
