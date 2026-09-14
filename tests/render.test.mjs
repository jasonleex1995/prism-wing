/**
 * tests/render.test.mjs — 렌더 경로가 «한 판 내내» 던지지 않는다는 회귀망.
 *
 * ★ 이 파일이 존재하는 이유(실측된 사고): `drawEnemies` 가 개체의 모양을 `archetypeId` 로 찾는 바람에
 *   보스 코어·파트(archetypeId '')가 화면에 있는 **모든 프레임에서 던졌고**, 렌더가 패널을 그리기도
 *   전에 중단됐다. 순수 core 테스트는 그것을 절대 못 잡는다 — 렌더를 실제로 통과시켜야 잡힌다.
 *
 * 방법: 2D 컨텍스트를 **스텁**으로 세운다(모든 메서드 = noop, 모든 대입 = 삼킴). 그러면 그리기 자체는
 *   아무 일도 안 하지만, **데이터 조회 실패**(미지 shapeId · 없는 팔레트 키 · undefined 필드 접근)는
 *   그대로 예외로 드러난다. 즉 «칠은 안 보고 배선만 본다».
 *
 * 커버: 한 판(잡몹 → 중간보스 → 위기 → 보스 인트로 → 보스)의 전 프레임 + 결정 화면 4종.
 */

import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, giveWeapon, levelUpWeapon } from '../src/core/state.js';
import { step, makeInput, TICK_DT } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { tickRun, initRun } from '../src/core/stage.js';
import { makeTutorialState, tickTutorial } from '../src/core/tutorial.js';
import { spawnEnemy } from '../src/core/state.js';
import { bossHook } from '../src/core/boss.js';
import { resolvePalette, drawWorld, makeInterp, captureInterp, makeFx, updateFx, bulletDensityAlpha } from '../src/render/draw.js';
import { drawPanels, drawResults, drawDraft, wrapLines, passiveWeaponLine, weaponRowLayout, clockText } from '../src/render/hud.js';
import { BODY_STATS } from '../src/core/schema.mjs';
import { giveWeapon as giveW, passiveAffectsSlot, recomputeEff } from '../src/core/state.js';
import { buildDraft } from '../src/core/draft.js';
import { tally } from '../src/core/score.js';

/**
 * 브라우저를 흉내 내는 검증 2D 컨텍스트(v1.10 ㊱). 칠은 안 하지만 브라우저가 **던지는 것은 똑같이 던지고**, 브라우저가 조용히
 *   삼키는 잘못은 로그로 남긴다:
 *   · arc/ellipse/arcTo 음수 반지름 = IndexSizeError · roundRect 음수 = RangeError · 그라데이션 비유한 인자 = NotSupportedError
 *   · save/restore 깊이 · globalAlpha · globalCompositeOperation 을 추적한다(프레임이 끝나면 전부 원상이어야 한다)
 *   · fillStyle/strokeStyle 에 색이 아닌 문자열(NaN 등)이 들어오면 로그(브라우저는 무시해 «직전 색»으로 칠한다 = 조용한 버그)
 * ★ 이 스텁이 «전부 삼키는» 스텁이던 때, 둔화 장판 페이드 끝의 음수 반지름 arc() 를 못 잡았다 — 실제 브라우저는 예외를 던져
 *   프레임을 중간에 끊었고, 굳은 globalAlpha(≈0.02)로 다음 프레임의 배경이 칠해져 런 끝까지 «모든 물체가 잔상»을 남겼다
 *   (플레이테스트 스크린샷 · 숲 위기 진입). 스텁은 브라우저만큼 엄격해야 회귀망이 된다.
 */
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([-\d.e\s,]+\)|hsla?\([-\d.e\s,%]+\))$/;
function stubCtx() {
  const noop = () => {};
  const state = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1 };
  const stack = [];
  const log = [];
  const grad = { addColorStop: (o, c) => { if (typeof c === 'string' && !COLOR_RE.test(c)) log.push(`gradient color ${c}`); } };
  const finite = (...a) => a.every((v) => Number.isFinite(v));
  const target = {
    canvas: { width: 1280, height: 800 },
    save: () => { stack.push({ ...state }); },
    restore: () => { if (stack.length === 0) { log.push('restore on empty stack'); return; } Object.assign(state, stack.pop()); },
    arc: (x, y, r) => { if (!finite(x, y, r)) return; if (r < 0) throw new Error(`IndexSizeError: arc radius ${r}`); },
    ellipse: (x, y, rx, ry) => { if (!finite(x, y, rx, ry)) return; if (rx < 0 || ry < 0) throw new Error(`IndexSizeError: ellipse ${rx},${ry}`); },
    arcTo: (x1, y1, x2, y2, r) => { if (!finite(x1, y1, x2, y2, r)) return; if (r < 0) throw new Error(`IndexSizeError: arcTo ${r}`); },
    roundRect: (x, y, w, h, r) => { if (typeof r === 'number' && r < 0) throw new RangeError(`roundRect ${r}`); },
    createLinearGradient: (...a) => { if (!finite(...a)) throw new Error(`NotSupportedError: linear gradient ${a}`); return grad; },
    createRadialGradient: (x0, y0, r0, x1, y1, r1) => {
      if (!finite(x0, y0, r0, x1, y1, r1)) throw new Error(`NotSupportedError: radial gradient ${[x0, y0, r0, x1, y1, r1]}`);
      if (r0 < 0 || r1 < 0) throw new Error(`IndexSizeError: radial gradient ${r0},${r1}`);
      return grad;
    },
    measureText: () => ({ width: 10 }),
    __depth: () => stack.length,
    __state: state,
    __log: log,
  };
  return new Proxy(target, {
    get(t, k) { if (k in t) return t[k]; if (k in state) return state[k]; return noop; },
    set(t, k, v) {
      if ((k === 'fillStyle' || k === 'strokeStyle' || k === 'shadowColor') && typeof v === 'string' && !COLOR_RE.test(v)) log.push(`${k} ${v}`);
      if (k === 'globalAlpha' && !(v >= 0 && v <= 1)) log.push(`globalAlpha ${v}`);
      state[k] = v; return true;
    },
  });
}

