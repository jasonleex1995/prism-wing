/**
 * src/core/bot.js — 결정적 AI 플레이어 (순수 core, §10.2 · §10.4.1)
 *
 * ★ 변종 B — CONTINUOUS STEERING (지각 지연이 있는 연속 조향).
 *   설계: 의도(표적 · 위협 SET · 스탠스)는 reactionSec 마다만 갱신한다(= 눈 감는 창 = 지연).
 *   그러나 이동 벡터는 **매 틱** 그 기억된 의도 + 라이브 기하로 새로 합성한다:
 *     · 사격 위치(표적 아래 + x정렬)로의 인력
 *     · 기억된(스냅샷·외삽) 탄/몸통/장판/빔/경계로부터의 1/거리 반발
 *   합벡터가 자연히 «빈 공간을 향하되 총구는 유지»한다. 새 위협은 다음 갱신 전엔 보이지 않는다
 *   (지연의 모델). 알던 위협은 기억한 속도로 외삽해 매끄럽게 추적한다(사람의 예측).
 *
 * 정본 v1.4 구현 절:
 *   §10.2  8번째 RNG 스트림 `bot`. 독립이므로 봇 추첨이 콘텐츠 시퀀스를 흔들지 않는다.
 *   §10.4.1 정책 4축 + 난이도는 봇의 반응 지연으로만 들어온다.
 *   §5.7   출력 = makeInput() 모양(불리언). §9.1 순수성 — rng 는 world.rng.bot 만.
 *   §10.3  봇 상태는 ensureBot 에서 최초 1회만 alloc. 핫패스 0 alloc(스냅샷은 미리 잡은 배열에 채운다).
 */

import { TICK_HZ, TICK_DT } from './step.js';
import { elementMul } from './elements.js';

// ── 조향 파라미터(튜닝 축 — bot.js 인라인 리터럴, §데이터 아님) ───────────────────
// ★ 변종 C — ROLLOUT DODGER (지연 스냅샷 + 짧은 지평 전개 탐색).
//   9 후보 방향(정지+4직교+4대각)을 각각 dodgeLookaheadSec 만큼 전개해, 외삽 위협과의
//   최초 피격 시점을 구한다. «완주(=지평 내 무피격)»가 생존을 지배하고, 완주 후보 중에서는
//   «사격 위치(표적 x정렬)에 가장 가까워지는» 방향을 고른다 → 위협이 없으면 총구를 지켜
//   uptime 을 최대화하고, 있을 때만 최소한으로 비킨다(11%→ 목표 60% uptime).
const T = {
  MOB_LINE_OFFSET: 260,  // 모브 사격선 = 하단에서 위로 얼마(px) — 중단이 명중·클리어 최적(실측)
  BOSS_STANDOFF: 40,     // 보스 표적 아래 여유(px) — 사거리 안이되 몸통에 붙지 않게
  ALIGN_XW: 1.0,         // 정렬 페널티 x가중(무기는 위로 나간다 §1.1 → x정렬이 명중의 전제)
  ALIGN_YW: 0.4,         // y가중(사거리/스탠드오프 — x보다 관대)
  ALIGN_W: 1.0,          // 정렬 vs 생존 트레이드오프(생존이 SURV_BASE 로 지배하므로 동점 판정용)
  ALIGN_STEP: 8,         // 정렬 점수용 투영 틱수(이 방향으로 몇 틱 뒤 위치가 ideal 에 얼마나 가깝나)
  LOWHP_ALIGN_MUL: 0.35, // 저체력 시 정렬 경시(사격보다 생존)
  SEG1_FRAC: 0.45,       // ★ 2세그 롤아웃 — 1세그(현재 커밋) 길이 비율. 나머지는 재기동(juke) 세그.
  PAD_BUL: 14,            // 롤아웃 위험 여유 — 탄(얇게: 지평이 예측을 대신하므로 반경은 얇게)
  PAD_CON: 24,           // 몸통·장판(접촉사 61% → 더 두껍게)
  PAD_LAS: 10,           // 빔
  PERCEPT: 380,          // 지각 반경(px) — 이 안의 위협만 스냅샷(지연·성능)
  CLUSTER_X: 62,         // 밀집 클러스터 x창(px)
  DEAD: 3,               // 목표 근처 떨림 방지(px)
  PICK_MAX_DIST: 140,    // 이 거리 안의 픽업만 좇는다(balanced) — 자석 밖 근접만
  SURV_BASE: 1000000,    // 지평 완주(무피격)가 생존을 지배한다
  HIT_W: 3000,           // 전부 피격이면 «가장 늦게 맞는» 방향(최선의 최악)
};

// 후보 방향(단위 벡터) — 정지 · 4직교 · 4대각. 입력은 4불리언이라 이 9개로 닫힌다.
const DIRX = [0, 0, 0, -1, 1, -0.70710678, 0.70710678, -0.70710678, 0.70710678];
const DIRY = [0, -1, 1, 0, 0, -0.70710678, -0.70710678, 0.70710678, 0.70710678];

