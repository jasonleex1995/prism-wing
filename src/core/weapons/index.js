/**
 * src/core/weapons/index.js — 패밀리 레지스트리 (§9.5)
 *
 * 사용 (§9.1 의 파일 배치는 확정돼 있으나 **합성 계약이 인쇄되지 않아** state.js 가 주입으로 뒀다):
 *   import { weapons } from './src/core/weapons/index.js';
 *   const world = createWorld({ data, seed, weapons, hooks: { enemies: null, emitters: null } });
 *
 * 각 모듈은 `{ update(world, slot, eff, dt) }` 를 default export 한다.
 * ★ 정정 — 아래 「JSON 을 스스로 읽지 않는다」는 **밸런스 수치**에 한한 말이다. 실제로는 5개 모듈이
 *   `world.data.rules.view.arena` · `elements.matrix` · `rules.player.iframeSec`
 *   를 읽는다(11군데) — 전부 «구조 상수»이고 밸런스 수치가 아니라 §9.1 리터럴 제약과 무관하다.
 * step.fireWeapons 가 슬롯마다 recomputeEff(world, slot) 를 계산해 넘기므로
 * ★ 무기 모듈은 JSON 을 스스로 읽지 않는다 → weapons/** 숫자 리터럴 제약이 자연히 지켜진다.
 *
 * ★ **10 패밀리 전부 구현 완료** (§9.5 의 표가 코드로 닫혔다. v1.5: omni·mine 삭제 = 12→10).
 *   step.fireWeapons 는 미등록 패밀리를 만나면 **조용히 넘어가지 않고 던진다**.
 *   ★ 보고 대상: draft.js 의 newWeapon 후보는 data/weapons.json 의 10 패밀리 전부에서 나온다.
 */

import forward from './forward.js';
import fan from './fan.js';
import seeker from './seeker.js';
import boomerang from './boomerang.js';
import aura from './aura.js';
import nova from './nova.js';
import lance from './lance.js';
import orbit from './orbit.js';
import barrage from './barrage.js';
import drone from './drone.js';
import missile from './missile.js';   // ㉟ 신설 5종
import chain from './chain.js';
import beam from './beam.js';
import pinball from './pinball.js';

/** 키 = §9.5 의 family (id == family, 15종 1:1 — ㉟) */
export const weapons = { forward, fan, seeker, boomerang, aura, nova, lance, orbit, barrage, drone, missile, chain, beam, pinball };
