/**
 * src/main.js — 부트스트랩 (브라우저 전용, **순수하지 않다**)
 *
 * 정본 v1.4 구현 절:
 *   §9.1   main.js = 캔버스·rAF·입력·화면 전환. **게임 로직 없음.** ★배속이 존재하는 유일한 곳★
 *   §9.2   data/*.json 9개를 Promise.all(fetch) 병렬 로드
 *   §9.3   schema.mjs 가 게임·시뮬 양쪽에서 동일 실행. 위반 = 로드 실패 + 에러 화면 (폴백 금지)
 *   §1.1   s = min(vw/1280, vh/720) · CSS 중앙 정렬 레터박스 · 백킹스토어 1280·min(dpr,2)
 *          · 뷰포트 < minViewportW/H → 플레이 차단 + 안내 (입력 무시)
 *   §5.1   키맵 — 이동 = 방향키 / Q W E R = 스탠스. `event.code` (물리 키 위치)
 *   §5.2   드래프트 — Digit1~3 즉시 선택 · ←→ 커서 · Space/Enter 확정 · Escape 무시 (§5.5 키 통일)
 *   §5.5   flow.edgeTriggerOnStateEnter — 상태 진입 프레임에 이미 눌려 있던 키는 무시
 *   §5.7   매 고정 틱마다 키 상태를 **폴링**한다 (이벤트 큐 아님) · 게임 키 전부 preventDefault
 *          · blur → 자동 일시정지 + acc = 0 (input.pauseOnBlur)
 *   §6.1   ★ tickDur = 1000 / (TICK_HZ × speed) — **배속이 코드에 존재하는 정확히 1곳**
 *   §6.4   레벨업 드래프트 — draft.pauseGame: 게임 클럭을 멈춘다
 *   §10.1  고정 타임스텝 · 나선형 죽음 방지(남은 시간 폐기) · render(alpha) 는 위치 보간만
 *   §10.2  마스터 시드 = (Date.now() ^ (performance.now()×1000)) >>> 0
 *          — ★ 비결정성이 들어오는 유일한 지점이며 core 바깥에서 생성해 주입한다
 *
 * ★ 단방향: 이 파일은 core 를 import 한다. core 는 이 파일을 모른다.
 */

import { validate, MANIFEST } from './core/schema.mjs';
import { createWorld } from './core/state.js';
import { step, makeInput, TICK_HZ } from './core/step.js';
import { setBotPolicy, botInput, botDraftPick } from './core/bot.js';   // 셀프플레이 데모(?demo)
import { buildDraft, buildTraitDraft, applyCard } from './core/draft.js';
import { weapons } from './core/weapons/index.js';
import { enemies } from './core/enemies.js';
import { emitters } from './core/emitters.js';
import { bossHook } from './core/boss.js';
import { initRun, tickRun, advanceStage, applyStageClearHeal, stageEntry, PHASE, attractOver } from './core/stage.js';
import { tally } from './core/score.js';
import { seedHex } from './core/rng.js';
import { dotText, dotLogo, dotScale } from './render/dotfont.js';   // §7.9.1(v1.10 ㊿-z) 도트 폰트
import { resolvePalette, drawWorld, makeInterp, captureInterp, makeFx, updateFx, rgba } from './render/draw.js';
import { drawPanels, drawDraft, drawResults, drawTutorial } from './render/hud.js';
import { makeTutorialState, tickTutorial, tutorialStep } from './core/tutorial.js';   // §6.7 ㊴·㊻

// ---------------------------------------------------------------------------
// 에러 화면 (§9.3 — 로드 실패는 조용히 지나가지 않는다)
// ---------------------------------------------------------------------------
function fatal(err) {
  const el = document.getElementById('fatal');
  el.textContent = String(err && err.message ? err.message : err)
    + (err && err.stack ? `\n\n${String(err.stack).split('\n').slice(0, 6).join('\n')}` : '');   // ㊱ 어디서 던졌는지도 보인다
  el.hidden = false;
  document.getElementById('game').hidden = true;
}

// ---------------------------------------------------------------------------
// 데이터 (§9.2 · §9.3)
// ---------------------------------------------------------------------------
async function loadData() {
  const jobs = MANIFEST.map(async (name) => {
    const url = new URL(`../data/${name}.json`, import.meta.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`data/${name}.json 로드 실패 (HTTP ${res.status}) — §9.2 매니페스트 9개는 닫혀 있다`);
    return [name, await res.json()];
  });
  const pairs = await Promise.all(jobs);
  const raw = {};
  for (let i = 0; i < pairs.length; i += 1) raw[pairs[i][0]] = pairs[i][1];
  return validate(raw);                       // §9.3 — 미지 키 = 에러 / 누락 키 = 에러 / 폴백 금지
}