// 스냅샷 용량(ensureBot 에서 1회 alloc)
const CAP_BUL = 72;
const CAP_CON = 44;
const CAP_LAS = 8;

/** 봇 상태를 최초 1회 만든다(§10.3). 정책은 meta.bot.baseline 에서 시작한다. */
function ensureBot(world) {
  if (world.bot !== undefined) return world.bot;
  const b = world.data.meta.bot;
  world.bot = {
    policy: {
      draft: b.baseline.draft,
      farm: b.baseline.farm,
      stance: b.baseline.stance,
      forceNoElement: false,
    },
    input: { left: false, right: false, up: false, down: false,
      stanceNormal: false, stanceFire: false, stanceWater: false, stanceGrass: false },
    decideT: 0,                   // 다음 재결정까지 남은 게임초(= 반응 지연 — 표적·스탠스 의도)
    percT: 0,                     // 다음 위협 스냅샷까지 남은 게임초(= 회피 지각 주기, 지연보다 짧다)
    rollH: 24,                    // 롤아웃 지평(틱) — decide 블록이 dodgeLookaheadSec 로 세팅
    stanceT: 0,                   // 스탠스 전환 쿨다운(게임초)
    wantStance: 'normal',
    armorIdx: -1, armorGen: -1,   // §8.13 격파 중인 armor 부위(화력 집중)
    // ── 기억된 의도(reactionSec 마다 갱신) ──
    tgtIdx: -1, tgtGen: -1,       // 추적 표적 개체(라이브 위치로 조준)
    tgtBoss: false,               // 표적이 보스/중간보스(사격선 위로 안 올라감)
    pickX: 0, pickY: 0, hasPick: false, // 파밍 목적지(스냅샷)
    fallbackX: 0,                 // 표적 소실 시 x
    aimJx: 0, aimJy: 0,           // 손 오차(갱신 시 1회 추첨, 창 동안 고정)
    margin: 0,                    // 반응 시간 동안 갈 수 있는 거리(px)
    lowHp: false,
    // ── 스냅샷 위협 SET(미리 alloc, 매 갱신 채움 — 핫패스 0 alloc) ──
    snapElapsed: 0,               // 스냅샷 이후 경과(외삽용)
    nBul: 0, bx: new Float64Array(CAP_BUL), by: new Float64Array(CAP_BUL),
    bvx: new Float64Array(CAP_BUL), bvy: new Float64Array(CAP_BUL), br: new Float64Array(CAP_BUL),
    // §10.4(v1.7) 이 탄이 벽 반사하는가(1/0). 롤아웃이 삼각파 접기로 외삽할지 정한다.
    bbounce: new Uint8Array(CAP_BUL),
    // §10.4(v1.10 ㊿-t) 반사 벽의 여백 = 탄의 반경(가장자리가 벽에 닿을 때 튄다 — step.bounceOffWalls). 피격 반경(br)이 아니다.
    bwr: new Float64Array(CAP_BUL),
    nCon: 0, cx: new Float64Array(CAP_CON), cy: new Float64Array(CAP_CON),
    cvx: new Float64Array(CAP_CON), cvy: new Float64Array(CAP_CON), cr: new Float64Array(CAP_CON),
    nLas: 0, lx: new Float64Array(CAP_LAS), ly: new Float64Array(CAP_LAS),
    la: new Float64Array(CAP_LAS), lr: new Float64Array(CAP_LAS),
  };
  return world.bot;
}

/** 정책 오버라이드(시뮬이 축을 바꿔가며 돌린다). 부분 갱신. */
export function setBotPolicy(world, patch) {
  const b = ensureBot(world);
  const keys = Object.keys(patch);
  for (let i = 0; i < keys.length; i += 1) b.policy[keys[i]] = patch[keys[i]];
  return b.policy;
}

/** §10.4.1 — 반응 지연(게임초). 난이도 배속이 클수록 「눈 감는 창」이 길어진다. */
function reactionSec(world) {
  const b = world.data.meta.bot;
  const diff = world.data.meta.difficulty[world.difficultyId];
  const speed = diff === undefined ? 1 : diff.speed;
  const jitter = (world.rng.bot.f() * 2 - 1) * b.reactionJitterMs;
  const ms = b.reactionMs + jitter;
  const ticks = Math.round((ms / 1000) * TICK_HZ * speed);
  return (ticks < 1 ? 1 : ticks) / TICK_HZ;
}

