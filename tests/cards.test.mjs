/**
 * tests/cards.test.mjs — §11.1 · v1.10 ㊿-zl 드래프트 카드 «전수» 넘침 검사.
 *
 * ★ 이 파일이 생긴 이유(사용자 플레이테스트 제보 2026-10-10 「칸에 글자가 넘친다 — 흡혈 선택에서」):
 *   ㊿-zj 가 HUD 표기(fmtTrait)에 흡혈 조건 「(HP 50%↓ · 조준 무기)」를 붙였고, 카드의 증분 줄이 같은 함수를
 *   「이전 → 이후」 양쪽에 썼다 → 「0.5% (HP 50%↓ · 조준 무기) → 0.75% (HP 50%↓ · 조준 무기)」 한 줄(16px 408~425px)이
 *   300px 카드 밖으로 60px 넘게 삐져나갔다. 기존 검사(render.test.mjs ㊴)는 «줄바꿈하는 문장»(desc · 이름)만 폭을 쟀고
 *   한 줄짜리(제목 · 증분 줄 · 진화 수치)는 아무도 재지 않았다. 세로 검사(㊿-r)도 무기 카드만 봤다.
 *
 * 방법: 나올 수 있는 카드를 «전부» 만든다(새 무기 · 무기 Lv1→최대(진화 포함) · 속성 · 패시브 Lv0→최대 · 특성 Lv0→5 · 보급) →
 *   한 장씩 drawDraft 로 그리며 fillText 를 기록 → 모든 글줄이 카드 상자 안(가로 · 세로)인지 본다.
 *   글자 폭은 보수적으로 어림한다: 한글·기호(U+1100 이상) = 글자 크기 1em, 그 밖 = 0.6em. 맥(애플 SD 산돌고딕 0.86em)보다
 *   넓고 윈도(맑은 고딕 ≈ 1em)에 가깝다 — 어느 기기에서도 넘치지 않아야 하므로 넓은 쪽으로 잰다.
 *   ★ 데이터 문구가 바뀌어도(무기·패시브·특성 desc · 레벨 표) 이 검사가 같이 돈다 → 다음 넘침은 플레이 전에 잡힌다.
 */
import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, giveWeapon, applyTrait } from '../src/core/state.js';
import { weapons } from '../src/core/weapons/index.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { tickRun, initRun } from '../src/core/stage.js';
import { bossHook } from '../src/core/boss.js';
import { buildDraft } from '../src/core/draft.js';
import { WEAPON_MAX_LEVEL, WEAPON_EVOLVE_LEVEL } from '../src/core/schema.mjs';
import { resolvePalette } from '../src/render/draw.js';
import { drawDraft, drawPanels } from '../src/render/hud.js';

const CARD_W = 300;      // hud.drawDraft 의 cw
const MARGIN = 4;        // 카드 테두리에서 이만큼은 비어 있어야 «안»이다

/** 보수적인 글자 폭 — 한글·화살표 등(U+1100 이상) = 1em, 그 밖 = 0.6em */
function wideMeasure(s, px) {
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) >= 0x1100 ? px : px * 0.6;
  return w;
}

/** fillText · fillRect 를 기록하는 2D 컨텍스트. measureText 는 wideMeasure 를 쓴다(줄바꿈·맞춤도 이 폭으로 판단한다). */
function recordingCtx() {
  const state = { font: '16px sans-serif', textAlign: 'left', textBaseline: 'alphabetic', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1 };
  const stack = [];
  const rec = { texts: [], rects: [] };
  const px = () => { const m = /(\d+(?:\.\d+)?)px/.exec(state.font); return m ? Number(m[1]) : 16; };
  const target = {
    canvas: { width: 1280, height: 720 },
    save: () => { stack.push({ ...state }); },
    restore: () => { if (stack.length) Object.assign(state, stack.pop()); },
    measureText: (t) => ({ width: wideMeasure(t, px()) }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillText: (t, x, y) => { rec.texts.push({ t: String(t), x, y, px: px(), align: state.textAlign, w: wideMeasure(t, px()) }); },
    fillRect: (x, y, w, h) => { rec.rects.push({ x, y, w, h }); },
  };
  const ctx = new Proxy(target, {
    get(t, k) { if (k in t) return t[k]; if (k in state) return state[k]; return () => {}; },
    set(t, k, v) { state[k] = v; return true; },
  });
  return { ctx, rec };
}

function mkW() {
  const w = createWorld({ data: loadData(), seed: 5, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook }, startWeaponId: 'forward' });
  initRun(w);
  return w;
}

