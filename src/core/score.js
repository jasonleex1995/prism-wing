/**
 * src/core/score.js — 런 점수 (순수 core, §11.3)
 *
 * 정본 v1.4 구현 절:
 *   §11.3  처치 점수(초효과 보너스) · 시간 보너스 · 보스/중간보스/런 클리어 · 스테이지 무피격 ·
 *          퍼펙트 · 난이도 배율 · **floor 는 마지막에 딱 한 번**(roundMode).
 *   §11.3  attribution "damageShare" — 처치의 초효과 보너스는 **막타가 아니라 누적 피해 지분**이다:
 *          그 개체에 넣은 ×2 피해 / 총 피해 ≥ superEffectiveDamageShare(0.5) 면 보너스.
 *   ★ v1.5 — 경제·소비아이템 폐지: 코인 환산·실드 무피격 유지·시간토큰·컨티뉴 소급무효 전부 제거.
 *          퍼펙트 = 승리 + 전 스테이지 무피격 (원데스라 컨티뉴 항이 없다).
 *   §9.1   순수성 — window/Date/Math.random 0. import 0 (world 만 만진다).
 *
 * ★ 값은 전부 meta.score 에 산다. 이 파일에 점수 수치가 없다.
 */

/** 런 점수 누적기. createWorld 가 1회 만든다(스테이지 수 = flow.stagePar 길이 = 6). */
export function makeScore(data) {
  const n = data.meta.flow.stagePar.length;
  const noHit = new Array(n);
  for (let i = 0; i < n; i += 1) noHit[i] = true;      // 아직 안 맞았다
  return {
    kills: 0,          // 처치 점수(초효과 보너스 포함)
    bossClear: 0,      // 보스 격파 보너스
    midBossClear: 0,   // 중간보스 격파 보너스
    time: 0,           // 시간 보너스(보스전 잔여 초 × timeBonusPerGameSec)
    runClear: 0,       // 최종 클리어 보너스
    noHit,             // 스테이지별 무피격 유지 여부
  };
}

/**
 * §11.3 — 개체 처치 점수. 그 개체에 넣은 ×2 피해 지분이 기준을 넘으면 초효과 보너스를 더한다.
 *   dmgTotal 이 0(피해 없이 사라진 개체)이면 지분이 정의되지 않으므로 보너스 없음.
 */
export function addKill(world, e) {
  const s = world.data.meta.score;
  let v = e.score;
  if (e.dmgTotal > 0 && e.dmgSuper / e.dmgTotal >= s.superEffectiveDamageShare) {
    v += e.score * s.superEffectiveKillBonusRatio;
  }
  world.score.kills += v;
  // §13.1.1 — 시뮬 텔레메트리(있을 때만). 게임 실행엔 world.tele 가 없다 = 무영향(§10.2).
  const t = world.tele;
  if (t !== undefined) {
    const k = e.archetypeId === '' ? (e.midBossId !== '' ? e.midBossId : 'boss') : e.archetypeId;
    t.kills[k] = (t.kills[k] === undefined ? 0 : t.kills[k]) + 1;
    if (world.run !== undefined && world.run.crisis) t.crisisKills += 1;
  }
}

/**
 * §11.3 — 피격 = 그 스테이지 무피격 깨짐 (v1.5: 실드 폐지 = 모든 피격이 진짜다).
 *   런이 아직 없으면(테스트 월드) 아무것도 하지 않는다.
 */
export function noteHit(world) {
  if (world.run === undefined) return;
  const i = world.run.stageIndex;
  if (i >= 0 && i < world.score.noHit.length) world.score.noHit[i] = false;
}

/**
 * §11.3 — 보스 격파. 잔여 타이머가 시간 보너스가 된다 (v1.5: 시간토큰 폐지 = 항상 잔여 반영).
 */
export function addBossClear(world, timerLeftSec) {
  const s = world.data.meta.score;
  world.score.bossClear += s.bossClearBonus;
  if (timerLeftSec > 0) world.score.time += timerLeftSec * s.timeBonusPerGameSec;
}