/**
 * ★ 회피 지각 주기(게임초) — 위협 스냅샷을 얼마나 자주 갱신하는가. 반응 지연(표적·스탠스 «의도»)과
 *   분리한다: 사람 플레이어는 조준·판단은 느려도(reactionMs) 날아오는 탄은 계속 본다. 스냅샷이
 *   지연 주기(250ms)에 묶이면 그 창 동안 «새로 생성된» 탄이 안 보여(≈70px 맹점) 접촉·피탄사한다.
 *   dodgePerceptionMs 로 훨씬 촘촘히 지각해 회피 정확도를 올린다(= deep dodge 의 핵심 지각 층).
 *   미설정(구데이터)이면 reactionMs 로 폴백(동작 불변).
 */
function perceptionSec(world) {
  const b = world.data.meta.bot;
  const diff = world.data.meta.difficulty[world.difficultyId];
  const speed = diff === undefined ? 1 : diff.speed;
  const ms = b.dodgePerceptionMs === undefined ? b.reactionMs : b.dodgePerceptionMs;
  const ticks = Math.round((ms / 1000) * TICK_HZ * speed);
  return (ticks < 1 ? 1 : ticks) / TICK_HZ;
}

/** 가장 가까운 살아있는 적(보스 코어 포함, 중간보스 제외). */
function nearestEnemy(world) {
  const en = world.enemies.items;
  const p = world.player;
  let best = null;
  let bestD = 0;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive) continue;
    if (e.midBossId !== '') continue;   // §8.9 중간보스는 조준 대상에서 제외(주차 방지)
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const d = dx * dx + dy * dy;
    if (best === null || d < bestD) { bestD = d; best = e; }
  }
  return best;
}

/**
 * §8.13 소프트게이트 — armor 부위를 먼저 부순다(화력 집중, sticky).
 * ★ 봉인(sealedNow)된 부위는 «무적»이라 탄이 통과한다(§8.11) → 조준 대상에서 제외.
 *   조준하면 사격 uptime 이 0이 되는 죽은 표적이다(봉인 안 뚫린 키스톤). 최소 레이어(=열린 앞면)만 노린다.
 */
function nearestArmor(world) {
  const en = world.enemies.items;
  const p = world.player;
  let best = null;
  let bestD = 0;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive || !e.isBoss || e.partType !== 'armor' || e.sealedNow) continue;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const d = dx * dx + dy * dy;
    if (best === null || d < bestD) { bestD = d; best = e; }
  }
  return best;
}

/**
 * ★ 모브 표적 — «밀집한 죽일 수 있는 클러스터»의 x 에 사격선을 건다.
 *   무기는 위로 나가므로(§1.1) x정렬이 명중의 전제다. 각 모브에 대해 x창(CLUSTER_X) 안의
 *   이웃 수를 세고(밀집도) 최대인 개체를 고른다 — 열(column)이 가장 많은 적을 관통한다.
 *   동점이면 더 가깝고 더 아래(사거리 안)인 개체.
 */
function clusterTarget(world) {
  const { CLUSTER_X } = T;
  const en = world.enemies.items;
  const p = world.player;
  let best = null;
  let bestScore = -1;
  let bestD = 0;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive || e.isBoss || e.midBossId !== '') continue;
    let n = 0;
    for (let j = 0; j < en.length; j += 1) {
      const o = en[j];
      if (!o.alive || o.isBoss || o.midBossId !== '') continue;
      const ddx = o.x - e.x;
      if (ddx < CLUSTER_X && ddx > -CLUSTER_X) n += 1;
    }
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const d = dx * dx + dy * dy;
    if (n > bestScore || (n === bestScore && d < bestD)) {
      bestScore = n; best = e; bestD = d;
    }
  }
  return best;
}

/** §8.13 sticky armor → 보스 코어 → 모브 클러스터 순으로 사격 표적을 고른다. */
function pickFoe(world) {
  const b = world.bot;
  // 고정된 armor 가 살아있으면 계속 그것을(화력 집중)
  if (b.armorIdx >= 0) {
    const held = world.enemies.items[b.armorIdx];
    if (held !== undefined && held.alive && held.gen === b.armorGen
      && held.isBoss && held.partType === 'armor' && !held.sealedNow) return held;
    b.armorIdx = -1; b.armorGen = -1;
  }
  const armor = nearestArmor(world);
  if (armor !== null) {
    b.armorIdx = armor.idx; b.armorGen = armor.gen;
    return armor;
  }
  const nb = nearestEnemy(world);
  if (nb !== null && nb.isBoss) return nb;   // 보스 코어(armor 없음)
  const cl = clusterTarget(world);
  return cl !== null ? cl : nb;
}

/** 가장 가까운 픽업(파밍 대상). 없으면 null. */
function nearestPickup(world) {
  const it = world.pickups.items;
  const p = world.player;
  let best = null;
  let bestD = 0;
  for (let i = 0; i < it.length; i += 1) {
    const k = it[i];
    if (!k.alive) continue;
    const dx = k.x - p.x;
    const dy = k.y - p.y;
    const d = dx * dx + dy * dy;
    if (best === null || d < bestD) { bestD = d; best = k; }
  }
  return best;
}