/** 카드 한 장을 그리고 카드 상자 밖으로 나간 글줄을 돌려준다. */
function overflowsOf(w, card) {
  const pal = resolvePalette(w.data.rules);
  const draft = buildDraft(w);
  draft.cards = [card];
  const { ctx, rec } = recordingCtx();
  drawDraft(ctx, w, pal, draft, 0);
  const box = rec.rects.find((r) => r.w === CARD_W && r.h > 300);
  assert.ok(box !== undefined, '카드 상자를 찾았다');
  const bad = [];
  let lines = 0;
  for (const r of rec.texts) {
    if (r.y < box.y) continue;                                   // 카드 위의 「LEVEL UP」 안내 줄
    lines += 1;
    const left = r.align === 'center' ? r.x - r.w / 2 : r.align === 'right' ? r.x - r.w : r.x;
    const right = left + r.w;
    const bottom = r.y + r.px / 2;                               // hud.text 는 textBaseline = middle
    const out = Math.max(box.x + MARGIN - left, right - (box.x + box.w - MARGIN), bottom - (box.y + box.h - MARGIN));
    if (out > 0.5) bad.push(`«${r.t}» ${r.px}px — ${out.toFixed(0)}px 넘침`);
  }
  return { bad, lines };
}

/** 나올 수 있는 카드 전부 — [이름, 세계를 준비하는 함수, 카드]. */
function allCards() {
  const d = loadData();
  const out = [];
  for (const def of d.weapons.weapons) {
    out.push([`새 무기 ${def.id}`, () => mkW(), () => ({ category: 'newWeapon', key: 'x', weaponId: def.id, slot: 1, weight: 1 })]);
  }
  for (const def of d.weapons.weapons) {
    for (let from = 1; from < WEAPON_MAX_LEVEL; from += 1) {
      const evo = from + 1 === WEAPON_EVOLVE_LEVEL;
      let si = -1;
      out.push([`무기 ${def.id} Lv${from}→${from + 1}${evo ? ' (진화)' : ''}`, () => {
        const w = mkW();
        si = w.slots.findIndex((s) => s.weaponId === def.id);
        if (si < 0) si = giveWeapon(w, def.id);
        w.slots[si].level = from;
        w.slots[si].evolved = from >= WEAPON_EVOLVE_LEVEL;
        return w;
      }, () => ({ category: 'weaponLevel', key: 'x', slot: si, weaponId: def.id, from, to: from + 1, isEvolution: evo, weight: 1 })]);
    }
  }
  const cap = d.rules.player.elementCapPerElement;
  const step = d.meta.draft.elementLevelStep;                  // ㊿-zn 속성 카드 한 장 = step 단계
  for (const el of d.elements.investable) {
    for (let lv = 0; lv < cap; lv += step) {
      const to = Math.min(lv + step, cap);
      out.push([`속성 ${el} ${lv}→${to}`, () => mkW(), () => ({ category: 'elementLevel', key: 'x', element: el, from: lv, to,
        prey: el, imbuedBefore: lv, imbuedAfter: to, weight: 1 })]);
    }
  }
  for (const p of d.passives.passives) {
    for (let lv = 0; lv < d.passives.maxLevel; lv += 1) {
      out.push([`패시브 ${p.id} ${lv}→${lv + 1}`, () => mkW(), () => ({ category: 'passive', key: 'x', passiveId: p.id, from: lv, to: lv + 1, isNew: lv === 0, weight: 1 })]);
    }
  }
  for (const t of d.traits.traits) {
    for (let lv = 0; lv < d.traits.maxLevel; lv += 1) {
      out.push([`특성 ${t.id} ${lv}→${lv + 1}`, () => mkW(), () => ({ category: 'trait', key: 'x', traitId: t.id, name: t.name, desc: t.desc, kind: t.effect.kind,
        level: lv, from: lv > 0 ? t.effect.values[lv - 1] : null, to: t.effect.values[lv], weight: 1 })]);
    }
  }
  const f = d.meta.draft.fallback;
  out.push(['보급', () => mkW(), () => ({ category: 'resupply', key: 'x', id: f.id, name: f.name, healPct: f.healPct, weight: 0 })]);
  return out;
}

