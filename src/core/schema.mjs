/**
 * src/core/schema.mjs
 *
 * 정본 v1.4 구현 절:
 *   §9.2  파일 매니페스트 — 정확히 9개, 닫힘
 *   §9.3  로더 규칙 — schemaVersion 필수 / **미지 키 = 에러** / **누락 키 = 에러, 폴백 금지**
 *         / 참조 무결성 / 모든 이미터가 rules.fairness 통과 필수 / 게임·시뮬 양쪽에서 동일 실행
 *   §9.4~§9.9  각 파일의 인쇄 블록 = 필드 집합의 소유자 (C-7)
 *   §9.5  패밀리별 base 필수 키 집합 12행 + evolution.params 키 집합
 *   §12.4 · §7.4  공정성 하한 (이미터)
 *   §9.1  core 순수성 — 파일을 읽지 않는다. **파싱된 객체를 주입받는다**
 *
 * ★ 이 파일은 fetch 도 fs 도 모른다. 호출자(main.js / tools/sim.mjs)가 9개 JSON 을
 *   파싱해서 넘긴다 → 같은 코드가 브라우저와 node 에서 문자 그대로 동일하게 돈다 (§9.3).
 * ★ 폴백이 없다. 실패는 전부 throw 다 — 조용한 밸런스 드리프트의 근원을 차단한다.
 *
 * ★ tools/check.mjs (S1~S40) 가 전수 정적 게이트이며 이 파일은 **런타임 로더**다.
 *   둘은 §9.3의 같은 규칙을 집행하되 check.mjs 가 상위집합이다.
 */

/** §9.2 — 정확히 11개, 닫힘 */
export const MANIFEST = ['rules', 'elements', 'weapons', 'passives', 'bullets',
  'enemies', 'bosses', 'stages', 'meta', 'traits', 'tutorial'];   // v1.10 ⑲ traits (§11.6) · ㊴ tutorial (§6.7)
export const TRAIT_EFFECT_KINDS = ['regenHpPerSec', 'lifestealPct', 'shieldEverySec'];   // §11.6 v1.10 ㉒ — 특성 3종과 1:1(재생·흡혈·쉴드)
/** §11.6 ㉗ 효과 kind 별 «추가 키» — 흡혈의 hpRatio(이 비율 이하일 때만 듣는다). 로더가 닫힌 키·(0,1] 로 지킨다. */
const TRAIT_EFFECT_EXTRA = { lifestealPct: ['hpRatio'] };

/** §9.3 — 모든 파일 루트에 필수. 불일치 → 로드 실패 */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// 동결 어휘 (§13.4-S3 · C-3)
// ---------------------------------------------------------------------------
const ELEMENTS4 = ['normal', 'fire', 'water', 'grass'];
const FAMILIES = ['forward', 'fan', 'seeker', 'lance', 'orbit', 'aura',
  'boomerang', 'barrage', 'drone', 'nova', 'missile', 'chain', 'beam', 'pinball'];   // ㉟ 15종 · ㊵ 스파이럴 삭제 → 14종
// §9.6(v1.10 ㊲) 14 스탯 = 14 패시브 1:1. 분류: 공용 1(fireRateMul) · 탄 4(projCountAdd·pierceAdd·projSpeedMul·durationMul) ·
//   빔 2(beamDmgMul·beamAreaMul) · 범위 2(areaMul·areaDmgMul) · 궤도 1(orbitMul) · 기체 4(maxHpAdd·terrainResist·xpGainMul·elementBonusMul).
//   ~~dmgMul(탄두 증량)~~ ~~ghostSecOnHit(잔광)~~ ~~hitBulletClearRadius(반응 장갑)~~ 폐지.
const PASSIVE_STATS = ['fireRateMul', 'projCountAdd', 'pierceAdd', 'projSpeedMul', 'durationMul',
  'beamDmgMul', 'beamAreaMul', 'areaMul', 'areaDmgMul', 'orbitMul',
  'maxHpAdd', 'terrainResist', 'xpGainMul', 'elementBonusMul'];
/** §9.6.1 ㊲ — 무기 피해 스탯(dmgStat)의 어휘. null = 그 패밀리엔 피해 패시브가 없다(탄·펄스필드·궤도). */
const DMG_STATS = ['beamDmgMul', 'areaDmgMul', 'orbitMul'];
/** §9.6 ㊲ — 기체 패시브(무기와 무관, 모든 빌드에 유효). 나머지 10 은 «무기 분류 패시브»다. */
export const BODY_STATS = ['maxHpAdd', 'terrainResist', 'xpGainMul', 'elementBonusMul'];
const HOOK_KEYS = ['rateKey', 'countKey', 'pierceApplies', 'speedKeys', 'durationKeys', 'areaKeys', 'beamKeys', 'orbitKeys', 'dmgStat', 'lifesteal'];   // v1.10 ㊿-za lifesteal
const BANDS = ['chaff', 'line', 'turret', 'bruiser'];
const FORMATION_IDS = ['lineH', 'vWedge', 'arc', 'scatter', 'wall'];
const EMITTER_TYPES = ['straight', 'fan', 'aimed', 'ring', 'spiral', 'laser', 'zone', 'wall', 'mortar', 'sweep'];
const BOSS_TIERS = ['stage', 'mid', 'final'];

/** §9.5 — 패밀리별 base 필수 키 집합 12행 (공통 ✔ + 고유 non-evo). 동결 */
const FAMILY_BASE_KEYS = {
  forward: ['dmg', 'cooldownSec', 'count', 'projSpeed', 'projRadius', 'lifetimeSec', 'pierce',
    'hitCooldownSec', 'targetMode', 'spreadDeg', 'jitterDeg', 'burstCount', 'burstIntervalSec'],
  fan: ['dmg', 'cooldownSec', 'count', 'projSpeed', 'projRadius', 'lifetimeSec', 'pierce',
    'hitCooldownSec', 'targetMode', 'arcDeg'],
  seeker: ['dmg', 'cooldownSec', 'count', 'projSpeed', 'projRadius', 'lifetimeSec', 'pierce',
    'hitCooldownSec', 'targetMode', 'turnRateDegSec', 'acquireRadius', 'retargetSec'],
  lance: ['dmg', 'cooldownSec', 'count', 'pierce', 'hitCooldownSec', 'targetMode',
    'beamWidthPx', 'chargeSec', 'rangePx'],
  orbit: ['dmg', 'projRadius', 'hitCooldownSec', 'orbitRadius', 'angularSpeedDegSec', 'bodyCount'],
  aura: ['radius', 'slowMul'],
  boomerang: ['dmg', 'cooldownSec', 'count', 'projSpeed', 'projRadius', 'lifetimeSec', 'pierce',
    'hitCooldownSec', 'targetMode', 'outRangePx', 'returnSpeed', 'canRehit', 'bounceLeft', 'spacingDeg', 'sweepDegSec'],
  barrage: ['dmg', 'cooldownSec', 'targetMode', 'strikeIntervalSec', 'strikesPerVolley',
    'blastRadius', 'telegraphSec', 'slowSec', 'impactFlashSec'],
  drone: ['dmg', 'projSpeed', 'projRadius', 'lifetimeSec', 'pierce', 'hitCooldownSec', 'targetMode',
    'droneCount', 'anchorOffsets', 'droneFireSec', 'droneRangePx'],
  nova: ['dmg', 'intervalSec', 'radius', 'expandSec', 'telegraphSec', 'actionSlowSec'],
  // ㉟ 신설 5종(속성 무기 10종 확장)
  missile: ['dmg', 'cooldownSec', 'count', 'projSpeed', 'projRadius', 'lifetimeSec', 'pierce',
    'hitCooldownSec', 'targetMode', 'blastRadius', 'spreadDeg'],
  chain: ['dmg', 'cooldownSec', 'count', 'hitCooldownSec', 'targetMode', 'acquireRadius', 'chainRangePx', 'chainCount', 'chainDmgMul'],
  beam: ['dmg', 'count', 'pierce', 'hitCooldownSec', 'targetMode', 'rangePx', 'beamWidthPx'],
  pinball: ['dmg', 'cooldownSec', 'count', 'projSpeed', 'projRadius', 'lifetimeSec', 'pierce',
    'hitCooldownSec', 'targetMode', 'bounceLeft', 'launchDeg'],
};

/** §9.5 — evolution.params 키 집합 (evo* 접두). 동결 */
const FAMILY_EVO_KEYS = {
  forward: ['evoRampSec', 'evoRampFireRateMul'],
  fan: ['evoBlastRadius', 'evoSecondaryDmgMul'],
  seeker: ['evoDistinctTargets', 'evoRetargetOnKill'],
  lance: ['evoFullHeight'],
  orbit: ['evoGuardBodies'],
  aura: ['evoPullForce'],   // ㊿-r evoSlowMul 삭제 — 진화 감속은 레벨 칸(Lv8~10)이 소유
  boomerang: ['evoChainCount'],
  barrage: ['evoRadiusMul'],
  drone: ['evoTrailDelaySec', 'evoTrailAnchor'],
  nova: ['evoRing2Radius', 'evoSecondaryDmgMul', 'evoActionSlowSec'],
  missile: ['evoClusterCount', 'evoClusterDmgMul'],
  chain: ['evoForkOnSuper', 'evoChainCountMul'],
  beam: ['evoSplitCount', 'evoSplitDmgMul', 'evoSplitRangePx'],
  pinball: ['evoSplitOnBounce', 'evoMaxBalls'],
};