/** §10.4.1 stance — 어떤 스탠스를 원하는가(사격 표적을 상성으로 때린다). */
function desiredStance(world, fireTarget) {
  const b = world.bot;
  if (b.policy.stance === 'static') return 'normal';
  const matrix = world.data.elements.matrix;
  const investable = world.data.elements.investable;

  let targetElement = null;
  if (b.policy.stance === 'majorityOnScreen') {
    const en = world.enemies.items;
    const count = Object.create(null);
    let bestN = 0;
    for (let i = 0; i < en.length; i += 1) {
      const e = en[i];
      if (!e.alive) continue;
      const c = (count[e.element] === undefined ? 0 : count[e.element]) + 1;
      count[e.element] = c;
      if (c > bestN) { bestN = c; targetElement = e.element; }
    }
  } else {
    const e = fireTarget !== null && fireTarget !== undefined ? fireTarget : nearestEnemy(world);
    if (e !== null) targetElement = e.element;
  }
  if (targetElement === null) return world.player.stance;
  for (let i = 0; i < investable.length; i += 1) {
    if (elementMul(matrix, investable[i], targetElement) > 1) return investable[i];
  }
  return world.player.stance;
}

/**
 * ★ 위협 SET 스냅샷 — reactionSec 마다 1회. 미리 잡은 배열에 채운다(핫패스 0 alloc).
 *   지각 반경(PERCEPT) 안의 위협만 담는다(지연 · 성능). 이후 매 틱 외삽해 반발을 만든다.
 */
function snapshotThreats(world, b) {
  const { PERCEPT, PAD_BUL, PAD_CON, PAD_LAS } = T;
  const p = world.player;
  const rp = world.data.rules.player;
  const percept2 = PERCEPT * PERCEPT;

  // ── 적탄 ──
  let n = 0;
  const eb = world.enemyBullets.items;
  for (let i = 0; i < eb.length && n < CAP_BUL; i += 1) {
    const bu = eb[i];
    if (!bu.alive) continue;
    const rx = bu.x - p.x;
    const ry = bu.y - p.y;
    if (rx * rx + ry * ry > percept2) continue;
    b.bx[n] = bu.x; b.by[n] = bu.y; b.bvx[n] = bu.vx; b.bvy[n] = bu.vy;
    b.bbounce[n] = bu.bounceLeft !== 0 ? 1 : 0;   // §10.4(v1.7) 반사탄은 직선 외삽이 틀린다
    b.bwr[n] = bu.radius;                          // §10.4(㊿-t) 벽 여백 = 그리는 반경(피격 반경 hitRadius 가 아니다)
    b.br[n] = rp.hitboxRadius + bu.hitRadius + PAD_BUL;
    n += 1;
  }
  b.nBul = n;

  // ── 적 몸통(모브만 — 보스/중간보스는 별도) + 장판을 한 배열에 ──
  let m = 0;
  const en = world.enemies.items;
  for (let i = 0; i < en.length && m < CAP_CON; i += 1) {
    const e = en[i];
    if (!e.alive || e.isBoss || e.midBossId !== '') continue;
    const rx = e.x - p.x;
    const ry = e.y - p.y;
    if (rx * rx + ry * ry > percept2) continue;
    b.cx[m] = e.x; b.cy[m] = e.y; b.cvx[m] = e.vx; b.cvy[m] = e.vy;
    b.cr[m] = rp.hitboxRadius + e.radius + PAD_CON;
    m += 1;
  }
  const zs = world.zones.items;
  for (let i = 0; i < zs.length && m < CAP_CON; i += 1) {
    const z = zs[i];
    if (!z.alive || z.fromPlayer) continue;
    const rx = z.x - p.x;
    const ry = z.y - p.y;
    if (rx * rx + ry * ry > percept2) continue;
    b.cx[m] = z.x; b.cy[m] = z.y; b.cvx[m] = 0; b.cvy[m] = 0;
    b.cr[m] = rp.hitboxRadius + z.radius + PAD_CON;
    m += 1;
  }
  b.nCon = m;

  // ── 빔(telegraph laser) — 선. ──
  let k = 0;
  const ts = world.telegraphs.items;
  for (let i = 0; i < ts.length && k < CAP_LAS; i += 1) {
    const t2 = ts[i];
    if (!t2.alive || t2.kind !== 'laser') continue;
    b.lx[k] = t2.x; b.ly[k] = t2.y; b.la[k] = t2.a;
    b.lr[k] = rp.hitboxRadius + t2.r * 0.5 + PAD_LAS;
    k += 1;
  }
  b.nLas = k;
}

// 조향 스크래치(모듈 스코프 — 핫패스 0 alloc)
const _steer = { x: 0, y: 0 };
const _ideal = { x: 0, y: 0 };