suite('cards — §11.1 ㊿-zl 어떤 카드의 어떤 글줄도 카드 상자를 넘지 않는다 (전수)', () => {
  test('나올 수 있는 카드 전부 — 가로(좌우 4px 안) · 세로(바닥 4px 위)', () => {
    const fails = [];
    let cards = 0;
    let lines = 0;
    for (const [name, prep, make] of allCards()) {
      const w = prep();
      const r = overflowsOf(w, make());
      cards += 1;
      lines += r.lines;
      for (const b of r.bad) fails.push(`${name}: ${b}`);
    }
    assert.eq(fails.length, 0, `넘친 글줄 ${fails.length}개 — ${fails.slice(0, 6).join(' | ')}`);
    assert.gt(cards, 100, `검사한 카드 ${cards}장 (vacuous 아님 — ㊿-zn 무기 4단계 · 패시브 3단계 · 속성 카드 2단계)`);
    assert.gt(lines, 700, `검사한 글줄 ${lines}줄 (vacuous 아님)`);
  });

  test('한 줄로 쓰던 글줄이 넘치면 줄이거나 줄을 바꾼다 — 잘리지도, 밖으로 나가지도 않는다', () => {
    // 일부러 아주 긴 특성 이름을 만든다(제목은 한 줄로 그리던 자리다)
    const w = mkW();
    const t = w.data.traits.traits[0];
    const long = '아주 아주 긴 이름을 가진 특성 하나를 일부러 만들어 본다';
    const { bad } = overflowsOf(w, { category: 'trait', key: 'x', traitId: t.id, name: long, desc: t.desc, kind: t.effect.kind,
      level: 0, from: null, to: t.effect.values[0], weight: 1 });
    assert.eq(bad.length, 0, `넘친 글줄 0 — ${bad.join(' | ')}`);
    const pal = resolvePalette(w.data.rules);
    const draft = buildDraft(w);
    draft.cards = [{ category: 'trait', key: 'x', traitId: t.id, name: long, desc: t.desc, kind: t.effect.kind, level: 0, from: null, to: t.effect.values[0], weight: 1 }];
    const { ctx, rec } = recordingCtx();
    drawDraft(ctx, w, pal, draft, 0);
    const joined = rec.texts.map((r) => r.t).join(' ');
    for (const word of long.split(' ')) assert.ok(joined.includes(word), `글자를 잃지 않는다: 「${word}」`);
    const minPx = w.data.rules.visual.text.minPx;
    for (const r of rec.texts) assert.ok(r.px >= minPx, `«${r.t}» ${r.px}px ≥ visual.text.minPx ${minPx}`);
  });
});

suite('cards — ㊿-zl 흡혈 카드의 증분 줄 (사용자 제보 2026-10-10)', () => {
  const texts = (w, card) => {
    const pal = resolvePalette(w.data.rules);
    const draft = buildDraft(w);
    draft.cards = [card];
    const { ctx, rec } = recordingCtx();
    drawDraft(ctx, w, pal, draft, 0);
    return rec.texts.map((r) => r.t);
  };

  test('강화 카드의 증분 줄은 «값 → 값» 만 — 조건을 양쪽에 되풀이하지 않는다 · 조건은 설명 문장이 말한다', () => {
    const w = mkW();
    const t = w.data.traits.traits.find((x) => x.id === 'lifesteal');
    const v = t.effect.values;
    const pct = (x) => `${Math.round(x * 10000) / 100}%`;
    const got = texts(w, { category: 'trait', key: 'x', traitId: t.id, name: t.name, desc: t.desc, kind: t.effect.kind, level: 1, from: v[0], to: v[1], weight: 1 });
    const want = `${pct(v[0])} → ${pct(v[1])}`;
    assert.ok(got.includes(want), `증분 줄 = 「${want}」 (${got.filter((s) => s.includes('→')).join(' | ')})`);
    assert.eq(got.some((s) => s.includes('→') && s.includes('조준')), false, '증분 줄에 조건(조준 무기)이 없다');
    assert.ok(got.join(' ').includes('조준'), '조건은 설명 문장(desc)으로 카드에 남는다');
  });

  test('HUD 좌 패널의 특성 줄은 그대로 조건을 단다 — 「1.5% (HP 50%↓ · 조준 무기)」 (㊿-zj)', () => {
    const w = mkW();
    const d = w.data.traits;
    for (let i = 0; i < d.maxLevel; i += 1) applyTrait(w, 'lifesteal');
    const t = d.traits.find((x) => x.id === 'lifesteal');
    const { ctx, rec } = recordingCtx();
    drawPanels(ctx, w, resolvePalette(w.data.rules));
    const line = rec.texts.map((r) => r.t).find((s) => s.includes('조준 무기'));
    assert.ok(line !== undefined, 'HUD 에 흡혈 조건 줄이 있다');
    assert.ok(line.includes(`HP ${Math.round(t.effect.hpRatio * 100)}%↓`), `HP 조건은 effect.hpRatio 에서 읽는다 (${line})`);
  });
});