// ---------------------------------------------------------------------------
// 입력 (§5.7 — 폴링. 이벤트는 **키 상태를 갱신할 뿐** 게임에 직접 도달하지 않는다)
// ---------------------------------------------------------------------------
function makeKeyboard(rules) {
  const b = rules.input.bindings;
  // §5.7 — 게임이 사용하는 모든 키에 preventDefault (특히 Space, Tab, 방향키)
  const owned = new Set();
  const add = (v) => { if (Array.isArray(v)) v.forEach((k) => owned.add(k)); else owned.add(v); };
  Object.keys(b).forEach((k) => add(b[k]));

  const down = new Set();
  const masked = new Set();                   // §5.5 edgeTriggerOnStateEnter 로 무효화된 키
  const kb = {
    /** §5.1 — layout "code": event.code = **물리 키 위치**. 자판 배열이 바뀌어도 손가락이 안 바뀐다 */
    held(code) { return down.has(code) && !masked.has(code); },
    /** 상태 진입 시 이미 눌려 있던 키를 그 상태에서 무효화한다 (§5.5 — 죽는 순간 Space 연타 방어) */
    maskHeld() {
      masked.clear();
      down.forEach((c) => masked.add(c));
    },
    clear() { down.clear(); masked.clear(); },
  };

  window.addEventListener('keydown', (e) => {
    if (rules.input.layout !== 'code') throw new Error(`main: 미지의 input.layout "${rules.input.layout}" (§5.1)`);
    if (owned.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    down.add(e.code);
  });
  window.addEventListener('keyup', (e) => {
    if (owned.has(e.code)) e.preventDefault();
    down.delete(e.code);
    masked.delete(e.code);                    // 떼면 마스크가 풀린다 = "다시 눌러야 유효"
  });
  return kb;
}

/** §5.7 — 이번 틱의 키 상태 스냅샷. ★ 매 고정 틱마다 새로 폴링한다 (헤드리스 재현성의 전제) */
function pollInput(kb, bindings, input) {
  const mv = bindings.move;                   // ["ArrowLeft","ArrowUp","ArrowRight","ArrowDown"]
  input.left = kb.held(mv[0]);
  input.up = kb.held(mv[1]);
  input.right = kb.held(mv[2]);
  input.down = kb.held(mv[3]);
  input.stanceNormal = kb.held(bindings.stanceNormal);
  input.stanceFire = kb.held(bindings.stanceFire);
  input.stanceWater = kb.held(bindings.stanceWater);
  input.stanceGrass = kb.held(bindings.stanceGrass);
  return input;
}

/** 상승 엣지 — 폴링 모델에서 "눌린 순간" = 직전 프레임 대비 변화 (§5.5 · §5.7) */
function makeEdge(kb) {
  const prev = new Set();
  return {
    pressed(code) {
      const now = kb.held(code);
      const was = prev.has(code);
      if (now) prev.add(code); else prev.delete(code);
      return now && !was;
    },
  };
}

// ---------------------------------------------------------------------------
// 캔버스 (§1.1 — 레터박스. **모든 게임 좌표는 논리 픽셀이며 스케일은 렌더에만 존재한다**)
// ---------------------------------------------------------------------------
function fitCanvas(canvas, view) {
  // ★ 정본 §1.1 은 CSS 스케일 s = min(vw/1280, vh/720) 와 setTransform 의 배율을 **같은 글자 s**
  //   로 적었으나, 백킹스토어가 1280·min(dpr,2) 이므로 setTransform 의 배율은 min(dpr,2) 여야 한다
  //   (CSS s 를 넣으면 논리 좌표가 두 번 축소된다). 표기 겹침이며 구조는 자명하다 — 보고 대상.
  const dpr = Math.min(window.devicePixelRatio || 1, view.maxDpr);
  const bw = Math.round(view.logicalW * dpr);
  const bh = Math.round(view.logicalH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }

  const s = Math.min(window.innerWidth / view.logicalW, window.innerHeight / view.logicalH);
  canvas.style.width = `${view.logicalW * s}px`;
  canvas.style.height = `${view.logicalH * s}px`;
  return dpr;
}

/** §1.1 — 뷰포트 < 최소 → 플레이 차단 + 안내(입력 무시). 데스크톱 키보드 전용 */
function viewportTooSmall(view) {
  return window.innerWidth < view.minViewportW || window.innerHeight < view.minViewportH;
}

// ---------------------------------------------------------------------------
// 오디오 (§7.10 — WebAudio 절차적 합성, 에셋 0KB · SFX 버스 하나 · 배속 무관)
//   ★ main.js 는 비순수이므로 WebAudio 사용 가능(core 는 소리를 모른다).
//   ★ 모든 큐는 시각 짝을 갖는다(§7.10) → 오디오 실패/무음이어도 게임은 100% 성립한다.
//     그러므로 여기의 모든 접근은 try/catch 로 감싸 소리가 게임을 절대 막지 않게 한다.
//   §7.7 히트 SFX: ×2 저역 크런치 / ×1 얇은 틱 / ×0.5 금속 "틴".
// ---------------------------------------------------------------------------
function makeAudio(rules) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;                       // 오디오 인프라 없음 → 시각만 (호출부 null 가드)
  let ctx = null;
  let master = null;
  let bgmBus = null;
  const sfxGain = rules.audio.busGain.sfx;                       // §7.10 busGain.sfx = 0.8
  const bgmGain = rules.audio.busGain.bgm;                       // §7.10 v1.5 busGain.bgm
  const minInterval = 1 / rules.audio.cueRateLimitPerSec;        // §7.10 동일 큐 초당 상한
  const lastAt = { super: -1, neutral: -1, resist: -1, levelup: -1, hurt: -1, stance: -1, kill: -1, boss: -1 };
  let muted = false;                          // §5.5 OPTIONS — 버스 뮤트/볼륨(SFX+BGM 공유)
  let vol = 1;
  function applyGain() {
    if (master !== null) master.gain.value = muted ? 0 : sfxGain * vol;
    if (bgmBus !== null) bgmBus.gain.value = muted ? 0 : bgmGain * vol;
  }
  function ensure() {
    if (ctx === null) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : sfxGain * vol;
      master.connect(ctx.destination);
      bgmBus = ctx.createGain();
      bgmBus.gain.value = muted ? 0 : bgmGain * vol;
      bgmBus.connect(ctx.destination);
    }
    return ctx;
  }
  function env(o, g, t0, peak, dur) {                            // 공통 감쇠 엔벨로프
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function crunch(t0) {                                          // ×2 — 짧고 두꺼운 저음
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(150, t0);
    o.frequency.exponentialRampToValueAtTime(58, t0 + 0.09);
    env(o, ctx.createGain(), t0, 0.9, 0.12);
  }
  function tick(t0) {                                            // ×1 — 얇은 틱
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(1900, t0);
    env(o, ctx.createGain(), t0, 0.22, 0.04);
  }
  function tin(t0) {                                             // ×0.5 — 비조화 3부분음 = 금속 튕김("틴")
    // ★ 시각 강화(두꺼운 회색 방패 + 본체 차폐 플래시)에 맞춰 살짝 더 또렷하게: 밝은 어택 트랜지언트
    //   1개 추가 + 기본 부분음 게인 소폭 상향. 여전히 비조화·고역·저역 없음 = "안 통함"(super 저역 크런치와 대비).
    const parts = [[2100, 0.38, 0.20], [3170, 0.20, 0.15], [4600, 0.12, 0.05]];
    for (let i = 0; i < parts.length; i += 1) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(parts[i][0], t0);
      env(o, ctx.createGain(), t0, parts[i][1], parts[i][2]);
    }
  }
  function chime(t0) {                                           // 레벨업 — 밝은 2음 상승(보상감)
    const freqs = [660, 990];
    for (let i = 0; i < freqs.length; i += 1) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(freqs[i], t0 + i * 0.06);
      env(o, ctx.createGain(), t0 + i * 0.06, 0.3, 0.12);
    }
  }
  function thud(t0) {                                            // 피격 — 낮고 둔탁한 경고
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(200, t0);
    o.frequency.exponentialRampToValueAtTime(70, t0 + 0.12);
    env(o, ctx.createGain(), t0, 0.5, 0.16);
  }
  function clickS(t0) {                                          // 스탠스 전환 — 얇은 클릭
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(880, t0);
    env(o, ctx.createGain(), t0, 0.12, 0.03);
  }
  function killPop(t0) {                                         // 처치 — 짧은 하강 팝
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(430, t0);
    o.frequency.exponentialRampToValueAtTime(170, t0 + 0.05);
    env(o, ctx.createGain(), t0, 0.13, 0.06);
  }
  function bossHorn(t0) {                                        // 보스 등장·페이즈 전환 — 낮고 웅장한 2음
    const freqs = [110, 164.81];
    for (let i = 0; i < freqs.length; i += 1) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(freqs[i], t0);
      env(o, ctx.createGain(), t0, 0.42, 0.55);
    }
  }
  // §7.10(v1.5) — 절차적 칩튠 BGM (오리지널·무저작권). A단조 구동 루프, look-ahead 스케줄.
  const BSTEP = 0.1852;                                          // 8분음(초) ≈ 162 BPM
  const NF = { _: 0,
    A2: 110.00, B2: 123.47, C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.00,
    A3: 220.00, B3: 246.94, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00,
    A4: 440.00, B4: 493.88, C5: 523.25 };
  const BLEAD = ['A4', '_', 'C5', 'B4', 'A4', 'E4', 'A4', 'C5', 'F4', '_', 'A4', 'G4', 'F4', 'E4', 'C4', 'E4',
    'C4', '_', 'E4', 'G4', 'C5', 'G4', 'E4', 'C4', 'E4', '_', 'G4', 'F4', 'E4', '_', 'B3', 'E4'];
  const BBASS = ['A2', 'A2', 'A3', 'A2', 'A2', 'A2', 'A3', 'A2', 'F3', 'F3', 'F3', 'F3', 'F3', 'F3', 'F3', 'F3',
    'C3', 'C3', 'C3', 'C3', 'C3', 'C3', 'C3', 'C3', 'E3', 'E3', 'E3', 'E3', 'E3', 'E3', 'B2', 'E3'];
  let bgmOn = false;
  let bgmStep = 0;
  let bgmNextT = 0;
  // ★ ㊶ — 예약해 둔 BGM 음을 들고 있는다. 탭이 숨겨지면 AudioContext 가 «정지»하고(브라우저 정책) 그동안 currentTime 이 멈춘다.
  //   돌아오면 예약 시각이 전부 과거가 되어 **한꺼번에 울린다** — 사용자가 들은 「노래가 중복되는」 순간이 이것이다(§7.10).
  //   그래서 숨겨질 때 예약분을 끊고(bgmPause) 돌아올 때 새로 시작한다.
  let bgmVoices = [];
  function bgmNote(freq, t0, dur, type, peak) {
    if (freq <= 0) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(bgmBus);
    o.start(t0); o.stop(t0 + dur + 0.02);
    bgmVoices.push({ o, until: t0 + dur + 0.02 });
  }
  function bgmSchedule() {                                       // 매 프레임 호출 — ~0.35s 앞을 채운다
    if (!bgmOn || ctx === null || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (bgmNextT < now) bgmNextT = now + 0.05;
    if (bgmVoices.length > 64) bgmVoices = bgmVoices.filter((v) => v.until > now);   // 끝난 보이스는 흘려보낸다(0 alloc 아님, 초당 수 회)
    while (bgmNextT < now + 0.35) {
      const li = NF[BLEAD[bgmStep % BLEAD.length]];
      const bi = NF[BBASS[bgmStep % BBASS.length]];
      bgmNote(li, bgmNextT, BSTEP * 0.92, 'square', 0.14);       // 리드
      bgmNote(bi, bgmNextT, BSTEP * 0.98, 'triangle', 0.30);     // 베이스
      if (bgmStep % 4 === 0 && li > 0) bgmNote(li * 2, bgmNextT, BSTEP * 0.35, 'square', 0.035);  // 옥타브 반짝
      bgmStep += 1;
      bgmNextT += BSTEP;
    }
  }
  return {
    resume() { try { ensure(); if (ctx.state === 'suspended') ctx.resume(); } catch (e) { /* 무음 폴백 */ } },
    setMuted(m) { muted = m; applyGain(); },
    toggleMuted() { muted = !muted; applyGain(); return muted; },
    isMuted() { return muted; },
    setVolume(v) { vol = v < 0 ? 0 : (v > 1 ? 1 : v); applyGain(); return vol; },
    getVolume() { return vol; },
    cue(tier) {
      try {
        if (muted) return;                                      // §5.5 뮤트
        ensure();
        if (ctx.state !== 'running') return;                    // 사용자 제스처 전 → 무음
        const now = ctx.currentTime;
        if (now - lastAt[tier] < minInterval) return;           // §7.10 rate limit
        lastAt[tier] = now;
        if (tier === 'super') crunch(now);
        else if (tier === 'resist') tin(now);
        else if (tier === 'levelup') chime(now);
        else if (tier === 'hurt') thud(now);
        else if (tier === 'stance') clickS(now);
        else if (tier === 'kill') killPop(now);
        else if (tier === 'boss') bossHorn(now);
        else tick(now);
      } catch (e) { /* 오디오 실패는 게임을 막지 않는다 */ }
    },
    // §7.10(v1.5) BGM — 절차적 루프. 사용자 제스처(resume) 뒤 켜지고, 매 프레임 bgmTick 으로 앞을 채운다.
    bgmStart() {
      try {
        ensure();
        if (ctx.state !== 'running') return;
        bgmOn = true;
        if (bgmNextT === 0) bgmNextT = ctx.currentTime + 0.05;
      } catch (e) { /* 무음 폴백 */ }
    },
    bgmStop() { bgmOn = false; },
    /** ㊶ 탭이 숨겨질 때 — 예약된 음을 «즉시» 끊고 위상을 버린다. 돌아오면 bgmStart 가 지금 시각에 다시 건다. */
    bgmPause() {
      try {
        bgmOn = false;
        bgmNextT = 0;
        if (ctx === null) return;
        const now = ctx.currentTime;
        for (const v of bgmVoices) { try { v.o.stop(now); } catch (e) { /* 이미 끝난 보이스 */ } }
        bgmVoices = [];
      } catch (e) { /* 무음 폴백 */ }
    },
    bgmTick() { try { if (bgmOn) bgmSchedule(); } catch (e) { /* */ } },
  };
}