/** ★ 사격 이상위치(ideal) — 봇이 서 있고 싶은 곳(uptime 최대). 표적 x정렬이 핵심. */
function firingIdeal(world, b) {
  const bounds = world.bounds;
  if (b.hasPick) { _ideal.x = b.pickX; _ideal.y = b.pickY; return; }
  const t = b.tgtIdx >= 0 ? world.enemies.items[b.tgtIdx] : undefined;
  if (t !== undefined && t.alive && t.gen === b.tgtGen) {
    _ideal.x = t.x + b.aimJx;
    if (b.tgtBoss) {
      const rp = world.data.rules.player;
      _ideal.y = t.y + rp.hitboxRadius + t.radius + T.BOSS_STANDOFF;   // 아래에서 위로 쏜다
    } else {
      _ideal.y = bounds.maxY - T.MOB_LINE_OFFSET;                       // 모브 사격선
    }
  } else {
    _ideal.x = b.fallbackX; _ideal.y = bounds.maxY - T.MOB_LINE_OFFSET;
  }
}

// 롤아웃 세그 끝 위치(모듈 스코프 — 핫패스 0 alloc). rollSeg 가 완주 시 채운다.
const _rollEnd = { x: 0, y: 0 };


/**
 * §10.4(v1.7) 반사탄의 «닫힌 형태» 외삽 — 봇이 벽 반사를 예측하기 위한 삼각파 접기.
 *   벽 사이를 무한히 되튀는 점의 위치는 반복 없이 한 번에 구할 수 있다: 구간 [lo,hi] 를
 *   주기 2(hi-lo) 로 접으면 된다. 그래서 롤아웃이 틱마다 반사를 시뮬레이션할 필요가 없다.
 *   ★ 이게 없으면 봇은 반사탄을 직선으로 보고 «탄 속으로» 피한다 — 회피율이 무너지고
 *     그 위에서 잰 시뮬 수치가 전부 무의미해진다(밸런스 판단의 근거가 썩는다).
 *   ★ 유한 반사(bounceLeft > 0)는 예산 소진 후 직선이 되므로 이 근사가 보수적으로 빗나간다.
 *     그래서 반사탄은 무제한(-1)으로만 저작한다 — S43 이 그것을 강제한다.
 */
function foldSpan(v, lo, hi) {
  const span = hi - lo;
  if (span <= 0) return lo;
  const period = span * 2;
  let u = (v - lo) % period;
  if (u < 0) u += period;
  return lo + (u <= span ? u : period - u);
}

/**
 * §10.4(v1.10 ㊿-t) 반사탄 한 축의 위치 — step.bounceOffWalls 와 같은 규칙: 벽 «안»에서 난 탄은 삼각파 접기,
 *   벽 밖(HP·XP 띠 · 화면 위)에서 나서 아직 안 들어온 탄은 직선(step 은 «안에서 넘을 때만» 되튄다). v0 = 스냅샷 위치.
 *   [lo, hi] = 반사 벽을 탄 반경만큼 줄인 구간(가장자리가 닿을 때 튄다). 들어온 뒤로는 접기와 같다 — 접기는 벽에서 연속이다.
 *   tests/hazards.test.mjs · tests/escape.test.mjs(계측도 이 함수를 쓴다)가 실제 궤적과 오차 0 을 본다.
 */
export function foldWall(v, v0, lo, hi) {
  if ((v0 < lo && v < lo) || (v0 > hi && v > hi)) return v;
  return foldSpan(v, lo, hi);
}

/**
 * ★ 롤아웃 세그 — (sx,sy)에서 dir 로 startK 틱 뒤부터 n 틱 등속 이동. 외삽 위협과 처음 맞는
 *   «전역» 틱(startK+로컬)을 반환한다. 무피격이면 0(완주)을 반환하고 끝 위치를 _rollEnd 에 쓴다.
 *   위협은 스냅샷 시점 + (snapElapsed + 전역틱·dt)로 외삽. 벽 클램프 포함(실제 궤적).
 *   ★ export 는 테스트용이다 — tests/bot.test.mjs 가 «봇이 찍은 스냅샷 → 이 롤아웃의 첫 피격 틱 = 실제 탄의 첫 피격 틱»을 본다
 *     (v1.10 ㊿-t 3차 검토: 외삽만 따로 재면 롤아웃이 그 결과를 안 써도 초록이었다 — 그래서 롤아웃의 «답»을 잰다).
 */
