/**
 * src/render/draw.js — Canvas 2D 렌더 (브라우저 전용)
 *
 * 정본 v1.4 구현 절:
 *   §1.1   논리 1280×720 · 아레나 {350,0,580,720} · 좌우 패널 350
 *   §1.2   아레나 오버레이 띠 (내용은 hud.js 가 그린다 — 레이어 1에서 호출)
 *   §7.1   불변식 4개 (I-1 테두리 = 적 전용 · I-2 색은 거짓말하지 않는다 · I-4 적 탄 불가림)
 *   §7.2   팔레트 = rules.palette 가 유일한 거처. ★ 이 파일에 색 리터럴이 없다
 *   §7.3   cbMode off / cvd / mono
 *   §7.4   적 탄 = 자홍 + 흰 스페큘러 코어 + 검은 하드 외곽선 2px + 불투명 + 레이어 9
 *   §7.5   기체 부착 3중 — 히트박스 코어 링(10) · 슬롯 스트립(6) · 상태 배지(6) · 림 오라(6)
 *   §7.6   적 = 중립 차콜 본체 + 속성색 외곽선 + 코어 글리프 + 림 라이트
 *   §7.8   픽업 = 무광·납작·외곽선 0·글로우 0 · ≤6px · 레이어 2
 *   §7.12.8 플레이어 탄의 밝은 코어 — coreRadiusRatio 0.45 · coreLightnessAdd 25 (L*)
 *   §9.10  절차적 도형 — 스프라이트 0바이트
 *   §10.1  렌더 보간은 **위치 lerp만**. 로직 금지
 *   §12.3  레이어 스택 (하 → 상)
 *
 * ★ core 는 이 파일을 모른다 (단방향). 이 파일은 world 를 **읽기만** 한다 (§9.1).
 */

import { drawArenaBands } from './hud.js';
import { recomputeEff } from '../core/state.js';   // §5.3 랜스 빔 기하 재구성용(즉발 무기 가시화)
import { wipeFrontY } from '../core/boss.js';        // §8.22 쓸어내기 앞선(판정과 같은 식)
import { TERRAIN_KINDS, TERRAIN_KIND_ELEMENT } from '../core/schema.mjs';   // §8.21 ② 지형 색 = 종의 속성

// ---------------------------------------------------------------------------
// 색 — sRGB ↔ CIE Lab. §7.12.8 의 「L*+25」와 §7.3 의 「채도 0」이 실제 수를 요구한다
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  const h = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

function rgbToHex(r, g, b) {
  const n = (clamp255(Math.round(r)) << 16) | (clamp255(Math.round(g)) << 8) | clamp255(Math.round(b));
  const s = n.toString(16);
  return `#${'000000'.slice(s.length)}${s}`;
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v) {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return c * 255;
}

const WHITE_X = 0.95047;
const WHITE_Z = 1.08883;
const LAB_EPS = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

function labF(t) { return t > LAB_EPS ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116; }
function labFInv(t) { const t3 = t * t * t; return t3 > LAB_EPS ? t3 : (116 * t - 16) / LAB_KAPPA; }

function hexToLab(hex) {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = srgbToLinear(r8);
  const g = srgbToLinear(g8);
  const b = srgbToLinear(b8);
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WHITE_X;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / WHITE_Z;
  const fx = labF(X);
  const fy = labF(Y);
  const fz = labF(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToHex(L, a, bb) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - bb / 200;
  const X = labFInv(fx) * WHITE_X;
  const Y = labFInv(fy);
  const Z = labFInv(fz) * WHITE_Z;
  const r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  const b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return rgbToHex(linearToSrgb(r), linearToSrgb(g), linearToSrgb(b));
}

/** §7.12.8 — 같은 hue 의 밝은 코어. L* 만 올린다 (a,b 불변 = hue·채도 보존) */
function lighten(hex, dL) {
  const [L, a, b] = hexToLab(hex);
  return labToHex(L + dL, a, b);
}

/** §7.3 mono — 「채도를 0으로」. Lab 의 a,b 를 0으로 두면 L* 사다리가 그대로 남는다 */
function desaturate(hex) {
  const [L] = hexToLab(hex);
  return labToHex(L, 0, 0);
}

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------
// 팔레트 해석 (§7.2 · §7.3)
// ---------------------------------------------------------------------------
/**
 * §7.3 — cbMode ∈ off / cvd / mono.
 *   off  : palette.element
 *   cvd  : palette.elementCvd + 글리프 ×1.5 + 적 외곽선 3px + 배경 명도 상한 0.22 + 라벨 강제
 *   mono : cvd 기저 + **palette 전체** 무채화 (element·threat·status·pickup·hud·enemyBody·… 전부)
 *
 * ★ 공장 기본값은 rules.visual.a11y.cbMode 다. 사용자 오버라이드(`opts.cbMode ?? …`, §9.4.3 · §14)는
 *   OPTIONS 화면(§14)의 소관이며 1주차 범위 밖이다 — 여기서는 공장 기본값만 읽는다.
 */
export function resolvePalette(rules) {
  const p = rules.palette;
  const mode = rules.visual.a11y.cbMode;
  if (mode !== 'off' && mode !== 'cvd' && mode !== 'mono') {
    throw new Error(`draw: 미지의 cbMode "${mode}" — 어휘 = off / cvd / mono (§7.3)`);
  }
  const cvd = mode !== 'off';
  const mono = mode === 'mono';
  const f = mono ? desaturate : (c) => c;

  const element = {};
  const src = cvd ? p.elementCvd : p.element;
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i += 1) element[keys[i]] = f(src[keys[i]]);

  return {
    mode,
    cvd,
    mono,
    element,
    /** §7.12.8 — 탄 코어. 비율(0.45)이라 H3 의 projRadius 클램프를 자동으로 상속한다 */
    elementCore: (() => {
      const out = {};
      const add = rules.visual.playerBullet.coreLightnessAdd;
      for (let i = 0; i < keys.length; i += 1) out[keys[i]] = f(lighten(src[keys[i]], add));
      return out;
    })(),
    threat: {
      enemyBullet: f(p.threat.enemyBullet),
      telegraph: f(p.threat.telegraph),
      bulletCore: f(p.threat.bulletCore),
      outline: f(p.threat.outline),
    },
    status: { band: f(p.status.band) },
    pickup: { xp: f(p.pickup.xp), trait: f(p.pickup.trait) },
    enemyBody: f(p.enemyBody),
    partDestroyed: f(p.partDestroyed),
    neutralGray: f(p.neutralGray),
    hud: {
      panelBg: f(p.hud.panelBg), panelRule: f(p.hud.panelRule),
      textPrimary: f(p.hud.textPrimary), textDim: f(p.hud.textDim), hpFill: f(p.hud.hpFill),
      accent: f(p.hud.accent),
      evolution: f(p.hud.evolution),   // ㊿-s 진화 카드 전용(보라) — 금(보상)·호박(상태이상)·자홍(위협)·속성색과 다른 채널. 적록 색각에선 물색과 가까워 칩 글자 「…진화」가 비색 단서다(§7.2)
    },
    bg: p.bg,
    /** §7.3 — 배경 명도 상한은 cvd/mono 에서 0.22 로 내려간다 */
    bgMaxLightness: cvd ? p.bg.cvdMaxLightness : p.bg.maxLightness,
    /** §7.3 — 글리프 크기 ×1.0 / ×1.5 */
    glyphScale: cvd ? 1.5 : 1.0,
    /** §7.6 · §7.3 — 적 외곽선 2px / 3px */
    enemyOutlinePx: cvd ? 3 : 2,
  };
}

// ---------------------------------------------------------------------------
// 속성 글리프 (§7.2 — ● 원 / ▲ 삼각(위) / ◆ 마름모 / ✚ 십자(사엽))
//   ★ 이 4실루엣이 색맹·mono 에서 속성의 **유일한** 채널이다 (§7.3). 형태를 바꾸면 그 보증이 깨진다.
// ---------------------------------------------------------------------------
/** §7.12 속성 글리프를 «현재 경로에 이어 붙인다»(beginPath 없음) — 같은 색 탄 수백 발을 한 번의 fill 로 그리는 배치용(㉛). */
function glyphSub(ctx, element, x, y, r) {
  if (element === 'normal') {
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
    return;
  }
  if (element === 'fire') {                       // ▲ 정삼각(위)
    const h = r * 1.15;
    ctx.moveTo(x, y - h);
    ctx.lineTo(x + h * 0.866, y + h * 0.5);
    ctx.lineTo(x - h * 0.866, y + h * 0.5);
    ctx.closePath();
    return;
  }
  if (element === 'water') {                      // ◆ 마름모
    const h = r * 1.3;
    ctx.moveTo(x, y - h);
    ctx.lineTo(x + h * 0.72, y);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x - h * 0.72, y);
    ctx.closePath();
    return;
  }
  if (element === 'grass') {                      // ✚ 십자(사엽)
    const a = r * 1.15;
    const b = a * 0.36;
    ctx.moveTo(x - b, y - a); ctx.lineTo(x + b, y - a); ctx.lineTo(x + b, y - b);
    ctx.lineTo(x + a, y - b); ctx.lineTo(x + a, y + b); ctx.lineTo(x + b, y + b);
    ctx.lineTo(x + b, y + a); ctx.lineTo(x - b, y + a); ctx.lineTo(x - b, y + b);
    ctx.lineTo(x - a, y + b); ctx.lineTo(x - a, y - b); ctx.lineTo(x - b, y - b);
    ctx.closePath();
    return;
  }
  throw new Error(`draw: 글리프가 없는 속성 "${element}" (§7.2 — 어휘 4종)`);
}

/** 글리프 하나 = 새 경로. 단일 도형(픽업 아이콘 등)용. */
export function glyphPath(ctx, element, x, y, r) {
  ctx.beginPath();
  glyphSub(ctx, element, x, y, r);
}



// ---------------------------------------------------------------------------
// 적 본체 도형 (§9.10 — shapeId 12종 동결)
//   ★ 정본은 **어휘 12개를 동결**하고 각 도형의 **기하를 인쇄하지 않았다** → 보고 대상.
//     여기서는 "반경 r 안에 들어오는 실루엣"으로만 해석했다. 기하가 확정되면 이 함수만 바뀐다.
// ---------------------------------------------------------------------------
function poly(ctx, x, y, r, pts) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    const px = x + pts[i] * r;
    const py = y + pts[i + 1] * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * §7.12.4-② ✳ — 스턴/과열 정지의 «단 하나의» 글리프. 3선이 60° 간격으로 교차하는 별.
 *   ★ ㊿-ze3 — 세 곳(지형 장판 · 상태 배지 · 정지 예고)이 같은 고리를 따로 적고 있었다. 별의 «모양»이
 *   한 곳에서만 바뀌면 「예고와 실제가 같은 글리프」(§7.12.4)라는 약속이 소리 없이 깨진다.
 *   색·굵기는 부르는 쪽이 정한다(경고는 깜빡이고 배지는 안 깜빡인다).
 */