/** §9.5 — 허용 targetMode. null = 그 패밀리 계약에 targetMode 키가 없다 */
const FAMILY_TARGET_MODES = {
  forward: ['forward'], fan: ['forward'], seeker: ['nearest', 'lowestHp', 'randomInArena'],
  lance: ['forward', 'nearest'], orbit: null, aura: null,
  boomerang: ['forward', 'sweep'], barrage: ['randomInArena', 'densest'],   // ㉚ sweep = 조준이 sweepDegSec 로 계속 돈다(리턴)
  drone: ['nearest', 'lowestHp', 'forward'], nova: null,
  missile: ['forward'], chain: ['nearest'], beam: ['nearest'], pinball: ['forward'],   // ㉟
};

/** §4.4 — elementStampMode. 구조 결정 = 잠금 키 */
const STAMP_LIVE = ['orbit', 'aura'];

/** §8.5 — 이미터 공통 9 + 타입별 고유 (발사 원점 키 from, 값 = self | part) */
const EMIT_COMMON = ['id', 'type', 'bulletId', 'from', 'telegraphSec', 'everySec', 'offsetSec',
  'repeat', 'restSec'];
const EMIT_OWN = {
  straight: ['count', 'spreadDeg', 'speed'],
  fan: ['count', 'arcDeg', 'speed'],
  aimed: ['count', 'spreadDeg', 'speed', 'leadSec'],
  ring: ['count', 'speed', 'rotOffsetDeg'],
  spiral: ['count', 'speed', 'rotStepDeg', 'durationSec', 'rateSec'],
  laser: ['widthPx', 'activeSec', 'angleDeg', 'trackDuringCharge'],
  zone: ['radius', 'activeSec', 'dmg'],
  wall: ['count', 'gapCount', 'gapWidthPx', 'speed'],
  mortar: ['radius', 'activeSec', 'dmg', 'fuseSec', 'leadSec'],
  sweep: ['widthPx', 'activeSec', 'angleStartDeg', 'angleEndDeg'],
};

/** §7.4 — 텔레그래프 하한 3축. 겹치면 max */
const TELEGRAPH_FLOOR_BY_TYPE = {
  straight: 0.55, fan: 0.60, aimed: 0.60, ring: 0.60,
  spiral: 0.60, wall: 0.80, zone: 0.90, laser: 1.20, mortar: 0.60, sweep: 1.20,
};

/** §9.4 — rules.json 루트 = schemaVersion + 정확히 16 블록 (v1.5: bomb 제거 = 경제·소비아이템 폐지) */
const RULES_ROOT_17 = ['loop', 'view', 'collide', 'caps', 'player', 'status', 'elite',
  'boss', 'fairness', 'terrain', 'hud', 'passiveHooks', 'input', 'palette', 'visual', 'render', 'audio'];   // v1.10 ⑦ terrain
export const TERRAIN_KINDS = ['slow', 'inertia', 'heat'];   // §8.21 — 지형 장판 3종(속성당 하나: 풀·물·불)
/** §8.21 ② 종 → 속성(고정 사전). 그림의 색(draw)과 게이트 S56 ② 가 같은 표를 본다 — 테마는 겉모습만 다르다. */
export const TERRAIN_KIND_ELEMENT = { slow: 'grass', inertia: 'water', heat: 'fire' };
/** §8.21 ③(v1.10 ⑳) finale 의 terrainKind — 3종이 slow→inertia→heat 순으로 «돌아가며» 나온다(테마가 없으니 전부 나온다). */
export const TERRAIN_MIXED = 'mixed';
const TERRAIN_KIND_VALUES = [...TERRAIN_KINDS, TERRAIN_MIXED];
export const WEAPON_CLASSES = ['bullet', 'beam', 'area', 'orbital'];   // §9.5 ㊲ 무기 분류(패시브 분류와 짝) · ㊵ 데이터가 소유한다
const TUTORIAL_GOALS = ['move', 'clear', 'level', 'superHit', 'terrain', 'boss'];   // §6.7 ㊻ 6스텝   // §6.7 ㊴
export const SECTIONS = ['early', 'midboss', 'crisis', 'boss'];   // §8.19 — 스테이지 구간 어휘(배수는 early 에 속한다)
export const WEAPON_MAX_LEVEL = 10;   // §9.5 v1.10 ⑱ — Lv8 진화 + Lv9·10 진화체 강화
export const WEAPON_EVOLVE_LEVEL = 8; // §9.5 — Lv7→Lv8 카드 = 진화(짝 패시브 Lv3)