export function rollSeg(world, b, sx, sy, startK, dirx, diry, n) {
  const bounds = world.bounds;
  const walls = world.walls;                      // §10.4(v1.7 · ㊿-t) 반사탄 접기의 구간 = step.bounceOffWalls 와 같은 벽
  const rp = world.data.rules.player;
  const dt = TICK_DT;
  const vx = dirx * rp.moveSpeed * dt;
  const vy = diry * rp.moveSpeed * dt;
  let px = sx;
  let py = sy;
  for (let k = 1; k <= n; k += 1) {
    px += vx; if (px < bounds.minX) px = bounds.minX; else if (px > bounds.maxX) px = bounds.maxX;
    py += vy; if (py < bounds.minY) py = bounds.minY; else if (py > bounds.maxY) py = bounds.maxY;
    const gk = startK + k;
    const tk = b.snapElapsed + gk * dt;
    for (let i = 0; i < b.nBul; i += 1) {
      // §10.4(v1.7 · ㊿-t) 반사탄은 벽에서 되튄다 — 직선 외삽하면 봇이 «탄 속으로» 피한다. 벽 = world.walls, 여백 = 스냅샷 반경 bwr
      //   (step.bounceOffWalls 와 같은 선). 핫패스라 인라인이다 — 함수 + 모듈 스크래치 객체로 뺐더니 botInput 이 7% 느려졌다(3차 검토 실측).
      //   동작은 tests/bot.test.mjs 가 «스냅샷 → 롤아웃의 첫 피격 틱 = 실제»로 본다.
      let bxk = b.bx[i] + b.bvx[i] * tk;
      let byk = b.by[i] + b.bvy[i] * tk;
      if (b.bbounce[i] === 1) {
        const wr = b.bwr[i];
        bxk = foldWall(bxk, b.bx[i], walls.x + wr, walls.x + walls.w - wr);
        byk = foldWall(byk, b.by[i], walls.y + wr, walls.y + walls.h - wr);
      }
      const ex = px - bxk;
      const ey = py - byk;
      const r = b.br[i];
      if (ex * ex + ey * ey < r * r) return gk;
    }
    for (let i = 0; i < b.nCon; i += 1) {
      const ex = px - (b.cx[i] + b.cvx[i] * tk);
      const ey = py - (b.cy[i] + b.cvy[i] * tk);
      const r = b.cr[i];
      if (ex * ex + ey * ey < r * r) return gk;
    }
    for (let i = 0; i < b.nLas; i += 1) {
      const rx = px - b.lx[i];
      const ry = py - b.ly[i];
      const a = b.la[i];
      const signed = -Math.sin(a) * rx + Math.cos(a) * ry;
      const perp = signed < 0 ? -signed : signed;
      if (perp < b.lr[i]) return gk;
    }
  }
  _rollEnd.x = px; _rollEnd.y = py;
  return 0;
}

/**
 * ★ 매 틱 조향 — 2세그(juke) 전개 탐색. 각 1세그 방향 d1 을 seg1 틱 커밋한 뒤, 그 끝에서
 *   9개 2세그 방향 d2 중 최선의 재기동을 이어붙여 «지평 완주 여부/깊이»를 매긴다. 단일 직선
 *   롤아웃은 «지금 꺾어 피할 길»을 보지 못해 안전한 방향을 죽은 것으로 오판했다 — 2세그는
 *   틱마다 재결정하는 실제 궤적공간(9^H)을 근사해 생존을 회복한다. 조기탈출: 완주하는 d2 를
 *   하나 찾으면 그 d1 은 «완전 생존»으로 확정하고 멈춘다(안전한 틱은 사실상 9회 롤아웃).
 *   생존이 지배, 동점(둘 다 완주)에서만 1세그 사격 위치 정렬을 최대화한다.
 */
