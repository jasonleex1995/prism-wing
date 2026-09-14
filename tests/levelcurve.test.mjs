/**
 * tests/levelcurve.test.mjs — §9.5(v1.10 ㊿-s) S44 대용치가 «못 보는» 레벨 칸은 실측으로 오른다.
 *   S44 대용치 = dmg × passiveHooks.countKey ÷ rateKey. countKey 가 null 인 무기(바라지 포격 수 · 오빗 공전체 수)는 개수가 대용치에 없고,
 *   조준 방식이 바뀐 칸(바라지 Lv8) «직후»는 아예 비교하지 않는다(check.mjs S44). 그 칸들을 정본 §11.1.1 ㊿-s 채움 벤치와 같은 방법으로 잰다:
 *   무한 체력 표적(움직이지 않음) · 기체 고정 · 패시브 없음 · 120초 — 짧게 재면 발사 주기에 걸려 반올림된다(20초 벤치가 틀렸다, 검토).
 */
import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, giveWeapon, recomputeEff, spawnEnemy } from '../src/core/state.js';
import { step, makeInput, TICK_DT } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';

/** 레벨 level 무기 하나의 초당 피해 — field = 무작위로 흩어 놓은 24기 · ring = 궤도 위 8기(★ 그 레벨의 궤도 반경 위라 반경 자체의 변화는 못 본다 — 검토) */
function firepower(id, level, layout, secs) {
  const data = loadData();
  const w = createWorld({ data, seed: 3, weapons, hooks: {}, startWeaponId: 'forward' });
  for (const s of w.slots) s.weaponId = null;
  const slot = w.slots[giveWeapon(w, id)];
  slot.level = level; slot.evolved = level >= 8; slot.effDirty = true;
  const eff = recomputeEff(w, slot);
  w.player.hp = 1e9; w.player.hpMax = 1e9;
  w.tele = { dmgByFamily: {}, dmgTakenByArch: {} };
  const a = data.rules.view.arena;
  const p = w.player;
  let r = 12345;
  const rnd = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
  const spots = [];
  for (let i = 0; i < (layout === 'field' ? 24 : 8); i += 1) {
    if (layout === 'field') spots.push([a.x + 40 + rnd() * (a.w - 80), a.y + rnd() * a.h * 0.7]);
    else { const ang = (i / 8) * Math.PI * 2; spots.push([p.x + Math.cos(ang) * eff.orbitRadius, p.y + Math.sin(ang) * eff.orbitRadius]); }
  }
  const es = spots.map(([x, y]) => spawnEnemy(w, 'drifter', 'normal', x, y, 1e9, false, false));
  const input = makeInput();
  const ticks = Math.round(secs / TICK_DT);
  for (let t = 0; t < ticks; t += 1) {
    for (let i = 0; i < es.length; i += 1) { es[i].hp = 1e9; es[i].x = spots[i][0]; es[i].y = spots[i][1]; }
    step(w, input, TICK_DT);
  }
  return (w.tele.dmgByFamily[w.weaponDefs[id].family] || 0) / secs;
}

suite('levelcurve/S44 가 못 보는 칸 §9.5 ㊿-s', () => {
  test('바라지 Lv8 → 9 → 10 이 실제로 오른다 — 조준 변화 직후 칸 · 포격 수(countKey null)', () => {
    const v = [8, 9, 10].map((L) => firepower('barrage', L, 'field', 120));
    assert.gt(v[1], v[0] * 1.02, `Lv9 ${v[1].toFixed(0)} > Lv8 ${v[0].toFixed(0)} (+2% 넘게)`);
    assert.gt(v[2], v[1] * 1.02, `Lv10 ${v[2].toFixed(0)} > Lv9 ${v[1].toFixed(0)} (+2% 넘게)`);
  });

  test('오빗 Lv1 → 2 → 3 → 4 가 실제로 오른다 — 공전체 수(countKey null) · Lv2 는 공전 속도', () => {
    const v = [1, 2, 3, 4].map((L) => firepower('orbit', L, 'ring', 120));
    for (let i = 1; i < v.length; i += 1) assert.gt(v[i], v[i - 1] * 1.02, `Lv${i + 1} ${v[i].toFixed(0)} > Lv${i} ${v[i - 1].toFixed(0)} (+2% 넘게)`);
  });
});