function strokeStar(ctx, cx, cy, r) {
  for (let i = 0; i < 3; i += 1) {
    const a = (i * Math.PI) / 3;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(a) * r, cy - Math.sin(a) * r);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }
}

/** 정다각형을 «현재 경로에 이어 붙인다»(배치용, ㉛). */
function regularSub(ctx, x, y, r, n, rot) {
  for (let i = 0; i < n; i += 1) {
    const a = rot + (i * Math.PI * 2) / n;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function regular(ctx, x, y, r, n, rot) {
  ctx.beginPath();
  for (let i = 0; i < n; i += 1) {
    const a = rot + (i * Math.PI * 2) / n;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function shapePath(ctx, shapeId, x, y, r) {
  switch (shapeId) {
    case 'wedge':  return poly(ctx, x, y, r, [0, 1, -0.9, -0.7, 0, -0.35, 0.9, -0.7]);
    case 'delta':  return poly(ctx, x, y, r, [0, 1, -0.85, -0.6, 0.85, -0.6]);
    case 'hexPod': return regular(ctx, x, y, r, 6, Math.PI / 6);
    case 'orb':    { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); return undefined; }
    case 'cross':  return poly(ctx, x, y, r, [-0.35, -1, 0.35, -1, 0.35, -0.35, 1, -0.35,
      1, 0.35, 0.35, 0.35, 0.35, 1, -0.35, 1, -0.35, 0.35, -1, 0.35, -1, -0.35, -0.35, -0.35]);
    case 'spike':  return poly(ctx, x, y, r, [0, 1, -0.45, 0, -0.2, 0, -0.2, -1, 0.2, -1, 0.2, 0, 0.45, 0]);
    case 'ring':   { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.arc(x, y, r * 0.55, 0, Math.PI * 2, true); return undefined; }
    case 'slab':   return poly(ctx, x, y, r, [-1, -0.55, 1, -0.55, 1, 0.55, -1, 0.55]);
    case 'fin':    return poly(ctx, x, y, r, [0, 1, -0.3, -1, 0.95, -0.15]);
    case 'claw':   return poly(ctx, x, y, r, [-0.9, -0.8, -0.25, 0.2, 0, 1, 0.25, 0.2, 0.9, -0.8, 0, -0.15]);
    case 'dart':   return poly(ctx, x, y, r, [0, 1, -0.5, -0.9, 0, -0.5, 0.5, -0.9]);
    case 'bulb':   { ctx.beginPath(); ctx.ellipse(x, y, r * 0.78, r, 0, 0, Math.PI * 2); return undefined; }
    default:
      throw new Error(`draw: 어휘 밖의 shapeId "${shapeId}" (§9.10 — 12종 동결)`);
  }
}

// ---------------------------------------------------------------------------
// 보간 (§10.1 — 위치 lerp만. 렌더가 소유하는 상태이며 world 를 건드리지 않는다)
// ---------------------------------------------------------------------------
function makeTrack(size) {
  return { x: new Float64Array(size), y: new Float64Array(size), gen: new Int32Array(size).fill(-1) };
}

/**
 * ★ world 는 이전 위치를 모른다 (core 는 렌더를 모른다). 그러므로 보간에 필요한
 *   직전 틱 스냅샷은 **렌더가 자기 것으로** 들고 있는다. gen 이 다르면 그 슬롯은 재사용된
 *   다른 개체이므로 보간하지 않는다 (스폰 순간 화면을 가로지르는 유령 방지).
 */
export function makeInterp(world) {
  const caps = world.data.rules.caps;
  return {
    enabled: world.data.rules.loop.interpolate,
    tick: -1,
    player: { x: world.player.x, y: world.player.y },
    enemies: makeTrack(caps.enemies),
    playerBullets: makeTrack(caps.playerBullets),
    enemyBullets: makeTrack(caps.enemyBullets),
    pickups: makeTrack(caps.pickups),
    drones: makeTrack(caps.drones),
  };
}

function captureTrack(track, pool) {
  const items = pool.items;
  for (let i = 0; i < items.length; i += 1) {
    const e = items[i];
    if (!e.alive) { track.gen[i] = -1; continue; }
    track.x[i] = e.x;
    track.y[i] = e.y;
    track.gen[i] = e.gen;
  }
}

/** ★ main.js 가 step() **직전**에 부른다 → track 은 언제나 "직전 틱의 위치"다 */
export function captureInterp(interp, world) {
  interp.player.x = world.player.x;
  interp.player.y = world.player.y;
  captureTrack(interp.enemies, world.enemies);
  captureTrack(interp.playerBullets, world.playerBullets);
  captureTrack(interp.enemyBullets, world.enemyBullets);
  captureTrack(interp.pickups, world.pickups);
  captureTrack(interp.drones, world.drones);
  interp.tick = world.tick;
}

function lerpX(interp, track, e, alpha) {
  if (!interp.enabled || track.gen[e.idx] !== e.gen) return e.x;
  return track.x[e.idx] + (e.x - track.x[e.idx]) * alpha;
}

function lerpY(interp, track, e, alpha) {
  if (!interp.enabled || track.gen[e.idx] !== e.gen) return e.y;
  return track.y[e.idx] + (e.y - track.y[e.idx]) * alpha;
}

// ---------------------------------------------------------------------------
// 렌더 상태 (순수 장식 — 결정성 무관, core 바깥, §10.1)
// ---------------------------------------------------------------------------
/** §7.7 — 히트 피드백 파티클 풀 (render 전용, 결정성 무관). 초과 = evictOldest(초과 정책 = particle) */
function makeHitPool(cap) {
  const buf = new Array(cap);
  for (let i = 0; i < cap; i += 1) {
    buf[i] = { active: false, tier: 'neutral', x: 0, y: 0, element: 'normal', age: 0, life: 0, killed: false, seed: 0 };
  }
  return { buf, cap, head: 0 };   // head = 다음 쓸 슬롯 → 링 덮어쓰기가 곧 evictOldest
}

/** §7.7 — tier 랭크(maxOnly 판정용). super > neutral > resist */
function tierRank(t) { return t === 'super' ? 2 : t === 'neutral' ? 1 : 0; }

export function makeFx(world) {
  const capE = world.data.rules.caps.enemies;
  return {
    stancePrev: world.player.stance,
    ringT: -1,          // §7.5 전환 링. 음수 = 비활성
    ringElement: 'normal',
    ringInvested: false,
    bgScroll: 0,
    // §7.7 — 히트 피드백 3중 감각. core 의 hitFx 링을 소진해 여기로 옮긴다(updateFx).
    hits: makeHitPool(world.data.rules.caps.particles),
    hitSeq: 0,                                    // 스파크 각도 분산용 결정적 카운터(무-RNG)
    // 개체(idx)별 상태 — gen 으로 풀 재사용 슬롯을 구분한다(다른 개체엔 안 샌다)
    freezeT: new Float64Array(capE),              // §7.7 ×2 임팩트 프리즈 잔여(게임초)
    freezeGen: new Int32Array(capE).fill(-1),
    resistT: new Float64Array(capE),              // §7.7 ×0.5 본체 회색 차폐 플래시 잔여(게임초)
    resistGen: new Int32Array(capE).fill(-1),
    markerT: new Float64Array(capE),              // §7.7 markerCooldownSecPerEntity 잔여
    markerGen: new Int32Array(capE).fill(-1),
    markerRank: new Int8Array(capE),              // 이 창에서 이미 보인 최고 tier(maxOnly)
  };
}

/**
 * ★ 렌더 전용 장식 갱신. **실제 경과 게임초**를 받는다 (배속을 그대로 탄다 = §6.2).
 *   판정에 아무 영향이 없으므로 결정성과 무관하다.
 */
export function updateFx(fx, world, dtGame) {
  const p = world.player;
  if (p.stance !== fx.stancePrev) {
    fx.stancePrev = p.stance;
    fx.ringT = 0;
    fx.ringElement = p.stance;
    // §7.5 — 투자 0인 속성으로의 전환은 **탈색 링**. 노말(Q)은 은색 정상 확장
    fx.ringInvested = p.stance === 'normal' ? true : p.invest[p.stance] > 0;
  }
  if (fx.ringT >= 0) {
    fx.ringT += dtGame;
    if (fx.ringT > world.data.rules.visual.stance.ringExpandSec) fx.ringT = -1;
  }
  const bg = world.data.rules.palette.bg;
  fx.bgScroll = (fx.bgScroll + bg.maxScrollSpeed * dtGame) % 4096;

  updateHitFx(fx, world, dtGame);
}

/**
 * §7.7 — core 의 히트 이벤트(이번 스텝분)를 소진해 3중 감각 파티클로 옮긴다.
 *   ★ main.js 가 **매 스텝 뒤** 부르므로 world.hitFx 는 언제나 「그 스텝의 히트」다(다음 step 진입 시 리셋).
 *   ★ 결정성 무관 — 여기 있는 어떤 값도 core 로 되돌아가지 않는다(순수 장식).
 *   dedup: markerPolicy "maxOnly" + markerCooldownSecPerEntity — 한 개체에 창(0.25s) 안에서는
 *     **더 높은 tier 만** 새로 그린다(4무기 동시타격의 버스트 스팸을 막고 「최고 배율 1개」를 남긴다).
 *     ★ 처치(killed)는 1회성이라 dedup 을 우회해 항상 처치 FX 를 보인다.
 */
function updateHitFx(fx, world, dtGame) {
  const vh = world.data.rules.visual.hitFx;
  // 개체별 타이머 감쇠(프리즈·마커 쿨다운) — 시간만 줄인다. gen 은 스폰 때만 쓴다
  for (let i = 0; i < fx.freezeT.length; i += 1) {
    if (fx.freezeT[i] > 0) { fx.freezeT[i] -= dtGame; if (fx.freezeT[i] < 0) fx.freezeT[i] = 0; }
    if (fx.resistT[i] > 0) { fx.resistT[i] -= dtGame; if (fx.resistT[i] < 0) fx.resistT[i] = 0; }
    if (fx.markerT[i] > 0) { fx.markerT[i] -= dtGame; if (fx.markerT[i] < 0) fx.markerT[i] = 0; }
  }
  // 파티클 수명
  const hb = fx.hits.buf;
  for (let i = 0; i < hb.length; i += 1) {
    const h = hb[i];
    if (h.active) { h.age += dtGame; if (h.age >= h.life) h.active = false; }
  }
  // 이번 스텝의 히트 이벤트 소진
  const src = world.hitFx;
  const cd = vh.markerCooldownSecPerEntity;
  for (let i = 0; i < src.count; i += 1) {
    const ev = src.buf[i];
    const idx = ev.enemyIdx;
    const rank = tierRank(ev.tier);
    const tracked = idx >= 0 && idx < fx.markerT.length;
    // maxOnly + 쿨다운: 창 안에서 같거나 낮은 tier 는 억제, 높은 tier 는 교체(처치는 우회)
    if (!ev.killed && tracked
        && fx.markerGen[idx] === ev.enemyGen && fx.markerT[idx] > 0 && rank <= fx.markerRank[idx]) {
      continue;
    }
    if (tracked) { fx.markerGen[idx] = ev.enemyGen; fx.markerT[idx] = cd; fx.markerRank[idx] = rank; }
    // ×2 임팩트 프리즈 — 살아있는 개체(idx,gen)에 묶는다. 죽은 적은 묶을 대상이 없다(처치 FX 로 간다)
    if (ev.tier === 'super' && !ev.killed && idx >= 0 && idx < fx.freezeT.length) {
      fx.freezeT[idx] = vh.superFreezeSec; fx.freezeGen[idx] = ev.enemyGen;
    }
    // ×0.5 차폐 플래시 — super 의 색 팝과 대비되는 무채색 본체 반응("맞았지만 안 통했다").
    //   프리즈와 같이 살아있는 개체(idx,gen)에 묶는다(죽은 적은 그릴 본체가 없다).
    if (ev.tier === 'resist' && !ev.killed && idx >= 0 && idx < fx.resistT.length) {
      fx.resistT[idx] = vh.resistArcLifeSec; fx.resistGen[idx] = ev.enemyGen;
    }
    spawnHit(fx, vh, ev);
  }
}

function spawnHit(fx, vh, ev) {
  const pool = fx.hits;
  const h = pool.buf[pool.head];
  pool.head = (pool.head + 1) % pool.cap;         // evictOldest = 링 덮어쓰기
  h.active = true;
  h.tier = ev.tier;
  h.x = ev.x; h.y = ev.y;
  h.element = ev.element;
  h.killed = ev.killed;
  h.age = 0;
  // 수명 = resistArcLifeSec(0.25) 를 세 tier 공통 페이드로 재사용한다 — 「얼마나」는 render 결정(새 키 0).
  h.life = vh.resistArcLifeSec;
  h.seed = fx.hitSeq; fx.hitSeq += 1;
}

// ---------------------------------------------------------------------------
// 레이어 0 — 배경 (§7.9 · §12.3: 채도 ≤0.25 / 명도 ≤ bgMaxLightness, **소프트 엣지만**)
//   ★ 테마 hue 는 stages.json 의 소관이고 1주차에는 스테이지가 없다 → 무채색 차콜 (보고 대상)
// ---------------------------------------------------------------------------
// §7.9 테마 hue (Lab a·b) — 스테이지 id 로 배경을 물들인다. v1.4 까지 «무채색 차콜 TODO»였다.
const THEME_AB = {
  sea: [-6, -26], glacier: [-12, -6], volcano: [34, 26],
  desert: [10, 34], forest: [-26, 22], bog: [-6, 16], finale: [22, 8],
};

function drawBackground(ctx, world, pal, fx) {
  const v = world.data.rules.view;
  const a = v.arena;
  const rid = world.run && world.run.order ? world.run.order[world.run.stageIndex] : null;
  const ab = THEME_AB[rid] || [0, 0];                        // 테마 없으면(타이틀 등) 무채색
  const base = labToHex(pal.bgMaxLightness * 100 * 0.45, ab[0] * 0.5, ab[1] * 0.5);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, v.logicalW, v.logicalH);

  ctx.save();
  ctx.beginPath();
  ctx.rect(a.x, a.y, a.w, a.h);
  ctx.clip();

  // §7.9 — parallaxLayers 2, maxScrollSpeed 90. 소프트 엣지만 (하드 엣지 = 게임플레이 전용)
  const layers = world.data.rules.palette.bg.parallaxLayers;
  for (let L = 0; L < layers; L += 1) {
    const depth = (L + 1) / layers;
    const step = 64 + L * 40;
    const speed = depth;
    const lum = pal.bgMaxLightness * 100 * (0.55 + 0.35 * depth);
    ctx.fillStyle = rgba(labToHex(lum, ab[0], ab[1]), 0.5);  // 테마 hue 로 물든 시차 레이어
    const off = (fx.bgScroll * speed) % step;
    for (let y = a.y - step + off; y < a.y + a.h + step; y += step) {
      for (let x = a.x; x < a.x + a.w; x += step) {
        const r = 1.2 + depth * 1.6;
        ctx.beginPath();
        ctx.arc(x + ((L * 23) % step), y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 레이어 1 — 지면 장판 · 지면 텔레그래프 (§12.3)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 레이어 1 — 지형 장판 (§8.21 · §7.13 v1.10 ⑮). «공격 장판»과 한눈에 갈리는 문법:
//   · 공격 장판(drawGroundZones) = 위협색(자홍) + 검은 외곽선 + 단단한 테두리 + 예고 링 → 「곧/지금 아프다」
//   · 지형 = 테마 속성색의 **부드러운 방사 그라데이션**(테두리 없음, 가장자리에서 0 으로 사라진다) + 가운데
//     **상태 아이콘** = 그 지형이 플레이어에게 주는 상태 배지와 같은 글리프(∿ 둔화 · ≋ 미끄러움 · ✳ 과열 정지, §7.12.4-②)
//   → 「테두리가 있으면 위협, 없으면 지형」 · 「아이콘 = 여기 서면 내게 붙는 배지」. 피해가 없으니 예고도 없다.
// ---------------------------------------------------------------------------
function terrainIcon(ctx, kind, x, y, px, t) {
  const h = px / 2;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  if (kind === 0) {                                     // ∿ 둔화 — 상태 배지와 같은 파형
    ctx.beginPath();
    for (let i = 0; i <= 16; i += 1) {
      const sx = x - h + (i / 16) * px;
      const sy = y + Math.sin((i / 16) * Math.PI * 2) * (px * 0.18);
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  } else if (kind === 1) {                              // ≋ 미끄러움 — 파형 두 줄(흘러가는 결)
    for (let row = -1; row <= 1; row += 2) {
      ctx.beginPath();
      for (let i = 0; i <= 16; i += 1) {
        const sx = x - h + (i / 16) * px;
        const sy = y + row * px * 0.16 + Math.sin((i / 16) * Math.PI * 2 + t * 2) * (px * 0.1);
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }
  } else {                                              // ✳ 과열 정지 — 스턴 배지와 같은 별
    strokeStar(ctx, x, y, h * 0.8);
  }
}

function drawTerrain(ctx, world, pal) {
  const it = world.terrain.items;
  if (world.terrain.live === 0) return;
  const vt = world.data.rules.visual.terrain;
  const fadeSec = world.data.rules.terrain.fadeSec;
  for (let i = 0; i < it.length; i += 1) {
    const t = it[i];
    if (!t.alive) continue;
    // §8.21 ② 색 = 종의 속성(TERRAIN_KIND_ELEMENT — 풀·물·불). 테마 스테이지는 테마색과 같고, finale(mixed)은 세 색이 같이 보인다.
    const col = pal.element[TERRAIN_KIND_ELEMENT[TERRAIN_KINDS[t.kind]]];
    // §8.21 ④ 사라지는 중 — 반지름과 알파가 같이 줄어든다(효과는 이미 꺼져 있다)
    const k = t.fadeT >= 0 ? Math.max(0, 1 - t.fadeT / fadeSec) : 1;
    const r = t.radius * k;
    if (r <= 0.5) continue;
    ctx.globalAlpha = k;
    // 부드러운 방사 채움 — 테두리가 없다(= 위협이 아니다)
    const g = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, r);
    g.addColorStop(0, rgba(col, vt.fillAlpha));
    g.addColorStop(0.72, rgba(col, vt.fillAlpha * 0.6));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, Math.PI * 2); ctx.fill();
    // 옅은 무늬 — 종의 «질감»(둔화 = 동심 물결 · 미끄러움 = 사선 결 · 과열 = 안에서 밖으로 맥동하는 열기 링)
    ctx.strokeStyle = rgba(col, vt.patternAlpha);
    ctx.lineWidth = 1.5;
    if (t.kind === 0) {
      for (let q = 1; q <= 2; q += 1) {
        // ★ 페이드 끝(r → 0)에서 물결 항(±2)이 반지름을 음수로 만들면 arc() 가 IndexSizeError 를 던진다 — 예외가 프레임을 중간에
        //   끊어 globalAlpha(=k≈0.02)·save 가 새고, 다음 프레임의 배경이 알파 0.02 로 칠해져 **모든 물체가 잔상**을 남겼다
        //   (플레이테스트 스크린샷: 숲 위기 진입 = 둔화 장판 페이드 순간). 0 으로 클램프한다(㊱).
        const rr = Math.max(0, r * (q / 3) + Math.sin(world.time * 1.2 + q) * 2);
        ctx.beginPath(); ctx.arc(t.x, t.y, rr, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (t.kind === 1) {
      ctx.save();
      ctx.beginPath(); ctx.arc(t.x, t.y, r * 0.92, 0, Math.PI * 2); ctx.clip();
      const step = 14;
      const off = (world.time * 24) % step;
      for (let d = -r * 2; d <= r * 2; d += step) {
        ctx.beginPath();
        ctx.moveTo(t.x + d + off - r, t.y - r);
        ctx.lineTo(t.x + d + off + r, t.y + r);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      const ph = (world.time * vt.heatPulseHz) % 1;
      for (let q = 0; q < 2; q += 1) {
        const f = (ph + q * 0.5) % 1;
        ctx.strokeStyle = rgba(col, vt.patternAlpha * 1.6 * (1 - f));
        ctx.beginPath(); ctx.arc(t.x, t.y, r * (0.3 + 0.62 * f), 0, Math.PI * 2); ctx.stroke();
      }
    }
    // 가운데 상태 아이콘 — 「여기 서면 이 배지가 붙는다」
    ctx.strokeStyle = rgba(col, vt.iconAlpha);
    const pulse = t.kind === 2 ? 1 + 0.12 * Math.sin(world.time * Math.PI * 2 * vt.heatPulseHz) : 1;
    terrainIcon(ctx, t.kind, t.x, t.y, vt.iconPx * pulse, world.time);
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// 레이어 9.5 — 보스 등장 쓸어내기 (§8.22 v1.10 ⑧). 앞선 위는 «닦인» 자리라 잠깐 밝고, 앞선 자체는 굵은 띠.
//   피해·위협이 아니라 «장면 전환»이므로 위협색이 아니라 텍스트/은색 채널을 쓴다. 판정과 같은 식(wipeFrontY).
// ---------------------------------------------------------------------------
function drawWipe(ctx, world, pal) {
  const run = world.run;
  if (run === undefined || run.wipeT < 0) return;
  const a = world.data.rules.view.arena;
  const vw = world.data.rules.visual.wipe;
  const sec = world.data.rules.boss.entryWipeSec;
  const y = wipeFrontY(world);
  const k = sec > 0 ? Math.min(1, run.wipeT / sec) : 1;
  const top = a.y;
  const h = Math.max(0, y - top);
  if (h > 0) {                                                 // 닦인 자리 — 앞선에서 위로 갈수록 옅어지는 섬광
    const g = ctx.createLinearGradient(0, top, 0, y);
    g.addColorStop(0, rgba(pal.hud.textPrimary, 0));
    g.addColorStop(1, rgba(pal.hud.textPrimary, vw.flashAlpha * (1 - k * 0.6)));
    ctx.fillStyle = g;
    ctx.fillRect(a.x, top, a.w, h);
  }
  ctx.fillStyle = rgba(pal.hud.textPrimary, 0.9);              // 앞선 띠
  ctx.fillRect(a.x, y - vw.bandPx / 2, a.w, vw.bandPx);
  ctx.fillStyle = rgba(pal.hud.textPrimary, 0.35);
  ctx.fillRect(a.x, y + vw.bandPx / 2, a.w, vw.bandPx * 0.6);
}

function drawGroundZones(ctx, world, pal) {
  const vz = world.data.rules.visual.zone;
  const items = world.zones.items;
  const strokePx = world.data.rules.visual.telegraph.strokePx;
  for (let i = 0; i < items.length; i += 1) {
    const z = items[i];
    if (!z.alive || z.fromPlayer) continue;                 // 플레이어 장판은 레이어 3
    // §8.5 mortar 퓨즈(예고, 무해) — 착탄 표적 링 + 수축 링(퓨즈 카운트다운, «곧 여기 터진다»)
    if (z.age < z.warnSec) {
      const frac = z.warnSec > 0 ? z.age / z.warnSec : 1;
      ctx.lineWidth = strokePx + 1;
      ctx.strokeStyle = pal.threat.outline;
      ctx.beginPath(); ctx.arc(z.x, z.y, z.radius, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = strokePx;
      ctx.strokeStyle = rgba(pal.threat.telegraph, 0.9);
      ctx.beginPath(); ctx.arc(z.x, z.y, z.radius, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = rgba(pal.threat.telegraph, 0.4 + 0.6 * frac);   // 착탄 순간 중심 수렴
      ctx.beginPath(); ctx.arc(z.x, z.y, z.radius * (1 - frac), 0, Math.PI * 2); ctx.stroke();
      continue;
    }
    const pulse = 0.5 + 0.5 * Math.sin(world.time * vz.pulseHz * Math.PI * 2);
    ctx.fillStyle = rgba(pal.threat.enemyBullet, vz.fillAlpha);
    ctx.beginPath();
    ctx.arc(z.x, z.y, z.radius, 0, Math.PI * 2);
    ctx.fill();
    // §12.3 — 활성 장판 = 외곽선 불투명 + 검은 외곽선 + 내부 0.30 + 1Hz 맥동
    ctx.lineWidth = strokePx + 2;
    ctx.strokeStyle = pal.threat.outline;
    ctx.stroke();
    ctx.lineWidth = strokePx;
    ctx.strokeStyle = rgba(pal.threat.enemyBullet, 0.7 + 0.3 * pulse);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// 레이어 2 — 픽업 (§7.8: 글로우·외곽선 **금지**, ≤6px, 무광·납작)
// ---------------------------------------------------------------------------
function drawPickups(ctx, world, pal, interp, alpha) {
  const items = world.pickups.items;
  for (let i = 0; i < items.length; i += 1) {
    const q = items[i];
    if (!q.alive) continue;
    const x = lerpX(interp, interp.pickups, q, alpha);
    const y = lerpY(interp, interp.pickups, q, alpha);
    if (q.kind === 'trait') {
      // §11.6(v1.10 ⑲) 특성 구슬 — 금색(pickup.trait = hud.accent 채널) 원 + 맥동하는 테두리 링. §7.8 의 «≤6px 납작»
      //   규칙은 XP 픽업의 것이고, 이 구슬은 판에 하나뿐인 «보상 그 자체»라 크게(반지름 9) 보인다.
      const pulse = 0.5 + 0.5 * Math.sin(world.time * Math.PI * 2 * 1.5);
      ctx.fillStyle = pal.pickup.trait;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = rgba(pal.pickup.trait, 0.35 + 0.45 * pulse);
      ctx.beginPath(); ctx.arc(x, y, 13 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = rgba(pal.threat.bulletCore, 0.9);
      ctx.beginPath(); ctx.arc(x - 3, y - 3, 2.5, 0, Math.PI * 2); ctx.fill();
      continue;
    }
    // v1.5 — 픽업 kind 는 xp (회복 픽업 폐지) · v1.10 ⑲ trait. 마름모, 값이 클수록 크게 (플레이테스트 #5b)
    ctx.fillStyle = pal.pickup.xp;
    const s = 2.2 + Math.min(q.value, 24) * 0.09;            // 1→2.3 · 6→2.7 · 12→3.3 · 병합24+→4.4
    glyphPath(ctx, 'water', x, y, s);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// 레이어 4 — 플레이어 탄 (§7.4: additive · 알파 ≤ playerBulletMaxAlpha · 외곽선 금지 · 속성 글리프)
// ---------------------------------------------------------------------------
/**
 * §7.4(v1.10 ㉖) 밀도 알파 — 플레이어 탄의 알파는 «무대의 탄 수»의 함수다: live ≤ densityRef 면 상한(0.80), 그 위로는
 *   상한 × densityRef / live 로 내려가되 minAlpha 아래로는 안 간다. 가산 합성(lighter)에서 탄이 200~500 발이면 겹친 자리가
 *   전부 흰색으로 포화돼 화면이 «백지»가 됐다(플레이테스트 Lv99 최종 스테이지 — 만렙 6무기 + 다중 장전이 탄 풀 256 을 채웠다).
 *   총 밝기 ≈ 일정(탄 수 × 알파 ≈ 상수)이 되어 «많이 쏘면 얇아진다». 순수 함수(테스트 가능).
 */
export function bulletDensityAlpha(r, live) {
  if (live <= r.playerBulletDensityRef) return r.playerBulletMaxAlpha;
  const a = r.playerBulletMaxAlpha * r.playerBulletDensityRef / live;
  return a < r.playerBulletMinAlpha ? r.playerBulletMinAlpha : a;
}

function drawPlayerBullets(ctx, world, pal, interp, alpha) {
  const r = world.data.rules.render;
  const vb = world.data.rules.visual.playerBullet;
  const items = world.playerBullets.items;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';                  // §7.4 — additive
  ctx.globalAlpha = bulletDensityAlpha(r, world.playerBullets.live);   // §7.4 · §12.3 — 0.80 상한, 밀도로 내려간다(㉖)
  // §12.3(v1.10 ㉛) 배치 — 탄 한 발마다 fill 하면 만렙 빌드에서 프레임당 fill 1,900회가 되어 GPU 플러시 스파이크(60~200ms)가
  //   났다(실측). 가산 합성은 순서 무관이므로 «속성별 한 경로 → fill 1회»로 묶는다: 4색 × 2패스(글리프·코어) = 최대 8회.
  const order = world.data.elements.order;
  for (let pass = 0; pass < 2; pass += 1) {
    const ratio = pass === 0 ? 1 : vb.coreRadiusRatio;
    for (let k = 0; k < order.length; k += 1) {
      const el = order[k];
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < items.length; i += 1) {
        const b = items[i];
        if (!b.alive) continue;
        // §4.4 · I-2 — live 각인(orbit·aura)은 슬롯의 **현재** 각인을 보여야 색이 거짓말하지 않는다
        const be = b.stampMode === 'live' ? world.slots[b.slot].stampElement : b.element;
        if (be !== el) continue;
        glyphSub(ctx, el, lerpX(interp, interp.playerBullets, b, alpha), lerpY(interp, interp.playerBullets, b, alpha), b.radius * ratio);
        any = true;
      }
      if (!any) continue;
      ctx.fillStyle = pass === 0 ? pal.element[el] : pal.elementCore[el];   // §7.12.8 — 같은 hue 의 밝은 코어. 외곽선 없음(I-1)
      ctx.fill();
    }
  }
  // ★ v1.10 ㊿-n — 이지스의 «방패 공»(orbit.place 가 s0=1 로 표시)에 링을 두른다.
  //   규칙이 「어느 공이 탄을 지우는가」인데 화면이 그걸 말하지 않으면 플레이어는 규칙을 못 배운다
  //   (사용자 2026-09-08: 「어떤 게 탄을 지운다는 건지 알기가 어려워」). 링 = «이 공이 방패다».
  let guard = false;
  ctx.beginPath();
  for (let i = 0; i < items.length; i += 1) {
    const b = items[i];
    // ★ ㊿-q — s0 는 무기마다 뜻이 다른 범용 스크래치다(핀볼·리턴·미사일·시커가 제각기 쓴다). 오빗의 공만 본다 —
    //   family 를 안 보면 다른 무기의 탄에도 방패 링이 붙는다(검토 실측: 오빗 없이 120프레임에 링 312개).
    if (!b.alive || b.family !== 'orbit' || b.s0 !== 1) continue;
    const gx = lerpX(interp, interp.playerBullets, b, alpha);
    const gy = lerpY(interp, interp.playerBullets, b, alpha);
    ctx.moveTo(gx + b.radius + 3, gy);
    ctx.arc(gx, gy, b.radius + 3, 0, Math.PI * 2);
    guard = true;
  }
  if (guard) { ctx.lineWidth = 2; ctx.strokeStyle = pal.hud.accent; ctx.stroke(); }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 레이어 5 — 적 기체 (§7.6: 중립 차콜 본체 + 속성색 외곽선 + 코어 글리프 + 림 라이트)
// ---------------------------------------------------------------------------
function drawEnemies(ctx, world, pal, fx, interp, alpha) {
  const vg = world.data.rules.visual.glyph;
  const el = world.data.rules.elite;
  const freezeScale = world.data.rules.visual.hitFx.superFreezeScale;   // §7.7 ×2 임팩트 프리즈
  const resistLife = world.data.rules.visual.hitFx.resistArcLifeSec;    // §7.7 ×0.5 차폐 플래시 수명
  const items = world.enemies.items;

  for (let i = 0; i < items.length; i += 1) {
    const e = items[i];
    if (!e.alive) continue;
    const x = lerpX(interp, interp.enemies, e, alpha);
    const y = lerpY(interp, interp.enemies, e, alpha);
    // ★ 모양은 개체가 들고 있다 — 보스 코어·파트는 archetypes 에 없다(archetypeId ''). 스캔도 사라진다
    if (e.shapeId === '') throw new Error(`draw: shapeId 없는 개체 (archetypeId "${e.archetypeId}", §9.7)`);
    const color = pal.element[e.element];
    ctx.globalAlpha = e.ghost ? 0.4 : 1;   // §8.9(v1.5) 유령몹 = 반투명(실체가 옅다). 루프 끝에서 1 복원.

    // §7.7 — ×2 히트의 0.04초 임팩트 프리즈: 개체(idx,gen)가 프리즈 중이면 본체를 ×superFreezeScale.
    //   ★ 게임 클럭·판정과 무관한 개체 단위 렌더 연출이다(§7.7 note). e.radius 는 원본 유지, r 만 스케일.
    const frozen = fx.freezeT[e.idx] > 0 && fx.freezeGen[e.idx] === e.gen;
    const r = frozen ? e.radius * freezeScale : e.radius;

    // 본체 — 속성별로 칠하지 않는다 (§7.6: 3층 분리의 근거)
    shapePath(ctx, e.shapeId, x, y, r);
    ctx.fillStyle = pal.enemyBody;
    ctx.fill();

    // §8.11 봉인 — «무채화»는 여기서, 기호·외곽선보다 «먼저». 봉인 부위는 무적일 뿐 계속 쏘므로
    //   판독 채널(기호·속성)을 덮으면 안 된다. 잠금은 흐림이 아니라 «자물쇠»가 말한다(아래).
    if (e.isBoss && e.sealedNow) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = pal.neutralGray;
      shapePath(ctx, e.shapeId, x, y, r);
      ctx.fill();
      ctx.restore();
    }

    // 림 라이트 — 진행 방향 **반대쪽**, 알파 0.35.
    //   ★ clip() 은 «현재 경로»로 자른다 — 공격 기호를 여기보다 먼저 그리면 기호 경로로 잘린다
    //     (v1.7 결함: straight 기호는 면적 0 이라 사격하는 잡몹의 림이 통째로 사라졌다).
    //     그래서 기호는 외곽선 «뒤»로 옮기고, 여기서는 본체 경로를 직접 재발행한다.
    const sp = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
    if (sp > 0) {
      ctx.save();
      shapePath(ctx, e.shapeId, x, y, r);
      ctx.clip();
      ctx.fillStyle = rgba(color, 0.35);
      ctx.beginPath();
      ctx.arc(x - (e.vx / sp) * r * 0.75, y - (e.vy / sp) * r * 0.75, r * 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 외곽선 — 속성색 2px (cvd 3px). 본체 크기 무관 항상
    ctx.lineWidth = pal.enemyOutlinePx;
    ctx.strokeStyle = color;
    shapePath(ctx, e.shapeId, x, y, r);
    ctx.stroke();

    // §8.11(v1.5·v1.8) 봉인된 파트 — 자물쇠 링. 무채화는 위(본체 직후)에서 이미 끝났다.
    if (e.isBoss && e.sealedNow) {
      ctx.save();
      ctx.strokeStyle = pal.neutralGray;
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // §7.7 — ×0.5 저항 피격: 본체를 짧게 **회색으로 차폐 플래시**("클렁크"). super 의 색 팝(프리즈+화이트-핫)과
    //   대비되는 무채색 반응 → "맞았지만 안 통했다". 색은 안 바꾼다(속성 외곽선은 이미 그렸다 = I-2 준수).
    //   회색은 neutralGray = §7.7 「튕겼다」의 단일 회색(팔레트 소유, §7.2). 발광 없음(방어는 둔하다).
    if (fx.resistT[e.idx] > 0 && fx.resistGen[e.idx] === e.gen) {
      const rt = Math.min(1, fx.resistT[e.idx] / resistLife);            // 1→0 페이드
      ctx.save();
      ctx.globalAlpha = rt;
      ctx.lineWidth = pal.enemyOutlinePx + 2;                            // 정상 외곽선보다 두껍게 = 튕겨냄
      ctx.strokeStyle = pal.neutralGray;
      shapePath(ctx, e.shapeId, x, y, r);
      ctx.stroke();
      ctx.restore();
    }

    // §7.6 엘리트 — 회전하는 이중 외곽선 + 개체 위 속성색 HP 바 + 상시 글리프
    if (e.elite) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(world.time * Math.PI * 0.5);
      ctx.lineWidth = pal.enemyOutlinePx;
      ctx.strokeStyle = rgba(color, 0.7);
      shapePath(ctx, e.shapeId, 0, 0, r * el.sizeMult * 0.82);
      ctx.stroke();
      ctx.restore();
      // ★ v1.8 — 엘리트 HP 바는 여기서 그리지 않는다. 아래 «단일 규격» 블록이 맡는다.
      //   규격이 두 자리에 흩어져 있던 것이 3종 두께(3/4/6px)를 낳은 기전이다.
    }

    // §7.6(v1.7) 개체 위 HP 바 — «내가 때리고 있는 그것»의 남은 체력은 그것에 붙어 있어야 읽힌다.
    //   대상: 중간보스 · 보스 부위(코어 제외). 코어만 상단 바가 맡는다 —
    //   코어는 「이 판을 끝내는 것」이라 화면 어디를 보고 있든 알아야 하는 유일한 값이다.
    //   ★ armor 부위는 §8.13 소프트게이트를 쥐고 있다(부수면 코어가 열린다). 바를 두껍게 +
    //     밑줄을 그어 「이건 그냥 부위가 아니다」를 말한다 — 상단 세그먼트 없이도 게이트가 읽힌다.
    //   ★ ㊷ 튜토리얼에서는 **모든 적**이 바를 단다 — 「잘하고 있는지 모르겠다」(사용자)에 대한 답이고,
    //     ×2 와 ×½ 의 차이가 «바가 줄어드는 속도»로 눈에 들어온다. 적이 몇 기뿐이라 §7.7 밀도 논거와 안 부딪는다.
    //   ★ ㊿-ze3 — 이 규격은 **여기 한 곳**이다. 튜토리얼 바는 hud.js 가 따로 그렸고, 거기엔 보간이 없어
    //     (drawTutorial 은 interp·alpha 를 안 받는다) 바가 스프라이트보다 한 틱 늦게 따라붙었다.
    //     여기로 옮기면 x·y 가 이미 보간된 값이라 지터가 사라지고 규격도 다시 하나가 된다.
    const ownBar = e.elite || e.midBossId !== '' || (e.isBoss && !e.isCore);
    if ((ownBar || (world.tut !== undefined && !e.isBoss)) && e.hpMax > 0) {
      const hb = world.data.rules.visual.hpBar;
      const bw = hb.wPx;                                     // ★ 폭은 radius 에서 파생되지 않는다
      const bx = x - bw / 2;
      const byy = y - e.radius - hb.gapPx - hb.hPx;          // 바는 UI — 프리즈 팝(r) 아닌 e.radius 앵커
      ctx.fillStyle = rgba(pal.threat.outline, hb.trackAlpha);
      ctx.fillRect(bx, byy, bw, hb.hPx);
      ctx.fillStyle = color;
      //   ★ 0~1 로 자른다 — 회복(흡혈·리젠)으로 hp 가 hpMax 를 넘으면 바가 궤도를 넘어 그려진다.
      const frac = Math.max(0, Math.min(1, e.hp / e.hpMax));
      ctx.fillRect(bx, byy, bw * frac, hb.hPx);
      // §8.13(v1.8) 소프트게이트 = 두께가 아니라 «형태». 좌우 은색 기둥.
      if (e.partType === 'armor') {
        ctx.fillStyle = pal.element.normal;
        const ph = hb.hPx + hb.gatePostOverhangPx * 2;
        ctx.fillRect(bx - hb.gatePostWPx, byy - hb.gatePostOverhangPx, hb.gatePostWPx, ph);
        ctx.fillRect(bx + bw, byy - hb.gatePostOverhangPx, hb.gatePostWPx, ph);
      }
    }

    // 코어 글리프 — max(6, bodyPx × bodyRatio), 상한 maxPx. cvd 는 ×1.5 + 항상 렌더
    const bodyPx = r * 2;
    if (e.elite || pal.cvd || bodyPx >= vg.lodMinBodyPx) {
      const g = Math.min(vg.maxPx, Math.max(6, bodyPx * vg.bodyRatio)) * 0.5 * pal.glyphScale;
      glyphPath(ctx, e.element, x, y, g);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;   // §8.9(v1.5) 유령몹 반투명 뒤 복원 (이후 레이어에 알파 누수 방지)
}

// ---------------------------------------------------------------------------
// 레이어 6 — 플레이어 기체 + 슬롯 스트립 + 상태 배지 + 림 오라 (§7.5)
// ---------------------------------------------------------------------------
function drawPlayer(ctx, world, pal, fx, interp, alpha) {
  const rp = world.data.rules.player;
  const vs = world.data.rules.visual.stance;
  const p = world.player;
  const x = interp.enabled ? interp.player.x + (p.x - interp.player.x) * alpha : p.x;
  const y = interp.enabled ? interp.player.y + (p.y - interp.player.y) * alpha : p.y;
  const stanceColor = pal.element[p.stance];

  ctx.save();
  // §2.4 — i-frame 깜빡임 8Hz, alpha 0.35 ↔ 1.0
  if (p.iframeSec > 0) {
    const ph = Math.sin(world.time * world.data.rules.visual.iframeBlinkHz * Math.PI * 2);
    ctx.globalAlpha = ph > 0 ? 1.0 : 0.35;
  }

  // §11.6(v1.10 ㉒) 쉴드 — 충전돼 있으면 기체 둘레에 금색(구슬과 같은 채널) 얇은 링. «지금 한 대는 공짜»가 보여야 조작 정보다.
  //   반지름은 스프라이트에서 파생(리터럴 아님) · 색은 palette.pickup.trait — 새 키 0.
  if (world.traitState.shieldReady) {
    ctx.strokeStyle = rgba(pal.pickup.trait, 0.85);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, rp.spriteRadius * 1.45, 0, Math.PI * 2); ctx.stroke();
  }

  // ④ 림 오라 — 현재 스탠스 색 소프트 글로우, 알파 0.40
  const grad = ctx.createRadialGradient(x, y, rp.spriteRadius * 0.4, x, y, rp.spriteRadius * 1.8);
  grad.addColorStop(0, rgba(stanceColor, vs.auraAlpha));
  grad.addColorStop(1, rgba(stanceColor, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, rp.spriteRadius * 1.8, 0, Math.PI * 2);
  ctx.fill();

  // 기체 본체 — ★ 정본에 플레이어 기체의 도형·색이 없다 (§9.10 은 적·보스만 확정) → 보고 대상.
  //   팔레트 어휘를 늘리지 않기 위해 §7.6 의 중립 차콜 본체 + 스탠스색 외곽선을 그대로 재사용했다.
  ctx.beginPath();
  ctx.moveTo(x, y - rp.spriteRadius);
  ctx.lineTo(x + rp.spriteRadius * 0.8, y + rp.spriteRadius * 0.75);
  ctx.lineTo(x, y + rp.spriteRadius * 0.35);
  ctx.lineTo(x - rp.spriteRadius * 0.8, y + rp.spriteRadius * 0.75);
  ctx.closePath();
  ctx.fillStyle = pal.enemyBody;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = stanceColor;
  ctx.stroke();

  // ② 슬롯 스트립 (임뷰 칩) — 기체 하단 +14px, 7px × N칸, 간격 2px. 좌→우 = 슬롯 1..N
  const n = world.slots.length;
  const w = n * vs.pipPx + (n - 1) * vs.pipGapPx;
  let sx = x - w / 2 + vs.pipPx / 2;
  const sy = y + vs.pipOffsetYPx;
  for (let i = 0; i < n; i += 1) {
    const s = world.slots[i];
    const r = vs.pipPx / 2;
    if (s.stampElement === 'normal') {
      // 부여 안 됨 = 은색 ● (I-2 — 실제로 ×1 이므로 속성색을 쓰면 화면이 거짓말한다)
      ctx.fillStyle = s.weaponId === null ? rgba(pal.element.normal, 0.25) : pal.element.normal;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = pal.element[s.stampElement];
      glyphPath(ctx, s.stampElement, sx, sy, r);
      ctx.fill();
    }
    sx += vs.pipPx + vs.pipGapPx;
  }

  // ③ 상태이상 배지 — 기체 위 −16px. ∿ 둔화 / ✳ 스턴 + 잔여 감소 바 12×2px (§7.12.4-② 호박)
  const st = p.stunSec > 0 ? 'stun' : p.slowSec > 0 ? 'slow' : null;
  if (st !== null) {
    const by = y - 16;
    ctx.strokeStyle = pal.status.band;
    ctx.lineWidth = 2;
    if (st === 'slow') {
      ctx.beginPath();
      for (let i = 0; i <= 12; i += 1) {
        const px = x - 6 + i;
        const py = by + Math.sin((i / 12) * Math.PI * 2) * 3;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    } else {
      strokeStar(ctx, x, by, 6);
    }
    const dur = st === 'stun' ? p.stunSec : p.slowSec;
    ctx.fillStyle = pal.status.band;
    ctx.fillRect(x - 6, by + 7, 12 * Math.min(1, dur), 2);
  }
  // §8.21(v1.10 ⑦·⑮) 과열 게이지 — 불 지형 안에서 차는 열. 기체 «둘레의 호»가 시계 방향으로 차오르고(호박 채널 §7.12.4-②),
  //   heatWarnAt(0.6) 부터는 굵어지며 4Hz 로 깜빡이고 ✳(정지 예고)가 기체 위에 뜬다 — 「오래 있으면 안 된다」가 몸에 보인다.
  //   0 이면 안 그린다(평소엔 없다). 다 차면 stallSec 스턴 → 위의 ✳ 배지가 이어받는다.
  if (p.heat > 0) {
    const vt2 = world.data.rules.visual.terrain;
    const warn = p.heat >= vt2.heatWarnAt;
    const blink = warn ? (Math.sin(world.time * Math.PI * 2 * 4) > 0 ? 1 : 0.45) : 1;
    const rr = rp.spriteRadius + 7;
    ctx.strokeStyle = rgba(pal.status.band, 0.25);
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = rgba(pal.status.band, blink);
    ctx.lineWidth = warn ? 5 : 3;
    ctx.beginPath(); ctx.arc(x, y, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, p.heat)); ctx.stroke();
    if (warn && st === null) {                             // 정지 예고 ✳ — 실제 스턴 배지와 같은 글리프, 깜빡임
      ctx.strokeStyle = rgba(pal.status.band, blink);
      ctx.lineWidth = 2;
      strokeStar(ctx, x, y - 16, 6);
    }
  }
  ctx.restore();

  // §7.5 전환 링 — 투자 있으면 속성색 정상 확장 / 투자 0이면 확장 중 회색으로 **탈색**
  if (fx.ringT >= 0) {
    const t = fx.ringT / vs.ringExpandSec;
    const from = pal.element[fx.ringElement];
    const to = fx.ringInvested ? from : pal.neutralGray;
    ctx.save();
    ctx.lineWidth = vs.ringStrokePx;
    ctx.strokeStyle = rgba(fx.ringInvested ? from : mix(from, to, t), 1 - t);
    ctx.beginPath();
    ctx.arc(x, y, vs.ringMaxRadiusPx * t, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  return { x, y };
}

function mix(a, b, t) {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

// ---------------------------------------------------------------------------
// 레이어 7 — 히트 피드백 3중 감각 (§7.7). ★ 적 탄(9)보다 **아래**에 그린다 → I-4 (탄 불가림) 보존.
//   ×2 (super)  : 공격 속성색 화이트-핫 코어 + 확장 버스트 링 + 스파크 3개 (발광). 처치면 흰 링 확장.
//   ×1 (neutral): 짧은 백색 플래시 + 스파크 1개. 처치면 소형 파열.
//   ×0.5(resist): **회색 방패**(두꺼운 호 + 바깥 겹판 + 양끝 프레임 틱 · sweep 160° · stroke 4px · 발광 아님)
//                 + 본체 회색 차폐 플래시(drawEnemies) + 스파크 0 → "튕겼다". ★ super 와 색·질감으로 대비.
//   ★ 색은 palette 가 소유(§7.2). 규격값(sweep·stroke·수명·스파크 수·프리즈)은 visual.hitFx 가 소유(§9.4.3).
// ---------------------------------------------------------------------------
const GOLDEN_ANGLE = 2.399963229728653;           // 스파크 각도 분산(무-RNG · 결정적)

function drawResistArc(ctx, pal, vh, h, t) {
  // 둔한 **회색 방패**. 아래(+y = 플레이어/입사탄 쪽)를 향해 살짝 바깥으로 밀린다 = 튕겨냄.
  //   두꺼운 주 호 + 바깥 겹판 + 양끝 프레임 틱 → 한 줄 곡선이 아니라 「판(plate)」으로 읽힌다.
  //   무채색·발광 없음(source-over) = super 의 밝은 속성색 발광과 색·질감 양쪽에서 대비(§7.7).
  const sweep = (vh.resistArcSweepDeg * Math.PI) / 180;
  const base = Math.PI / 2;
  const r = 15 + t * 8;                            // 살짝 바깥으로 확장 = 튕겨내는 밀어냄
  const a0 = base - sweep / 2;
  const a1 = base + sweep / 2;
  const sw = vh.resistArcStrokePx;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';    // 발광 금지 — 방어는 둔하다(§7.7)
  ctx.strokeStyle = pal.neutralGray;
  ctx.lineCap = 'round';

  // 주 방패 호 — 두꺼운 무채색 (stroke = resistArcStrokePx)
  ctx.globalAlpha = (1 - t) * 0.95;
  ctx.lineWidth = sw;
  ctx.beginPath();
  ctx.arc(h.x, h.y, r, a0, a1);
  ctx.stroke();

  // 바깥 겹판 — 얇게·낮은 알파. 「두 겹 방패판」의 깊이
  ctx.globalAlpha = (1 - t) * 0.5;
  ctx.lineWidth = sw > 2 ? sw - 2 : 1;
  ctx.beginPath();
  ctx.arc(h.x, h.y, r + sw + 1, a0, a1);
  ctx.stroke();

  // 양끝 프레임 틱 — 호가 「판」임을 못박는다(방패의 가장자리 프레임)
  ctx.globalAlpha = (1 - t) * 0.9;
  ctx.lineWidth = sw;
  const tick = sw + 3;
  for (let i = 0; i < 2; i += 1) {
    const a = i === 0 ? a0 : a1;
    const cx = h.x + Math.cos(a) * r;
    const cy = h.y + Math.sin(a) * r;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(a) * tick * 0.5, cy - Math.sin(a) * tick * 0.5);
    ctx.lineTo(cx + Math.cos(a) * tick * 0.5, cy + Math.sin(a) * tick * 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBurst(ctx, pal, vh, h, t) {
  const isSuper = h.tier === 'super';
  const color = isSuper ? pal.element[h.element] : pal.threat.bulletCore;  // neutral = 백색 플래시
  const nSpark = isSuper ? vh.particles.super : vh.particles.neutral;
  const fade = 1 - t;
  const baseR = isSuper ? 10 : 5;
  const grow = isSuper ? 22 : 9;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';        // 발광 = 플레이어 FX(I-1: 외곽선 없음)

  // 화이트-핫 코어 — §7.7 ×2 "속성색 화이트-핫 1프레임" (첫 ~1/6 구간만 강한 백색)
  const hot = 1 - t * 6;
  if (hot > 0) {
    ctx.globalAlpha = hot * (isSuper ? 0.95 : 0.6);
    ctx.fillStyle = pal.threat.bulletCore;
    ctx.beginPath();
    ctx.arc(h.x, h.y, isSuper ? 7 : 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // 확장 버스트 링 — 속성색(super) / 백색(neutral). 처치면 더 크게(대형 파열)
  const rr = baseR + t * grow * (h.killed ? 1.8 : 1);
  ctx.globalAlpha = fade * (isSuper ? 0.85 : 0.5);
  ctx.lineWidth = isSuper ? 3 : 1.5;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(h.x, h.y, rr, 0, Math.PI * 2);
  ctx.stroke();

  // 스파크 — 중심에서 방사. 각도는 seed 로 분산(결정적, 무-RNG)
  const sparkLen = (isSuper ? 14 : 8) * (0.4 + t);
  ctx.lineWidth = isSuper ? 2 : 1.5;
  ctx.strokeStyle = color;
  ctx.globalAlpha = fade * (isSuper ? 0.9 : 0.55);
  for (let k = 0; k < nSpark; k += 1) {
    const ang = h.seed * GOLDEN_ANGLE + (k * Math.PI * 2) / Math.max(1, nSpark);
    const cx = h.x + Math.cos(ang) * baseR;
    const cy = h.y + Math.sin(ang) * baseR;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * sparkLen, cy + Math.sin(ang) * sparkLen);
    ctx.stroke();
  }

  // 처치 FX — 흰 링 확장 (§7.7 처치: 속성색 대형 파열 + 흰 링)
  if (h.killed) {
    ctx.globalAlpha = fade * 0.8;
    ctx.lineWidth = 2;
    ctx.strokeStyle = pal.threat.bulletCore;
    ctx.beginPath();
    ctx.arc(h.x, h.y, baseR + t * grow * 2.4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHitFx(ctx, world, pal, fx) {
  const vh = world.data.rules.visual.hitFx;
  const hb = fx.hits.buf;
  for (let i = 0; i < hb.length; i += 1) {
    const h = hb[i];
    if (!h.active) continue;
    const t = h.life > 0 ? h.age / h.life : 1;     // 0→1 진행
    if (t >= 1) continue;
    if (h.tier === 'resist') drawResistArc(ctx, pal, vh, h, t);
    else drawBurst(ctx, pal, vh, h, t);            // super · neutral
  }
}

// ---------------------------------------------------------------------------
// 레이어 8 — 공중 텔레그래프 (§7.4: 자홍 점선 + 알파 0.50, 채움 금지)
// ---------------------------------------------------------------------------
function drawTelegraphs(ctx, world, pal) {
  const vt = world.data.rules.visual.telegraph;
  const items = world.telegraphs.items;
  const a = world.data.rules.view.arena;
  const beamLen = Math.sqrt(a.w * a.w + a.h * a.h);   // 아레나를 확실히 가로지르는 길이

  // (a) §8.5 · §7.4 laser — 2단으로 그린다:
  //     충전(age < warnSec) = **점선·반투명·폭 0→최종폭 보간**(경고, 무해) — 이 리드가 회피 시간이다.
  //     활성(age ≥ warnSec) = **실선·불투명**(검은 외곽선 + 자홍 본체 + 흰 코어, 피해).
  ctx.save();
  for (let i = 0; i < items.length; i += 1) {
    const t = items[i];
    if (!t.alive || t.kind !== 'laser') continue;
    const ex = t.x + Math.cos(t.a) * beamLen;
    const ey = t.y + Math.sin(t.a) * beamLen;
    if (t.warnSec > 0 && t.age < t.warnSec) {
      // 충전 — 점선·반투명, 폭이 최종폭으로 자란다(§7.4 「폭 0→최종폭 보간」)
      const prog = t.age / t.warnSec;
      ctx.globalAlpha = 0.35 + 0.35 * prog;
      ctx.setLineDash([12, 10]);
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(ex, ey);
      ctx.lineWidth = Math.max(2, t.r * prog);
      ctx.strokeStyle = pal.threat.enemyBullet;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(t.x, t.y);
    ctx.lineTo(ex, ey);
    ctx.lineWidth = t.r + vt.strokePx * 2;
    ctx.strokeStyle = pal.threat.outline;
    ctx.stroke();
    ctx.lineWidth = t.r;
    ctx.strokeStyle = pal.threat.enemyBullet;
    ctx.stroke();
    ctx.lineWidth = t.r * 0.3;
    ctx.strokeStyle = pal.threat.bulletCore;
    ctx.stroke();
  }
  ctx.restore();

  // (b) 원형 텔레그래프 — 점선·반투명(아직 오지 않은 위협)
  ctx.save();
  ctx.globalAlpha = vt.airAlpha;
  ctx.setLineDash([vt.dashPx, vt.dashPx]);
  ctx.lineWidth = vt.strokePx;
  for (let i = 0; i < items.length; i += 1) {
    const t = items[i];
    if (!t.alive || t.kind === 'laser') continue;
    // §7.12(v1.7) 착탄 — 예고가 익어 «맞은» 순간. 점선이 아니라 «찬 원»이 빠르게 사라진다.
    //   예고(점선·옅음)와 착탄(채움·밝음)이 시각적으로 반대라, 「올 것」과 「왔다」가 갈린다.
    if (t.kind === 'barrageHit') {
      const f = t.durSec > 0 ? Math.min(1, t.age / t.durSec) : 1;
      const sl = t.owner >= 0 && t.owner < world.slots.length ? world.slots[t.owner] : null;
      const c = pal.element[sl === null ? 'normal' : sl.stampElement] || pal.element.normal;
      ctx.save();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = rgba(c, 0.55 * (1 - f));
      ctx.beginPath(); ctx.arc(t.x, t.y, t.r * (0.55 + 0.45 * f), 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = rgba(c, 0.95 * (1 - f * f));
      ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      continue;
    }
    // §7.12.6(v1.7) — 자홍은 «적의 위협»색이다. 원형 텔레그래프 레이어는 실제로는
    //   바라지(플레이어 무기) 전용인데 자홍으로 칠하고 있었다 — 적 예고는 spawnZone 으로 가고
    //   이 레이어에 오지 않는다. 「내 공격인지 적 공격인지 모르겠다」의 직접 원인이다.
    //   소유자로 가른다: owner >= 0 = 내 슬롯 → 그 슬롯의 속성색, 음수 = 적 → 자홍.
    const mine = t.owner >= 0 && t.owner < world.slots.length;
    const st = mine ? world.slots[t.owner].stampElement : null;
    ctx.strokeStyle = mine ? (pal.element[st] || pal.element.normal) : pal.threat.telegraph;
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 레이어 9 — 적 탄 (§7.4: 불투명 · additive 금지 · 검은 하드 외곽선 2px · 흰 스페큘러 코어)
//   ★ I-4 — 이 레이어 위에 면적이 있는 것은 아무것도 없다 (히트박스 도트 r=4 만 예외, §7.5)
// ---------------------------------------------------------------------------
function drawEnemyBullets(ctx, world, pal, interp, alpha) {
  const items = world.enemyBullets.items;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1.0;                                     // §7.4 — 알파 1.0 고정
  // §12.3(v1.10 ㉛) 배치 — 탄마다 fill+stroke+fill(3~4회 × 384 발)이 프레임을 스파이크시켰다. «외곽선 패스 → 채움 패스 →
  //   스페큘러 패스»로 묶으면 겹친 탄에서 이웃 탄의 채움이 내 외곽선을 덮는 것까지 낱개 그리기와 같다(외곽선을 먼저, 채움을 뒤에).
  //   원(status 없음)과 육각(status 있음, 호박 테두리)은 모양·색이 달라 두 묶음. 호출 수: 최대 7회.
  const hex = Math.PI / 6;
  for (let shape = 0; shape < 2; shape += 1) {
    let any = false;
    // ① 외곽선 — 반지름 r+1 을 폭 2 로 스트로크 = r~r+2 의 검은 링(§7.4 「검은 하드 외곽선 2px」)
    ctx.beginPath();
    for (let i = 0; i < items.length; i += 1) {
      const b = items[i];
      if (!b.alive || (b.status !== null) !== (shape === 1)) continue;
      const x = lerpX(interp, interp.enemyBullets, b, alpha);
      const y = lerpY(interp, interp.enemyBullets, b, alpha);
      if (shape === 0) { ctx.moveTo(x + b.radius + 1, y); ctx.arc(x, y, b.radius + 1, 0, Math.PI * 2); }
      else regularSub(ctx, x, y, b.radius + 1, 6, hex);
      any = true;
    }
    if (!any) continue;
    ctx.lineWidth = 2;
    ctx.strokeStyle = pal.threat.outline;
    ctx.stroke();
    if (shape === 1) {                                       // §7.12.4-⑤ — 호박 테두리(육각 바깥 한 겹)
      ctx.beginPath();
      for (let i = 0; i < items.length; i += 1) {
        const b = items[i];
        if (!b.alive || b.status === null) continue;
        regularSub(ctx, lerpX(interp, interp.enemyBullets, b, alpha), lerpY(interp, interp.enemyBullets, b, alpha), b.radius + 2, 6, hex);
      }
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = pal.status.band;
      ctx.stroke();
    }
    // ② 채움 — 자홍(§7.4 자홍 고정)
    ctx.beginPath();
    for (let i = 0; i < items.length; i += 1) {
      const b = items[i];
      if (!b.alive || (b.status !== null) !== (shape === 1)) continue;
      const x = lerpX(interp, interp.enemyBullets, b, alpha);
      const y = lerpY(interp, interp.enemyBullets, b, alpha);
      if (shape === 0) { ctx.moveTo(x + b.radius, y); ctx.arc(x, y, b.radius, 0, Math.PI * 2); }
      else regularSub(ctx, x, y, b.radius, 6, hex);
    }
    ctx.fillStyle = pal.threat.enemyBullet;
    ctx.fill();
    // ③ 흰 스페큘러 점 — hue 가 없다 (플레이어 탄의 「같은 hue 의 밝은 판」과 배타, §7.12.8)
    ctx.beginPath();
    for (let i = 0; i < items.length; i += 1) {
      const b = items[i];
      if (!b.alive || (b.status !== null) !== (shape === 1)) continue;
      const x = lerpX(interp, interp.enemyBullets, b, alpha) - b.radius * 0.28;
      const y = lerpY(interp, interp.enemyBullets, b, alpha) - b.radius * 0.28;
      const sr = Math.max(1, b.radius * 0.24);
      ctx.moveTo(x + sr, y); ctx.arc(x, y, sr, 0, Math.PI * 2);
    }
    ctx.fillStyle = pal.threat.bulletCore;
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 레이어 10 — 히트박스 도트 + 스탠스 링 (§7.5 ① — **적 탄보다 위**)
//   그려진 흰 코어 도트의 반지름 = 히트박스 반지름 = 4. 크기도 거짓말하지 않는다 (§2.3)
// ---------------------------------------------------------------------------
function drawHitboxDot(ctx, world, pal, px, py) {
  const rp = world.data.rules.player;
  const vs = world.data.rules.visual.stance;
  if (!world.data.rules.hud.hitboxAlwaysVisible) return;
  const p = world.player;

  // §7.8 — 자석 반경 가시화: 은색 점선 원, 알파 0.12 상시
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(pal.element.normal, 0.12);
  ctx.beginPath();
  ctx.arc(px, py, rp.magnetRadius * (1 + world.stats.areaMul), 0, Math.PI * 2);   // §2.6 ㉚ 자석 = 점선 = 코일을 탄다(step.pickups 와 같은 식)
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = pal.threat.bulletCore;
  ctx.beginPath();
  ctx.arc(px, py, rp.hitboxRadius, 0, Math.PI * 2);          // r = 4 = 실제 히트박스
  ctx.fill();
  // 스탠스 색 링 stroke 2px, r 4 → 6. 투자 0인 스탠스면 은색 (I-2)
  const invested = p.stance === 'normal' ? false : p.invest[p.stance] > 0;
  ctx.lineWidth = vs.dotRingPx;
  ctx.strokeStyle = invested ? pal.element[p.stance] : pal.element.normal;
  ctx.beginPath();
  ctx.arc(px, py, rp.hitboxRadius + vs.dotRingPx / 2, 0, Math.PI * 2);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// 전체 (§12.3 레이어 스택 — 이 함수의 호출 순서가 곧 그 표다)
// ---------------------------------------------------------------------------
// §5.3 드론(옵션) — 위성이 플레이어를 따라다니며 대신 쏜다. 이제껏 렌더가 없어 «안 보이는 무기»였다.
//   플레이어와 잇는 가는 테더 + 밝은 위성 본체(바깥 링 + 코어)로 «내 편대»임을 명확히 한다.
function drawDrones(ctx, world, pal, interp, alpha, px, py) {
  const items = world.drones.items;
  for (let i = 0; i < items.length; i += 1) {
    const d = items[i];
    if (!d.alive) continue;
    const x = lerpX(interp, interp.drones, d, alpha);
    const y = lerpY(interp, interp.drones, d, alpha);
    ctx.strokeStyle = rgba(pal.hud.textDim, 0.3);            // 편대 테더
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
    ctx.strokeStyle = pal.hud.textPrimary;                   // 위성 본체 — 바깥 링
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = pal.hud.textPrimary;                     // 코어
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
  }
}

// §5.3 랜스(즉발 빔) — 탄이 없어 «작동이 안 보이던» 무기(드론과 같은 부류). 차지 예고 + 발사 섬광.
//   §7.4/I-1: 플레이어 FX 는 additive · 하드 외곽선 금지 · 알파 ≤ playerBulletMaxAlpha. lance.js:78-79 의
//   evoFullHeight 기하(length=arena.h)를 그대로 미러 → 레일건이 아레나 세로 전체로 읽힌다.
function drawLance(ctx, world, pal, px, py) {
  const arena = world.data.rules.view.arena;
  const cap = world.data.rules.render.playerBulletMaxAlpha;
  const slots = world.slots;
  for (let si = 0; si < slots.length; si += 1) {
    const slot = slots[si];
    if (slot.weaponId === null || slot.family !== 'lance') continue;
    const eff = recomputeEff(world, slot);
    const charging = slot.a0 > 0 && slot.a0 <= eff.chargeSec;
    const firing = slot.a1 > 0;
    if (!charging && !firing) continue;
    let length = eff.rangePx;
    if (slot.evolved && eff.evoFullHeight) length = arena.h;   // 레일건 = 세로 전체
    const topY = py - length;
    const col = pal.element[slot.stampElement] || pal.hud.textPrimary;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const n = eff.count;
    // §7.4(v1.10 ㉖) 빔 «다발»의 총 밝기는 한 줄과 같다 — 줄마다 알파를 √n 으로 나눈다(가산 합성에서 7줄이 흰 기둥이 됐다:
    //   count 3 + 다중 장전 4, 폭 12 × 1.54 = 130px 의 백색 기둥). 폭·판정은 그대로(연출만).
    const bundle = 1 / Math.sqrt(n);
    let bx = px - (n - 1) * eff.beamWidthPx * 0.5;
    for (let i = 0; i < n; i += 1) {
      let a; let w;
      if (firing) { const t = slot.a1 / eff.chargeSec; a = 0.75 * t; w = eff.beamWidthPx; }        // 섬광(감쇠)
      else { const c = 1 - slot.a0 / eff.chargeSec; a = 0.28 * c; w = eff.beamWidthPx * (0.35 + 0.65 * c); } // 차지
      ctx.fillStyle = rgba(col, Math.min(a * bundle, cap));
      ctx.fillRect(bx - w * 0.5, topY, w, length);
      bx += eff.beamWidthPx;
    }
    ctx.restore();
  }
}

// §9.5(v1.10 ㉟) 빔 — 첫 빔은 슬롯 스크래치(a0 = 표적 idx · a2 = gen)로 플레이어 → 표적 선분. 가산 합성, 폭 beamWidthPx.
function drawBeams(ctx, world, pal, px, py) {
  const cap = world.data.rules.render.playerBulletMaxAlpha;
  const slots = world.slots;
  const en = world.enemies.items;
  for (let si = 0; si < slots.length; si += 1) {
    const slot = slots[si];
    if (slot.weaponId === null || slot.family !== 'beam') continue;
    const idx = slot.a0;
    if (idx < 0) continue;
    const e = en[idx];
    if (!e.alive || e.gen !== slot.a2) continue;
    const eff = recomputeEff(world, slot);
    const col = pal.element[slot.stampElement] || pal.hud.textPrimary;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(col, Math.min(0.55, cap));
    ctx.lineWidth = eff.beamWidthPx;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(e.x, e.y); ctx.stroke();
    ctx.strokeStyle = rgba(pal.threat.bulletCore, Math.min(0.5, cap));   // 흰 코어 라인
    ctx.lineWidth = Math.max(1, eff.beamWidthPx * 0.35);
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(e.x, e.y); ctx.stroke();
    ctx.restore();
  }
}

// §7.4(v1.10 ㉟) 체인 라이트닝·빔 갈래 — 이번 틱의 선분 링. 속성색 가산, 한 줄에 지그재그 한 번(번개 인상)
function drawChainFx(ctx, world, pal) {
  const c = world.chainFx;
  if (c.count === 0) return;
  const cap = world.data.rules.render.playerBulletMaxAlpha;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let i = 0; i < c.count; i += 1) {
    const s = c.buf[i];
    const col = pal.element[s.element] || pal.hud.textPrimary;
    const mx = (s.x1 + s.x2) * 0.5 + (s.y2 - s.y1) * 0.12;   // 중간점을 수직으로 살짝 꺾는다 — 직선이 아니라 번개
    const my = (s.y1 + s.y2) * 0.5 - (s.x2 - s.x1) * 0.12;
    ctx.strokeStyle = rgba(col, Math.min(0.7, cap));
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(mx, my); ctx.lineTo(s.x2, s.y2); ctx.stroke();
    ctx.strokeStyle = rgba(pal.threat.bulletCore, Math.min(0.6, cap));
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(mx, my); ctx.lineTo(s.x2, s.y2); ctx.stroke();
  }
  ctx.restore();
}

// §5.3 노바(주기 대폭발) — 탄이 없어 «작동이 안 보이던» 무기(랜스·드론과 같은 부류). 판정은 폭발
//   시점 1회(nova.js). 여기선 연출만: expandSec 동안 0→radius 확장 플래시 + telegraphSec 예고.
//   since = intervalSec − a0 (a0 = 다음 폭발까지 남은 시간) → 새 스크래치 필드 없이 파생.
function drawNova(ctx, world, pal, px, py) {
  const cap = world.data.rules.render.playerBulletMaxAlpha;
  const slots = world.slots;
  for (let si = 0; si < slots.length; si += 1) {
    const slot = slots[si];
    if (slot.weaponId === null || slot.family !== 'nova') continue;
    const eff = recomputeEff(world, slot);
    const col = pal.element[slot.stampElement] || pal.hud.textPrimary;
    const since = eff.intervalSec - slot.a0;                    // 폭발 후 경과
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (since >= 0 && since < eff.expandSec) {                  // 폭발 확장 플래시
      const f = since / eff.expandSec;                          // 0→1
      const rr = eff.radius * f;
      // §7.12(v1.7) — v1.6 은 알파가 0.5×(1−f) 라 **커질수록 흐려졌다**: 가장 밝을 때 가장 작고,
      //   실제 도달 반경에 닿을 땐 이미 안 보인다. 그래서 「노바가 좁아 보인다」가 됐다(플레이 피드백).
      //   ★ 채움은 사라지되(잔상 방지) **테두리는 항상 eff.radius 에 그리고 끝까지 남긴다** —
      //     「여기까지 닿았다」가 매 폭발마다 같은 자리에서 읽힌다.
      ctx.fillStyle = rgba(pal.threat.bulletCore, Math.min(0.4 * (1 - f), cap));
      ctx.beginPath(); ctx.arc(px, py, rr, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = rgba(col, Math.min(0.9, cap));
      ctx.beginPath(); ctx.arc(px, py, eff.radius, 0, Math.PI * 2); ctx.stroke();
      if (slot.evolved) {                                       // 슈퍼노바 2단 링
        ctx.strokeStyle = rgba(col, Math.min(0.5 * (1 - f), cap));
        ctx.beginPath(); ctx.arc(px, py, eff.evoRing2Radius * f, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (slot.a0 < eff.telegraphSec) {                    // 다음 폭발 임박 예고
      const f = 1 - slot.a0 / eff.telegraphSec;                 // 0→1
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgba(col, Math.min(0.15 + 0.35 * f, cap));
      ctx.beginPath(); ctx.arc(px, py, eff.radius, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
}

export function drawWorld(ctx, world, pal, fx, interp, alpha) {
  const v = world.data.rules.view;
  const a = v.arena;

  drawBackground(ctx, world, pal, fx);                        // 0

  ctx.save();
  ctx.beginPath();
  ctx.rect(a.x, a.y, a.w, a.h);
  ctx.clip();                                                 // §1.1 — 아레나 밖으로 새지 않는다

  drawArenaBands(ctx, world, pal);                            // 1 — 띠 (내용의 소유자는 hud.js)
  drawTerrain(ctx, world, pal);                               // 1 — 지형 장판(§8.21, 피해 0 = 위협색 아님)
  drawGroundZones(ctx, world, pal);                           // 1
  drawPickups(ctx, world, pal, interp, alpha);                // 2
  drawPlayerBullets(ctx, world, pal, interp, alpha);          // 4
  drawEnemies(ctx, world, pal, fx, interp, alpha);            // 5 (§7.7 임팩트 프리즈 = 본체 팝)
  const pp = drawPlayer(ctx, world, pal, fx, interp, alpha);  // 6
  drawDrones(ctx, world, pal, interp, alpha, pp.x, pp.y);     // 6.5 — 위성 편대(테더로 플레이어와의 관계 표시)
  drawLance(ctx, world, pal, pp.x, pp.y);                     // 6.6 — 랜스 빔(플레이어 위 · 적 탄 9 아래 = I-4)
  drawNova(ctx, world, pal, pp.x, pp.y);                      // 6.65 — 노바 대폭발(확장 플래시 + 예고)
  drawBeams(ctx, world, pal, pp.x, pp.y);                     // 6.7 — 빔(㉟ 지속 레이저, 슬롯 스크래치의 표적으로)
  drawChainFx(ctx, world, pal);                               // 6.75 — 체인·빔 갈래 선분(㉟ 이번 틱 신호)
  drawHitFx(ctx, world, pal, fx);                             // 7 — §7.7 3중 감각 (적 탄 9보다 아래 = I-4)
  drawTelegraphs(ctx, world, pal);                            // 8
  drawEnemyBullets(ctx, world, pal, interp, alpha);           // 9
  drawWipe(ctx, world, pal);                                  // 9.5 — 보스 등장 쓸어내기(§8.22)
  drawHitboxDot(ctx, world, pal, pp.x, pp.y);                 // 10

  ctx.restore();
}

// rgba 만 외부(main.js)가 쓴다. lighten/desaturate/mix/hexToLab/labToHex/shapePath 는 importer 0 →
// 모듈-프라이빗으로 강등(죽은 export 표면 제거, 기능 영향 없음)
export { rgba };