/** §11.3 — 중간보스 격파 보너스. */
export function addMidBossClear(world) {
  world.score.midBossClear += world.data.meta.score.midBossClearBonus;
}

/** §6.5 — 최종 스테이지 격파 = 런 클리어 보너스. */
export function addRunClear(world) {
  world.score.runClear += world.data.meta.score.runClearBonus;
}

/**
 * §11.3 — 최종 집계. 합 × difficulty.scoreMul 를 **마지막에 한 번만** floor 한다(roundMode).
 *   반환은 표시용 내역 + 총점. 죽어도 집계된다(§11.3).
 */
export function tally(world) {
  const s = world.data.meta.score;
  const sc = world.score;

  // ★ 무피격은 **클리어한 스테이지만** 센다. noHit[] 기본값이 true 라, 미도달·미클리어 스테이지가
  //   거짓 무피격으로 잡히면 «타임아웃 사망이 만점 퍼펙트»가 된다(실측 익스플로잇 — 사망 런이 +48000).
  const cleared = world.run !== undefined
    ? (world.run.won ? sc.noHit.length : world.run.stageIndex)
    : sc.noHit.length;
  let noHitCount = 0;
  for (let i = 0; i < cleared; i += 1) if (sc.noHit[i]) noHitCount += 1;
  const noHitBonus = noHitCount * s.stageNoHitBonus;
  // 퍼펙트 = **승리** + 전 스테이지 무피격 (미승리 런은 퍼펙트가 될 수 없다). v1.5: 컨티뉴 폐지 = 원데스.
  const perfect = (world.run !== undefined && world.run.won)
    && noHitCount === sc.noHit.length;
  const perfectBonus = perfect ? s.perfectBonus : 0;
  // §11.3-6항 — floor 는 **마지막에 한 번뿐**. 최종 floor(raw × scoreMul)가 전체를 정수로 만든다.
  const raw = sc.kills + sc.bossClear + sc.midBossClear + sc.time
    + sc.runClear + noHitBonus + perfectBonus;

  const diff = world.data.meta.difficulty[world.difficultyId];
  if (diff === undefined) throw new Error(`score: 미지의 난이도 "${world.difficultyId}" (§11.3)`);

  return {
    kills: sc.kills,
    bossClear: sc.bossClear,
    midBossClear: sc.midBossClear,
    time: sc.time,
    runClear: sc.runClear,
    noHitCount,
    noHitBonus,
    perfect,
    perfectBonus,
    scoreMul: diff.scoreMul,
    total: Math.floor(raw * diff.scoreMul),      // ★ floor 는 여기 한 번뿐
    // §11.3(v1.10 ㊿-u) 클리어 시간 — 사용자(2026-09-12) 「클리어하면 클리어하는데 걸린 시간도 같이 나왔으면 좋겠어」.
    //   승리한 런에만 있다(사망 = null). = 실제로 플레이한 초: 흐른 틱 ÷ tickHz ÷ 배속(speed). 월드가 도는 동안만 센다 —
    //   일시정지 · 레벨업/특성 카드 · 스테이지 배너는 빠지고, 보스 «WARNING» 연출 · 특성 구슬 비행은 들어간다.
    //   ★ 게임초(world.time) 그대로 쓰면 하드 ×1.1 · 헬 ×1.25 에서 실제보다 길게 나온다(헬 24분 클리어가 30:00 — 검토). 보스 타이머는 게임초 그대로다.
    //   ★ 틱 수로 센다 — world.time 은 1/60 을 더해 쌓여 정초가 소수 오차로 살짝 모자라고, 버리면 1초가 빠진다(검토 실측).
    //   승리 틱에 world.over 가 서서 step 이 멈추므로 결과 화면에서 읽어도 그 순간의 값이다.
    clearSec: (world.run !== undefined && world.run.won) ? world.tick / world.data.rules.loop.tickHz / diff.speed : null,
  };
}