// ---------------------------------------------------------------------------
// 검증 원시 함수
// ---------------------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** 위반 수집기. §9.3의 어떤 위반도 조용히 통과하지 않는다 */
function collector() {
  const errs = [];
  return {
    errs,
    fail(path, msg) { errs.push(`${path}: ${msg}`); },
    /**
     * §9.3 — 미지 키 = 에러 / 누락 키 = 에러 / 폴백 금지.
     * allowed 와 required 가 같은 집합인 것이 정본의 기본값이다.
     */
    closed(path, node, allowed, optional) {
      if (!isObj(node)) {
        this.fail(path, `객체가 아니다 (${node === undefined ? 'undefined' : typeof node})`);
        return false;
      }
      const opt = optional || [];
      let ok = true;
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i += 1) {
        if (allowed.indexOf(keys[i]) < 0) {
          this.fail(`${path}.${keys[i]}`, '미지 키 = 에러 (§9.3) — 정본의 인쇄 블록에 이 필드의 자리가 없다');
          ok = false;
        }
      }
      for (let i = 0; i < allowed.length; i += 1) {
        if (!own(node, allowed[i]) && opt.indexOf(allowed[i]) < 0) {
          this.fail(`${path}.${allowed[i]}`, '누락 키 = 에러, 기본값 폴백 금지 (§9.3)');
          ok = false;
        }
      }
      return ok;
    },
    vocab(path, v, list) {
      if (list.indexOf(v) < 0) {
        this.fail(path, `동결 어휘 밖의 값 ${JSON.stringify(v)} — 허용 = [${list.join(', ')}] (C-3)`);
        return false;
      }
      return true;
    },
    arr(path, v, len) {
      if (!Array.isArray(v)) { this.fail(path, '배열이 아니다'); return false; }
      if (len !== undefined && v.length !== len) {
        this.fail(path, `${v.length}행 ≠ ${len}행`);
        return false;
      }
      if (len === undefined && v.length === 0) {
        this.fail(path, '0행 — 빈 배열은 통과가 아니다 (인증할 콘텐츠가 없다)');
        return false;
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// 파일별 검증
// ---------------------------------------------------------------------------
function checkRules(c, r) {
  c.closed('rules', r, ['schemaVersion', ...RULES_ROOT_17]);
  c.closed('rules.loop', r.loop, ['tickHz', 'maxStepsPerFrame', 'maxFrameGapMs', 'interpolate']);
  c.closed('rules.view', r.view, ['logicalW', 'logicalH', 'arena', 'panelLeftW', 'panelRightW',
    'bandTopH', 'bandHpH', 'bandXpH', 'playerBoundsInset', 'spawnLineY', 'spawnPadPx', 'minViewportW',
    'minViewportH', 'maxDpr']);
  if (isObj(r.view)) {
    c.closed('rules.view.arena', r.view.arena, ['x', 'y', 'w', 'h']);
    c.closed('rules.view.playerBoundsInset', r.view.playerBoundsInset, ['top', 'bottom', 'left', 'right']);
  }
  c.closed('rules.collide', r.collide, ['gridCellPx']);
  c.closed('rules.caps', r.caps, ['playerBullets', 'enemyBullets', 'enemies', 'pickups', 'zones',
    'drones', 'particles', 'telegraphs', 'terrain', 'overflow']);
  if (isObj(r.caps)) {
    c.closed('rules.caps.overflow', r.caps.overflow, ['playerBullet', 'enemyBullet', 'enemy',
      'pickup', 'zone', 'drone', 'telegraph', 'particle', 'terrain']);
  }
  // ★ §2.1 healPickupPct — 회복 드랍량의 유일한 거처. data 에 0.35 로 착지됨(required).
  c.closed('rules.player', r.player, ['hpMax', 'spriteRadius', 'hitboxRadius', 'moveSpeed',
    'moveResponseTau', 'diagonalNormalize', 'iframeSec', 'defenseBase', 'damageFloorRatio',
    'lowHpThreshold', 'lowHpCriticalThreshold', 'magnetRadius', 'xpDriftPxSec', 'elementSlots',
    'startStance', 'stanceSwitchCooldown', 'stancePersistAcrossStages', 'elementCapPerElement',
    'elementCapTotal', 'weaponSlots', 'passiveSlots', 'lives']);
  c.closed('rules.status', r.status, ['slowMoveSpeedMul', 'actionSlowMul', 'stackMode', 'resistAffects']);
  c.closed('rules.elite', r.elite, ['perWaveMax', 'hpMult', 'sizeMult', 'contactDmgMul', 'xpMult',
    'bandAllowed', 'elementAllowed']);
  c.closed('rules.boss', r.boss, ['partCount', 'partRegen', 'partHitPriority',
    'phaseThresholds', 'phaseTransitionSec', 'timerPausesOnPhaseTransition', 'introSec', 'entryWipeSec',
    'timerStartsAfterIntro', 'timerExpire', 'mobilityPenalty', 'partXpRatio', 'escalateFireRateMul', 'escalateFireRateMax', 'coreElement', 'coreEmitterId',
    'partNormalForbidden', 'partElementDistinctMin', 'partThemeElementMax', 'armorElementNotTheme',
    'armorPartCountRange', 'armorCoreRatioMax', 'optionalPartArmorRatio', 'partReachMinPx',
    'ghostXpRatio', 'midBossSummonsAllowed', 'bossSummonsAllowed', 'finale']);
  if (isObj(r.boss)) {
    c.closed('rules.boss.finale', r.boss.finale, ['partCount', 'armorPartCount', 'exemptRules',
      'allowNormalPeripheral']);
  }
  // §8.21(v1.10 ⑦) 지형 장판 — 피해 0, 조작만 건드린다. 3종의 파라미터. 둔화는 status.slowMoveSpeedMul 을 재사용(새 키 0).
  c.closed('rules.terrain', r.terrain, ['radiusPx', 'scrollSpeedPx', 'everySec', 'spawnIn', 'bossEntryCount', 'fadeSec', 'inertia', 'heat']);   // ㊿-w: 무대 상한은 난이도 표로 옮겼다
  if (isObj(r.terrain) && Array.isArray(r.terrain.spawnIn)) {
    for (let i = 0; i < r.terrain.spawnIn.length; i += 1) c.vocab(`rules.terrain.spawnIn[${i}]`, r.terrain.spawnIn[i], SECTIONS);
  }
  if (isObj(r.terrain)) {
    c.closed('rules.terrain.inertia', r.terrain.inertia, ['responseTauSec']);
    c.closed('rules.terrain.heat', r.terrain.heat, ['fullSec', 'stallSec', 'coolSec']);
  }
  c.closed('rules.fairness', r.fairness, ['minTelegraphSec', 'beamLockSec', 'beamBlockRadiusPx', 'beamBlockRatio', 'minStunTelegraphSec', 'maxStunSec',
    'maxBulletSpeed', 'maxAimedBulletSpeed', 'statusBulletSpeedMul', 'minBulletRadiusPx',
    'minGapWidthPx', 'minSpawnRadiusPx', 'maxSimultaneousEnemyBullets', 'maxBulletAgeSec', 'enemyConcurrentMax', 'introConcurrentMax',
    'swarmConcurrentMax', 'telegraphConcurrentMaxPerEntity',
    'telegraphConcurrentMaxGlobal', 'playerWeaponsExempt']);
  c.closed('rules.hud', r.hud, ['hitboxAlwaysVisible', 'showElementBudget', 'fontHeroPx',
    'fontLargePx', 'fontMediumPx', 'fontBodyPx', 'fontSmallPx', 'panelPadPx', 'keycapBoxPx',
    'bossHpBarH', 'hpBarSegGapPx', 'xpBarH', 'hpBarSegCount', 'panelCacheDirtyOnly',
    'parGhostEnabled', 'elementMatrixInPanel', 'noHitIndicator',
    'stanceHintTargetsMajorityElement', 'icons']);

  // §9.6.1 — family 를 키로 하는 중첩 맵. 12행 동결
  c.closed('rules.passiveHooks', r.passiveHooks, FAMILIES);
  if (isObj(r.passiveHooks)) {
    for (let i = 0; i < FAMILIES.length; i += 1) {
      const f = FAMILIES[i];
      if (!own(r.passiveHooks, f)) continue;
      if (!c.closed(`rules.passiveHooks.${f}`, r.passiveHooks[f], HOOK_KEYS)) continue;   // ㉟ H5·H6 · ㊲ H7 beamKeys · H8 orbitKeys · dmgStat
      const h = r.passiveHooks[f];
      if (h.dmgStat !== null && !c.vocab(`rules.passiveHooks.${f}.dmgStat`, h.dmgStat, DMG_STATS)) continue;
      for (const k of ['speedKeys', 'durationKeys', 'areaKeys', 'beamKeys', 'orbitKeys']) {
        if (!Array.isArray(h[k])) c.fail(`rules.passiveHooks.${f}.${k}`, '배열이어야 한다 (§9.6.1)');
      }
    }
  }

  c.closed('rules.input', r.input, ['layout', 'socd', 'pauseOnBlur', 'bindings']);
  if (isObj(r.input)) {
    c.closed('rules.input.bindings', r.input.bindings, ['move', 'stanceNormal', 'stanceFire',
      'stanceWater', 'stanceGrass', 'pause', 'options', 'draftPick',
      'suppress', 'grab', 'confirm', 'mute', 'cursor']);
  }

  c.closed('rules.palette', r.palette, ['element', 'elementCvd', 'threat', 'status', 'pickup',
    'enemyBody', 'partDestroyed', 'neutralGray', 'hud', 'bg']);
  if (isObj(r.palette)) {
    c.closed('rules.palette.element', r.palette.element, ELEMENTS4);
    c.closed('rules.palette.elementCvd', r.palette.elementCvd, ELEMENTS4);
    c.closed('rules.palette.threat', r.palette.threat, ['enemyBullet', 'telegraph', 'bulletCore', 'outline']);
    c.closed('rules.palette.status', r.palette.status, ['band']);
    c.closed('rules.palette.pickup', r.palette.pickup, ['xp', 'trait']);   // v1.10 ⑲ 특성 구슬(금색 = hud.accent 채널)
    c.closed('rules.palette.hud', r.palette.hud, ['panelBg', 'panelRule', 'textPrimary', 'textDim', 'hpFill', 'accent', 'evolution']);
    c.closed('rules.palette.bg', r.palette.bg, ['maxSaturation', 'maxLightness', 'cvdMaxLightness',
      'parallaxLayers', 'maxScrollSpeed']);
  }

  c.closed('rules.visual', r.visual, ['iframeBlinkHz', 'hpBar', 'stance', 'playerBullet', 'glyph',
    'telegraph', 'band', 'zone', 'terrain', 'wipe', 'timer', 'trail', 'hitFx', 'a11y', 'text', 'dot']);   // v1.10 ㊿-z dot
  if (isObj(r.visual)) {
    c.closed('rules.visual.terrain', r.visual.terrain, ['fillAlpha', 'patternAlpha', 'iconAlpha', 'iconPx', 'heatPulseHz', 'heatWarnAt']);   // §7.13(v1.10 ⑦)
    c.closed('rules.visual.wipe', r.visual.wipe, ['bandPx', 'flashAlpha']);                                          // §8.22(v1.10 ⑧)
    c.closed('rules.visual.hpBar', r.visual.hpBar,
      ['hPx', 'wPx', 'gapPx', 'trackAlpha', 'gatePostWPx', 'gatePostOverhangPx']);
    c.closed('rules.visual.stance', r.visual.stance, ['ringExpandSec', 'ringMaxRadiusPx',
      'ringStrokePx', 'emptyDesatSec', 'dotRadiusPx', 'dotRingPx', 'auraAlpha', 'pipPx', 'pipPxCvd',
      'pipGapPx', 'pipOffsetYPx', 'hintPulseHz', 'hintPulseAlpha']);
    c.closed('rules.visual.playerBullet', r.visual.playerBullet, ['coreRadiusRatio', 'coreLightnessAdd']);
    c.closed('rules.visual.glyph', r.visual.glyph, ['bodyRatio', 'maxPx', 'occludedSkip',
      'lodMinBodyPx', 'lodDegradedBodyPx']);
    c.closed('rules.visual.telegraph', r.visual.telegraph, ['strokePx', 'dashPx', 'dashTightenAtPct',
      'dashTightenMul', 'airAlpha', 'fillAlpha', 'emphasisBySpeed']);
    c.closed('rules.visual.band', r.visual.band, ['plateAlpha', 'contentOpaque']);
    c.closed('rules.visual.zone', r.visual.zone, ['fillAlpha', 'pulseHz']);
    c.closed('rules.visual.timer', r.visual.timer, ['warnScale', 'warnPulseHz', 'alertScale', 'alertPulseHz']);
    c.closed('rules.visual.trail', r.visual.trail, ['ghostCount', 'ghostAlpha']);
    c.closed('rules.visual.hitFx', r.visual.hitFx, ['numberTargets', 'numberAggregateSec',
      'numberMinPx', 'numberOutlinePx', 'numberLifeSec', 'numberDriftPx', 'markerPolicy',
      'markerCooldownSecPerEntity', 'superFreezeSec', 'superFreezeScale', 'resistArcSweepDeg',
      'resistArcLifeSec', 'resistArcStrokePx', 'particles']);
    if (isObj(r.visual.hitFx)) {
      c.closed('rules.visual.hitFx.particles', r.visual.hitFx.particles, ['super', 'neutral', 'resist']);
    }
    c.closed('rules.visual.a11y', r.visual.a11y, ['cbMode', 'reduceFlash', 'screenShake',
      'shakeMaxPx', 'fullscreenFlashMaxPerSec', 'fullscreenFlashMaxAlpha']);
    c.closed('rules.visual.text', r.visual.text, ['family', 'minPx', 'outlinePx']);
    c.closed('rules.visual.dot', r.visual.dot, ['logoScale', 'titleSubScale', 'titlePromptScale', 'logoSlant', 'logoTopTint', 'logoBottomShade']);   // §7.9.1(v1.10 ㊿-z · ㊿-z3)
  }

  c.closed('rules.render', r.render, ['playerFxCompositeAlpha', 'killFxCompositeAlpha',
    'playerBulletMaxAlpha', 'playerBulletMaxRadiusPx', 'playerBulletDensityRef', 'playerBulletMinAlpha', 'particleMaxAlpha', 'particleMaxLifeSec',
    'fxMinRealMs', 'targetFps', 'degradeOnFrameMs', 'degradeRecoverFrames']);
  c.closed('rules.audio', r.audio, ['busGain', 'cueRateLimitPerSec']);
  if (isObj(r.audio)) c.closed('rules.audio.busGain', r.audio.busGain, ['sfx', 'bgm']);

  // §4.3 · §2.6 — 어휘 검사
  if (isObj(r.player)) {
    c.vocab('rules.player.startStance', r.player.startStance, ELEMENTS4);
  }
}

function checkElements(c, e) {
  // §9.4.4
  c.closed('elements', e, ['schemaVersion', 'order', 'investable', 'matrix']);
  if (!c.arr('elements.order', e.order, 4)) return;
  for (let i = 0; i < ELEMENTS4.length; i += 1) {
    if (e.order[i] !== ELEMENTS4[i]) {
      c.fail(`elements.order[${i}]`,
        `${JSON.stringify(e.order[i])} ≠ "${ELEMENTS4[i]}" — §4.1 "표 순서 = 키 순서 = Q(노말) W(불) E(물) R(풀)"`);
    }
  }
  // §4.2 — 노말은 투자축이 아니다
  if (Array.isArray(e.investable) && e.investable.indexOf('normal') >= 0) {
    c.fail('elements.investable', '"normal" 이 들어 있다 — §4.2 "노말은 투자축이 아니다"');
  }
  // §4.1 — 4×4 완전 행렬
  c.closed('elements.matrix', e.matrix, ELEMENTS4);
  if (isObj(e.matrix)) {
    for (let i = 0; i < ELEMENTS4.length; i += 1) {
      c.closed(`elements.matrix.${ELEMENTS4[i]}`, e.matrix[ELEMENTS4[i]], ELEMENTS4);
    }
  }
}

function checkWeapons(c, w) {
  c.closed('weapons', w, ['schemaVersion', 'weapons']);
  if (!c.arr('weapons.weapons', w.weapons, FAMILIES.length)) return;   // ㉟ 15종 · ㊵ 14종(FAMILIES 가 소유)
  for (let i = 0; i < w.weapons.length; i += 1) {
    const it = w.weapons[i];
    const p = `weapons[${it && it.id}]`;
    if (!c.closed(p, it, ['id', 'family', 'name', 'desc', 'elementStampMode', 'slotClass', 'class', 'base', 'levels', 'evolution'])) continue;
    c.vocab(`${p}.class`, it.class, WEAPON_CLASSES);   // ㊵ §9.5 무기 분류 — 패시브 분류(§9.6)와 짝. 훅 표와의 정합은 S34 가 본다.
    if (!c.vocab(`${p}.family`, it.family, FAMILIES)) continue;
    // §9.5 — id == family (12종 1:1)
    if (it.id !== it.family) c.fail(p, `id ≠ family(${it.family}) — §9.5 "id == family"`);
    // §4.4 — 구조 결정 = 잠금 키
    const wantStamp = STAMP_LIVE.indexOf(it.family) >= 0 ? 'live' : 'spawn';
    if (it.elementStampMode !== wantStamp) {
      c.fail(`${p}.elementStampMode`, `${JSON.stringify(it.elementStampMode)} ≠ "${wantStamp}" — §4.4/§9.5 표`);
    }
    // §9.5 — base 의 키 집합 == 그 family 의 계약 (미지 = 에러 / 누락 = 에러)
    const baseKeys = FAMILY_BASE_KEYS[it.family];
    c.closed(`${p}.base`, it.base, baseKeys);
    // §9.5 — targetMode 어휘
    const modes = FAMILY_TARGET_MODES[it.family];
    if (modes !== null && isObj(it.base) && own(it.base, 'targetMode')) {
      c.vocab(`${p}.base.targetMode`, it.base.targetMode, modes);
    }
    // §9.3 — levels 는 정확히 10행(v1.10 ⑱ · ~~8~~). 유일한 부분 오버라이드 예외. Lv8 = 진화, Lv9·10 = 진화체 강화
    if (c.arr(`${p}.levels`, it.levels, WEAPON_MAX_LEVEL)) {
      for (let j = 0; j < WEAPON_MAX_LEVEL; j += 1) {
        const row = it.levels[j];
        if (!isObj(row)) { c.fail(`${p}.levels[${j}]`, '객체가 아니다 (빈 객체 {} 는 로드되지만 levels[0] 밖이면 S64 위반 — Lv2~10 은 카드에 보이는 값을 하나 이상 바꾼다)'); continue; }
        const rk = Object.keys(row);
        for (let k = 0; k < rk.length; k += 1) {
          // 행에 등장하는 키는 반드시 그 패밀리의 계약 안이어야 한다 (§9.3)
          if (baseKeys.indexOf(rk[k]) < 0) {
            c.fail(`${p}.levels[${j}].${rk[k]}`,
              '계약 밖의 키 = 미지 키 = 에러 (§9.3 — levels[i] 는 base 에 대한 부분 오버라이드다)');
          }
        }
      }
    }
    // §9.5 — evolution.params 의 키 집합 == 그 family 의 evo* 목록
    if (c.closed(`${p}.evolution`, it.evolution, ['name', 'desc', 'params', 'requiresPassive'])) {
      c.closed(`${p}.evolution.params`, it.evolution.params, FAMILY_EVO_KEYS[it.family]);
      // §9.5(v1.5) — 진화 짝 패시브 (뱀서식). 의미 검증은 check.mjs S41.
      if (it.evolution.requiresPassive !== undefined) {
        c.closed(`${p}.evolution.requiresPassive`, it.evolution.requiresPassive, ['id', 'level']);
      }
    }
  }
}

function checkPassives(c, ps) {
  c.closed('passives', ps, ['schemaVersion', 'maxLevel', 'stats', 'passives']);
  // §9.6 — 폐쇄 스탯 어휘 11종. 전수 일치 (순서는 정본의 인쇄 순서를 따르지 않아도 된다)
  //   v1.5: salvage(coinGainMul) 제거 = 경제 폐지 → 12→11
  if (c.arr('passives.stats', ps.stats, PASSIVE_STATS.length)) {
    for (let i = 0; i < ps.stats.length; i += 1) c.vocab(`passives.stats[${i}]`, ps.stats[i], PASSIVE_STATS);
    for (let i = 0; i < PASSIVE_STATS.length; i += 1) {
      if (ps.stats.indexOf(PASSIVE_STATS[i]) < 0) {
        c.fail('passives.stats', `"${PASSIVE_STATS[i]}" 누락 — §9.6 폐쇄 어휘 ${PASSIVE_STATS.length}종`);
      }
    }
  }
  if (!c.arr('passives.passives', ps.passives, PASSIVE_STATS.length)) return;
  const seen = [];
  for (let i = 0; i < ps.passives.length; i += 1) {
    const it = ps.passives[i];
    const p = `passives[${it && it.id}]`;
    if (!c.closed(p, it, ['id', 'name', 'desc', 'stat', 'values'])) continue;
    // §9.6 — 각 패시브 = 엔진 훅 정확히 1개. 11훅 = 11 패시브 1:1 (v1.5: salvage 제거)
    if (!c.vocab(`${p}.stat`, it.stat, PASSIVE_STATS)) continue;
    if (seen.indexOf(it.stat) >= 0) c.fail(p, `stat "${it.stat}" 중복 — §9.6 "11훅 = 11 패시브 1:1"`);
    seen.push(it.stat);
    // §9.6 — values 는 정확히 maxLevel 행. 각 레벨의 **절대 총량**이지 증분이 아니다
    c.arr(`${p}.values`, it.values, ps.maxLevel);
  }
}

function checkBullets(c, b) {
  c.closed('bullets', b, ['schemaVersion', 'bullets']);
  if (!c.arr('bullets.bullets', b.bullets)) return;
  for (let i = 0; i < b.bullets.length; i += 1) {
    const it = b.bullets[i];
    // §9.7 — element 키가 존재하지 않는다. 스키마가 "적의 공격에는 속성이 없다"를 강제한다 (§4.1)
    c.closed(`bullets[${it && it.id}]`, it, ['id', 'radius', 'hitboxScale', 'dmg', 'shape',
      'status', 'statusDurationSec', 'accel', 'turnRateDegSec', 'retargetSec', 'waveAmp', 'waveHz',
        'bounceLeft', 'homingSec'], ['bounceLeft', 'homingSec']);   // §8.5(v1.7) 반사는 선택 키 — 미선언 = 반사 없음
  }
}

function checkEnemies(c, e) {
  c.closed('enemies', e, ['schemaVersion', 'bands', 'archetypes', 'emitters']);
  c.closed('enemies.bands', e.bands, BANDS);
  if (isObj(e.bands)) {
    for (let i = 0; i < BANDS.length; i += 1) {
      const bn = BANDS[i];
      if (!own(e.bands, bn)) continue;
      // §9.7 — xpRef 는 chaff 밴드 전용 필드다
      c.closed(`enemies.bands.${bn}`, e.bands[bn],
        bn === 'chaff' ? ['hpMult', 'xpRef', 'minPerWave'] : ['hpMult', 'minPerWave']);
    }
  }
  if (c.arr('enemies.archetypes', e.archetypes)) {
    for (let i = 0; i < e.archetypes.length; i += 1) {
      const a = e.archetypes[i];
      const p = `enemies.archetypes[${a && a.id}]`;
      // §8.6 — element 는 아키타입 필드가 아니다. 웨이브 편성이 주입한다
      // §8.17(v1.7) 적 개성 3종 = 선택 키(§8.11 sealLayer 규약). 미선언 = 기본값.
      if (!c.closed(p, a, ['id', 'name', 'desc', 'band', 'shapeId', 'radius', 'moveId',
        'moveParams', 'attack', 'contactDmg', 'hp', 'xp', 'score', 'themeOnly',
        'hitFloorSec', 'pierceCost', 'ccImmune'], ['hitFloorSec', 'pierceCost', 'ccImmune'])) continue;
      c.vocab(`${p}.band`, a.band, BANDS);
      if (a.attack !== null) c.closed(`${p}.attack`, a.attack, ['emitterId', 'firstDelaySec']);
    }
  }
  if (c.arr('enemies.emitters', e.emitters)) {
    for (let i = 0; i < e.emitters.length; i += 1) {
      const em = e.emitters[i];
      const p = `enemies.emitters[${em && em.id}]`;
      if (!isObj(em)) { c.fail(p, '객체가 아니다'); continue; }
      if (!c.vocab(`${p}.type`, em.type, EMITTER_TYPES)) continue;
      c.closed(p, em, [...EMIT_COMMON, ...EMIT_OWN[em.type]]);
    }
  }
}

function checkBosses(c, b) {
  c.closed('bosses', b, ['schemaVersion', 'bosses']);
  if (!c.arr('bosses.bosses', b.bosses)) return;
  for (let i = 0; i < b.bosses.length; i += 1) {
    const it = b.bosses[i];
    const p = `bosses[${it && it.id}]`;
    if (!isObj(it)) { c.fail(p, '객체가 아니다'); continue; }
    if (!c.vocab(`${p}.tier`, it.tier, BOSS_TIERS)) continue;
    if (it.tier === 'mid') {
      // §9.8.2 — 중간보스에는 core 가 없다. hp·element 가 루트 필드다
      c.closed(p, it, ['id', 'name', 'tier', 'themeId', 'hp', 'element', 'radius', 'contactDmg',
        'shapeId', 'moveId', 'moveParams', 'patternSet', 'summon', 'parts', 'xp', 'score']);
    } else {
      // §9.8 — 스테이지·최종 보스
      c.closed(p, it, ['id', 'name', 'tier', 'themeId', 'armorCoreRatio', 'core', 'parts',
        'movePattern', 'movePatternParams', 'summon']);
      if (isObj(it.core)) {
        c.closed(`${p}.core`, it.core, ['element', 'hp', 'radius', 'contactDmg', 'shapeId', 'score']);
      }
      if (isObj(it.movePatternParams)) {
        c.closed(`${p}.movePatternParams`, it.movePatternParams, ['speedPxSec', 'ampPx', 'yHoldPx']);
      }
      if (Array.isArray(it.parts)) {
        for (let j = 0; j < it.parts.length; j += 1) {
          const pt = it.parts[j];
          c.closed(`${p}.parts[${pt && pt.id}]`, pt, ['id', 'name', 'partType', 'element', 'hp',
            'radius', 'anchor', 'contactDmg', 'shapeId', 'score', 'patternSet', 'extra', 'sealLayer'], ['extra', 'sealLayer']);
        }
      }
    }
    if (isObj(it.summon)) {
      c.closed(`${p}.summon`, it.summon, ['archetypeId', 'count', 'everySec', 'formationId', 'ghost'], ['ghost']);
    }
  }
}

function checkStages(c, s) {
  c.closed('stages', s, ['schemaVersion', 'theme', 'themeDraw', 'curve', 'phase', 'stages', 'formations']);
  // §8.2 ③(v1.10 ㉔) 테마 밖 속성의 HP 배율 — (0, 1]. 1 = 차이 없음(항은 존재하고 값만 바뀐다, C-4)
  if (isObj(s.theme)) {
    c.closed('stages.theme', s.theme, ['offThemeHpMul']);
    if (typeof s.theme.offThemeHpMul !== 'number' || !(s.theme.offThemeHpMul > 0) || s.theme.offThemeHpMul > 1) c.fail('stages.theme.offThemeHpMul', '(0, 1] 이어야 한다 (§8.2 ③)');
  } else c.fail('stages.theme', '객체가 아니다 (§8.2 ③)');
  c.closed('stages.themeDraw', s.themeDraw, ['pool', 'count', 'allowRepeat', 'stage1RequiresIntroOk', 'finalStageId']);
  c.closed('stages.curve', s.curve, ['enemyHpScale', 'xpScale', 'bossHpScale', 'midBossHpScale', 'bossBulletScale', 'firingPartsPerStage',
    'spawnDensityScale', 'mobFireRateScale', 'mobBulletDmgScale', 'midBossCount', 'elitePerWaveChance', 'swarmTotalScale', 'crisisHpScale', 'rearSpawnAllowed',
    'shooterRatio', 'threatBudgetScale']);
  c.closed('stages.phase', s.phase, ['mobPhaseSec', 'mobPhaseSkippable', 'mobPhaseMaxWaves',
    'waveIntervalSec', 'waveClearAdvance',
    'phaseEndAutocollect', 'enemyExitForfeitsReward', 'waveListExhausted', 'crisisPerStage',
    'crisisStartSec', 'crisisCycleSec', 'crisisSuspendsWaves', 'crisisSwarmLoop', 'crisisOnMidBossClear', 'crisisTotal', 'crisisShooterId',
    'crisisSubWaves', 'crisisWaves', 'introFormationId', 'sectionSpeedMul', 'earlyWaveIntervalSec', 'earlyDrainSec', 'midBossSuspendsWaves', 'midBossAtSec', 'midBossOnFieldClear', 'midBossFirstId', 'midBossElementRule',
    'midBossForcedLeaveOnCrisis', 'bossTimerSec', 'timerWarnSec', 'timerRedAlertSec',
    'statusStunMaxPerStage']);
  if (isObj(s.phase) && Array.isArray(s.phase.crisisWaves)) {
    for (let i = 0; i < s.phase.crisisWaves.length; i += 1) {
      c.closed(`stages.phase.crisisWaves[${i}]`, s.phase.crisisWaves[i],
        ['subWave', 'formationId', 'bodyId', 'count', 'spawnEdge']);   // v1.10 ⑫ bodyId(서브웨이브의 몸 종) · 공격형은 phase.crisisShooterId + 봉지
    }
  }
  // §9.9.2 — 편대 6종 + 파라미터
  if (isObj(s.phase) && own(s.phase, 'sectionSpeedMul')) c.closed('stages.phase.sectionSpeedMul', s.phase.sectionSpeedMul, ['early', 'mid', 'crisis']);
  c.closed('stages.formations', s.formations, FORMATION_IDS);
  const FORM_PARAMS = {
    lineH: ['gapPx'], vWedge: ['gapPx', 'angleDeg'],
    arc: ['radiusPx', 'spanDeg', 'flatten', 'minSepPx'], scatter: ['jitterPx', 'minSepPx'],
    wall: ['gapPx', 'rowGapPx', 'perRow', 'laneSlots', 'laneStrideCols', 'jitterY'],
  };
  if (isObj(s.formations)) {
    for (let i = 0; i < FORMATION_IDS.length; i += 1) {
      const f = FORMATION_IDS[i];
      if (own(s.formations, f)) c.closed(`stages.formations.${f}`, s.formations[f], FORM_PARAMS[f]);
    }
  }
  if (!c.arr('stages.stages', s.stages)) return;
  for (let i = 0; i < s.stages.length; i += 1) {
    const t = s.stages[i];
    const p = `stages.stages[${t && t.id}]`;
    if (!c.closed(p, t, ['id', 'name', 'element', 'introOk', 'bossId', 'crisisElementRule',
      'introArchetypeId', 'terrainKind', 'roster', 'mix', 'waves'])) continue;
    if (own(t, 'terrainKind') && t.terrainKind !== null) c.vocab(`stages.stages[${i}].terrainKind`, t.terrainKind, TERRAIN_KIND_VALUES);   // null = 지형 없음 · mixed = finale 순환(§8.21 ③)
    if (c.arr(`${p}.roster`, t.roster)) {
      for (let j = 0; j < t.roster.length; j += 1) {
        c.closed(`${p}.roster[${j}]`, t.roster[j], ['archetypeId', 'unlockStageMin']);
      }
    }
    if (c.arr(`${p}.waves`, t.waves)) {
      for (let j = 0; j < t.waves.length; j += 1) {
        c.closed(`${p}.waves[${j}]`, t.waves[j], ['formationId', 'archetypeId', 'count',
          'spawnEdge', 'eliteIndex', 'unlockStageMin']);
      }
    }
  }
}

/** §6.7(v1.10 ㊴) tutorial.json — 체험형 튜토리얼의 스텝 목록. 닫힌 키 · 닫힌 목표 어휘 · 참조 무결성. */
function checkTutorial(c, t) {
  c.closed('tutorial', t, ['schemaVersion', 'startWeaponId', 'spawnYPx', 'spawnGapPx', 'hpMul', 'safeHpFloor', 'terrainDwellSec', 'completeHoldSec', 'steps']);   // v1.10 ㊿-z5 terrainDwellSec
  if (typeof t.completeHoldSec !== 'number' || !(t.completeHoldSec > 0)) c.fail('tutorial.completeHoldSec', '양수여야 한다');
  //   §6.7(v1.10 ㊿-z5) 지형은 «밟았는가»가 아니라 «머물렀는가»로 센다 — 스쳐 지나가면 효과를 못 느낀다.
  if (typeof t.terrainDwellSec !== 'number' || !(t.terrainDwellSec > 0)) c.fail('tutorial.terrainDwellSec', '양수여야 한다');
  if (typeof t.startWeaponId !== 'string' || t.startWeaponId === '') c.fail('tutorial.startWeaponId', '빈 문자열 — 튜토리얼의 시작 무기는 고정이다(§6.7)');
  for (const k of ['spawnYPx', 'spawnGapPx']) if (typeof t[k] !== 'number' || !(t[k] > 0)) c.fail(`tutorial.${k}`, '양수여야 한다');
  for (const k of ['hpMul', 'safeHpFloor']) if (typeof t[k] !== 'number' || !(t[k] > 0) || t[k] > 1) c.fail(`tutorial.${k}`, '(0, 1] 이어야 한다');
  if (!Array.isArray(t.steps) || t.steps.length === 0) { c.fail('tutorial.steps', '비어 있지 않은 배열이어야 한다'); return; }
  const ids = new Set();
  for (let i = 0; i < t.steps.length; i += 1) {
    const st = t.steps[i];
    const p = `tutorial.steps[${i}]`;
    if (!c.closed(p, st, ['id', 'minSec', 'title', 'lines', 'goal', 'spawn', 'grant', 'reset', 'pickup'])) continue;   // v1.10 ㊿-z5 minSec
    for (const k of ['id', 'title']) if (typeof st[k] !== 'string' || st[k] === '') c.fail(`${p}.${k}`, '빈 문자열');
    for (const k of ['reset', 'pickup']) if (typeof st[k] !== 'boolean') c.fail(`${p}.${k}`, '불리언이어야 한다(§9.3 — 누락 키는 에러)');
    //   §6.7(v1.10 ㊿-z5) 목표를 일찍 채워도 이만큼은 머문다 — 글을 읽을 시간이 없으면 안내가 안내가 아니다.
    if (typeof st.minSec !== 'number' || !(st.minSec >= 0)) c.fail(`${p}.minSec`, '0 이상의 수여야 한다');
    if (!Array.isArray(st.lines) || st.lines.length === 0 || st.lines.length > 3) c.fail(`${p}.lines`, '1~3줄의 배열이어야 한다');
    else for (let k = 0; k < st.lines.length; k += 1) if (typeof st.lines[k] !== 'string' || st.lines[k] === '') c.fail(`${p}.lines[${k}]`, '빈 문자열');
    if (ids.has(st.id)) c.fail(`${p}.id`, `중복 id "${st.id}"`);
    ids.add(st.id);
    if (c.closed(`${p}.goal`, st.goal, ['kind', 'value'])) {
      c.vocab(`${p}.goal.kind`, st.goal.kind, TUTORIAL_GOALS);
      if (typeof st.goal.value !== 'number' || st.goal.value < 0) c.fail(`${p}.goal.value`, '0 이상의 수여야 한다');
    }
    if (!Array.isArray(st.spawn)) { c.fail(`${p}.spawn`, '배열이어야 한다'); continue; }
    for (let k = 0; k < st.spawn.length; k += 1) {
      const sp = st.spawn[k];
      if (!c.closed(`${p}.spawn[${k}]`, sp, ['archetypeId', 'element', 'count'])) continue;
      c.vocab(`${p}.spawn[${k}].element`, sp.element, ELEMENTS4);
      if (!Number.isInteger(sp.count) || sp.count < 1) c.fail(`${p}.spawn[${k}].count`, '1 이상의 정수여야 한다');
    }
    // grant = 없으면 **null**(§9.3 — 누락 키는 에러다. «없음»도 저작한다). invest = 속성 배열(각 1투자).
    if (st.grant !== null && c.closed(`${p}.grant`, st.grant, ['invest'])) {
      if (!Array.isArray(st.grant.invest) || st.grant.invest.length === 0 || st.grant.invest.length > 3) c.fail(`${p}.grant.invest`, '1~3개의 속성 배열이어야 한다');
      else for (let k = 0; k < st.grant.invest.length; k += 1) c.vocab(`${p}.grant.invest[${k}]`, st.grant.invest[k], ELEMENTS4);
    }
  }
}

/** §11.6(v1.10 ⑲) traits.json — 특성(보스 처치 보상). 닫힌 키 · 어휘 · 값 범위. */
function checkTraits(c, t) {
  c.closed('traits', t, ['schemaVersion', 'maxLevel', 'traits']);
  if (!Number.isInteger(t.maxLevel) || t.maxLevel < 1) c.fail('traits.maxLevel', '양의 정수여야 한다 (= 한 런의 구슬 수, §11.6)');
  if (!Array.isArray(t.traits)) { c.fail('traits.traits', '배열이 아니다'); return; }
  const ids = new Set();
  const kinds = new Set();
  for (let i = 0; i < t.traits.length; i += 1) {
    const x = t.traits[i];
    const p = `traits.traits[${i}]`;
    c.closed(p, x, ['id', 'name', 'desc', 'effect']);
    if (typeof x.id !== 'string' || x.id === '') c.fail(`${p}.id`, '빈 문자열');
    if (ids.has(x.id)) c.fail(`${p}.id`, `중복 id "${x.id}"`);
    ids.add(x.id);
    if (!isObj(x.effect)) { c.fail(`${p}.effect`, '객체가 아니다'); continue; }
    const extra = TRAIT_EFFECT_EXTRA[x.effect.kind] || [];
    c.closed(`${p}.effect`, x.effect, ['kind', 'values', ...extra]);
    for (const k of extra) if (typeof x.effect[k] !== 'number' || !(x.effect[k] > 0) || x.effect[k] > 1) c.fail(`${p}.effect.${k}`, '(0, 1] 이어야 한다');
    c.vocab(`${p}.effect.kind`, x.effect.kind, TRAIT_EFFECT_KINDS);
    if (kinds.has(x.effect.kind)) c.fail(`${p}.effect.kind`, `"${x.effect.kind}" 를 쓰는 특성이 둘 — 효과와 특성은 1:1 (§11.6)`);
    kinds.add(x.effect.kind);
    // values = 레벨별 절대값(패시브 §9.6 과 같은 규약: 증분이 아니다). 길이 = maxLevel, 전부 양수
    if (c.arr(`${p}.effect.values`, x.effect.values, t.maxLevel)) {
      for (let k = 0; k < x.effect.values.length; k += 1) if (typeof x.effect.values[k] !== 'number' || !(x.effect.values[k] > 0)) c.fail(`${p}.effect.values[${k}]`, '양수여야 한다');
    }
  }
}

function checkMeta(c, m) {
  c.closed('meta', m, ['schemaVersion', 'xp', 'draft', 'score', 'flow', 'onboarding',
    'difficulty', 'bot', 'certify']);
  c.closed('meta.xp', m.xp, ['curve', 'base', 'exp', 'levelUpsPerRunTarget', 'levelUpQueueMode']);
  if (isObj(m.draft)) {
    c.closed('meta.draft', m.draft, ['optionCount', 'slotAssign', 'categoryWeights',
      'newWeaponSlotScale', 'weaponLevelEvolutionBonus', 'elementFirstLevelBonus', 'passiveNewBonus',
      'distinctItemsPerDraft', 'filterInvalid', 'newWeaponWhenSlotsFull',
      'elementLevelOfferRequiresWeaponCount', 'guaranteeElementCardOnFirstDraft',
      'guaranteeNewWeaponUntilSlots', 'elementCardPity', 'fallback', 'pauseGame']);
    c.closed('meta.draft.categoryWeights', m.draft.categoryWeights,
      ['newWeapon', 'weaponLevel', 'elementLevel', 'passive']);
    c.closed('meta.draft.fallback', m.draft.fallback, ['id', 'name', 'healPct']);
  }
  c.closed('meta.score', m.score, ['superEffectiveDamageShare', 'superEffectiveKillBonusRatio',
    'attribution', 'timeBonusPerGameSec', 'bossClearBonus', 'midBossClearBonus', 'runClearBonus',
    'noHitScope', 'stageNoHitBonus', 'perfectScope', 'perfectBonus', 'roundMode']);
  c.closed('meta.onboarding', m.onboarding, ['autoEquipFirstElement', 'stanceHintPulse', 'stanceHintPulseStageMax']);
  if (isObj(m.flow)) {
    c.closed('meta.flow', m.flow, ['themeBannerSec', 'stageClearSec', 'healSec', 'stageClearHealPct',
      'pauseResumeCountdownSec', 'attractIdleSec', 'menuSpeed', 'deathAnimSec',
      'edgeTriggerOnStateEnter', 'pauseAllowsAbandon', 'attract', 'stagePar']);
    c.closed('meta.flow.attract', m.flow.attract, ['difficulty', 'draftDwellSec', 'endAfterMobPhase']);
    // ㊿-s — 어트랙트 설정은 «값»까지 본다(검토 재현: 난이도 id 오타 하나가 타이틀을 매 프레임 예외 → 검은 화면으로 만들었다).
    const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
    if (!posNum(m.flow.attractIdleSec)) c.fail('meta.flow.attractIdleSec', '유한한 양수(초)여야 한다 (§6.5 ㊿-s)');
    if (isObj(m.flow.attract)) {
      const tiers = isObj(m.difficulty) ? Object.keys(m.difficulty).filter((k) => isObj(m.difficulty[k])) : [];
      if (tiers.indexOf(m.flow.attract.difficulty) < 0) c.fail('meta.flow.attract.difficulty', `난이도 id 여야 한다 (${tiers.join(' · ')}) (§6.5 ㊿-s)`);
      if (!posNum(m.flow.attract.draftDwellSec)) c.fail('meta.flow.attract.draftDwellSec', '유한한 양수(게임초)여야 한다 (§6.5 ㊿-s)');
      if (typeof m.flow.attract.endAfterMobPhase !== 'boolean') c.fail('meta.flow.attract.endAfterMobPhase', '불리언이어야 한다 (§6.5 ㊿-s)');
    }
  }
  if (isObj(m.difficulty)) {
    // ★ v1.10 ㊿ — 「디재스터」 삭제 · hpMul 신설(난이도 = 적 체력, §11.3).
    //   ㊿-c: evolutionsExpected 삭제 — 화면에서 뺐더니 읽는 곳이 0 이 됐다(죽은 키). 설계 의도는 정본이 소유한다.
    //   ㊿-q: enemyDmgMul 신설 — 난이도 공격력 배율(적 → 플레이어 피해 전부, 기준선 = 노멀, §3.2 · §11.3).
    c.closed('meta.difficulty', m.difficulty, ['normal', 'hard', 'hell', 'stunMinDifficulty']);
    const ds = ['normal', 'hard', 'hell'];
    for (let i = 0; i < ds.length; i += 1) {
      if (own(m.difficulty, ds[i])) {
        c.closed(`meta.difficulty.${ds[i]}`, m.difficulty[ds[i]], ['speed', 'scoreMul', 'hpMul', 'enemyDmgMul', 'enemyFireRateMul', 'terrainMaxOnScreen']);   // v1.10 ㊿-z6 enemyFireRateMul
      }
    }
  }
  if (isObj(m.bot)) {
    // §10.4 — grazeTolerancePx 는 삭제됐다 (§2.3 "그레이즈 없음")
    c.closed('meta.bot', m.bot, ['reactionMs', 'reactionJitterMs', 'stanceSwitchMs',
      'dodgeLookaheadSec', 'dodgePerceptionMs', 'aimErrorPx', 'policies', 'baseline', 'probes']);
    c.closed('meta.bot.policies', m.bot.policies, ['draft', 'farm', 'stance']);
    c.closed('meta.bot.baseline', m.bot.baseline, ['draft', 'farm', 'stance']);
    c.closed('meta.bot.probes', m.bot.probes, ['dpsProbe', 'forceNoElement']);
  }
  // certify 의 하위 트리는 tools/sim.mjs 의 소유다 (§13.1). 로더는 존재만 요구한다.
  if (!isObj(m.certify)) c.fail('meta.certify', '객체가 아니다 (§13.1)');
}

// ---------------------------------------------------------------------------
// §9.3 — 참조 무결성: 모든 *Id 는 로드 시 대상 존재 확인
// ---------------------------------------------------------------------------
function idList(arr) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i < arr.length; i += 1) if (isObj(arr[i])) out.push(arr[i].id);
  return out;
}

function checkRefs(c, d) {
  const archIds = idList(d.enemies.archetypes);
  const emitIds = idList(d.enemies.emitters);
  const bulletIds = idList(d.bullets.bullets);
  const bossIds = idList(d.bosses.bosses);
  const weaponIds = idList(d.weapons.weapons);
  const stageIds = idList(d.stages.stages);
  const formIds = isObj(d.stages.formations) ? Object.keys(d.stages.formations) : [];

  const need = (list, id, where) => {
    if (id === null || id === undefined) return;
    if (list.indexOf(id) < 0) c.fail(where, `참조 무결성 실패 — "${id}" 가 존재하지 않는다 (§9.3)`);
  };

  // §6.7 ㊴ — 튜토리얼이 부르는 아키타입·시작 무기는 실재해야 한다
  if (isObj(d.tutorial)) need(weaponIds, d.tutorial.startWeaponId, 'tutorial.startWeaponId');
  if (isObj(d.tutorial) && Array.isArray(d.tutorial.steps)) {
    for (let i = 0; i < d.tutorial.steps.length; i += 1) {
      const st = d.tutorial.steps[i];
      if (!isObj(st) || !Array.isArray(st.spawn)) continue;
      for (let k = 0; k < st.spawn.length; k += 1) need(archIds, st.spawn[k].archetypeId, `tutorial.steps[${i}].spawn[${k}].archetypeId`);
    }
  }

  for (let i = 0; i < d.enemies.archetypes.length; i += 1) {
    const a = d.enemies.archetypes[i];
    if (!isObj(a)) continue;
    if (isObj(a.attack)) need(emitIds, a.attack.emitterId, `enemies.archetypes[${a.id}].attack.emitterId`);
    if (a.themeOnly !== null) need(stageIds, a.themeOnly, `enemies.archetypes[${a.id}].themeOnly`);
  }
  for (let i = 0; i < d.enemies.emitters.length; i += 1) {
    const e = d.enemies.emitters[i];
    if (isObj(e) && e.bulletId !== null) need(bulletIds, e.bulletId, `enemies.emitters[${e.id}].bulletId`);
  }
  for (let i = 0; i < d.stages.stages.length; i += 1) {
    const t = d.stages.stages[i];
    if (!isObj(t)) continue;
    need(bossIds, t.bossId, `stages.stages[${t.id}].bossId`);
    // §8.19 — 도입 침묵의 «내용». 없는 아키타입을 가리키면 로드 실패(폴백 금지)
    need(archIds, t.introArchetypeId, `stages.stages[${t.id}].introArchetypeId`);
    for (let j = 0; Array.isArray(t.roster) && j < t.roster.length; j += 1) {
      need(archIds, t.roster[j].archetypeId, `stages.stages[${t.id}].roster[${j}].archetypeId`);
    }
    for (let j = 0; Array.isArray(t.waves) && j < t.waves.length; j += 1) {
      need(archIds, t.waves[j].archetypeId, `stages.stages[${t.id}].waves[${j}].archetypeId`);
      need(formIds, t.waves[j].formationId, `stages.stages[${t.id}].waves[${j}].formationId`);
      // v1.10 ⑬ — 웨이브는 속성을 주입하지 않는다(몸마다 stages[].mix 봉지, §8.2). waves[].element 는 삭제됐다.
    }
  }
  need(stageIds, d.stages.themeDraw.finalStageId, 'stages.themeDraw.finalStageId');
}

// ---------------------------------------------------------------------------
// §9.3 — "모든 이미터가 rules.fairness 통과 필수. 위반 → 로드 실패"
//   §12.4 (각 하나의 값) + §7.4 (텔레그래프 하한 3축, 겹치면 max)
//   ★ 플레이어 무기는 대상이 아니다 (fairness.playerWeaponsExempt, §9.5)
// ---------------------------------------------------------------------------
function checkFairness(c, d) {
  const f = d.rules.fairness;
  if (f.playerWeaponsExempt !== true) {
    c.fail('rules.fairness.playerWeaponsExempt',
      `${f.playerWeaponsExempt} ≠ true — §9.5 "플레이어 무기는 fairness 의 대상이 아니다"`);
  }
  const bullets = d.bullets.bullets;
  const findBullet = (id) => {
    for (let i = 0; i < bullets.length; i += 1) if (bullets[i].id === id) return bullets[i];
    return null;
  };
  for (let i = 0; i < d.enemies.emitters.length; i += 1) {
    const e = d.enemies.emitters[i];
    if (!isObj(e)) continue;
    const p = `enemies.emitters[${e.id}]`;
    const b = e.bulletId === null ? null : findBullet(e.bulletId);

    // (1) §7.4 — 텔레그래프 하한. 절대 하한 + 거동별 + 탄 상태. 겹치면 max
    //     ★ 개체 클래스 축(중간보스 1.20 · 보스 부위 1.50)은 이미터가 아니라 **참조자**가
    //       결정한다 → 전수 검사는 tools/check.mjs S6 이 소유한다 (로더는 이미터 로컬 축만).
    let floor = f.minTelegraphSec;
    const byType = TELEGRAPH_FLOOR_BY_TYPE[e.type];
    if (byType !== undefined && byType > floor) floor = byType;
    if (b !== null && b.status === 'slow' && 0.80 > floor) floor = 0.80;
    if (b !== null && b.status === 'stun' && f.minStunTelegraphSec > floor) floor = f.minStunTelegraphSec;
    if (typeof e.telegraphSec === 'number' && e.telegraphSec < floor - 1e-9) {
      c.fail(`${p}.telegraphSec`, `${e.telegraphSec} < ${floor} — §7.4 3축 max`);
    }

    // (2) §12.4 — 탄 속도. 이미터가 유일 소유자 (§9.7: bullets[].speed 는 삭제됐다)
    if (typeof e.speed === 'number') {
      if (e.speed > f.maxBulletSpeed) {
        c.fail(`${p}.speed`, `${e.speed} > fairness.maxBulletSpeed(${f.maxBulletSpeed}) (§12.4)`);
      }
      if (e.type === 'aimed' && e.speed > f.maxAimedBulletSpeed) {
        c.fail(`${p}.speed`, `조준탄 ${e.speed} > fairness.maxAimedBulletSpeed(${f.maxAimedBulletSpeed}) (§12.4)`);
      }
      if (b !== null && b.status !== null) {
        const cap = f.maxBulletSpeed * f.statusBulletSpeedMul;
        if (e.speed > cap + 1e-9) {
          c.fail(`${p}.speed`, `${e.speed} > ${cap} — 상태이상 탄은 크고 느려야 한다 (§12.4)`);
        }
      }
    }
    // (3) §12.4 — 최소 탄 반경
    if (b !== null && b.radius < f.minBulletRadiusPx) {
      c.fail(`${p} → bullets[${b.id}].radius`, `${b.radius} < fairness.minBulletRadiusPx(${f.minBulletRadiusPx}) (§12.4)`);
    }
    // (4) §12.4 — wall 의 통과 틈
    if (e.type === 'wall') {
      if (e.gapWidthPx < f.minGapWidthPx) {
        c.fail(`${p}.gapWidthPx`, `${e.gapWidthPx} < fairness.minGapWidthPx(${f.minGapWidthPx}) (§12.4)`);
      }
      if (e.gapCount < 1) c.fail(`${p}.gapCount`, `${e.gapCount} — 틈 없는 벽은 회피 불가 (§12.4)`);
    }
    // (5) §12.4 — 스턴 최대 지속
    if (b !== null && b.status === 'stun' && b.statusDurationSec > f.maxStunSec) {
      c.fail(`${p} → bullets[${b.id}].statusDurationSec`,
        `${b.statusDurationSec} > fairness.maxStunSec(${f.maxStunSec}) (§12.4)`);
    }
    //  ★ ㊿-ze5 — 상태 지속시간의 «하한». 고정 틱(1/60)보다 짧으면 step 의 감쇠(step.js 122행)가 첫 틱에
    //  통째로 먹어 **한 프레임도 효과가 없고**, 그러면서 지형/탄 판별(movePlayer)의 경계만 흐린다.
    //  값이 0 인 것은 「상태 없음」의 표기이므로 허용한다 — 0 초과인데 한 틱보다 짧은 것만 막는다.
    if (b !== null && b.status !== null && b.statusDurationSec > 0 && b.statusDurationSec < 1 / 60) {
      c.fail(`${p} → bullets[${b.id}].statusDurationSec`,
        `${b.statusDurationSec} < 한 틱(${(1 / 60).toFixed(5)}) — 고정 틱이 첫 감쇠에 통째로 먹어 아무 효과도 없다 (§2.7 · §12.4)`);
    }
    // (6) §7.4 v1.5 — mortar 의 퓨즈(착탄→폭발)가 곧 회피 창 → 절대 하한 강제(이미터 로컬 축)
    if (e.type === 'mortar' && typeof e.fuseSec === 'number' && e.fuseSec < f.minTelegraphSec - 1e-9) {
      c.fail(`${p}.fuseSec`, `${e.fuseSec} < fairness.minTelegraphSec(${f.minTelegraphSec}) — 착탄 후 폭발까지가 회피 창 (§7.4)`);
    }
  }
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------
/**
 * §9.3 — 9개 파일의 **이미 파싱된 객체**를 검증하고 그대로 돌려준다.
 * 위반이 하나라도 있으면 throw. 부분 로드도 폴백도 없다.
 *
 * @param raw { rules, elements, weapons, passives, bullets, enemies, bosses, stages, meta }
 * @returns 같은 객체 (동결됨)
 */
export function validate(raw) {
  const c = collector();

  // §9.2 — 매니페스트는 닫혀 있다. 여분 파일도 에러다
  const given = Object.keys(raw);
  for (let i = 0; i < given.length; i += 1) {
    if (MANIFEST.indexOf(given[i]) < 0) {
      c.fail(`data/${given[i]}.json`, '§9.2 매니페스트(정확히 11개, 닫힘) 밖의 파일');
    }
  }
  for (let i = 0; i < MANIFEST.length; i += 1) {
    const n = MANIFEST[i];
    if (!own(raw, n)) { c.fail(`data/${n}.json`, '매니페스트 파일 누락 (§9.2)'); continue; }
    if (!isObj(raw[n])) { c.fail(`data/${n}.json`, '루트가 객체가 아니다'); continue; }
    // §9.3 — schemaVersion 은 모든 파일 루트에 필수. 불일치 → 로드 실패
    if (!own(raw[n], 'schemaVersion')) {
      c.fail(`${n}.schemaVersion`, '누락 (§9.3 — 모든 파일 루트에 필수)');
    } else if (raw[n].schemaVersion !== SCHEMA_VERSION) {
      c.fail(`${n}.schemaVersion`, `${raw[n].schemaVersion} ≠ ${SCHEMA_VERSION} → 로드 실패 (§9.3)`);
    }
  }
  if (c.errs.length > 0) throwAll(c.errs);

  checkRules(c, raw.rules);
  checkElements(c, raw.elements);
  checkWeapons(c, raw.weapons);
  checkPassives(c, raw.passives);
  checkBullets(c, raw.bullets);
  checkEnemies(c, raw.enemies);
  checkBosses(c, raw.bosses);
  checkStages(c, raw.stages);
  checkMeta(c, raw.meta);
  checkTraits(c, raw.traits);   // v1.10 ⑲
  checkTutorial(c, raw.tutorial);   // v1.10 ㊴
  if (c.errs.length > 0) throwAll(c.errs);

  // 구조가 성립한 뒤에만 참조·공정성을 본다 (undefined 를 훑지 않기 위해)
  checkRefs(c, raw);
  checkFairness(c, raw);
  if (c.errs.length > 0) throwAll(c.errs);

  return raw;
}

function throwAll(errs) {
  const head = `schema.mjs: §9.3 로더 규칙 위반 ${errs.length}건 — 로드 실패 (폴백 금지)`;
  throw new Error(`${head}\n  ${errs.join('\n  ')}`);
}