/** §7.7 — 이번 스텝의 히트 이벤트에서 존재하는 tier 별로 큐를 1회 발화한다(각기 rate-limited). */
function playHitCues(audio, world) {
  if (audio === null) return;
  const h = world.hitFx;
  let sup = false; let neu = false; let res = false; let killed = false;
  for (let i = 0; i < h.count; i += 1) {
    const t = h.buf[i].tier;
    if (t === 'super') sup = true; else if (t === 'resist') res = true; else neu = true;
    if (h.buf[i].killed) killed = true;
  }
  if (sup) audio.cue('super');
  if (res) audio.cue('resist');
  if (neu) audio.cue('neutral');
  if (killed) audio.cue('kill');                 // §7.10 v1.5 — 처치 팝(rate-limited)
}

/** §7.10 — 플레이어 상태 변화를 SFX 로: 레벨업·피격·스탠스 전환. prev 는 프레임 간 유지. (v1.5: 코인 폐지) */
function playEventCues(audio, world, prev) {
  if (audio === null) return;
  const p = world.player;
  if (p.level > prev.level) audio.cue('levelup');
  if (p.hp < prev.hp) audio.cue('hurt');
  if (p.stance !== prev.stance) audio.cue('stance');
  const bp = world.run !== undefined ? world.run.bossPhase : 0;
  if (bp > prev.bossPhase) audio.cue('boss');    // §7.10 v1.5 — 보스 페이즈 전환(발악 등) 웅장 큐
  prev.level = p.level; prev.hp = p.hp; prev.stance = p.stance; prev.bossPhase = bp;
}
const audioPrev = { level: 1, hp: 0, stance: '', bossPhase: 0 };