function steer(world, b) {
  firingIdeal(world, b);
  const p = world.player;
  const bounds = world.bounds;
  const rp = world.data.rules.player;
  const H = b.rollH;
  let s1 = (H * T.SEG1_FRAC) | 0;
  if (s1 < 1) s1 = 1; else if (s1 > H) s1 = H;
  const rem = H - s1;
  const proj = rp.moveSpeed * TICK_DT * T.ALIGN_STEP;
  const alignMul = (b.lowHp ? T.LOWHP_ALIGN_MUL : 1) * T.ALIGN_W;

  let bestScore = -Infinity;
  let bestDir = 0;
  for (let d = 0; d < 9; d += 1) {
    // 1세그: d 방향으로 s1 틱. 이 안에서 맞으면 그 방향의 생존 깊이는 거기까지.
    const hit1 = rollSeg(world, b, p.x, p.y, 0, DIRX[d], DIRY[d], s1);
    let surv;
    if (hit1 !== 0) {
      surv = hit1;                     // 1세그 내 피격 — 재기동 이전에 죽는다
    } else if (rem <= 0) {
      surv = H;                        // 지평 == 1세그 → 완주
    } else {
      // 2세그: 끝 위치에서 9개 재기동 방향 중 하나라도 완주하면 «완전 생존» 확정(조기탈출).
      const mx = _rollEnd.x;
      const my = _rollEnd.y;
      let best2 = 0;
      let full = false;
      for (let q = 0; q < 9; q += 1) {
        const d2 = q === 0 ? d : (q === d ? 0 : q);   // d(직진 계속)·정지를 먼저 → 조기탈출 잦게
        const hit2 = rollSeg(world, b, mx, my, s1, DIRX[d2], DIRY[d2], rem);
        if (hit2 === 0) { full = true; break; }
        if (hit2 > best2) best2 = hit2;
      }
      surv = full ? H : best2;
    }
    // 정렬: 이 1세그 방향으로 ALIGN_STEP 틱 뒤 위치가 ideal 에 얼마나 가까운가(x가중)
    let ax = p.x + DIRX[d] * proj;
    if (ax < bounds.minX) ax = bounds.minX; else if (ax > bounds.maxX) ax = bounds.maxX;
    let ay = p.y + DIRY[d] * proj;
    if (ay < bounds.minY) ay = bounds.minY; else if (ay > bounds.maxY) ay = bounds.maxY;
    const dxi = (ax - _ideal.x) * T.ALIGN_XW;
    const dyi = (ay - _ideal.y) * T.ALIGN_YW;
    const alignPen = Math.sqrt(dxi * dxi + dyi * dyi) * alignMul;
    const score = (surv >= H ? T.SURV_BASE : surv * T.HIT_W) - alignPen;
    if (score > bestScore) { bestScore = score; bestDir = d; }
  }
  _steer.x = DIRX[bestDir] * 100;
  _steer.y = DIRY[bestDir] * 100;
}

/**
 * ★ 봇의 한 틱 입력. step(world, botInput(world, dt), dt) 로 쓰인다.
 *   의도(표적·위협 SET·스탠스)는 반응 지연마다만 갱신하고, 이동은 매 틱 조향한다.
 */
export function botInput(world, dt) {
  const b = ensureBot(world);
  const p = world.player;
  const bt = world.data.meta.bot;
  const rp = world.data.rules.player;
  const inp = b.input;

  // 스탠스 키는 매 틱 내린다 — 상승 엣지를 만들 틱에만 올린다
  inp.stanceNormal = false; inp.stanceFire = false; inp.stanceWater = false; inp.stanceGrass = false;

  // ── 의도 갱신 (반응 지연마다 = 눈 감는 창) ──────────────────────────────────
  b.decideT -= dt;
  if (b.decideT <= 0) {
    b.decideT = reactionSec(world);
    b.margin = rp.moveSpeed * (bt.reactionMs / 1000);
    b.rollH = Math.round(bt.dodgeLookaheadSec * TICK_HZ);   // §10.4.1 dodgeLookaheadSec → 롤아웃 지평
    b.lowHp = p.hp < p.hpMax * rp.lowHpThreshold;

    const farm = b.policy.farm;
    const foe = pickFoe(world);
    const foeIsBoss = foe !== null && (foe.isBoss || foe.midBossId !== '');
    // ★ 보스/중간보스가 표적이면 픽업을 좇지 않는다 — 실측: 보스전에 픽업을 좇다 열을 벗어나
    //   보스전 명중률이 ≈1% 로 붕괴했다. 보스전엔 사격선을 지킨다.
    let pick = (farm === 'passive' || foeIsBoss) ? null : nearestPickup(world);
    // ★ 먼 픽업은 좇지 않는다(maxFarm 제외) — 실측: 화력선을 벗어나 픽업을 좇으면 모브 명중 시간이
    //   줄어 레벨이 안 오른다. 자석(90px)이 근처는 자동 수거하므로 «가까운» 픽업만 살짝 우회한다.
    if (pick !== null && farm !== 'maxFarm') {
      const pdx = pick.x - p.x;
      const pdy = pick.y - p.y;
      if (pdx * pdx + pdy * pdy > T.PICK_MAX_DIST * T.PICK_MAX_DIST) pick = null;
    }
    // 안전하거나 maxFarm 이면 픽업을 목적지로
    if (pick !== null && (farm === 'maxFarm' || p.hp > p.hpMax * 0.5)) {
      b.hasPick = true; b.pickX = pick.x; b.pickY = pick.y;
      b.tgtIdx = -1; b.tgtGen = -1; b.tgtBoss = false;
    } else {
      b.hasPick = false;
      if (foe !== null) {
        b.tgtIdx = foe.idx; b.tgtGen = foe.gen;
        b.tgtBoss = foe.isBoss || foe.midBossId !== '';
        b.fallbackX = foe.x;
      } else {
        b.tgtIdx = -1; b.tgtGen = -1; b.tgtBoss = false;
        b.fallbackX = (world.bounds.minX + world.bounds.maxX) * 0.5;
      }
    }
    // §10.4.1 aimErrorPx — 손 오차(창 동안 고정)
    b.aimJx = (world.rng.bot.f() * 2 - 1) * bt.aimErrorPx;
    b.aimJy = (world.rng.bot.f() * 2 - 1) * bt.aimErrorPx;

    b.wantStance = desiredStance(world, foe);
  }

  // ── 회피 지각 갱신 (반응 지연과 분리 · 훨씬 촘촘) ─────────────────────────────
  //   위협 스냅샷을 자주 새로 잡아 「새 탄 맹점」을 줄인다. 갱신 시 외삽 기준(snapElapsed)도 0으로.
  b.percT -= dt;
  if (b.percT <= 0) {
    b.percT = perceptionSec(world);
    b.snapElapsed = 0;
    snapshotThreats(world, b);
  }

  // ── 연속 조향 (매 틱) ──────────────────────────────────────────────────────
  steer(world, b);
  const DEAD = T.DEAD;
  inp.left = _steer.x < -DEAD;
  inp.right = _steer.x > DEAD;
  inp.up = _steer.y < -DEAD;
  inp.down = _steer.y > DEAD;

  b.snapElapsed += dt;

  // ── 스탠스 — stanceSwitchMs 간격으로만 전환 ──────────────────────────────
  b.stanceT -= dt;
  if (b.stanceT <= 0 && b.wantStance !== p.stance) {
    b.stanceT = bt.stanceSwitchMs / 1000;
    if (b.wantStance === 'normal') inp.stanceNormal = true;
    else if (b.wantStance === 'fire') inp.stanceFire = true;
    else if (b.wantStance === 'water') inp.stanceWater = true;
    else if (b.wantStance === 'grass') inp.stanceGrass = true;
  }

  return inp;
}