/** 한 프레임 뒤의 캔버스 상태가 원상인지 — 깊이 0 · 알파 1 · source-over · 잘못된 색 0. 아니면 그 프레임 번호로 실패한다. */
function assertClean(ctx, frame) {
  assert.eq(ctx.__depth(), 0, `f${frame}: save/restore 균형`);
  assert.eq(ctx.__state.globalAlpha, 1, `f${frame}: globalAlpha 원상`);
  assert.eq(ctx.__state.globalCompositeOperation, 'source-over', `f${frame}: 합성 모드 원상`);
  assert.eq(ctx.__log.length, 0, `f${frame}: 잘못된 색/알파 0 — ${ctx.__log.slice(0, 3).join(' | ')}`);
}

function mkRun(seed) {
  const world = createWorld({
    data: loadData(), seed, weapons,
    hooks: { enemies, emitters, run: tickRun, boss: bossHook },
  });
  initRun(world);
  world.player.hp = 1e9; world.player.hpMax = 1e9;     // 관측 중 죽지 않게(전 페이즈를 보려면 살아야 한다)
  return world;
}

suite('render — 한 판 전 프레임이 던지지 않는다 (회귀망)', () => {
  test('잡몹 → 중간보스 → 위기 → 보스까지 전 프레임 렌더', () => {
    const w = mkRun(7);
    const pal = resolvePalette(w.data.rules);
    const fx = makeFx(w);
    const interp = makeInterp(w);
    const ctx = stubCtx();
    let frames = 0; let midFrames = 0; let bossFrames = 0;
    const total = Math.floor(190 / TICK_DT);
    for (let i = 0; i < total; i += 1) {
      captureInterp(interp, w);
      step(w, makeInput(), TICK_DT);
      updateFx(fx, w, TICK_DT);
      drawWorld(ctx, w, pal, fx, interp, 1);           // 던지면 여기서 테스트가 깨진다
      drawPanels(ctx, w, pal);
      assertClean(ctx, frames);
      frames += 1;
      for (const e of w.enemies.items) {
        if (!e.alive) continue;
        if (e.midBossId !== '') { midFrames += 1; break; }
      }
      for (const e of w.enemies.items) {
        if (e.alive && e.isBoss) { bossFrames += 1; break; }
      }
    }
    assert.eq(frames, total, '전 프레임을 그렸다');
    assert.gt(midFrames, 0, '중간보스가 실제로 화면에 있었다 (vacuous 아님)');
    assert.gt(bossFrames, 0, '보스가 실제로 화면에 있었다 (vacuous 아님)');
  });

  test('둔화 장판이 있는 숲 · 위기 진입(장판 페이드 → 반지름 0)에서도 전 프레임이 깨끗하다 (㊱ 잔상 회귀)', () => {
    const d = loadData();
    const w = createWorld({ data: d, seed: 19, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook }, startWeaponId: 'forward' });
    initRun(w); w.run.order[0] = 'forest'; w.run.stageIndex = 0;
    for (const id of ['lance', 'pinball', 'beam', 'aura', 'nova']) giveWeapon(w, id);
    for (let i = 0; i < w.slots.length; i += 1) { if (w.slots[i].weaponId === null) continue; for (let k = 0; k < 6; k += 1) levelUpWeapon(w, i); }
    w.player.hp = 1e9; w.player.hpMax = 1e9;
    const pal = resolvePalette(d.rules); const fx = makeFx(w); const interp = makeInterp(w); const ctx = stubCtx();
    let faded = 0; let crisisFrames = 0;
    const total = Math.floor(120 / TICK_DT);
    for (let i = 0; i < total; i += 1) {
      captureInterp(interp, w);
      step(w, makeInput(), TICK_DT);
      updateFx(fx, w, TICK_DT);
      for (const t of w.terrain.items) if (t.alive && t.fadeT >= 0) { faded += 1; break; }
      if (w.run.crisis) crisisFrames += 1;
      drawWorld(ctx, w, pal, fx, interp, (i % 3) / 3);
      drawPanels(ctx, w, pal);
      assertClean(ctx, i);
    }
    assert.gt(crisisFrames, 0, '위기에 실제로 들어갔다');
    assert.gt(faded, 0, '페이드 중인 장판을 실제로 그렸다 (vacuous 아님)');
  });

  test('결정 화면(드래프트·결과)도 던지지 않는다 (v1.5: 상점·사망 화면 폐지)', () => {
    const w = mkRun(3);
    const pal = resolvePalette(w.data.rules);
    const ctx = stubCtx();
    const draft = buildDraft(w);
    drawDraft(ctx, w, pal, draft, 0);
    drawResults(ctx, w, pal, tally(w), 'seed-3');
    assert.ok(true, '두 화면 모두 예외 없이 통과');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('render · §7.4 밀도 알파 (v1.10 ㉖ — 만렙 빌드의 백지 화면 회귀)', () => {
  test('탄 수 ≤ densityRef 면 상한, 그 위로는 상한 × ref / live, minAlpha 아래로는 안 간다 — 총 밝기(수 × 알파)가 늘지 않는다', () => {
    const d = loadData(); const r = d.rules.render;
    assert.ok(r.playerBulletDensityRef > 0 && r.playerBulletMinAlpha > 0 && r.playerBulletMinAlpha < r.playerBulletMaxAlpha, '키가 있고 순서가 맞다');
    assert.eq(bulletDensityAlpha(r, 0), r.playerBulletMaxAlpha, '0발 = 상한');
    assert.eq(bulletDensityAlpha(r, r.playerBulletDensityRef), r.playerBulletMaxAlpha, 'ref 발 = 상한');
    const a2 = bulletDensityAlpha(r, r.playerBulletDensityRef * 2);
    assert.near(a2, r.playerBulletMaxAlpha / 2, 1e-12, '2배면 절반');
    assert.near(2 * r.playerBulletDensityRef * a2, r.playerBulletDensityRef * r.playerBulletMaxAlpha, 1e-9, '수 × 알파 = 일정');
    assert.eq(bulletDensityAlpha(r, 100000), r.playerBulletMinAlpha, '바닥 = minAlpha');
    for (let n = 1; n < 600; n += 7) assert.ok(bulletDensityAlpha(r, n) >= bulletDensityAlpha(r, n + 7) - 1e-12, `단조 비증가 @${n}`);
    // 풀 상한(caps.playerBullets)에서의 총 밝기가 ref × 상한의 몇 배인가 — 바닥 때문에 조금 넘지만 4배는 안 넘는다
    const cap = d.rules.caps.playerBullets;
    assert.ok(cap * bulletDensityAlpha(r, cap) <= 4 * r.playerBulletDensityRef * r.playerBulletMaxAlpha, `풀 상한 ${cap}발의 총 밝기 ≤ 4 × 기준`);
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('render · §11.1 ㊴ 카드 줄바꿈 — 어떤 문장도 카드를 넘지 않는다', () => {
  const measure = (t) => t.length * 10;          // 글자당 10px 인 가짜 폰트(순수 함수라 테스트가 결정적이다)

  test('공백이 없는 긴 한 덩어리도 maxW 안으로 쪼갠다 (플레이테스트 회귀: 「다중 장전」 카드가 삐져나갔다)', () => {
    const s = '[탄] 탄 무기(벌컨·팬아웃·스파이럴·시커·리턴·미사일·핀볼)의 발사 수 +N';
    const lines = wrapLines(measure, s, 200);
    assert.gt(lines.length, 1, '여러 줄로 나뉜다');
    for (const l of lines) assert.ok(measure(l) <= 200, `줄이 폭 안에 있다: "${l}" (${measure(l)}px)`);
    assert.eq(lines.join('').replace(/ /g, ''), s.replace(/ /g, ''), '글자는 하나도 잃지 않는다');
  });

  test('실제 데이터의 모든 카드 문장이 카드 폭 안에 들어간다 (패시브·무기·특성 desc 전수)', () => {
    const d = loadData();
    const maxW = 264;                            // drawDraft 의 cw(300) − 36
    const strings = [];
    for (const p of d.passives.passives) strings.push(p.desc, p.name);
    for (const w of d.weapons.weapons) { strings.push(w.desc, w.name, w.evolution.desc, w.evolution.name); }
    for (const t of d.traits.traits) strings.push(t.desc, t.name);
    for (const st of d.tutorial.steps) strings.push(...st.lines);   // ㊿-q 검토: 필드는 title·lines 다(body·hint 는 없어 undefined 를 검사하고 있었다). 제목은 줄바꿈 없이 그려지므로(hud.drawTutorial) 줄만 본다
    let n = 0;
    for (const s of strings) {
      for (const l of wrapLines(measure, s, maxW)) {
        assert.ok(measure(l) <= maxW, `카드 폭 초과: "${l}"`);
        n += 1;
      }
    }
    assert.gt(n, 60, `검사한 줄 ${n} (vacuous 아님)`);
  });

  test('한 글자가 폭보다 넓어도 무한 루프에 빠지지 않는다 (극단)', () => {
    const lines = wrapLines(measure, '가나다라', 3);
    assert.eq(lines.length, 4, '글자마다 한 줄');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('render · §11.1 ㊸ 패시브 카드의 «내 무기» 줄', () => {
  test('기체 패시브에는 줄이 붙지 않는다 — 무기와 무관하기 때문이다 (강화 격벽이 「내 무기: 벌컨…」을 달던 회귀)', () => {
    const w = mkRun(5);
    for (const p of w.data.passives.passives) {
      const line = passiveWeaponLine(w, p.id);
      if (BODY_STATS.indexOf(p.stat) >= 0) assert.eq(line, null, `${p.id}(기체) = 줄 없음`);
      else assert.ok(line !== null && typeof line.text === 'string', `${p.id}(무기 분류) = 줄 있음`);
    }
  });

  test('㊸ 답은 «저작값»이 아니라 «지금 그 무기의 유효 파라미터»에서 나온다', () => {
    const w = mkRun(9);
    for (const s of w.slots) { s.weaponId = null; s.family = ''; }
    giveW(w, 'forward');
    const slot = w.slots.find((s) => s.family === 'forward');
    assert.eq(passiveAffectsSlot(w, slot, 'pierceAdd'), true, '벌컨은 관통 코팅을 받는다');
    // 유효 파라미터에서 pierce 가 «무제한(-1)»이 되면 관통 +N 은 의미가 없다 → 화면도 그렇게 답해야 한다
    const eff = recomputeEff(w, slot);
    const keep = eff.pierce;
    eff.pierce = -1; slot.effDirty = false;
    assert.eq(passiveAffectsSlot(w, slot, 'pierceAdd'), false, '무제한 관통이면 «혜택 없음»');
    eff.pierce = keep;
    // 키 자체가 없으면(그 무기의 계약에 없는 파라미터) 역시 없음
    delete eff.lifetimeSec;
    assert.eq(passiveAffectsSlot(w, slot, 'durationMul'), false, '수명 키가 없으면 장기 배터리 무효');
  });

  test('무기 분류 패시브는 «내가 든 무기 중 듣는 것»만 센다', () => {
    const w = mkRun(6);
    for (const s of w.slots) { s.weaponId = null; s.family = ''; }
    giveW(w, 'lance');                                   // 빔 하나만 든다
    const beam = passiveWeaponLine(w, 'highvolt');       // 빔 피해
    assert.eq(beam.hit.length, 1, '랜스 하나');
    assert.ok(beam.text.indexOf('랜스') >= 0, `${beam.text}`);
    const bullet = passiveWeaponLine(w, 'autoload');     // 탄 발사 수
    assert.eq(bullet.hit.length, 0, '탄 무기가 없다');
    assert.eq(bullet.text, '지금 내 무기엔 효과 없음', bullet.text);
  });
});

suite('render/무기 행 배치 §9.5 (v1.10 ㊿-d)', () => {
  // 한글 = 전각, ASCII ≈ 0.56 배 — 캔버스 없이 결정적으로 재는 근사 폰트
  const mm = (t, px) => [...t].reduce((a, c) => a + (/[가-힣]/.test(c) ? px : px * 0.56), 0);
  const W = () => loadData().rules.view.panelRightW - loadData().rules.hud.panelPadPx * 2;
  const SM = () => loadData().rules.hud.fontSmallPx;
  const BD = () => loadData().rules.hud.fontBodyPx;

  test('진화 임박 행: 이름·칩·힌트·레벨이 «겹치지 않는다» — 14 무기 전부', () => {
    const d = loadData();
    const w = W();
    const lvText = `Lv.${7}/10`;
    const lvW = mm(lvText, SM());
    let shown = 0;
    for (const wd of d.weapons.weapons) {
      const req = wd.evolution.requiresPassive;
      const pdef = d.passives.passives.find((q) => q.id === req.id);
      const full = `${pdef.name} 0/${req.level}`;
      const chip = '궤도';                       // 분류 칩 중 가장 긴 것(2자) = 최악
      const lay = weaponRowLayout(w, mm(wd.name, BD()), mm(chip, SM()), lvW, [full, `0/${req.level}`], (t) => mm(t, SM()));
      assert.ok(lay.hint !== '', `${wd.name}: 진화 힌트가 그려진다`);
      if (lay.hint === full) shown += 1;
      const hintRight = lay.hintX + mm(lay.hint, SM());
      const levelLeft = w - 46 - lvW;
      assert.ok(hintRight <= levelLeft, `${wd.name}: 힌트 우측 ${hintRight.toFixed(0)} ≤ 레벨 좌측 ${levelLeft.toFixed(0)}`);
      if (lay.showChip) {
        assert.ok(lay.chipX + mm(chip, SM()) <= lay.hintX, `${wd.name}: 칩이 힌트와 안 겹친다`);
      }
      assert.ok(26 + mm(wd.name, BD()) <= lay.chipX, `${wd.name}: 이름이 칩/힌트와 안 겹친다`);
    }
    assert.eq(shown, d.weapons.weapons.length, '14 무기 모두 «패시브 이름 + 진행»을 온전히 보여준다');
  });

  test('폭이 모자라면 칩 → 짧은 힌트 → 힌트 없음 순으로 양보한다', () => {
    const long = '아주아주아주 긴 무기 이름';
    const hints = ['자기 코일 0/3', '0/3'];
    const wide = weaponRowLayout(400, 30, 28, 46, hints, (t) => mm(t, 14));
    assert.eq(wide.hint, hints[0], '넉넉하면 전부');
    assert.eq(wide.showChip, true, '넉넉하면 칩도');
    const mid = weaponRowLayout(240, mm(long, 16), 28, 46, hints, (t) => mm(t, 14));
    assert.ok(mid.hint === hints[1] || mid.hint === '' || mid.showChip === false, '좁으면 양보한다');
    const tiny = weaponRowLayout(120, mm(long, 16), 28, 46, hints, (t) => mm(t, 14));
    assert.eq(tiny.hint, '', '아주 좁으면 힌트를 접는다 (겹쳐 찍지 않는다)');
    assert.eq(tiny.showChip, true, '힌트를 접었으면 칩은 남는다');
  });

  test('진화 임박이 아니면 힌트가 없다 (hints 빈 배열)', () => {
    const lay = weaponRowLayout(318, 32, 28, 55, [], (t) => mm(t, 14));
    assert.eq(lay.hint, '', '힌트 없음');
    assert.eq(lay.showChip, true, '칩은 그린다');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ㊿-q 회귀 — (1) 이지스 방패 링은 «오빗의 공»에만 (2) 진화 카드에 좌표 배열 파라미터가 숫자 줄로 찍히지 않는다
// ─────────────────────────────────────────────────────────────────────────
/** 링 획(선폭 2 · accent)과 fillText 문자열만 세는 기록 컨텍스트. 칠은 안 한다. */
function recorderCtx(accent) {
  const state = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif' };
  const stack = [];
  const rec = { ringStrokes: 0, texts: [] };
  const target = {
    canvas: { width: 1280, height: 800 },
    save: () => { stack.push({ ...state }); },
    restore: () => { if (stack.length) Object.assign(state, stack.pop()); },
    measureText: (t) => ({ width: String(t).length * 8 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    stroke: () => { if (state.lineWidth === 2 && state.strokeStyle === accent) rec.ringStrokes += 1; },
    fillText: (t) => { rec.texts.push(String(t)); },
  };
  const ctx = new Proxy(target, {
    get(t, k) { if (k in t) return t[k]; if (k in state) return state[k]; return () => {}; },
    set(t, k, v) { state[k] = v; return true; },
  });
  return { ctx, rec };
}

suite('render — ㊿-q 회귀 (방패 링 · 진화 카드)', () => {
  test('이지스 방패 링은 오빗의 공에만 그린다 — s0 를 다른 뜻으로 쓰는 무기(핀볼·리턴·미사일·시커)의 탄에는 안 붙는다', () => {
    const d = loadData();
    const pal = resolvePalette(d.rules);
    const mk = (ids) => {
      const w = createWorld({ data: d, seed: 11, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook }, startWeaponId: ids[0] });
      initRun(w);
      for (const id of ids.slice(1)) giveWeapon(w, id);
      for (let i = 0; i < w.slots.length; i += 1) {
        if (w.slots[i].weaponId === null) continue;
        for (let k = 0; k < 6; k += 1) levelUpWeapon(w, i);
      }
      w.player.hp = 1e9; w.player.hpMax = 1e9;
      return w;
    };
    const run = (w, frames) => {
      const fx = makeFx(w);
      const interp = makeInterp(w);
      const { ctx, rec } = recorderCtx(pal.hud.accent);
      let ringFrames = 0;
      let foreign = 0;
      for (let i = 0; i < frames; i += 1) {
        captureInterp(interp, w);
        step(w, makeInput(), TICK_DT);
        updateFx(fx, w, TICK_DT);
        for (const b of w.playerBullets.items) if (b.alive && b.family !== 'orbit' && b.s0 === 1) foreign += 1;
        const before = rec.ringStrokes;
        drawWorld(ctx, w, pal, fx, interp, 1);
        if (rec.ringStrokes > before) ringFrames += 1;
      }
      return { ringFrames, foreign };
    };
    const none = run(mk(['pinball', 'boomerang', 'missile', 'seeker']), 120);
    assert.gt(none.foreign, 0, '전제: 다른 무기의 탄이 실제로 s0 = 1 을 갖는다 (vacuous 아님)');
    assert.eq(none.ringFrames, 0, '오빗이 없으면 방패 링이 한 번도 안 그려진다');
    const wo = mk(['forward']);
    const s = wo.slots[giveWeapon(wo, 'orbit')];
    s.level = 8; s.evolved = true; s.effDirty = true; recomputeEff(wo, s);
    assert.gt(run(wo, 30).ringFrames, 0, '진화 오빗(이지스)에는 링이 그려진다');
  });

  test('진화 카드는 좌표 배열 파라미터를 숫자 줄로 찍지 않는다 (「잔상 자리 0,44」 회귀)', () => {
    const d = loadData();
    const pal = resolvePalette(d.rules);
    const w = createWorld({ data: d, seed: 3, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook }, startWeaponId: 'forward' });
    initRun(w);
    const withArrays = d.weapons.weapons.filter((x) => Object.values(x.evolution.params).some(Array.isArray));
    assert.gt(withArrays.length, 0, '전제: 배열 파라미터를 가진 진화가 있다');
    for (const def of withArrays) {
      const si = giveWeapon(w, def.id);
      const draft = buildDraft(w);
      draft.cards = [{ category: 'weaponLevel', key: `weaponLevel:${def.id}`, slot: si, weaponId: def.id, from: 7, to: 8, isEvolution: true, weight: 1 }];
      const { ctx, rec } = recorderCtx(pal.hud.accent);
      drawDraft(ctx, w, pal, draft, 0);
      assert.ok(rec.texts.includes(def.evolution.name), `${def.id}: 진화 카드가 실제로 그려졌다`);
      for (const [k, v] of Object.entries(def.evolution.params)) {
        if (!Array.isArray(v)) continue;
        assert.eq(rec.texts.some((t) => t.includes(String(v))), false, `${def.id}.${k}: 「${String(v)}」가 카드에 찍히지 않는다`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ㊿-r — 진화 카드는 «진화도 레벨업»: 칩 · Lv.8 레벨업 수치 · 진화 뒤 이름 · 카드 안에 들어가는가
// ─────────────────────────────────────────────────────────────────────────
/** fillText(문자열·x·y·글자 크기)와 fillRect 를 기록한다. 글자 폭은 한글 = 글자 크기, 그 밖 = 0.6배로 어림한다(8px 고정 스텁보다 실제에 가깝다). */
function layoutCtx() {
  const state = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '16px sans-serif', textAlign: 'left', textBaseline: 'alphabetic' };
  const stack = [];
  const rec = { texts: [], rects: [] };
  const px = () => { const m = /(\d+(?:\.\d+)?)px/.exec(state.font); return m ? Number(m[1]) : 16; };
  const target = {
    canvas: { width: 1280, height: 720 },
    save: () => { stack.push({ ...state }); },
    restore: () => { if (stack.length) Object.assign(state, stack.pop()); },
    measureText: (t) => ({ width: [...String(t)].reduce((s, ch) => s + (ch.charCodeAt(0) >= 0x1100 ? px() : px() * 0.6), 0) }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillText: (t, x, y) => { rec.texts.push({ t: String(t), x, y, px: px() }); },
    fillRect: (x, y, w, h) => { rec.rects.push({ x, y, w, h }); },
  };
  const ctx = new Proxy(target, {
    get(t, k) { if (k in t) return t[k]; if (k in state) return state[k]; return () => {}; },
    set(t, k, v) { state[k] = v; return true; },
  });
  return { ctx, rec };
}

suite('render — ㊿-r 진화 카드', () => {
  const mkW = () => {
    const w = createWorld({ data: loadData(), seed: 5, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook }, startWeaponId: 'forward' });
    initRun(w);
    return w;
  };
  const drawOne = (w, card) => {
    const pal = resolvePalette(w.data.rules);
    const draft = buildDraft(w);
    draft.cards = [card];
    const { ctx, rec } = layoutCtx();
    drawDraft(ctx, w, pal, draft, 0);
    return rec;
  };
  const levelCard = (def, si, from, isEvolution) => ({
    category: 'weaponLevel', key: `weaponLevel:${def.id}`, slot: si, weaponId: def.id, from, to: from + 1, isEvolution, weight: 1,
  });

  test('진화 카드 = 칩 「…진화」 · 진화 이름 · 소제목 「Lv.8 레벨업」 아래 그 레벨 칸의 «이전 → 이후» — 14개 무기 전부', () => {
    // ★ 2차 검토: «이후» 값만 보면 «이전» 을 한 칸 잘못 읽어도(연사 3 → 3), 조준 방식이 원문(randomInArena)으로 떠도 통과했다.
    const n = (v) => (typeof v !== 'number' ? String(v) : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let lines = 0;
    for (const def of loadData().weapons.weapons) {
      const w = mkW();
      let si = w.slots.findIndex((s) => s.weaponId === def.id);
      if (si < 0) si = giveWeapon(w, def.id);
      const texts = drawOne(w, levelCard(def, si, 7, true)).texts.map((r) => r.t);
      assert.ok(texts.includes(def.evolution.name), `${def.id}: 제목 = 진화 이름`);
      assert.ok(texts.some((t) => /진화$/.test(t)), `${def.id}: 칩이 「…진화」 — 일반 레벨업 칩(「…레벨」)과 다르다`);
      const scalar = Object.entries(def.levels[7]).filter(([, v]) => !Array.isArray(v));
      assert.eq(texts.includes('Lv.8 레벨업'), scalar.length > 0, `${def.id}: 소제목 「Lv.8 레벨업」은 Lv8 칸에 수치가 있을 때만`);
      const before = Object.assign({}, def.base);
      for (let i = 0; i < 7; i += 1) Object.assign(before, def.levels[i]);
      for (const [k, v] of scalar) {
        if (typeof v === 'string') continue;                  // 문자열 값(조준 방식)은 아래에서 한글로 본다
        const re = new RegExp(`${esc(n(before[k]))}\\D{0,3} → ${esc(n(v))}`);
        assert.ok(texts.some((t) => re.test(t)), `${def.id}: Lv8 칸 ${k} 「${n(before[k])} → ${n(v)}」가 보인다`);
        lines += 1;
      }
      for (const t of texts) assert.eq(/randomInArena|densest|nearest|forward|sweep/.test(t), false, `${def.id}: 조준 방식이 원문으로 뜨지 않는다 (${t})`);
      if (def.id === 'barrage') assert.ok(texts.some((t) => t.includes('무작위 → 적이 몰린 곳')), '바라지: 「조준 무작위 → 적이 몰린 곳」');
    }
    assert.gt(lines, 20, `검사한 Lv8 수치 줄 ${lines} (vacuous 아님)`);
    // 일반 레벨업 카드는 그대로 — 소제목 없음 · 좌표 배열은 「배치 변경」
    const w = mkW();
    const drone = loadData().weapons.weapons.find((x) => x.id === 'drone');
    const di = giveWeapon(w, 'drone');
    const plain = drawOne(w, levelCard(drone, di, 2, false)).texts.map((r) => r.t);
    assert.eq(plain.includes('Lv.3 레벨업'), false, '일반 레벨업 카드에는 소제목이 없다');
    assert.ok(plain.some((t) => t.endsWith('변경')), '일반 레벨업 카드는 좌표 배열을 「배치 변경」으로 보인다');
  });

  test('진화 뒤 레벨업(Lv9·10) 카드는 진화 이름으로 말한다 — 「오버드라이브 Lv.9」', () => {
    const w = mkW();
    const def = w.data.weapons.weapons.find((x) => x.id === 'forward');
    const si = w.slots.findIndex((s) => s.weaponId === 'forward');
    w.slots[si].level = 8; w.slots[si].evolved = true;
    const texts = drawOne(w, levelCard(def, si, 8, false)).texts.map((r) => r.t);
    assert.ok(texts.includes(`${def.evolution.name} Lv.9`), `제목 = 「${def.evolution.name} Lv.9」`);
    assert.eq(texts.includes(`${def.name} Lv.9`), false, `「${def.name} Lv.9」가 아니다`);
    assert.ok(texts.includes(def.evolution.desc), '효과 줄 = 진화체의 설명');
    assert.ok(texts.includes('Lv.8/10 → 9/10'), '맨 아래 줄 = 「Lv.8/10 → 9/10」');
    assert.eq(texts.some((t) => t.includes('진화 ·')), false, '맨 아래 줄에 「… 진화 ·」가 없다 — 진화 카드의 줄과 같으면 «두 번째 진화»로 읽힌다');
  });

  test('모든 무기의 진화 카드 · 진화 뒤 Lv.10 카드가 세로로 넘치지 않는다 (줄이 늘어도 상자 바닥 안)', () => {
    let checked = 0;
    for (const def of loadData().weapons.weapons) {
      for (const evo of [true, false]) {
        const w = mkW();
        let si = w.slots.findIndex((s) => s.weaponId === def.id);
        if (si < 0) si = giveWeapon(w, def.id);
        if (!evo) { w.slots[si].level = 9; w.slots[si].evolved = true; }
        const rec = drawOne(w, levelCard(def, si, evo ? 7 : 9, evo));
        const box = rec.rects.find((r) => r.w === 300 && r.h > 100);
        assert.ok(box !== undefined, `${def.id}: 카드 상자를 찾았다`);
        const inside = rec.texts.filter((r) => r.x >= box.x && r.x <= box.x + box.w && r.y >= box.y);
        const bottom = Math.max(...inside.map((r) => r.y + r.px / 2));
        assert.lte(bottom, box.y + box.h - 6, `${def.id} ${evo ? '진화' : 'Lv.10'} 카드: 마지막 줄 바닥 ${bottom.toFixed(0)} ≤ 상자 ${box.y + box.h - 6}`);
        checked += 1;
      }
    }
    assert.gt(checked, 20, `검사한 카드 ${checked}장 (vacuous 아님)`);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ㊿-s — 진화 카드의 보라
// ─────────────────────────────────────────────────────────────────────────
suite('render — ㊿-s 진화 카드 테두리', () => {
  // 카드 한 장을 그리고 «테두리(strokeRect) · 윗줄(높이 4 fillRect) · 칩 글자(…진화 / …레벨)»의 색·굵기를 기록한다
  const drawCard = (isEvolution, selected, palOverride) => {
    const d = loadData();
    const w = createWorld({ data: d, seed: 5, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook }, startWeaponId: 'forward' });
    initRun(w);
    const si = w.slots.findIndex((s) => s.weaponId === 'forward');
    const draft = buildDraft(w);
    draft.cards = [{ category: 'weaponLevel', key: 'weaponLevel:forward', slot: si, weaponId: 'forward',
      from: isEvolution ? 7 : 2, to: isEvolution ? 8 : 3, isEvolution, weight: 1 }];
    const state = { strokeStyle: '#000', fillStyle: '#000', lineWidth: 1, font: '16px sans-serif' };
    const rec = { strokes: [], bars: [], texts: [] };
    const target = {
      canvas: { width: 1280, height: 720 },
      measureText: (t) => ({ width: String(t).length * 16 }),
      strokeRect: (x, y, ww, hh) => { rec.strokes.push({ style: state.strokeStyle, lw: state.lineWidth, ww, hh }); },
      fillRect: (x, y, ww, hh) => { if (hh === 4) rec.bars.push({ style: state.fillStyle, ww }); },
      fillText: (t) => { rec.texts.push({ t: String(t), style: state.fillStyle }); },
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
    };
    const ctx = new Proxy(target, {
      get(t, k) { if (k in t) return t[k]; if (k in state) return state[k]; return () => {}; },
      set(t, k, v) { state[k] = v; return true; },
    });
    drawDraft(ctx, w, palOverride || resolvePalette(d.rules), draft, selected ? 0 : 5);   // 커서 5 = 카드 밖(고르지 않음)
    const border = rec.strokes.find((s) => s.hh > 300);
    return {
      border,
      bar: border === undefined ? undefined : rec.bars.find((b) => b.ww === border.ww),
      chip: rec.texts.find((x) => /^(무)?속성 (진화|레벨)$/.test(x.t)),
    };
  };

  test('진화 카드 = 칩·윗줄·테두리가 보라(고르지 않아도) · 일반 카드엔 보라가 없다 · 굵기는 «선택»만 말한다', () => {
    const V = resolvePalette(loadData().rules).hud.evolution;
    const pal = resolvePalette(loadData().rules);
    assert.eq(typeof V, 'string', '전제: 팔레트에 진화 색이 있다');
    const cards = { evo: drawCard(true, false), evoSel: drawCard(true, true), plain: drawCard(false, false), plainSel: drawCard(false, true) };
    for (const [name, r] of Object.entries(cards)) {
      assert.ok(r.border !== undefined && r.bar !== undefined && r.chip !== undefined, `${name}: 테두리·윗줄·칩을 찾았다`);
    }
    assert.eq(cards.evo.border.style, V, '진화 카드(고르지 않음) 테두리 = 보라');
    assert.eq(cards.evoSel.border.style, V, '진화 카드(고름) 테두리 = 보라');
    assert.eq(cards.evo.bar.style, V, '진화 카드 윗줄 = 보라');
    assert.eq(cards.evo.chip.style, V, '진화 카드 칩 글자 = 보라');
    assert.ok(/진화$/.test(cards.evo.chip.t), `진화 카드 칩 = 「…진화」 (${cards.evo.chip.t})`);
    assert.eq(cards.plain.border.style, pal.hud.panelRule, '일반 카드(고르지 않음) 테두리 = 회색');
    for (const name of ['plain', 'plainSel']) {
      const r = cards[name];
      assert.ok(r.border.style !== V && r.bar.style !== V && r.chip.style !== V, `${name}: 일반 레벨업 카드엔 보라가 없다`);
    }
    // 굵기 = 선택만 — 진화 카드라서 더 굵거나 덜 굵지 않다(커서가 진화 카드 위에서도 똑같이 읽힌다)
    assert.gt(cards.evoSel.border.lw, cards.evo.border.lw, '진화 카드: 고르면 더 굵다');
    assert.eq(cards.evo.border.lw, cards.plain.border.lw, '고르지 않은 굵기는 진화·일반이 같다');
    assert.eq(cards.evoSel.border.lw, cards.plainSel.border.lw, '고른 굵기는 진화·일반이 같다');
  });

  test('진화 색은 다른 색 채널과 같지 않고, 흑백(mono)에서는 무채색 — 그때도 칩 글자 「…진화」가 종류를 말한다', () => {
    const d = loadData();
    const pal = resolvePalette(d.rules);
    const others = [pal.hud.accent, pal.status.band, pal.threat.enemyBullet, pal.threat.telegraph, pal.pickup.trait, pal.pickup.xp,
      pal.hud.panelRule, pal.hud.textPrimary, ...Object.values(pal.element)];
    for (const c of others) assert.ok(c.toLowerCase() !== pal.hud.evolution.toLowerCase(), `진화 색이 다른 채널(${c})과 같지 않다`);
    const mono = resolvePalette({ ...d.rules, visual: { ...d.rules.visual, a11y: { ...d.rules.visual.a11y, cbMode: 'mono' } } });
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(mono.hud.evolution);
    assert.ok(m !== null && m[1].toLowerCase() === m[2].toLowerCase() && m[2].toLowerCase() === m[3].toLowerCase(), `mono 에서 진화 색 = 무채색 (${mono.hud.evolution})`);
    const evoMono = drawCard(true, false, mono);
    assert.ok(evoMono.chip !== undefined && /진화$/.test(evoMono.chip.t), 'mono 에서도 칩 글자가 「…진화」');
  });
});

suite('render — ㊿-s 카드 단위 · 데모 드래프트 안내', () => {
  const mkDraftWorld = () => {
    const w = createWorld({ data: loadData(), seed: 5, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook }, startWeaponId: 'forward' });
    initRun(w);
    return w;
  };
  const textsOf = (w, cards, auto) => {
    const draft = buildDraft(w);
    draft.cards = cards;
    if (auto !== undefined) draft.auto = auto;
    const { ctx, rec } = layoutCtx();
    drawDraft(ctx, w, resolvePalette(w.data.rules), draft, 0);
    return rec.texts.map((r) => r.t);
  };

  test('각도/초 키(*DegSec)는 «°/초» — 「공전 속도 90초 → 105초」처럼 느려지는 것으로 읽히지 않는다', () => {
    const w = mkDraftWorld();
    const oi = giveWeapon(w, 'orbit');
    const def = loadData().weapons.weapons.find((x) => x.id === 'orbit');
    const after = def.levels[1].angularSpeedDegSec;
    assert.eq(typeof after, 'number', '전제: 오빗 Lv2 칸이 공전 속도를 바꾼다');
    const texts = textsOf(w, [{ category: 'weaponLevel', key: 'weaponLevel:orbit', slot: oi, weaponId: 'orbit', from: 1, to: 2, isEvolution: false, weight: 1 }]);
    const want = `공전 속도 ${def.base.angularSpeedDegSec}°/초 → ${after}°/초`;
    assert.ok(texts.includes(want), `오빗 Lv2 카드 = 「${want}」 (${texts.filter((t) => t.includes('공전')).join(' | ')})`);
    assert.eq(texts.some((t) => t.includes('공전') && /\d초/.test(t)), false, '공전 속도 줄에 «초» 단위(각도 없이)가 붙지 않는다');
  });

  test('데모·어트랙트 드래프트(draft.auto)는 «1 / 2 / 3 선택» 대신 «봇이 고르는 중» — 사람 드래프트는 그대로', () => {
    const w = mkDraftWorld();
    const fi = w.slots.findIndex((s) => s.weaponId === 'forward');
    const card = { category: 'weaponLevel', key: 'weaponLevel:forward', slot: fi, weaponId: 'forward', from: 1, to: 2, isEvolution: false, weight: 1 };
    const human = textsOf(w, [card]);
    const auto = textsOf(w, [card], true);
    assert.ok(human.some((t) => t.includes('1 / 2 / 3 선택')), '사람 드래프트 = 「1 / 2 / 3 선택」 안내');
    assert.eq(auto.some((t) => t.includes('선택') || t.includes('확정')), false, '데모 드래프트엔 «선택»·«확정» 안내가 없다 — 그 말대로 누르면 데모에서 튕겨 나간다');
    assert.ok(auto.some((t) => t.includes('봇이 고르는 중')), '데모 드래프트 = 「데모 — 봇이 고르는 중」');
  });
});

suite('render — ㊿-u 결과 화면의 클리어 시간', () => {
  const results = (won, ticks, difficulty = 'normal') => {
    const w = createWorld({ data: loadData(), seed: 7, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook }, startWeaponId: 'forward', difficulty });
    initRun(w);
    w.tick = ticks;
    w.run.won = won;
    const { ctx, rec } = layoutCtx();
    drawResults(ctx, w, resolvePalette(w.data.rules), tally(w), 'seed');
    return rec.texts.map((r) => r.t);
  };

  test('클리어하면 「클리어!」 아래에 「클리어 시간 m:ss」 — 사망한 판에는 없다', () => {
    const d = loadData();
    assert.eq(d.meta.difficulty.normal.speed, 1, '전제: 노멀 배속 1');
    const win = results(true, 43554);                // 43,554틱 = 725.9초
    assert.ok(win.includes('클리어!'), '전제: 클리어 화면');
    assert.ok(win.includes('클리어 시간 12:05'), `노멀 725.9초 → 「12:05」(초는 두 자리 · 소수 버림) (${win.filter((t) => t.includes('시간')).join(' | ')})`);
    // 헬은 배속만큼 실제로 흐른 시간이 짧다 — 725.9 게임초 ÷ 1.25 = 580.7초 → 「9:40」
    const hellWin = results(true, 43554, 'hell');
    const hellWant = `클리어 시간 ${clockText(43554 / d.rules.loop.tickHz / d.meta.difficulty.hell.speed)}`;
    assert.ok(d.meta.difficulty.hell.speed > 1 && hellWant !== '클리어 시간 12:05', `전제: 헬은 배속이 1보다 크다 (${hellWant})`);
    assert.ok(hellWin.includes(hellWant), `헬 = 실제로 플레이한 초 — 「${hellWant}」 (${hellWin.filter((t) => t.includes('시간')).join(' | ')})`);
    const lose = results(false, 43554);
    assert.ok(lose.includes('GAME OVER'), '전제: 사망 화면');
    assert.eq(lose.some((t) => t.includes('클리어 시간')), false, '사망한 판에는 클리어 시간이 없다');
  });

  test('clockText — 분:초 · 1시간 넘으면 시:분:초 · 음수·소수는 안전하게', () => {
    assert.eq(clockText(0), '0:00', '0초');
    assert.eq(clockText(59.99), '0:59', '초 아래는 버린다');
    assert.eq(clockText(120 / 60 - 2.2e-15), '0:02', '정초가 소수 오차로 살짝 모자라도 1초 빠지지 않는다(검토)');
    assert.eq(clockText(605), '10:05', '초는 두 자리');
    assert.eq(clockText(3725), '1:02:05', '1시간 넘으면 h:mm:ss');
    assert.eq(clockText(-3), '0:00', '음수 = 0');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ㊿-ze3 — 개체 위 HP 바는 «한 규격 · 한 자리»다.
//   튜토리얼 바를 hud.js 가 따로 그렸고 거기엔 보간이 없어(drawTutorial 이 interp·alpha 를 안 받는다)
//   바가 스프라이트보다 한 틱 늦게 따라붙었다. 그리고 한쪽만 0~1 클램프가 있었다.
//   ★ 테스트가 «그려진 사각형»을 직접 읽는다 — 규격이 다시 두 자리로 흩어지면 여기서 걸린다.
// ─────────────────────────────────────────────────────────────────────────
suite('render — ㊿-ze3 개체 HP 바', () => {
  //  ★ main.js startTutorial(488행)과 «같은 순서»로 조립한다 — initRun 을 빼면 world.run 이 없어
  //    지형도 구간 질의도 없는, 실제로는 존재하지 않는 판을 검사하게 된다(검토가 지적한 충실도 구멍).
  const mkTut = () => {
    const d = loadData();
    const w = createWorld({ data: d, seed: 1, weapons, hooks: { enemies: null, emitters, run: tickTutorial, boss: null },
      startWeaponId: d.tutorial.startWeaponId });
    initRun(w);
    w.tut = makeTutorialState();
    return w;
  };

  test('튜토리얼에서는 평범한 적도 바를 단다 — 그리고 바는 «보간된» 자리에 선다(스프라이트와 같은 x)', () => {
    const w = mkTut();
    const d = w.data;
    const hb = d.rules.visual.hpBar;
    const e = spawnEnemy(w, 'drifter', 'fire', 500, 220, 100, false);
    assert.ok(e !== null, '적이 섰다(전제)');
    e.hp = e.hpMax * 0.5;                                  // 반쯤 깎아 «채움»이 궤도의 절반이 되게
    const pal = resolvePalette(d.rules); const fx = makeFx(w); const interp = makeInterp(w);
    captureInterp(interp, w);                              // 직전 틱 위치 = 지금 위치
    e.x += 40;                                             // 한 틱 사이에 40px 움직였다 치고
    const { ctx, rec } = layoutCtx();
    drawWorld(ctx, w, pal, fx, interp, 0.5);               // alpha 0.5 → 보간 x = 500 + 20 = 520
    const track = rec.rects.filter((r) => r.w === hb.wPx && r.h === hb.hPx);
    assert.gt(track.length, 0, '★ 궤도 사각형(wPx×hPx)이 그려졌다 — 없으면 튜토리얼 적이 바를 잃은 것이다');
    const bx = 520 - hb.wPx / 2;
    const mine = track.filter((r) => Math.abs(r.x - bx) < 0.5);
    assert.gt(mine.length, 0, `★ 바가 «보간된» x(${bx})에 선다 — 생 e.x(${e.x - hb.wPx / 2})면 스프라이트보다 한 틱 늦는다`);
    const fill = rec.rects.find((r) => r.h === hb.hPx && Math.abs(r.x - bx) < 0.5 && Math.abs(r.w - hb.wPx * 0.5) < 0.5);
    assert.ok(fill !== undefined, 'HP 50% → 채움 폭도 궤도의 절반');
  });

  test('회복으로 hp 가 hpMax 를 넘어도 채움은 궤도를 안 넘는다 (0~1 클램프)', () => {
    const w = mkTut();
    const hb = w.data.rules.visual.hpBar;
    const e = spawnEnemy(w, 'drifter', 'fire', 500, 220, 100, false);
    e.hp = e.hpMax * 3;                                    // 있을 수 없는 값이 아니다 — 바를 그리는 쪽이 막아야 한다
    const pal = resolvePalette(w.data.rules); const fx = makeFx(w); const interp = makeInterp(w);
    captureInterp(interp, w);
    const { ctx, rec } = layoutCtx();
    drawWorld(ctx, w, pal, fx, interp, 0);
    const over = rec.rects.filter((r) => r.h === hb.hPx && r.w > hb.wPx + 0.5);
    assert.eq(over.length, 0, `★ 궤도(${hb.wPx}px)보다 넓은 채움이 ${over.length}개 — 클램프가 빠졌다`);
  });

  test('평시(튜토리얼 아님)에는 평범한 적이 바를 달지 않는다 — ㊷ 는 튜토리얼 한정이다', () => {
    const d = loadData();
    const w = createWorld({ data: d, seed: 1, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook }, startWeaponId: 'forward' });
    initRun(w);
    const hb = d.rules.visual.hpBar;
    const e = spawnEnemy(w, 'drifter', 'fire', 500, 220, 100, false);
    e.hp = e.hpMax * 0.5;
    const pal = resolvePalette(d.rules); const fx = makeFx(w); const interp = makeInterp(w);
    captureInterp(interp, w);
    const { ctx, rec } = layoutCtx();
    drawWorld(ctx, w, pal, fx, interp, 0);
    const bx = 500 - hb.wPx / 2;
    const mine = rec.rects.filter((r) => r.w === hb.wPx && r.h === hb.hPx && Math.abs(r.x - bx) < 0.5);
    assert.eq(mine.length, 0, '평범한 적에 바가 붙었다 — §7.7 밀도 논거가 깨진다');
  });
});