// ---------------------------------------------------------------------------
// 부트
// ---------------------------------------------------------------------------
async function boot() {
  const data = await loadData();
  const rules = data.rules;
  const view = rules.view;

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  const pal = resolvePalette(rules);
  const kb = makeKeyboard(rules);
  // §6.5(v1.10 ㊿-s) 어트랙트 — 타이틀의 «무입력» 시계(실시간 ms — 타이틀은 런이 없어 배속 1, §0.2.1)와 «끝» 깃발.
  //   · 키·클릭 = 시계를 되돌리고, 어트랙트 중이면 깃발을 세운다 → 다음 프레임에 그 판이 끝난다(라벨이 약속한 그대로 — 「아무 키나 누르면」).
  //     시각 비교가 아니라 깃발이다 — 타이머 정밀도가 낮은 브라우저에서 «시작한 그 순간»의 입력이 묻히지 않게(검토).
  //   · 창·탭으로 돌아온 순간(focus · visibilitychange) = 타이틀의 시계만 새로 잰다(오래 비운 탭에 돌아오자마자 데모가 뜨지 않게).
  //     데모는 끝내지 않는다 — 창 전환·화면 캡처처럼 «사람이 누르지 않은» 이벤트로 데모가 끊기지 않게.
  //   · 게임이 쓰는 키는 조합이어도 입력이다 — 2차 검토: 조합을 전부 무시했더니 Ctrl+Esc 가 데모를 «일시정지»시켰다(키보드는 Esc 를 그대로 받는다).
  //     게임이 안 쓰는 키는 수정 키 단독이거나 Cmd·Ctrl·Alt 와 함께면 입력이 아니다 — Cmd+Tab(창 전환) · Cmd+Shift+4(화면 캡처)가 blur 보다 먼저 데모를 끊었다(검토).
  let attract = false;                        // 어트랙트 진행 중
  let attractExit = false;                    // 어트랙트 중에 키·클릭이 들어왔다 = 끝
  let lastInputAt = performance.now();
  const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'AltGraph', 'Shift', 'OS', 'CapsLock', 'Fn']);
  const BOUND_CODES = new Set(Object.values(rules.input.bindings).flat());   // 게임이 쓰는 물리 키(event.code)
  const noteInput = (e) => {
    if (e.type === 'keydown' && !BOUND_CODES.has(e.code) && (MODIFIER_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey)) return;
    lastInputAt = performance.now();
    if (attract) attractExit = true;
  };
  const noteReturn = () => { if (!attract) lastInputAt = performance.now(); };
  window.addEventListener('keydown', noteInput, true);
  window.addEventListener('pointerdown', noteInput, true);
  window.addEventListener('focus', noteReturn);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) noteReturn(); });
  const edge = makeEdge(kb);
  const input = makeInput();
  // ── 셀프플레이 데모(어트랙트) — `?demo` 이면 봇이 자동 플레이(쇼케이스). 비침습: 기본 OFF ──
  //   `?demo` / `?demo=1` = **고정 시드**(DEMO_DEFAULT_SEED) 루프 · `?demo=<8자리 hex>` = 그 시드로 고정.
  //   ★ 어느 쪽이든 시드는 고정이다 — 아래 demoFixedSeed 는 DEMO 일 때 절대 null 이 되지 않는다.
  const _demoParam = new URLSearchParams(location.search).get('demo');
  const DEMO = _demoParam !== null;
  const DEMO_DEFAULT_SEED = 8;                // 시뮬로 고른 쇼케이스 런: 3스테이지 격파·무기 4종·Lv6 (결정적 재현)
  const demoFixedSeed = !DEMO ? null
    : (/^[0-9a-fA-F]{8}$/.test(_demoParam) ? (parseInt(_demoParam, 16) >>> 0) : DEMO_DEFAULT_SEED);
  let demoHoldT = 0;                          // DRAFT/RESULTS 를 잠깐 보여주는 잔여(ms)
  // §7.10 — SFX. AudioContext 는 사용자 제스처 후에만 소리를 낸다 → 첫 키 입력에서 resume.
  const audio = makeAudio(rules);
  // §7.10 — AudioContext 는 사용자 제스처 뒤에만 소리를 낸다 → 첫 키 입력에서 resume.
  //   ★ ㊶ `isTrusted` 검사: **사람이 누른 키**만 오디오를 켠다. 스크립트가 만든 KeyboardEvent(자동화·계측 도구)로 음악이
  //     시작되면, 그 페이지가 화면 밖에서 조용히 계속 울린다(실측: 개발용 프로브가 탭을 닫은 뒤에도 BGM 을 냈다).
  if (audio !== null) {
    window.addEventListener('keydown', (e) => {
      if (!e.isTrusted) return;
      audio.resume();
      audio.bgmStart();
    });
  }
  const baseTitle = document.title;

  // §9.1 — enemies.js · emitters.js 의 합성 계약을 정본이 인쇄하지 않았다 → state.js 가 주입으로 뒀다.
  //   적 스포너/이동 훅 + 적-공격 훅 + 런 디렉터 + 보스 훅을 주입한다.
  const HOOKS = { enemies, emitters, run: tickRun, boss: bossHook };

  // ★★ 배속 — 정본이 코드에 허용한 **유일한 거처** (§6.1 · §10.1) ★★
  //    난이도는 dt 를 바꾸지 않는다. **초당 소비 틱 수**만 바꾼다(tickDur).
  //    §6.5 — 이제 난이도는 DIFFICULTY 화면에서 고른다 → world·seed·tickDur 은 런마다 새로 만든다.
  let seed = 0;
  let world = null;
  let interp = null;
  let fx = null;
  let difficultyId = 'normal';
  let tickDur = 1000 / TICK_HZ;
  //  §6.1 — ★ 배속이 코드에 존재하는 정확히 1곳. 정본이 그렇게 못박았는데 ㊿-ze3 전까지 두 곳이었다
  //  (startRun · startTutorial 이 같은 식을 따로 적었다). 게이트 S69 가 이 한 줄만 남아 있는지 본다.
  const tickDurFor = (diffId) => 1000 / (TICK_HZ * data.meta.difficulty[diffId].speed);
  let bannerT = 0;                            // THEME_BANNER 잔여(실시간 ms)

  /** §6.5 RUN_START — 고른 난이도로 새 런을 조립한다(시드·world·보간·FX 전부 신규). */
  function startRun(diffId) {
    difficultyId = diffId;
    tickDur = tickDurFor(diffId);
    // §10.2 — 마스터 시드 = uint32. **비결정성이 들어오는 유일한 지점**. core 밖에서 만들어 주입.
    seed = (Date.now() ^ Math.floor(performance.now() * 1000)) >>> 0;
    if (DEMO && demoFixedSeed !== null) seed = demoFixedSeed;   // 데모: 고정 시드 = 같은 쇼케이스 런 재현
    world = createWorld({ data, seed, weapons, hooks: HOOKS });
    world.difficultyId = diffId;             // §11.3 점수 배율(tally)이 읽는다
    if (DEMO || attract) setBotPolicy(world, { farm: 'maxFarm', draft: 'generalist' });  // 무기 다양성 + 레벨업 최대화 (㊿-s 어트랙트도 같은 쇼케이스 정책)
    initRun(world);
    interp = makeInterp(world);
    fx = makeFx(world);
    document.title = `${baseTitle} — ${seedHex(seed)}`;
    enterBanner();                           // 스테이지 1 테마 배너 → PLAY
  }

  /**
   * §6.7(v1.10 ㊴) 튜토리얼 — 스테이지 디렉터 대신 tickTutorial 을 `hooks.run` 에 꽂은 «같은 게임»이다.
   *   보스 훅도 끈다(보스는 튜토리얼이 직접 세운다). 죽지 않으며, 끝나면 타이틀로 돌아간다.
   */
  function startTutorial() {
    difficultyId = DIFFS[0];
    tickDur = tickDurFor(difficultyId);
    seed = 1;                                   // 튜토리얼은 매번 같아야 «배울» 수 있다 (§10.2 결정성)
    world = createWorld({ data, seed, weapons, hooks: { enemies: null, emitters, run: tickTutorial, boss: null },
      startWeaponId: data.tutorial.startWeaponId });    // 튜토리얼의 시작 무기는 «가장 단순한 것»으로 고정(데이터 소유)
    world.difficultyId = difficultyId;
    initRun(world);                             // run 구조체(지형·구간 질의)가 필요하다 — 페이즈는 튜토리얼이 안 쓴다
    world.tut = makeTutorialState();
    interp = makeInterp(world);
    fx = makeFx(world);
    document.title = `${baseTitle} — 튜토리얼`;
    enter('PLAY');
    last = performance.now(); acc = 0;
  }

  /**
   * §6.5(v1.10 ㊿-s) 어트랙트 — 오락실처럼 «아무도 안 건드리면» 봇이 게임을 보여준다. 사용자(2026-09-11)
   *   「홈 화면에서 그러면 20초 동안 안돌아가면 봇이 게임을 플레이하는거로 하자!」. 설정은 meta.flow.attract 가 소유한다.
   *   `?demo`(고정 시드 쇼케이스)와 같은 봇·같은 정책이되, 시드는 매번 새로 뽑아 루프마다 다른 판을 보여준다.
   *   정책 실측(노멀 · 스테이지 1 잡몹 페이즈 · 시드 1~96): 사망 — 쇼케이스(maxFarm) 10 · 인증 기본(balanced) 20(㊿-t 반사 벽 기준 · 옛 벽에서는 8 · 21).
   */
  function startAttract() {
    lastInputAt = performance.now();               // 시작이 실패해도 매 프레임 다시 시도하지 않는다 — 다음 시도는 다시 attractIdleSec 뒤
    attract = true;
    attractExit = false;
    try {
      startRun(data.meta.flow.attract.difficulty); // 봇 정책은 startRun 이 attract 를 보고 건다(?demo 와 같은 자리 · initRun 전)
    } catch (err) {
      attract = false;                             // 반쯤 만든 데모를 남기지 않는다 — 타이틀은 계속 그려진다(㊳ «멈추지 않는다»)
      enter('TITLE');
      document.title = baseTitle;                  // 검토: 실패한 판의 시드가 탭 제목에 남았다
      throw err;                                   // 조용히는 아니다 — frame() 이 기록하고 «렌더 오류» 배지를 띄운다
    }
    document.title = baseTitle;                    // 탭 제목에 시드를 띄우지 않는다 — 사람의 판이 아니다
  }
  /** 어트랙트 종료 — 결과 화면 없이 타이틀로(다시 attractIdleSec 뒤에 새 판). enter('TITLE') 이 world 를 비운다. */
  function endAttract() {
    attract = false;
    attractExit = false;
    enter('TITLE');
    document.title = baseTitle;
  }

  let state = 'TITLE';   // TITLE | DIFFICULTY | OPTIONS | THEME_BANNER | PLAY | DRAFT | PAUSE | RESULTS | TOO_SMALL  (v1.5: SHOP·DEATH 폐지)
  const DIFFS = Object.keys(data.meta.difficulty).filter((k) => data.meta.difficulty[k].speed !== undefined);
  // §6.7(㊵ 개정) 시작 메뉴 = 「튜토리얼 + 난이도들」. 사용자(2026-09-05): 「노말·하드·헬… 에 튜토리얼을 넣자」.
  //   튜토리얼은 난이도가 아니므로 meta.difficulty 에 넣지 않는다(배속·점수 배율이 없는 항목이 그 표에 들어가면 표가 거짓말한다).
  //   대신 **메뉴의 첫 줄**로 세운다 — 처음 온 사람이 가장 먼저 보는 자리.
  const MENU_TUTORIAL = 'tutorial';
  const MENU = [MENU_TUTORIAL, ...DIFFS];
  let diffCursor = 1;                        // 기본 커서 = 첫 난이도(노말). 튜토리얼은 «고르러 가는» 자리다
  let optionsFrom = 'TITLE';                 // OPTIONS 를 어디서 들어왔는가(나갈 때 복귀)
  let tooSmallReturn = 'TITLE';              // TOO_SMALL 에서 복귀할 상태
  let draft = null;
  let cursor = 0;
  let acc = 0;
  let last = performance.now();

  /** §6.5 THEME_BANNER — 스테이지 시작마다 themeBannerSec 동안 테마를 알린다(Space 스킵). */
  function enterBanner() {
    bannerT = data.meta.flow.themeBannerSec * 1000;   // 메뉴 배속 1 → 게임초 = 실초
    enter('THEME_BANNER');
    acc = 0;
  }

  function enter(next) {
    state = next;
    // §6.5 — TITLE 은 «런이 없는» 화면이다. 여기서 world 를 비우지 않으면
    //   renderFrame 의 `world === null` 메뉴 분기가 두 번 다시 잡히지 않아
    //   RESULTS→Esc 이후 타이틀·난이도 화면이 통째로 백지가 된다(죽은 런이 얼어붙은 채 남는다).
    //   OPTIONS 는 PAUSE 위에 겹쳐 그리므로 여기서 비우지 않는다.
    if (next === 'TITLE') { world = null; interp = null; fx = null; lastInputAt = performance.now(); }   // ㊿-s 타이틀에 올 때마다 무입력 시계를 새로 잰다
    if (data.meta.flow.edgeTriggerOnStateEnter) kb.maskHeld();
    if (attract && next === 'DRAFT') demoHoldT = data.meta.flow.attract.draftDwellSec * 1000 / data.meta.difficulty[difficultyId].speed;   // ㊿-s 카드 체류 — 게임초(§19.4-⑧)라 실시간은 ÷ 배속
    else if (DEMO && next === 'DRAFT') demoHoldT = 1200;         // 카드 ~1.2s 보여주고 자동 픽
    else if (DEMO && next === 'RESULTS') demoHoldT = 2500;  // 결과 ~2.5s 보여주고 루프
  }

  // §5.7 — blur → 자동 일시정지 + acc = 0. 세이브 없는 런이 알트탭으로 죽지 않는다
  if (rules.input.pauseOnBlur) {
    window.addEventListener('blur', () => {
      kb.clear();
      acc = 0;
      if (state === 'PLAY' && !attract) enter('PAUSE');   // ㊿-s 어트랙트는 멈추지 않는다 — «일시정지»가 걸린 데모는 고장처럼 보인다(사람의 입력 중 데모를 끝내는 것은 키·클릭뿐)
    });
  }
  // §7.10(㊶) — 탭이 숨겨지면 BGM 을 «끊는다». rAF 가 멈춰 스케줄은 알아서 서지만, **이미 예약된 음**은 컨텍스트가
  //   깨어나는 순간 한꺼번에 울린다(= 노래가 겹쳐 들린다, 사용자 보고 2026-09-05). 돌아오면 지금 시각에 새로 건다.
  if (audio !== null) {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { audio.bgmPause(); kb.clear(); acc = 0; }
      else audio.bgmStart();
    });
  }

  /**
   * ㊿-s 데모·어트랙트의 드래프트 — 봇이 고를 카드에 커서를 먼저 둔다(보여 주는 것 = 고르는 것). draft.auto 가 안내 줄을
   *   「봇이 고르는 중」으로 바꾼다(hud.drawDraft) — «1 / 2 / 3 선택» 안내대로 누르면 데모에서 튕겨 나갔다(검토).
   *   ★ 게임이 멈춘 동안 한 번만 부르므로, 고르는 시각을 «열 때»로 옮겨도 ?demo 의 고정 시드 판은 그대로다.
   */
  function prepareDraftCursor() {
    const auto = DEMO || attract;
    draft.auto = auto;
    cursor = auto ? botDraftPick(world, draft) : 0;
  }

  function openDraftIfQueued() {
    if (world.draftQueue <= 0) return false;
    if (!data.meta.draft.pauseGame) return false;   // §6.4 — 드래프트는 게임 클럭을 멈춘다
    draft = buildDraft(world);
    prepareDraftCursor();
    acc = 0;
    enter('DRAFT');
    return true;
  }

  // §11.6(v1.10 ⑲) 특성 3택 — 같은 DRAFT 화면·같은 입력(tickDraft/pick). 후보가 0장이면(전부 보유) 큐만 비운다.
  function openTraitDraft() {
    const td = buildTraitDraft(world);
    if (td.cards.length === 0) { world.traitQueue = 0; return false; }
    draft = td;
    prepareDraftCursor();
    acc = 0;
    enter('DRAFT');
    return true;
  }

  // ★ v1.5 — 상점 입력(tickShop)은 폐지됐다: 경제 제거.

  function tickDraft(confirmE) {
    const b = rules.input.bindings;
    for (let i = 0; i < b.draftPick.length; i += 1) {
      if (edge.pressed(b.draftPick[i]) && i < draft.cards.length) { pick(i); return; }
    }
    if (edge.pressed(b.cursor[0])) cursor = (cursor + draft.cards.length - 1) % draft.cards.length;
    if (edge.pressed(b.cursor[1])) cursor = (cursor + 1) % draft.cards.length;
    if (confirmE) { pick(cursor); return; }             // ★ 상단에서 소비한 Enter 를 넘겨받는다
    // §5.2 — Escape 는 무시한다 (드래프트는 스킵 불가, 리롤 폐지). Q W E R 는 죽은 키(Space/Enter 는 확정으로 통일)
  }

  function pick(i) {
    applyCard(world, draft.cards[i]);         // §6.4 — 큐를 하나 줄인다
    draft = null;
    if (!openDraftIfQueued()) { enter('PLAY'); last = performance.now(); }
  }

  // ★★ §9.3(v1.10 ㊱ · ㊳ 개정) — 프레임 격리. 사용자(2026-09-05): 「무슨 일이 있더라도 게임이 깨지는 경우가 나와선 안 된다」.
  //   ㊱ 은 프레임 예외를 fatal(루프 정지 + 에러 화면)로 만들었다. 그건 «조용한 잔상»보다는 낫지만 **게임이 멈춘다** —
  //   플레이어에게는 그것도 «깨진 것»이다. ㊳ 의 계약은 세 겹이다:
  //     ① **매 프레임 캔버스를 원상으로 시작한다** (`ctx.reset()` — 상태·변환·클립·save 스택이 전부 초기화된다).
  //        그래서 어떤 프레임이 어떻게 망가지든 **다음 프레임으로 새지 않는다**(잔상 화면의 구조적 재발 방지).
  //     ② 예외는 그 프레임만 버리고 루프는 계속 돈다 — 스텝 예외면 그 틱만, 렌더 예외면 그 그리기만.
  //     ③ 조용히는 아니다: 콘솔에 처음 5건을 스택과 함께 남기고, 화면 구석에 «렌더 오류 N» 배지를 띄운다.
  //   개발 쪽 «시끄러움»은 테스트가 진다 — tests/render.test.mjs 의 브라우저 충실 스텁이 예외 1건에 빨간불이 된다.
  let frameErrN = 0;
  let frameErrMsg = '';
  function noteFrameError(err) {
    frameErrN += 1;
    frameErrMsg = String(err && err.message ? err.message : err).slice(0, 90);
    if (frameErrN <= 5) console.error(`[프레임 오류 ${frameErrN}]`, err);      // eslint-disable-line no-console
  }

  /** 캔버스를 공장 상태로 — save 스택·클립·알파·합성·변환 전부. reset() 이 없는 구형 브라우저는 폭으로 리셋한다. */
  function resetCtx() {
    if (typeof ctx.reset === 'function') ctx.reset();
    else { const bw = canvas.width; canvas.width = bw; }   // 폴백: 크기 재대입 = 컨텍스트 완전 초기화
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(now) {
    requestAnimationFrame(frame);
    try { frameBody(now); } catch (err) { noteFrameError(err); }
  }

  function frameBody(now) {
    if (audio !== null) audio.bgmTick();          // §7.10 v1.5 — BGM look-ahead 스케줄(매 프레임)

    if (viewportTooSmall(view)) {
      if (state !== 'TOO_SMALL') { if (attract) endAttract(); tooSmallReturn = state; state = 'TOO_SMALL'; }   // ㊿-s 어트랙트는 끝낸다 — 창이 돌아왔을 때 «일시정지»된 데모가 남지 않게
    } else if (state === 'TOO_SMALL') {
      // 창이 다시 커지면 직전 상태로 복귀(런 중이면 PAUSE, 메뉴면 그 메뉴)
      enter(tooSmallReturn === 'PLAY' ? 'PAUSE' : tooSmallReturn); last = now; acc = 0;
    }

    const dpr = fitCanvas(canvas, view);
    resetCtx();                               // ㊳ ① 프레임의 시작 = 공장 상태 (앞 프레임의 상태가 절대 새지 않는다)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 이후 모든 좌표 = 논리 픽셀 (§1.1)

    const elapsed = now - last;
    last = now;

    // ★ 엣지는 매 프레임 소비해 prev 를 갱신한다(상태가 어긋나지 않게). ★v1.5 키 통일:
    //   «Space 또는 Enter» = 확정/시작/스킵/재시작/선택(전 화면 동일) · Escape = 일시정지/뒤로 ·
    //   O = 옵션 · M = 음소거. (이전엔 화면마다 Space/Enter 가 갈렸다 — 플레이 피드백 반영.)
    const pauseEdge = edge.pressed(rules.input.bindings.pause);
    const startEdge = edge.pressed(rules.input.bindings.grab);       // Space
    const confirmEdge = edge.pressed(rules.input.bindings.confirm);  // Enter
    const muteEdge = edge.pressed(rules.input.bindings.mute);        // M
    const optionsEdge = edge.pressed(rules.input.bindings.options);  // O
    const upEdge = edge.pressed(rules.input.bindings.cursor[2]);
    const downEdge = edge.pressed(rules.input.bindings.cursor[3]);
    const advanceEdge = startEdge || confirmEdge;                    // ★ 통일된 «확정/진행» = Space ∨ Enter
    // §6.5(㊿-s) 어트랙트 중 입력(키·클릭 깃발) = 즉시 타이틀. 누른 키는 enter() 가 가려(maskHeld) 타이틀에서 «시작»으로 새지 않는다.
    if (attract && attractExit) { endAttract(); renderFrame(); return; }

    // ── §6.5 메뉴(런 없음) ─────────────────────────────────────────
    if (state === 'TITLE') {
      if (advanceEdge) enter('DIFFICULTY');
      else if (optionsEdge) { optionsFrom = 'TITLE'; enter('OPTIONS'); }
      else if (!DEMO && now - lastInputAt >= data.meta.flow.attractIdleSec * 1000) startAttract();   // ㊿-s 무입력 → 봇 쇼케이스
      renderFrame();
      return;
    }
    if (state === 'DIFFICULTY') {
      if (upEdge) diffCursor = (diffCursor + MENU.length - 1) % MENU.length;
      if (downEdge) diffCursor = (diffCursor + 1) % MENU.length;
      if (advanceEdge) {
        if (MENU[diffCursor] === MENU_TUTORIAL) startTutorial();       // §6.7 — 난이도가 아니라 «연습»
        else startRun(MENU[diffCursor]);                               // → THEME_BANNER
      }
      else if (pauseEdge) enter('TITLE');
      renderFrame();
      return;
    }
    if (state === 'OPTIONS') {
      if (audio !== null) {
        if (muteEdge) audio.toggleMuted();                     // M = 뮤트 토글(통일)
        if (upEdge) audio.setVolume(audio.getVolume() + 0.1);
        if (downEdge) audio.setVolume(audio.getVolume() - 0.1);
      }
      if (pauseEdge || optionsEdge || advanceEdge) enter(optionsFrom);   // Esc·O·Space·Enter = 나가기
      renderFrame();
      return;
    }

    // ── §6.5 THEME_BANNER — 실시간 카운트다운, Space/Enter 로 스킵 → PLAY ──
    if (state === 'THEME_BANNER') {
      bannerT -= Math.min(elapsed, rules.loop.maxFrameGapMs);   // §10.1 프레임 갭 클램프(첫 프레임 폭주 방지)
      if (advanceEdge || bannerT <= 0) { enter('PLAY'); last = now; acc = 0; }
      renderFrame();
      return;
    }

    // §5.7 — Escape = 일시정지 토글 (PLAY ↔ PAUSE).
    if (pauseEdge && state === 'PLAY') { enter('PAUSE'); acc = 0; }
    else if (pauseEdge && state === 'PAUSE') { enter('PLAY'); acc = 0; }
    else if (pauseEdge && state === 'RESULTS') { enter('TITLE'); }
    // §5.5 — PAUSE 에서 O = OPTIONS
    else if (optionsEdge && state === 'PAUSE') { optionsFrom = 'PAUSE'; enter('OPTIONS'); }
    // §6.5 — RESULTS 에서 Space/Enter = 같은 난이도 즉시 재시작(통일)
    if (advanceEdge && state === 'RESULTS') { startRun(difficultyId); }
    if (DEMO && state === 'RESULTS') { demoHoldT -= elapsed; if (demoHoldT <= 0) startRun('normal'); }  // 데모 루프

    // §6.7 ㊴ — 튜토리얼: 마지막 스텝의 확정(Space) · 전 스텝 완료 → 타이틀
    if (world !== null && world.tut !== undefined && state === 'PLAY') {
      world.over = false;                                          // 튜토리얼에는 사망이 없다(§6.7) — step 은 over 면 아무것도 안 한다
      if (world.tut.done) { world = null; document.title = baseTitle; enter('DIFFICULTY'); return; }   // 끝나면 시작 메뉴로(바로 난이도를 고를 수 있게)
    }

    if (state === 'PLAY') {
      // §10.1 — 고정 타임스텝. maxFrameGapMs 로 프레임 갭을 자른다
      acc += Math.min(elapsed, rules.loop.maxFrameGapMs);
      let steps = 0;
      try {                                    // ㊳ ② 스텝 예외는 그 틱만 버린다 — 렌더는 계속된다(게임이 멈추지 않는다)
      while (acc >= tickDur && steps < rules.loop.maxStepsPerFrame) {
        captureInterp(interp, world);         // §10.1 — 보간용 직전 위치. 렌더가 자기 것으로 들고 있는다
        step(world, (DEMO || attract) ? botInput(world, 1 / TICK_HZ) : pollInput(kb, rules.input.bindings, input), 1 / TICK_HZ);   // ★ dt 는 상수. speed 를 곱하지 않는다 (데모·어트랙트=봇 입력)
        updateFx(fx, world, 1 / TICK_HZ);
        playHitCues(attract ? null : audio, world);            // §7.7 — 이 스텝의 히트 tier 를 SFX 로 (시각 짝, §7.10) · ㊿-s 어트랙트는 무음
        playEventCues(attract ? null : audio, world, audioPrev); // §7.10 — 레벨업·피격·스탠스 SFX
        acc -= tickDur;
        steps += 1;
        // §6.5(㊿-s) 어트랙트는 사망·잡몹 페이즈 끝에서 결과 화면 없이 타이틀로(core.attractOver)
        if (attract && attractOver(world)) { endAttract(); break; }
        // §11.4(v1.5) — 사망 = 즉시 결과. 컨티뉴 폐지 = 원데스=게임오버.
        if (world.over) { enter('RESULTS'); break; }
        // §6.5(v1.5) STAGE_CLEAR → (§11.6 특성 선택) → 회복 → 바로 다음 스테이지 배너 (상점 폐지).
        if (world.run.phase === PHASE.STAGE_CLEAR) {
          // §11.6(v1.10 ⑲) 보스의 금색 구슬을 먹었으면(traitQueue) 먼저 특성 3택 — 고르면 다음 프레임에 여기로 다시 온다
          if (world.traitQueue > 0 && openTraitDraft()) break;
          applyStageClearHeal(world);
          advanceStage(world);
          enterBanner();
          break;
        }
        if (world.draftQueue > 0 && openDraftIfQueued()) break;
      }
      } catch (err) { noteFrameError(err); acc = 0; }
      // §10.1 — 나선형 죽음 방지: 남은 시간 폐기 (빨리감기 금지)
      if (acc >= tickDur) acc = 0;
    } else {
      acc = 0;
      if (state === 'DRAFT') {
        if (DEMO || attract) { demoHoldT -= elapsed; if (demoHoldT <= 0) pick(cursor); }  // 봇 자동 픽(데모·어트랙트) — 커서는 열 때 봇이 고른 카드(prepareDraftCursor)
        else tickDraft(advanceEdge);
      }
      else if (state === 'TOO_SMALL') { /* 입력 무시 (§1.1) */ }
      // PAUSE 재개는 위의 Escape 토글이 처리한다 (§5.7)
    }

    renderFrame();
  }

  /** ㊳ ②③ — 렌더 예외는 그 «그리기»만 버린다. 캔버스는 다음 프레임에 resetCtx() 로 어차피 공장 상태가 된다. */
  function renderFrame() {
    try { renderWorldAndOverlays(); } catch (err) { noteFrameError(err); }
    if (frameErrN > 0) {
      // 조용히 지나가지 않는다 — 구석의 작은 배지(플레이를 막지 않는다). 자기 자신은 절대 던지지 않게 최소한만 쓴다.
      try {
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillStyle = pal.threat.telegraph;
        ctx.font = `700 ${rules.hud.fontSmallPx}px ${rules.visual.text.family}`;
        ctx.fillText(`렌더 오류 ${frameErrN} — ${frameErrMsg}`, 8, view.logicalH - 18);
      } catch (e2) { /* 배지조차 못 그리면 그냥 넘어간다 */ }
    }
  }

  /** 모든 상태의 렌더. 메뉴 상태(TITLE/DIFFICULTY/OPTIONS)는 world 가 없다 → 메뉴 배경을 그린다. */
  function renderWorldAndOverlays() {
    if (state === 'TOO_SMALL') {
      menuBg();
      menuBanner('창이 너무 작습니다',
        `최소 ${view.minViewportW} × ${view.minViewportH} — 데스크톱 키보드 전용`);
      return;
    }
    if (world === null) {   // TITLE / DIFFICULTY / OPTIONS
      menuBg();
      if (state === 'TITLE') drawTitleScreen();
      else if (state === 'DIFFICULTY') drawDifficultyScreen();
      else if (state === 'OPTIONS') drawOptionsScreen();
      return;
    }

    const alpha = state === 'PLAY' ? acc / tickDur : 0;    // §10.1 — 위치 lerp 만. 로직 금지
    drawWorld(ctx, world, pal, fx, interp, alpha);
    drawPanels(ctx, world, pal);
    if (world.tut !== undefined) drawTutorial(ctx, world, pal, tutorialStep(world));   // §6.7 ㊴
    if (state === 'THEME_BANNER') drawThemeBanner();
    if (state === 'DRAFT') drawDraft(ctx, world, pal, draft, cursor);
    if (state === 'PAUSE') banner(ctx, data, pal, '일시정지', '[Esc] 재개   ·   [O] 옵션');
    if (state === 'OPTIONS') drawOptionsScreen();          // PAUSE→OPTIONS 는 world 위에 겹친다
    // §11.3 — 결과 화면(죽어도 집계된다). 내역 + 총점.
    if (state === 'RESULTS') drawResults(ctx, world, pal, tally(world), `시드 ${seedHex(seed)}`);
    if (attract) drawAttractTag();                         // ㊿-s «데모» 표시 — 맨 마지막(드래프트 오버레이에 묻히지 않게)
  }

  /**
   * §6.5(v1.10 ㊿-x) 어트랙트 표시 — 오락실 어트랙트 화면의 표기를 그대로 쓴다(사용자(2026-09-12) 「데모 플레이라고 하기에는 좀 어색한 것 같아 · 글자가 좀 더 커져야 할 것 같고 · 오락실 감성이 더 들어갔으면」).
   *   두 줄: 큰 「AUTO PLAY」(항상) + 「PRESS ANY KEY」(1초에 한 번 깜빡). 상자를 두르지 않고 화면에 바로 얹되,
   *   외곽선으로 읽히게 한다 — 밝은 탄 위에서도 글자가 뭉개지지 않는다. 외곽선 색의 거처는 palette.threat.outline 하나다(§7.12.7).
   *   ★ ㊿-z 부터 이 두 줄은 도트 글자다 — 외곽선도 strokeText 가 아니라 «칸 한 겹»이다(도트에는 획이 없다, §7.9.1).
   *   메뉴 화면의 도트 글자에는 외곽선이 없다(뒤가 단색 판이라 할 일이 없다). 여기만 두른다 — 플레이 화면 위에 얹히기 때문이다.
   *   자리 = 아레나 상단 띠 바로 아래(보스 코어 체력바를 안 가린다) · 드래프트 중엔 카드 아래(오버레이 위에 그린다).
   *   ★ 깜빡임은 **실시간**(performance.now)이다 — 드래프트 체류 중에는 월드 시계가 멈춘다(§0.2.1). 화면이 멈춘 것처럼 보이면 안 된다.
   */
  function drawAttractTag() {
    const a = view.arena;
    const cx = a.x + a.w / 2;
    const y = state === 'DRAFT' ? view.logicalH - 52 : a.y + view.bandTopH + 30;
    // ㊿-z — 메뉴와 같은 도트 폰트로 찍는다(한 벌로 보여야 한다). 외곽선 색의 거처는 palette.threat.outline 하나다(§7.12.7).
    const out = pal.threat.outline;
    ctx.save();
    dotText(ctx, 'AUTO PLAY', cx, y, dotScale(rules.hud.fontLargePx), pal.hud.textPrimary, { outline: out });
    if (performance.now() % 1000 < 600) {
      dotText(ctx, 'PRESS ANY KEY', cx, y + rules.hud.fontLargePx + 6, dotScale(rules.hud.fontMediumPx), pal.hud.accent, { outline: out });
    }
    ctx.restore();
  }

  // ── §6.5 메뉴 렌더 (world 없이도 그린다) ──────────────────────────────
  function menuBg() {
    ctx.fillStyle = pal.hud.panelBg;
    ctx.fillRect(0, 0, view.logicalW, view.logicalH);
  }
  function mText(text, y, sizePx, color, weight, align) {
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.font = `${weight || 400} ${sizePx}px ${rules.visual.text.family}`;
    ctx.fillText(text, view.logicalW / 2, y);
  }
  function menuBanner(title, sub) {
    const h = rules.hud;
    mText(title, view.logicalH / 2 - 16, h.fontHeroPx, pal.hud.textPrimary, 800);
    mText(sub, view.logicalH / 2 + 24, h.fontBodyPx, pal.hud.textDim, 400);
  }
  /** ㊿-z — 제목은 굵은 도트 로고(글자마다 4속성 색 = 「프리즘」), 나머지는 5×7 도트 폰트. 문구는 영어다(§7.9.1). */
  function logoColors() {
    const e = pal.element;
    return [e.normal, e.fire, e.water, e.grass];
  }
  function drawTitleScreen() {
    const h = rules.hud;
    const d = rules.visual.dot;
    //   ㊿-z2 사용자(2026-09-12) 「제목 크기를 좀 큼직하게 키웠으면 해 — PRISM WING도, alien invasion도, 밑에 있는 start도」
    //   → ㊿-z3 「조금 너무 큰 것 같아. 이전이랑 지금의 중간 정도로」 → ㊿-z4 「이전으로 다시 롤백해줘. 그게 가장 나은것 같네」
    //   = 키우기 전(㊿-z)의 크기로 되돌린다. 배율 키 셋은 남긴다 — 사다리가 성긴 것이 문제였지 배율이 갈린 것은 문제가 아니었고,
    //   되돌린 값(5 · 4 · 2)은 토큰에서 파생하던 옛 값과 정확히 같다.
    //   ★ 타이틀 세 줄은 **자기 배율을 갖는다**(§7.9.1 의 예외) — 글자 크기 토큰에서 파생하면 ×4 와 ×6 사이가 없어
    //   «중간»을 잡을 수 없다. 간판은 본문이 아니므로 본문의 크기 사다리를 따라갈 이유도 없다.
    dotLogo(ctx, 'PRISM WING', view.logicalW / 2, view.logicalH / 2 - 76, d.logoScale, {
      slant: d.logoSlant, colors: logoColors(), outline: pal.threat.outline,
      topTint: d.logoTopTint, bottomShade: d.logoBottomShade,
    });
    dotText(ctx, 'ALIEN INVASION', view.logicalW / 2, view.logicalH / 2 - 18,
      d.titleSubScale, pal.hud.textPrimary);
    dotText(ctx, '[SPACE/ENTER] START    [O] OPTIONS', view.logicalW / 2, view.logicalH / 2 + 46,
      d.titlePromptScale, pal.hud.textDim);
    // ㊴ — 「QWER 스탠스 · 상성 ×2 …」 요약 줄 삭제(사용자 2026-09-05). 규칙은 문장이 아니라 **튜토리얼이 가르친다**.
  }
  // ㊿ 사용자(2026-09-06): 「튜토리얼, 노멀, 하드, 헬 이렇게 구분」 — 디재스터 삭제.
  const DIFF_LABEL = { normal: 'NORMAL', hard: 'HARD', hell: 'HELL' };   // ㊿-z 도트 폰트는 영문만 찍는다(§7.9.1)
  //   ㊿-z 난이도 두 열의 x · ㊿-z6 에서 설명줄이 짧아져 다시 잡았다.
  //   가장 긴 설명줄(헬 = ×1.5 SPEED · ×1.5 SCORE · 도트 ×2 = 274px)이 604 에서 시작해 878 에서 끝나므로,
  //   블록 [402, 878] 의 가운데가 **정확히 640 = 화면 가운데**다.
  //   커서 → 이름 → 설명 순으로 28 · 174 씩 띄운다. 가장 긴 이름(TUTORIAL = 141px)도 설명 열을 안 넘는다(430+141 = 571 < 604).
  const MENU_CURSOR_X = 402;
  const MENU_NAME_X = 430;
  const MENU_STAT_X = 604;
  function drawDifficultyScreen() {
    const h = rules.hud;
    dotText(ctx, 'SELECT MODE', view.logicalW / 2, view.logicalH / 2 - 130,
      dotScale(h.fontLargePx), pal.hud.textPrimary);
    for (let i = 0; i < MENU.length; i += 1) {
      const id = MENU[i];
      const sel = i === diffCursor;
      const y = view.logicalH / 2 - 70 + i * 46;
      const tut = id === MENU_TUTORIAL;
      const d = tut ? null : data.meta.difficulty[id];
      // ㊻ 사용자(2026-09-06): 「튜토리얼 이렇게만 하자」 — 부제·설명 줄 없이 이름만.
      // ㊿-c 사용자(2026-09-06): 「진화 무기 3개 이상 · ×0.62 체력 이런거 빼고, 속도랑 점수만」 —
      //   「일반인 기준에서는 노멀을 선택할 것 같거든? 그래서 그냥 저런 언급 없이도 괜찮을것 같아.」
      //   ★ 체력 배율(hpMul)은 «있지만 안 보인다» — 난이도의 뜻은 이름이 말하고, 수치는 고르는 사람을 겁준다.
      // ㊿-u 사용자(2026-09-12) 「지금 모드에 따라 공격력이 바뀌었잖아? 그 정보가 각 모드 (난이도) 선택화면에 반영이 되어야할 것 같은데」
      //   → 적 공격력(enemyDmgMul)은 보인다 — 맞는 순간 체감하는 차이라 고를 때 알려 준다. 체력 배율은 계속 숨긴다(노멀 ×0.81 같은 «할인 값»은 헷갈린다).
      //   ㊿-z — 한 줄로 붙어 있던 것을 두 열로 나눈다. 고른 줄에는 네모 커서가 붙는다(「▶」 한 글자는 긴 줄에 묻혔다).
      const tone = sel ? pal.hud.textPrimary : pal.hud.textDim;
      if (sel) {
        ctx.fillStyle = pal.hud.textPrimary;
        ctx.fillRect(MENU_CURSOR_X, y - 10, 10, 20);
      }
      dotText(ctx, tut ? 'TUTORIAL' : (DIFF_LABEL[id] || id), 0, y, dotScale(h.fontMediumPx), tone, { left: MENU_NAME_X });
      if (!tut) {
        //   ㊿-z6 사용자(2026-09-12) 「select mode 에서는 그냥 속도랑 score 만 보여지면 좋을것 같아」 —
        //   ㊿-u 가 넣었던 적 공격 배율을 도로 뺀다. 적의 «세기»는 이제 공격력·발사 주기 두 축이라
        //   한 줄에 다 적으면 고르는 사람이 읽을 수 없고, 하나만 적으면 거짓이 된다. 그래서 둘 다 숨긴다(hpMul 과 같은 처지).
        dotText(ctx, `×${d.speed} SPEED · ×${d.scoreMul} SCORE`,
          0, y, dotScale(h.fontBodyPx), tone, { left: MENU_STAT_X });
      }
    }
    dotText(ctx, '[UP/DOWN] SELECT   [SPACE/ENTER] START   [ESC] BACK',
      view.logicalW / 2, view.logicalH / 2 + 150, dotScale(h.fontSmallPx), pal.hud.textDim);
  }
  function drawOptionsScreen() {
    const h = rules.hud;
    if (world !== null) { ctx.save(); ctx.fillStyle = rgba(pal.threat.outline, 0.72); ctx.fillRect(view.arena.x, 0, view.arena.w, view.logicalH); ctx.restore(); }
    const cx = view.logicalW / 2;
    dotText(ctx, 'OPTIONS', cx, view.logicalH / 2 - 70, dotScale(h.fontLargePx), pal.hud.textPrimary);
    if (audio === null) {
      dotText(ctx, 'NO AUDIO (VISUAL ONLY)', cx, view.logicalH / 2 - 12, dotScale(h.fontBodyPx), pal.hud.textDim);
    } else {
      const muted = audio.isMuted();
      const vol = Math.round(audio.getVolume() * 100);
      dotText(ctx, `SOUND   ${muted ? 'MUTED' : `${vol}%`}`, cx, view.logicalH / 2 - 12,
        dotScale(h.fontBodyPx), muted ? pal.hud.textDim : pal.hud.textPrimary);
      dotText(ctx, '[M] MUTE   [UP/DOWN] VOLUME', cx, view.logicalH / 2 + 28, dotScale(h.fontSmallPx), pal.hud.textDim);
    }
    dotText(ctx, '[ESC] BACK', cx, view.logicalH / 2 + 60, dotScale(h.fontSmallPx), pal.hud.textDim);
  }
  function drawThemeBanner() {
    const h = rules.hud;
    const st = stageEntry(world);
    const n = world.run.stageIndex + 1;
    const total = world.run.order.length;
    ctx.save();
    ctx.fillStyle = rgba(pal.threat.outline, 0.55);
    ctx.fillRect(view.arena.x, view.logicalH / 2 - 60, view.arena.w, 120);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = pal.hud.textDim;
    ctx.font = `700 ${h.fontBodyPx}px ${rules.visual.text.family}`;
    ctx.fillText(`스테이지 ${n} / ${total}`, view.arena.x + view.arena.w / 2, view.logicalH / 2 - 20);
    ctx.fillStyle = pal.hud.textPrimary;
    ctx.font = `800 ${h.fontHeroPx}px ${rules.visual.text.family}`;
    ctx.fillText(st.name, view.arena.x + view.arena.w / 2, view.logicalH / 2 + 18);
    ctx.restore();
  }

  if (DEMO) startRun('normal');              // 데모: TITLE/DIFFICULTY 건너뛰고 즉시 자동 플레이
  requestAnimationFrame(frame);
}

function banner(ctx, data, pal, title, sub) {
  const v = data.rules.view;
  const h = data.rules.hud;
  ctx.save();
  ctx.fillStyle = rgba(pal.threat.outline, 0.72);      // §7.2 — 색의 유일한 거처는 palette 다
  ctx.fillRect(v.arena.x, 0, v.arena.w, v.logicalH);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = pal.hud.textPrimary;
  ctx.font = `800 ${h.fontHeroPx}px ${data.rules.visual.text.family}`;
  ctx.fillText(title, v.arena.x + v.arena.w / 2, v.logicalH / 2 - 16);
  ctx.fillStyle = pal.hud.textDim;
  ctx.font = `400 ${h.fontBodyPx}px ${data.rules.visual.text.family}`;
  ctx.fillText(sub, v.arena.x + v.arena.w / 2, v.logicalH / 2 + 24);
  ctx.restore();
}

boot().catch(fatal);