/**
 * §10.4.1 draft — 어떤 카드를 고르는가(인덱스). 결정 불가 시 0.
 */
export function botDraftPick(world, draft) {
  const b = ensureBot(world);
  const cards = draft.cards;
  if (cards.length === 0) return 0;
  if (b.policy.draft === 'random') return Math.floor(world.rng.bot.f() * cards.length);
  // §11.6(v1.10 ㉒) 특성 드래프트 — 셋 다 회복이다. 봇은 «자연 재생»(조건 없는 회복 = 원데스 봇에게 최선)을 올리고, 만렙이면 첫 장.
  if (cards[0].category === 'trait') {
    for (let i = 0; i < cards.length; i += 1) if (cards[i].traitId === 'regen') return i;
    return 0;
  }

  // ★ (1) 진화 카드(Lv7→Lv8)가 있으면 즉시 — 진화는 후반 화력의 «단일 최대 배수»(뱀서식). 놓치지 않는다.
  //   ★ 정책 다양성 보존: 이건 어떤 정책이든 하는 «명백한 최선»이라 정책 색깔을 지우지 않는다(진화 카드는 희소).
  for (let i = 0; i < cards.length; i += 1) {
    if (cards[i].category === 'weaponLevel' && cards[i].isEvolution === true) return i;
  }

  // ★ (2) 캐리(가장 레벨 높은 무기)가 진화 임박(Lv≥6)인데 짝 패시브가 부족하면 그 패시브를 집는다(진화 게이트).
  let carry = null;
  for (let si = 0; si < world.slots.length; si += 1) {
    const s = world.slots[si];
    if (s.weaponId === null) continue;
    if (carry === null || s.level > carry.level) carry = s;
  }
  if (carry !== null && carry.level >= 6) {
    const req = world.weaponDefs[carry.family].evolution.requiresPassive;
    let lv = 0;
    for (let j = 0; j < world.passives.length; j += 1) {
      if (world.passives[j].id === req.id) { lv = world.passives[j].level; break; }
    }
    if (lv < req.level) {
      for (let i = 0; i < cards.length; i += 1) {
        if (cards[i].category === 'passive' && cards[i].passiveId === req.id) return i;
      }
    }
  }

  const noElement = b.policy.forceNoElement;
  let order;
  if (b.policy.draft === 'weaponRush') order = ['newWeapon', 'weaponLevel', 'passive', 'elementLevel'];
  else if (b.policy.draft === 'elementRush' || b.policy.draft === 'specialist') {
    order = ['elementLevel', 'newWeapon', 'weaponLevel', 'passive'];
  } else if (b.policy.draft === 'greedyDps') order = ['weaponLevel', 'newWeapon', 'passive', 'elementLevel'];
  else order = ['newWeapon', 'weaponLevel', 'elementLevel', 'passive'];   // generalist (§13.5.1 사다리)

  for (let k = 0; k < order.length; k += 1) {
    if (noElement && order[k] === 'elementLevel') continue;
    for (let i = 0; i < cards.length; i += 1) if (cards[i].category === order[k]) return i;
  }
  return 0;
}

// ★ v1.5 — 상점 봇 정책(botShopPlan·botShopReserve)은 폐지됐다: 경제 제거.
