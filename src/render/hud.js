/**
 * src/render/hud.js — 최소 HUD (브라우저 전용)
 *
 * 정본 v1.4 구현 절:
 *   §1.2   아레나 오버레이 띠 — 하단 A(672~696) HP 세그먼트 · 하단 B(696~720) XP
 *          판 알파 visual.band.plateAlpha 0.30 / **내용 불투명** visual.band.contentOpaque
 *   §2.1   칸당 = hpMax / hud.hpBarSegCount (★ 칸 수는 5 고정, 칸당이 파생값)
 *   §4.2   투자 상한 2종 — elementCapPerElement 4 · elementCapTotal 6
 *   §4.3   부여 — 슬롯 1..N. ★ 이 규칙을 화면에서 읽을 수 있게 하는 것이 이 파일의 존재 이유
 *   §5.1   키맵 Q/W/E/R
 *   §6.4   LV UP ×N 배지 (드래프트 큐)
 *   §7.2   팔레트 = rules.palette. ★ 이 파일에 색 리터럴이 없다
 *   §7.12.4-① 저체력 HP 바의 호박 (1Hz → 위독 2Hz). 호박 5곳 목록 안
 *   §9.4.1 hud 스코프 — hpBarSegCount · xpBarH · font*Px · panelPadPx · keycapBoxPx
 *          · showElementBudget · elementMatrixInPanel
 *   §11.1  드래프트 3택 (카드 표기 — 속성 카드의 부여 프리뷰 포함)
 *   §12.3  레이어 1(띠) · 12(HUD 패널)
 *
 * ★ 정본 §17 은 **패널 내부 레이아웃**을 02 섹션에 위임했고 그 문서는 이 저장소에 없다
 *   → 패널 안의 px 좌표는 이 파일이 임시로 소유한다 (보고 대상). 띠(§1.2)·칸 수·상한은 정본 값이다.
 */

import { rgba, glyphPath } from './draw.js';
import { WEAPON_MAX_LEVEL, WEAPON_EVOLVE_LEVEL, BODY_STATS } from '../core/schema.mjs';
import { PHASE, stageEntry } from '../core/stage.js';   // 읽기 전용 상수·질의 (render 는 core 를 읽기만 한다, §9.1)
import { passiveAffectsSlot } from '../core/state.js';   // ㊸ — 「이 패시브가 지금 내 무기에 실제로 듣는가」(§11.1, eff 기준)

/** §9.5 ㊵ 무기 분류의 화면 이름 — 값(class)의 소유자는 weapons.json 이고, 여기는 «부르는 말»만 갖는다. */
const CLASS_KO = { bullet: '탄', beam: '빔', area: '범위', orbital: '궤도' };

/**
 * ㊵·㊸ — 이 패시브(stat)에서 «지금 내가 든 무기» 중 **실제로 혜택을 받는** 것들. 사용자(2026-09-05): 「내 무기가 탄인지 아닌지를 잘 모르겠다」.
 *   판정은 core 의 passiveAppliesTo 하나뿐이다(드래프트 필터·S41 과 같은 표) — 화면이 다른 답을 하면 그게 거짓말이다.
 */
function affectedOwnedWeapons(world, stat) {
  const out = [];
  for (let i = 0; i < world.slots.length; i += 1) {
    const s = world.slots[i];
    if (s.weaponId === null) continue;
    if (!passiveAffectsSlot(world, s, stat)) continue;      // ㊸ 저작값이 아니라 «지금 그 무기의 유효 파라미터»로 답한다
    const def = world.weaponDefs[s.family];
    out.push(s.evolved ? def.evolution.name : def.name);
  }
  return out;
}

/**
 * ㊸ — 패시브 카드의 «내 무기» 줄. ★ **무기와 관련된 패시브에만 붙는다**(사용자 2026-09-06: 「강화 격벽은 무기랑 상관 없잖아」).
 *   기체 4(최대 HP·지형 저항·XP·상성 증폭)는 무기를 가리지 않으므로 이 줄이 없는 것이 정답이다 — 있으면 «무기 때문에 좋은 카드»로 읽힌다.
 *   @returns { text, hit } · 기체 패시브면 null
 */
export function passiveWeaponLine(world, passiveId) {
  const def = world.data.passives.passives.find((p) => p.id === passiveId);
  if (def === undefined || BODY_STATS.indexOf(def.stat) >= 0) return null;
  const hit = affectedOwnedWeapons(world, def.stat);
  return { hit, text: hit.length > 0 ? `내 무기: ${hit.join(' · ')}` : '지금 내 무기엔 효과 없음' };
}

const KEYCAP = { normal: 'Q', fire: 'W', water: 'E', grass: 'R' };
// ★ §11.1 — 드래프트 카드는 키 문자(W/E/R)가 아니라 **속성 이름**을 말한다. 키 배정은 §5.1
//   패널에서만 노출하고, "무엇을 하는가"를 묻는 카드에는 노출하지 않는다 (사용자 피드백).
const ELEMENT_NAME = { normal: '노말', fire: '불', water: '물', grass: '풀' };

function font(world, px, weight) {
  return `${weight} ${px}px ${world.data.rules.visual.text.family}`;
}

/** §9.4.3 visual.text.outlinePx + §7.2 — 텍스트 아웃라인 색 = palette.threat.outline (색의 유일한 거처) */
function text(ctx, world, pal, s, x, y, px, color, align, weight) {
  ctx.font = font(world, px, weight === undefined ? 400 : weight);
  ctx.textAlign = align === undefined ? 'left' : align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = world.data.rules.visual.text.outlinePx;
  ctx.strokeStyle = pal.threat.outline;
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

// ---------------------------------------------------------------------------
// 레이어 1 — 아레나 오버레이 띠 (§1.2). draw.js 가 아레나 클립 안에서 부른다
// ---------------------------------------------------------------------------
/**
 * §1.2 상단 띠 (0~48) — 스테이지 표시 · 보스 타이머(§7.12.1 3단) · 보스 코어 HP(40~48).
 *   §1.2 「없을 때: 바 자체를 그리지 않는다(빈 트랙 금지)」 — 런이 없거나 보스가 없으면 그 요소를 생략.
 *   §7.12.1 3단: 정상 은색 / 잔여 ≤ timerWarnSec 경고(색 불변 + 크기·맥동) / ≤ timerRedAlertSec 자홍.
 */
function drawTopBand(ctx, world, pal) {
  const run = world.run;
  if (run === undefined) return;                       // 런 미구동(테스트 월드) — 띠 자체를 그리지 않는다
  const v = world.data.rules.view;
  const h = world.data.rules.hud;
  const vb = world.data.rules.visual.band;
  const a = v.arena;
  const topH = v.bandTopH;
  const pad = 8;

  ctx.fillStyle = rgba(pal.hud.panelBg, vb.plateAlpha);
  ctx.fillRect(a.x, a.y, a.w, topH);

  ctx.save();
  if (vb.contentOpaque) ctx.globalAlpha = 1.0;

  // 좌 — 스테이지 n/N + 테마 이름 (지금 어디인지가 항상 보인다)
  const id = run.order[run.stageIndex];
  const list = world.data.stages.stages;
  let stage = null;
  for (let i = 0; i < list.length; i += 1) if (list[i].id === id) { stage = list[i]; break; }
  text(ctx, world, pal, `${run.stageIndex + 1}/${run.order.length}  ${stage === null ? id : stage.name}`,
    a.x + pad, a.y + 16, h.fontBodyPx, pal.hud.textDim, 'left', 600);

  // 우 — 위기 세션 진행 표식 (§8.10). 없을 땐 그리지 않는다
  if (run.crisis) {
    text(ctx, world, pal, '위기', a.x + a.w - pad, a.y + 16,
      h.fontBodyPx, pal.threat.enemyBullet, 'right', 700);
  }

  // 중앙 — 보스 타이머 (BOSS 페이즈에만)
  if (run.phase === PHASE.BOSS) {
    const ph = world.data.stages.phase;
    const vt = world.data.rules.visual.timer;
    const left = run.bossTimer < 0 ? 0 : run.bossTimer;
    let color = pal.element.normal;                    // 정상·경고 = 은색 (§7.12.1 — 호박 없음)
    let scale = 1;
    if (left <= ph.timerRedAlertSec) {
      color = pal.threat.enemyBullet;                  // 빨간불 = 자홍 (타이머 만료가 나를 죽인다)
      const pulse = 0.5 + 0.5 * Math.sin(world.time * vt.alertPulseHz * Math.PI * 2);
      scale = 1 + (vt.alertScale - 1) * pulse;
    } else if (left <= ph.timerWarnSec) {
      const pulse = 0.5 + 0.5 * Math.sin(world.time * vt.warnPulseHz * Math.PI * 2);
      scale = 1 + (vt.warnScale - 1) * pulse;
    }
    const secs = Math.ceil(left);
    const mm = Math.floor(secs / 60);
    const ss = secs - mm * 60;
    text(ctx, world, pal, `${mm}:${ss < 10 ? '0' : ''}${ss}`,
      a.x + a.w / 2, a.y + 18, h.fontLargePx * scale, color, 'center', 700);
  }

  // 보스 «코어» HP — 이 판을 끝내는 단 하나의 값. 보스가 없으면 안 그린다
  //   ★ §7.6(v1.7) — 상단 바는 **보스 코어 전용**이다. v1.6 까지 중간보스도 이 바를 썼는데,
  //     draw.js 가 중간보스 «개체 위»에도 같은 바를 그려서 **같은 체력이 화면에 두 번** 떴다.
  //     둘 중 개체 위 바가 옳다: 중간보스는 동시 다수라 상단 바 하나로는 애초에 부족하고,
  //     내가 보고 있는 곳에 붙어 있어야 읽힌다. 상단은 «이 판을 끝내는 것»만 말한다.
  let core = null;
  const en = world.enemies.items;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (e.alive && e.isBoss && e.isCore) { core = e; break; }
  }
  const bar = core;
  if (bar !== null) {
    // §18 — 굵은 코어 바 + 수치. (v1.7: armor 세그먼트는 부위 자기 바로 옮겼다)
    //   기존 6px 은색 실오라기 + magenta 카운트 핍이라 «남은 체력이 안 보였다».
    const barW = a.w - pad * 2;
    const bx = a.x + pad;
    const coreH = h.bossHpBarH;
    const coreY = a.y + topH - coreH;
    // §7.6(v1.7) armor 세그먼트 스트립 폐지 — 이제 부위마다 «자기 위»에 바가 있다(draw.js).
    //   같은 값을 두 곳에 그리면 어느 쪽을 봐야 하는지가 사라진다. §8.13 게이트는 armor 부위의
    //   «두꺼운 바 + 밑줄»이 대신 말한다 — 정보가 읽는 사람이 보고 있는 대상 위에 붙는다.
    const ratio = bar.hpMax > 0 ? bar.hp / bar.hpMax : 0;
    ctx.fillStyle = rgba(pal.hud.panelRule, 0.85);
    ctx.fillRect(bx, coreY, barW, coreH);
    ctx.fillStyle = pal.element[bar.element];            // 코어=노말 은색 · 중간보스=주입 속성
    ctx.fillRect(bx, coreY, barW * ratio, coreH);
    text(ctx, world, pal, `${Math.ceil(bar.hp)}/${Math.round(bar.hpMax)}`,
      bx + barW - 6, coreY + coreH / 2, h.fontSmallPx, pal.hud.textPrimary, 'right', 700);
  }

  ctx.restore();
}

/**
 * 아레나 오버레이 띠 — 상단(스테이지·보스 타이머·코어 HP) · 하단 A(HP) · 하단 B(XP).
 *   §1.2 「없을 때: 바 자체를 그리지 않는다(빈 트랙 금지)」.
 */
/** BOSS_INTRO 강림 배너용 — 지금 스테이지 보스의 한국어 이름(없으면 null). */
function bossNameFor(world) {
  if (world.run === undefined) return null;
  const entry = stageEntry(world);
  const b = world.data.bosses.bosses.find((x) => x.id === entry.bossId);
  return b ? b.name : null;
}

export function drawArenaBands(ctx, world, pal) {
  drawTopBand(ctx, world, pal);
  const v = world.data.rules.view;
  const h = world.data.rules.hud;
  const vb = world.data.rules.visual.band;
  const rp = world.data.rules.player;
  const p = world.player;
  const a = v.arena;

  // ★ BOSS_INTRO — «WARNING» 강림 배너(비행슈팅 연출). 필드가 비어 있어 아레나 중앙에 크게 점멸.
  if (world.run !== undefined && world.run.phase === PHASE.BOSS_INTRO) {
    const bx = a.x + a.w / 2;
    const by = a.y + a.h * 0.58;
    const blink = 0.55 + 0.45 * Math.sin(world.time * Math.PI * 4);   // 2Hz 점멸
    ctx.save();
    ctx.globalAlpha = blink;
    text(ctx, world, pal, 'WARNING', bx, by, h.fontHeroPx, pal.threat.enemyBullet, 'center', 800);
    const nm = bossNameFor(world);
    if (nm !== null) text(ctx, world, pal, `${nm} 강림`, bx, by + h.fontHeroPx * 0.85, h.fontLargePx, pal.hud.textPrimary, 'center', 700);
    ctx.restore();
  }

  const hpY = a.y + a.h - v.bandHpH - v.bandXpH;      // 672
  const xpY = a.y + a.h - v.bandXpH;                  // 696
  const pad = 8;

  // 하단 띠 = 플레이영역 «밖»의 가라앉은 패널로 읽히게 — 불투명 판 + 상단 «바닥» 구분선
  //   (사이드 패널과 통일. 반투명 0.30 은 «떠 있는» 느낌이라는 플레이테스트 #7).
  ctx.fillStyle = rgba(pal.hud.panelBg, 0.94);
  ctx.fillRect(a.x, hpY, a.w, v.bandHpH + v.bandXpH);
  ctx.fillStyle = rgba(pal.hud.panelRule, 0.9);
  ctx.fillRect(a.x, hpY, a.w, 1.5);                    // 플레이영역과의 경계(바닥)

  ctx.save();
  if (vb.contentOpaque) ctx.globalAlpha = 1.0;

  // ---- 하단 A — HP 세그먼트 바 -------------------------------------------
  // §2.1 — 칸 수는 hpBarSegCount(5) 고정. **칸당 = hpMax / 5** 는 파생값이다
  const segs = h.hpBarSegCount;
  const perSeg = p.hpMax / segs;
  const labelW = 78;
  const trackW = a.w - pad * 2 - labelW;
  const segW = (trackW - h.hpBarSegGapPx * (segs - 1)) / segs;
  const barH = v.bandHpH - 10;
  const barY = hpY + 5;

  // §7.12.4-① — 저체력이면 호박. 위독(0.15)에서 주파수가 2배가 된다 (같은 사건의 두 번째 표면)
  const ratio = p.hp / p.hpMax;
  let fill = pal.hud.hpFill;
  if (ratio <= rp.lowHpThreshold) {
    const hz = ratio <= rp.lowHpCriticalThreshold ? 2 : 1;
    const pulse = 0.5 + 0.5 * Math.sin(world.time * hz * Math.PI * 2);
    fill = rgba(pal.status.band, 0.55 + 0.45 * pulse);
  }

  for (let i = 0; i < segs; i += 1) {
    const x = a.x + pad + i * (segW + h.hpBarSegGapPx);
    ctx.fillStyle = rgba(pal.hud.panelRule, 0.85);
    ctx.fillRect(x, barY, segW, barH);
    const inSeg = Math.max(0, Math.min(perSeg, p.hp - i * perSeg)) / perSeg;
    if (inSeg > 0) {
      ctx.fillStyle = fill;
      ctx.fillRect(x, barY, segW * inSeg, barH);
    }
  }
  text(ctx, world, pal, `${Math.ceil(p.hp)}/${Math.round(p.hpMax)}`,
    a.x + a.w - pad, hpY + v.bandHpH / 2, h.fontBodyPx, pal.hud.textPrimary, 'right', 600);

  // ---- 하단 B — XP 바 + Lv + LV UP ×N -----------------------------------
  const lvW = 62;
  const badgeW = world.draftQueue > 0 ? 86 : 0;
  const xTrack = a.x + pad + lvW;
  const wTrack = a.w - pad * 2 - lvW - badgeW;
  const xbY = xpY + (v.bandXpH - h.xpBarH) / 2;

  text(ctx, world, pal, `Lv.${p.level}`, a.x + pad, xpY + v.bandXpH / 2,
    h.fontSmallPx, pal.hud.textPrimary, 'left', 600);
  ctx.fillStyle = rgba(pal.hud.panelRule, 0.85);
  ctx.fillRect(xTrack, xbY, wTrack, h.xpBarH);
  ctx.fillStyle = pal.pickup.xp;                       // XP 바 = XP 픽업과 같은 색 (새 색 0)
  ctx.fillRect(xTrack, xbY, wTrack * Math.max(0, Math.min(1, p.xp / p.xpToNext)), h.xpBarH);

  // §6.4 — 동시 다중 레벨업은 순차 드래프트다. 큐가 화면에 있어야 "몇 번 남았나"가 읽힌다
  if (world.draftQueue > 0) {
    text(ctx, world, pal, `LV UP ×${world.draftQueue}`, a.x + a.w - pad, xpY + v.bandXpH / 2,
      h.fontSmallPx, pal.element.normal, 'right', 700);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 레이어 12 — HUD 패널 (§1.1 — 좌 0~350 · 우 930~1280. 아레나를 침범하지 않는다)
// ---------------------------------------------------------------------------
export function drawPanels(ctx, world, pal) {
  const v = world.data.rules.view;
  ctx.fillStyle = pal.hud.panelBg;
  ctx.fillRect(0, 0, v.panelLeftW, v.logicalH);
  ctx.fillRect(v.arena.x + v.arena.w, 0, v.panelRightW, v.logicalH);
  ctx.fillStyle = pal.hud.panelRule;
  ctx.fillRect(v.panelLeftW - 1, 0, 1, v.logicalH);
  ctx.fillRect(v.arena.x + v.arena.w, 0, 1, v.logicalH);

  drawLeftPanel(ctx, world, pal);
  drawRightPanel(ctx, world, pal);
}

/** 좌 패널 — §9.4.1 elementMatrixInPanel: 상성표 4×4 상시 = **정보 루프의 폐쇄** */
function drawLeftPanel(ctx, world, pal) {
  const h = world.data.rules.hud;
  const pad = h.panelPadPx;
  const order = world.data.elements.order;
  const matrix = world.data.elements.matrix;
  let y = pad + 10;

  //   ㊿-z4 사용자(2026-09-12) 「부수적인 설명들을 모두 제거해줘 — 세로 = 내 스탠스 · 적 속성 키의 오른쪽... · 보스를 잡으면 금색 구슬...」.
  //   상성 니모닉(§5.6)은 설계 근거로 그대로 남고, 온보딩은 튜토리얼 4단계가 맡는다(§6.7). 패널은 «지금 상태»만 말한다.
  text(ctx, world, pal, '상성표', pad, y, h.fontMediumPx, pal.hud.textPrimary, 'left', 700);
  y += 30;

  if (!h.elementMatrixInPanel) return;

  const cell = 46;
  const x0 = pad + cell;
  const y0 = y + cell;

  for (let i = 0; i < order.length; i += 1) {                 // 헤더 (가로 = 방어 속성)
    const e = order[i];
    const cx = x0 + i * cell + cell / 2;
    glyphPath(ctx, e, cx, y + cell / 2, 8);
    ctx.fillStyle = pal.element[e];
    ctx.fill();
  }
  for (let r = 0; r < order.length; r += 1) {
    const atk = order[r];
    const cy = y0 + r * cell + cell / 2;
    glyphPath(ctx, atk, pad + cell / 2, cy, 8);              // 헤더 (세로 = 공격 속성 = 내 스탠스)
    ctx.fillStyle = pal.element[atk];
    ctx.fill();
    // ★ 현재 스탠스 행을 강조 — "지금 내가 어느 줄에 서 있는가"가 상성표의 유일한 사용법이다
    if (atk === world.player.stance) {
      ctx.fillStyle = rgba(pal.element[atk], 0.12);
      ctx.fillRect(pad, y0 + r * cell, cell * 5, cell);
    }
    for (let c = 0; c < order.length; c += 1) {
      const m = matrix[atk][order[c]];
      const cx = x0 + c * cell + cell / 2;
      const label = m > 1 ? '×2' : m < 1 ? '×½' : '×1';
      // §7.7 — ×2 는 속성색 / ×1 은 은색 / ×0.5 는 회색. 히트 피드백과 같은 3단 어휘
      const col = m > 1 ? pal.element[atk] : m < 1 ? pal.neutralGray : pal.element.normal;
      text(ctx, world, pal, label, cx, cy, m > 1 ? h.fontBodyPx : h.fontSmallPx, col, 'center', m > 1 ? 700 : 400);
    }
  }
  ctx.strokeStyle = pal.hud.panelRule;
  ctx.lineWidth = 1;
  for (let i = 0; i <= order.length; i += 1) {
    ctx.beginPath(); ctx.moveTo(x0, y0 + i * cell); ctx.lineTo(x0 + cell * 4, y0 + i * cell); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x0 + i * cell, y0); ctx.lineTo(x0 + i * cell, y0 + cell * 4); ctx.stroke();
  }

  // ---- §11.6(v1.10 ⑲) 보스 특성 — 상성표 아래. 없으면 제목만(빈 칸 = «보스를 잡으면 여기가 찬다»)
  let ty = y0 + cell * 4 + 44;
  text(ctx, world, pal, '보스 특성', pad, ty, h.fontMediumPx, pal.hud.textPrimary, 'left', 700);
  ty += 24;
  const tdefs = world.data.traits.traits;
  for (let i = 0; i < tdefs.length; i += 1) {
    const def = tdefs[i];
    const lv = world.traits[def.id];
    if (lv <= 0) continue;
    // §11.6 ㉒ — 이름 · Lv · 지금 값(효과 kind 의 표기법). 쉴드는 충전 상태도(«지금 막을 수 있는가»가 곧 조작 정보)
    const val = fmtTrait(def.effect.kind, def.effect.values[lv - 1]);
    const state = def.effect.kind === 'shieldEverySec' ? (world.traitState.shieldReady ? ' · 준비됨' : ' · 충전 중') : '';
    ctx.fillStyle = rgba(pal.hud.accent, 0.9);
    ctx.beginPath(); ctx.arc(pad + 5, ty, 4, 0, Math.PI * 2); ctx.fill();
    text(ctx, world, pal, `${def.name} Lv.${lv}`, pad + 16, ty, h.fontSmallPx, pal.hud.textPrimary, 'left', 600);
    text(ctx, world, pal, `${val}${state}`, pad + 16, ty + 14, h.fontSmallPx, rgba(pal.hud.textDim, 0.85), 'left');
    ty += 34;
  }
}

/** 우 패널 — 스탠스 키캡 · 속성 투자 pip · 무기 4슬롯 + 부여 상태 */
function drawRightPanel(ctx, world, pal) {
  const v = world.data.rules.view;
  const h = world.data.rules.hud;
  const rp = world.data.rules.player;
  const p = world.player;
  const x = v.arena.x + v.arena.w + h.panelPadPx;
  const w = v.panelRightW - h.panelPadPx * 2;
  let y = h.panelPadPx + 10;

  // ---- 스탠스 (§5.1 QWER) ------------------------------------------------
  text(ctx, world, pal, '스탠스', x, y, h.fontMediumPx, pal.hud.textPrimary, 'left', 700);
  y += 26;
  const order = world.data.elements.order;
  const box = h.keycapBoxPx;
  for (let i = 0; i < order.length; i += 1) {
    const e = order[i];
    const bx = x + i * (box + 10);
    const active = p.stance === e;
    // I-2 — 투자 0인 키는 은색. 이 키를 눌러도 아무것도 부여되지 않는 것이 참이다 (§7.12.7 과 같은 규칙)
    const invested = e === 'normal' ? true : p.invest[e] > 0;
    const col = invested ? pal.element[e] : pal.element.normal;
    ctx.fillStyle = active ? rgba(col, 0.22) : rgba(pal.hud.panelRule, 0.5);
    ctx.fillRect(bx, y, box, box);
    ctx.lineWidth = active ? 2 : 1;
    ctx.strokeStyle = active ? col : pal.hud.panelRule;
    ctx.strokeRect(bx, y, box, box);
    text(ctx, world, pal, KEYCAP[e], bx + box / 2, y + box / 2, h.fontBodyPx,
      active ? col : pal.hud.textDim, 'center', 700);
    glyphPath(ctx, e, bx + box / 2, y + box + 12, 5);
    ctx.fillStyle = invested ? pal.element[e] : rgba(pal.element.normal, 0.35);
    ctx.fill();
  }
  y += box + 30;

  // ---- 속성 투자 pip (§4.2 상한 2종) -------------------------------------
  let head = '속성 투자';
  if (h.showElementBudget) {
    let total = 0;
    for (let i = 0; i < world.data.elements.investable.length; i += 1) {
      total += p.invest[world.data.elements.investable[i]];
    }
    head += `  ${total}/${rp.elementCapTotal}`;
  }
  text(ctx, world, pal, head, x, y, h.fontMediumPx, pal.hud.textPrimary, 'left', 700);
  y += 24;

  const inv = world.data.elements.investable;
  for (let i = 0; i < inv.length; i += 1) {
    const e = inv[i];
    glyphPath(ctx, e, x + 7, y + 8, 6);
    ctx.fillStyle = pal.element[e];
    ctx.fill();
    for (let k = 0; k < rp.elementCapPerElement; k += 1) {
      const px = x + 30 + k * 16;
      const on = k < p.invest[e];
      ctx.beginPath();
      ctx.arc(px, y + 8, 5, 0, Math.PI * 2);
      ctx.fillStyle = on ? pal.element[e] : rgba(pal.hud.panelRule, 0.9);
      ctx.fill();
    }
    // ★ §4.3 을 문장으로 — "투자 N = 슬롯 1..N 부여". 투자 0 = 부여 없음 (I-2: 화면이 참을 말한다)
    const lv = p.invest[e];
    text(ctx, world, pal, lv === 0 ? '부여 없음' : lv === 1 ? '슬롯 1 부여' : `슬롯 1~${lv} 부여`,
      x + 30 + rp.elementCapPerElement * 16 + 8, y + 8,
      h.fontSmallPx, lv > 0 ? pal.hud.textDim : rgba(pal.hud.textDim, 0.4), 'left');
    y += 22;
  }
  //   ㊿-z4 사용자 「무기 슬롯과 그 위 속성간의 여백이 너무 좁아」 — 14 → 20.
  //   ★ 이 패널은 이미 꽉 차 있다: 패시브 6번 칸의 바닥이 720 − panelPadPx(16) = 704 다.
  //   여기와 패시브 사이에 더할 수 있는 총량이 12px 이라 6px 씩 나눴다. 더 벌리려면 다른 리듬을 줄여야 한다.
  y += 20;

  // ---- 무기 슬롯 (§4.3 — 위→아래 = 슬롯 1..N = 부여 우선순위) ---------------
  //   §11.1(v1.6) 슬롯은 계열로 갈린다: 앞 elementSlots 칸 = 속성칸(각인 대상),
  //   나머지 = 유틸칸(각인되지 않는다). 갈린 사실이 화면에서 안 읽히면
  //   빌드를 짤 근거가 사라진다 — 그래서 두 구역에 머리글을 세운다.
  //   ★ 세로 리듬은 상수로 둔다. v1.6 은 머리글 앞 여백이 «첫 머리글에만» 있어서
  //     두 번째(무속성) 머리글이 앞 슬롯 박스와 2px 겹쳤다 — text 의 기준선이 middle 이라
  //     y 에 그리면 글자가 y−6 부터 시작하는데, 그 y 가 박스 바닥 +4 였다.
  const ROW_H = 34;          // 슬롯 행: 박스 30 + 아래 간격 4
  const HEAD_TO_ROW = 18;    // 구역 머리글(middle) → 다음 박스 top
  const GROUP_GAP = 16;      // 앞 구역의 마지막 박스 바닥 → 다음 구역 머리글(middle)
  const eSlots = world.data.rules.player.elementSlots;
  text(ctx, world, pal, '무기 슬롯', x, y, h.fontMediumPx, pal.hud.textPrimary, 'left', 700);
  y += 26;
  for (let i = 0; i < world.slots.length; i += 1) {
    if (i === 0 || i === eSlots) {
      if (i !== 0) y += GROUP_GAP;      // ★ 첫 구역은 섹션 제목이 이미 여백을 준다
      text(ctx, world, pal, i === 0 ? `속성 ${eSlots}칸` : `무속성 ${world.slots.length - eSlots}칸`,
        x, y, h.fontSmallPx, pal.hud.textDim, 'left', 600);
      y += HEAD_TO_ROW;
    }
    const s = world.slots[i];
    const rowH = ROW_H;
    const imbued = s.stampElement !== 'normal';
    ctx.fillStyle = imbued ? rgba(pal.element[s.stampElement], 0.14) : rgba(pal.hud.panelRule, 0.35);
    ctx.fillRect(x, y, w, rowH - 4);
    ctx.lineWidth = 1;
    ctx.strokeStyle = imbued ? pal.element[s.stampElement] : pal.hud.panelRule;
    ctx.strokeRect(x, y, w, rowH - 4);

    text(ctx, world, pal, `${i + 1}`, x + 10, y + (rowH - 4) / 2, h.fontSmallPx, pal.hud.textDim, 'left', 700);
    if (s.weaponId === null) {
      text(ctx, world, pal, '빈 슬롯', x + 26, y + (rowH - 4) / 2, h.fontBodyPx, rgba(pal.hud.textDim, 0.5), 'left');
    } else {
      const def = world.weaponDefs[s.family];
      const name = s.evolved ? def.evolution.name : def.name;
      const chip = CLASS_KO[def.class];        // ㊵ 분류 칩(탄·빔·범위·궤도) — 패시브 카드의 «[탄]» 과 같은 어휘
      // §9.5(v1.5 · ★㊹ 개정) — Lv7 은 «진화 임박»이고, 짝 패시브 Lv3 이 없으면 **그 무기의 레벨업 카드가 아예 안 나온다**.
      //   v1.5 는 「짝은 안 밝힌다(유추를 유도)」였는데, 실제로는 «카드가 왜 사라졌는지 모르는» 상태가 됐다(사용자 2026-09-06:
      //   「플레이해보면서 알게 됐다」). ㊲ 로 패시브가 분류를 달고부터는 짝이 이미 읽히므로, 조건을 **그 자리에서 말한다**.
      const nearEvo = s.level === WEAPON_EVOLVE_LEVEL - 1 && !s.evolved;
      const lvText = s.evolved ? `EVO ${s.level}/${WEAPON_MAX_LEVEL}` : `Lv.${s.level}/${WEAPON_MAX_LEVEL}`;
      let hints = [];
      let hintDone = false;
      if (nearEvo) {
        const req = def.evolution.requiresPassive;
        let have = 0;
        for (let k = 0; k < world.passives.length; k += 1) if (world.passives[k].id === req.id) { have = world.passives[k].level; break; }
        const pdef = world.data.passives.passives.find((q) => q.id === req.id);
        hintDone = have >= req.level;
        // ★ ㊿-d — 「진화: 」 접두를 지운다(사용자). 그래도 폭이 모자라면 «수»만이라도 남긴다.
        hints = [`${pdef === undefined ? req.id : pdef.name} ${have}/${req.level}`, `${have}/${req.level}`];
      }
      ctx.font = font(world, h.fontBodyPx, 600);
      const nameW = ctx.measureText(name).width;
      ctx.font = font(world, h.fontSmallPx, 700);
      const chipW = ctx.measureText(chip).width;
      const levelW = ctx.measureText(lvText).width;
      const lay = weaponRowLayout(w, nameW, chipW, levelW, hints, (t) => ctx.measureText(t).width);
      text(ctx, world, pal, name, x + 26, y + (rowH - 4) / 2, h.fontBodyPx, pal.hud.textPrimary, 'left', 600);
      if (lay.showChip) text(ctx, world, pal, chip, x + lay.chipX, y + (rowH - 4) / 2, h.fontSmallPx, pal.hud.accent, 'left', 700);
      if (lay.hint !== '') {
        text(ctx, world, pal, lay.hint, x + lay.hintX, y + (rowH - 4) / 2, h.fontSmallPx,
          hintDone ? pal.element.normal : pal.hud.accent, 'left', 700);
      }
      text(ctx, world, pal, lvText, x + w - 46, y + (rowH - 4) / 2,
        h.fontSmallPx, (s.evolved || nearEvo) ? pal.element.normal : pal.hud.textDim, 'right', 600);
    }
    // 부여 칩 — 기체의 슬롯 스트립(§7.5 ②)과 **같은 어휘**. 두 표면이 같은 것을 말한다
    const cx = x + w - 18;
    const cy = y + (rowH - 4) / 2;
    if (imbued) { glyphPath(ctx, s.stampElement, cx, cy, 6); ctx.fillStyle = pal.element[s.stampElement]; ctx.fill(); }
    else {
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = s.weaponId === null ? rgba(pal.element.normal, 0.2) : pal.element.normal;
      ctx.fill();
    }
    y += rowH;
  }

  // ---- 패시브 슬롯 (§4.2 상한 = rules.player.passiveSlots · 위→아래 = 획득 순) ---------------------
  //   ★ 무기 슬롯과 같은 어휘 — 먹을 수 있는 패시브 수가 화면에서 읽힌다
  y += 24;                   // 섹션 사이 — 구역 사이(16)보다 넓어야 «다른 것»으로 읽힌다. ㊿-z4 사용자 「패시브 슬롯과 6번 무기 칸의 여백이 너무 좁아」 — 18 → 24(위 주석의 12px 예산 중 6)
  text(ctx, world, pal, '패시브 슬롯', x, y, h.fontMediumPx, pal.hud.textPrimary, 'left', 700);
  y += 24;
  const pdefs = world.data.passives.passives;
  for (let i = 0; i < world.passives.length; i += 1) {
    const p = world.passives[i];
    const rowH = 26;
    const filled = p.id !== null;
    ctx.fillStyle = filled ? rgba(pal.hud.panelRule, 0.5) : rgba(pal.hud.panelRule, 0.2);
    ctx.fillRect(x, y, w, rowH - 4);
    ctx.lineWidth = 1;
    ctx.strokeStyle = filled ? pal.hud.panelRule : rgba(pal.hud.panelRule, 0.5);
    ctx.strokeRect(x, y, w, rowH - 4);
    text(ctx, world, pal, `${i + 1}`, x + 10, y + (rowH - 4) / 2, h.fontSmallPx, pal.hud.textDim, 'left', 700);
    if (!filled) {
      text(ctx, world, pal, '빈 슬롯', x + 26, y + (rowH - 4) / 2, h.fontSmallPx, rgba(pal.hud.textDim, 0.5), 'left');
    } else {
      let pname = p.id;
      for (let k = 0; k < pdefs.length; k += 1) if (pdefs[k].id === p.id) { pname = pdefs[k].name; break; }
      text(ctx, world, pal, pname, x + 26, y + (rowH - 4) / 2, h.fontSmallPx, pal.hud.textPrimary, 'left', 600);
      text(ctx, world, pal, `Lv.${p.level}`, x + w - 12, y + (rowH - 4) / 2, h.fontSmallPx, pal.hud.textDim, 'right', 600);
    }
    y += rowH;
  }
}

// ---------------------------------------------------------------------------
// 드래프트 3택 (§11.1 · §5.2)
//   ★ 정본 §9.1 은 드래프트 **화면**의 거처를 `src/ui/` 로 확정했다. 1주차 최소 판본을
//     여기에 둔 것은 임시이며 2주차에 `src/ui/draft.js` 로 이사한다 (보고 대상).
// ---------------------------------------------------------------------------
export function drawDraft(ctx, world, pal, draft, cursor) {
  const v = world.data.rules.view;
  const h = world.data.rules.hud;

  ctx.fillStyle = rgba(pal.threat.outline, 0.78);
  ctx.fillRect(0, 0, v.logicalW, v.logicalH);

  text(ctx, world, pal, 'LEVEL UP', v.logicalW / 2, 92, h.fontHeroPx, pal.hud.textPrimary, 'center', 800);
  // ㊿-s 데모·어트랙트(draft.auto) — 봇이 고르는 화면에 «1 / 2 / 3 선택»을 띄우면 그 말대로 누른 사람이 데모에서 튕겨 나간다(검토)
  text(ctx, world, pal, draft.auto === true
    ? `Lv.${world.player.level}  ·  데모 — 봇이 고르는 중`
    : `Lv.${world.player.level}  ·  1 / 2 / 3 선택   ←→ 커서   Space/Enter 확정`,
    v.logicalW / 2, 132, h.fontBodyPx, pal.hud.textDim, 'center');
  if (world.draftQueue > 1) {
    text(ctx, world, pal, `대기 중인 레벨업 ×${world.draftQueue - 1}`, v.logicalW / 2, 156,
      h.fontSmallPx, pal.element.normal, 'center', 600);
  }

  const cw = 300;
  const ch = 450;   // ㊿-r 380 → 450 — 진화 카드가 «특수 효과 수치 + Lv.8 레벨업 수치»를 함께 싣는다
  const gap = 28;
  const total = draft.cards.length * cw + (draft.cards.length - 1) * gap;
  const x0 = (v.logicalW - total) / 2;
  const y0 = 200;

  for (let i = 0; i < draft.cards.length; i += 1) {
    const c = draft.cards[i];
    const x = x0 + i * (cw + gap);
    const sel = i === cursor;
    const accent = cardAccent(world, pal, c);

    ctx.fillStyle = rgba(pal.hud.panelBg, 0.97);
    ctx.fillRect(x, y0, cw, ch);
    // ㊿-s — 진화 카드는 고르지 않았을 때도 테두리가 자기 색(보라)이다. 굵기는 «선택»만 말한다(3px) —
    //   진화 카드만 굵게 두면 커서가 그 카드 위에서 1px 차이로만 읽혔다(검토). 종류 = 색, 선택 = 굵기.
    const evoCard = c.category === 'weaponLevel' && c.isEvolution;
    ctx.lineWidth = sel ? 3 : 1;
    ctx.strokeStyle = (sel || evoCard) ? accent : pal.hud.panelRule;
    ctx.strokeRect(x, y0, cw, ch);
    ctx.fillStyle = accent;
    ctx.fillRect(x, y0, cw, 4);

    text(ctx, world, pal, `${i + 1}`, x + 16, y0 + 30, h.fontLargePx, pal.hud.textDim, 'left', 800);
    text(ctx, world, pal, categoryLabel(world, c), x + cw - 16, y0 + 28,
      h.fontSmallPx, accent, 'right', 700);

    const body = cardBody(world, c);
    const cx = x + cw / 2;
    // §7.3 — cvd/mono 에서 HUD·카드는 **텍스트 라벨 강제**. off 에서도 라벨은 손해가 없다
    if (body.glyph !== null) {
      glyphPath(ctx, body.glyph, cx, y0 + 100, 26 * pal.glyphScale);
      ctx.fillStyle = accent;
      ctx.fill();
    }
    // 헤드라인(이름/레벨) — 가장 크게
    text(ctx, world, pal, body.title, cx, y0 + 156, h.fontLargePx, pal.hud.textPrimary, 'center', 700);
    // ★ 효과 한 줄을 **크게**(accent, 16px, 굵게, 중앙) — "무엇을 하는가"가 여기서 읽힌다.
    //   긴 효과는 자동 줄바꿈 (accent 로 헤드라인과 명도 대비를 준다)
    // ★ wrap 은 «마지막 줄의 y» 를 돌려준다 — 아래 블록을 그 값에서 이어 붙여
    //   긴 설명이 증분 줄을 덮는 일이 없게 한다(고정 y 는 sub 가 4줄이 되면 겹친다).
    let cy = y0 + 200;
    if (body.sub !== '') {
      cy = wrap(ctx, world, pal, body.sub, cx, cy, cw - 36, h.fontBodyPx, accent, 22, 'center', 600);
    }
    // ★ §11.1(v1.7) 증분 줄 — «얼마나» 좋아지는가. 세 장을 비교할 근거가 여기서 나온다.
    //   accent(효과)와 색을 갈라 둔다 — 「무엇을」과 「얼마나」가 서로 묻히지 않게.
    const delta = cardDelta(world, c);
    cy += 34;
    for (let k = 0; k < delta.length; k += 1) {
      text(ctx, world, pal, delta[k], cx, cy, h.fontBodyPx, pal.hud.textPrimary, 'center');
      cy += 22;
    }
    // ★ ㊿-r — 진화 카드는 «진화도 레벨업»(Lv7 → Lv8)이다. 같은 순간 그 레벨 칸의 수치도 들어오는데 카드가 그것을 숨겼다
    //   (옵션: 카드엔 「위성 하나 더」만 보이는데 실제로는 위성이 3 → 5개). 작은 제목 아래에 붙인다
    //   (사용자 2026-09-11 「진화도 레벨업이면 당연히 붙여줘야할듯」).
    const gains = evolutionLevelGains(world, c);
    if (gains.length > 0) {
      text(ctx, world, pal, `Lv.${c.to} 레벨업`, cx, cy, h.fontSmallPx, pal.hud.textDim, 'center', 600);
      cy += 22;
      for (let k = 0; k < gains.length; k += 1) {
        text(ctx, world, pal, gains[k], cx, cy, h.fontBodyPx, pal.hud.textPrimary, 'center');
        cy += 22;
      }
    }
    // 부가 설명(레벨·부여 프리뷰 등) — 작게, 아래에
    cy = wrap(ctx, world, pal, body.desc, cx, cy + 18, cw - 36, h.fontSmallPx, pal.hud.textDim, 20, 'center');
    // ★ ㊵ — 패시브 카드는 «내 무기 중 무엇에 듣는지»를 말한다. 분류를 외우게 하지 않는다(사용자 2026-09-05).
    if (c.category === 'passive') {
      const line = passiveWeaponLine(world, c.passiveId);      // ㊸ 기체 패시브면 null — 줄을 붙이지 않는다
      if (line !== null) {
        wrap(ctx, world, pal, line.text, cx, cy + 24, cw - 36, h.fontSmallPx,
          line.hit.length > 0 ? pal.hud.accent : rgba(pal.hud.textDim, 0.8), 18, 'center', 700);
      }
    }
  }
  // ★ v1.5 — 리롤 표시 폐지(경제 제거). 드래프트는 3장 고정.
}

/**
 * §11.1(v1.7) 드래프트 카드의 «증분 줄» — 레벨업이 구체적으로 무엇을 얼마나 바꾸는지.
 *   v1.6 까지 카드는 「모든 피해 증가」처럼 **방향만** 말하고 «얼마나»를 말하지 않았다.
 *   그래서 세 장 중 무엇이 더 나은지 고를 근거가 화면에 없었다(플레이 피드백).
 *
 * ★ 표기는 «스탯의 값»이지 «효과의 약속»이 아니다. 예컨대 오버클럭은 노바·펄스필드에
 *   무효(§9.6.1 rateKey null)인데, 카드는 그 사실을 지우지 않는다 — 정본 H4 가
 *   「시스템이 지우면 드래프트는 선택이 아니라 자동 최적화가 된다」로 확정한 규약이다.
 *   무엇이 자기 빌드에 듣는가는 여전히 플레이어가 안다.
 */

/** 패시브 스탯의 표기법. 단위가 스탯마다 다르다(비율·정수·초·픽셀·곱). */
/** §5 스탠스 키의 «글자». 바인딩(rules.input.bindings.stance*)은 KeyW 같은 코드라 화면에 못 쓴다. */
const STANCE_KEY = { normal: 'Q', fire: 'W', water: 'E', grass: 'R' };

const STAT_FMT = {
  fireRateMul: 'pct', areaMul: 'pct', terrainResist: 'pct', xpGainMul: 'pct', projSpeedMul: 'pct', durationMul: 'pct',
  beamDmgMul: 'pct', beamAreaMul: 'pct', areaDmgMul: 'pct', orbitMul: 'pct',   // ㊲ 빔·범위·궤도
  pierceAdd: 'add', projCountAdd: 'add', maxHpAdd: 'add',
  elementBonusMul: 'mul',                 // ★ §3.1 의 k — 가산이 아니라 «대입»이다
};

/** §11.6 ㉒ 특성 효과의 표기법 — kind 마다 단위가 다르다(초당 HP · 피해의 % · 초). 미지의 kind 는 숫자 그대로(숨기지 않는다). */
function fmtTrait(kind, v) {
  if (kind === 'regenHpPerSec') return `초당 ${num(v)} HP`;
  if (kind === 'lifestealPct') return `${num(v * 100)}% (HP 50%↓)`;
  if (kind === 'shieldEverySec') return `${num(v)}초마다`;
  return num(v);
}

/** 무기 파라미터의 한글 이름. 없는 키는 원래 이름을 그대로 보인다(조용히 숨기지 않는다). */
const PARAM_KO = {
  dmg: '피해', cooldownSec: '발사 주기', count: '발사체 수', spreadDeg: '산포',
  burstCount: '연사', pierce: '관통', hitCooldownSec: '재타격 간격',
  projSpeed: '탄속', projRadius: '탄 크기', lifetimeSec: '지속',
  rangePx: '사거리', beamWidthPx: '빔 폭', arcDeg: '부채각', radius: '반경',
  blastRadius: '폭발 반경', intervalSec: '폭발 주기', telegraphSec: '예고',
  orbitRadius: '궤도 반경', angularSpeedDegSec: '공전 속도', bodyCount: '공전체 수',
  outRangePx: '사거리', returnSpeed: '귀환 속도', spacingDeg: '투척 간격',
  turnRateDegSec: '선회', acquireRadius: '포착 반경', retargetSec: '재조준',
  strikesPerVolley: '포격 수', strikeIntervalSec: '포격 간격', targetMode: '조준',
  droneCount: '위성 수', droneFireSec: '위성 주기', droneRangePx: '위성 사거리',
  anchorOffsets: '배치', actionSlowSec: '행동 감속', slowSec: '감속', bounceLeft: '벽 반사',
  // ㉟ 신설 5종
  evoClusterCount: '자탄 수', evoClusterDmgMul: '자탄 피해', chainCount: '연쇄 수', chainRangePx: '연쇄 거리', chainDmgMul: '연쇄 감쇠',
  evoChainCountMul: '연쇄 배율', evoSplitCount: '갈래 수', evoSplitDmgMul: '갈래 피해', evoSplitRangePx: '갈래 거리',
  evoMaxBalls: '최대 공 수', launchDeg: '투척 각', ampPx: '나선 폭', freqHz: '나선 빠르기', evoAmpMul: '나선 폭 배율', evoLifetimeMul: '지속 배율',
  healCooldownSec: '회수 쿨다운', slowMul: '구역 속도',   // ㊿-q — ㊿-p 부터 탄만이 아니라 기체도 늦춘다 · 작을수록 느리다
  // 진화 파라미터 — 불리언은 «켜짐/꺼짐»이라 수치가 없다. desc 가 이미 그것을 말하므로 표기에서 뺀다.
  evoRampSec: '가속까지', evoRampFireRateMul: '가속 후 발사', evoBlastRadius: '폭발 반경',
  evoSecondaryDmgMul: '2차 피해', evoGuardBodies: '방패 공 수',
  evoPullForce: '흡인력', evoChainCount: '연쇄', evoRadiusMul: '반경 배수',
  evoTrailDelaySec: '잔상 지연', evoTrailAnchor: '잔상 자리',
  evoRing2Radius: '2단 링', evoActionSlowSec: '행동 감속',
};

/** ㊿-r — 문자열 파라미터 값(조준 방식)의 한글 이름. 없는 값은 원래 문자를 그대로 보인다(조용히 숨기지 않는다). */
const VALUE_KO = { forward: '정면', nearest: '가장 가까운 적', sweep: '훑기', randomInArena: '무작위', densest: '적이 몰린 곳' };
function valueText(v) { return typeof v === 'string' ? (VALUE_KO[v] || v) : num(v); }

/** 키 이름이 단위를 말한다 — Sec = 초, Px/Radius = px, Deg = °. 없으면 단위 없음. */
function unitOf(k) {
  if (k.endsWith('DegSec')) return '°/초';   // ㊿-s 검토: «Sec» 보다 먼저 — 「공전 속도 90초 → 105초」가 느려지는 것처럼 읽혔다
  if (k.endsWith('Sec')) return '초';
  if (k.endsWith('Px') || /radius$/i.test(k)) return 'px';   // ㊿-r 검토: 소문자 radius(노바·펄스필드 반경)도 px — 「2단 링 320px」 옆에 「반경 210 → 240」이 떴다
  if (k.endsWith('Deg')) return '°';
  return '';
}

/** 수를 짧게 — 정수는 그대로, 소수는 유효한 자리까지만. */
function num(v) {
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

function fmtStat(kind, v) {
  if (kind === 'pct') return `+${Math.round(v * 100)}%`;
  if (kind === 'mul') return `×${num(v)}`;
  if (kind === 'sec') return `${num(v)}초`;
  if (kind === 'px') return `${num(v)}px`;
  return `+${num(v)}`;
}

/** 무기 레벨 i(1-기준)까지 부분 오버라이드를 누적한 파라미터 집합. */
function paramsAt(def, level) {
  const cur = Object.assign({}, def.base);
  for (let i = 0; i < level && i < def.levels.length; i += 1) Object.assign(cur, def.levels[i]);
  return cur;
}

/**
 * 무기 레벨 from → to 에서 «그 칸이 실제로 바꾸는» 수치 줄(§11.1.1). 안 바뀐 값은 늘어놓지 않는다.
 *   markArrays: 좌표 배열(배치)을 「배치 변경」으로 보일지 — 진화 카드는 줄이 귀해서 뺀다(㊿-r).
 *   문자열 값(조준 방식)은 VALUE_KO 로 한글화한다 — 바라지 Lv8 의 randomInArena → densest 가 원문으로 뜨지 않게.
 */
function levelGains(def, from, to, max, markArrays) {
  const out = [];
  const changed = def.levels[to - 1];
  if (!changed) return out;
  const before = paramsAt(def, from);
  const keys = Object.keys(changed);
  for (let i = 0; i < keys.length && out.length < max; i += 1) {
    const k = keys[i];
    const ko = PARAM_KO[k] || k;
    if (Array.isArray(changed[k])) { if (markArrays) out.push(`${ko} 변경`); continue; }
    const u = unitOf(k);
    out.push(`${ko} ${valueText(before[k])}${u} → ${valueText(changed[k])}${u}`);
  }
  return out;
}

/** ㊿-r — 진화 카드는 «진화도 레벨업»(Lv7 → Lv8)이다: 같은 순간 들어오는 그 레벨 칸의 수치. 진화 카드가 아니면 빈 배열. */
function evolutionLevelGains(world, c) {
  if (c.category !== 'weaponLevel' || !c.isEvolution) return [];
  return levelGains(world.weaponDefs[c.weaponId], c.from, c.to, 3, false);
}

/**
 * 카드가 바꾸는 것을 「이름 이전 → 이후」 문자열 배열로 만든다. 바뀌는 게 없으면 빈 배열.
 *   ★ 무기 레벨은 «그 레벨에서 실제로 바뀐 키»만 보인다 — 안 바뀐 값을 나열하면 신호가 묻힌다.
 */
function cardDelta(world, c) {
  const out = [];
  if (c.category === 'elementLevel') {
    // §11.1(v1.7) 상성은 «양날»이다 — 강한 쪽만 보여주면 스탠스를 언제 «바꿔야» 하는지 모른다.
    //   값은 elements.matrix 가 소유한다(카드가 배율을 발명하지 않는다).
    const m = world.data.elements.matrix[c.element];
    if (m === undefined) return out;
    const keys = Object.keys(m);
    for (let k = 0; k < keys.length; k += 1) {
      const t = keys[k];
      if (t === c.element || m[t] === 1) continue;      // 자기 자신·등배는 말할 게 없다
      // 강한 쪽(×2)을 앞에 — 「무엇을 노리는가」가 먼저, 「무엇을 피하는가」가 뒤.
      const line = `${ELEMENT_NAME[t] || t} 적에게 ×${num(m[t])}`;
      if (m[t] > 1) out.unshift(line); else out.push(line);
    }
    return out;
  }
  if (c.category === 'passive') {
    const list = world.data.passives.passives;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].id !== c.passiveId) continue;
      const def = list[i];
      const kind = STAT_FMT[def.stat] || 'add';
      const to = def.values[c.to - 1];
      if (c.isNew) { out.push(fmtStat(kind, to)); return out; }
      out.push(`${fmtStat(kind, def.values[c.from - 1])} → ${fmtStat(kind, to)}`);
      return out;
    }
    return out;
  }
  if (c.category === 'trait') {
    // §11.6 ㉒ — 증분 줄: 「얼마나 좋아지는가」. 표기는 효과 kind 가 정한다(초당 HP · % · 초)
    out.push(c.from === null ? fmtTrait(c.kind, c.to) : `${fmtTrait(c.kind, c.from)} → ${fmtTrait(c.kind, c.to)}`);
    return out;
  }
  if (c.category === 'weaponLevel') {
    const def = world.weaponDefs[c.weaponId];
    if (c.isEvolution) {
      const pr = def.evolution.params;
      const keys = Object.keys(pr);
      for (let i = 0; i < keys.length && out.length < 3; i += 1) {
        const k = keys[i];
        if (typeof pr[k] === 'boolean' || Array.isArray(pr[k])) continue;   // 켜짐/꺼짐·좌표 배열은 수치 한 줄이 아니다 — desc 가 말한다(㊿-q: 「잔상 자리 0,44」가 떴다)
        out.push(`${PARAM_KO[k] || k} ${num(pr[k])}${unitOf(k)}`);
      }
      return out;
    }
    return levelGains(def, c.from, c.to, 3, true);
  }
  if (c.category === 'newWeapon') {
    // §11.1(v1.7) — 무기마다 다른 이름으로 다른 줄이 뜨면 세 장을 나란히 못 읽는다(플레이 피드백:
    //   「오빗은 피해·재타격 간격, 리턴은 피해·발사 주기·발수 — 다 제각각」).
    //   ★ 라벨을 «통일»하고 값만 무기별 키에서 끌어온다. 어느 키가 그 무기의 주기·발수인지는
    //     rules.passiveHooks 가 이미 소유한다(rateKey/countKey) — 새 어휘를 만들지 않는다.
    //   ★ 발사체가 없는 무기(펄스필드·노바·옵션)는 countKey 가 null 이다. 그 «없음»도 정보라
    //     빈칸(—)으로 자리를 지킨다 — 자리가 사라지면 세 장의 줄 수가 어긋나 비교가 깨진다.
    const def = world.weaponDefs[c.weaponId];
    const b = def.base;
    const hk = world.data.rules.passiveHooks[def.family];
    const rate = hk && hk.rateKey ? b[hk.rateKey] : undefined;
    const cnt = hk && hk.countKey ? b[hk.countKey] : undefined;
    const used = { dmg: 1 };
    if (hk && hk.rateKey) used[hk.rateKey] = 1;
    if (hk && hk.countKey) used[hk.countKey] = 1;
    if (b.dmg !== undefined) out.push(`피해 ${num(b.dmg)}`);
    if (rate !== undefined) out.push(`공격 주기 ${num(rate)}초`);
    if (cnt !== undefined) out.push(`발사체 수 ${num(cnt)}`);
    // ★ 세 항이 다 있는 무기가 기준이다. 없는 항을 «—»로 채우면 세 줄이 통째로 비어
    //   아무 정보도 없는 카드가 나온다(펄스필드는 피해도 주기도 발사체도 없다).
    //   빈 자리는 그 무기가 «실제로 가진» 값으로 메운다 — 라벨은 PARAM_KO 가 소유한다.
    const keys = Object.keys(b);
    for (let i = 0; i < keys.length && out.length < 3; i += 1) {
      const k = keys[i];
      if (used[k] === 1 || typeof b[k] !== 'number') continue;
      out.push(`${PARAM_KO[k] || k} ${num(b[k])}${unitOf(k)}`);
    }
    return out;
  }
  return out;
}



function categoryLabel(world, c) {
  const cat = c.category;
  // §11.1(v1.7) 「새 무기」만으로는 어느 «칸»에 들어가는지가 안 읽힌다 — 그게 곧 무엇을 포기하는가다.
  //   칩에서 바로 갈라 준다(카드 아래 설명까지 내려가지 않아도 알 수 있게).
  if (cat === 'newWeapon') {
    return world.weaponDefs[c.weaponId].slotClass === 'utility' ? '새 무속성 무기' : '새 속성 무기';
  }
  if (cat === 'weaponLevel') {
    const util = world.weaponDefs[c.weaponId].slotClass === 'utility';
    // ㊿-r — 진화 카드는 칩부터 다르다. ㊿-q 까지는 제목·설명만 달랐고 칩(「속성 레벨」)·색이 일반 레벨업과 같아
    //   한눈에 안 갈렸다(사용자 2026-09-11 「진화 카드는 일반 카드와 다르도록 설정된게 맞을까?」).
    if (c.isEvolution) return util ? '무속성 진화' : '속성 진화';
    return util ? '무속성 레벨' : '속성 레벨';
  }
  if (cat === 'elementLevel') return '속성 투자';
  if (cat === 'passive') return '패시브';
  if (cat === 'resupply') return '보급';
  if (cat === 'trait') return '보스 특성';
  throw new Error(`hud: 미지의 드래프트 카테고리 "${cat}" (§11.1)`);
}

function cardAccent(world, pal, c) {
  if (c.category === 'elementLevel') return pal.element[c.element];
  if (c.category === 'weaponLevel' && c.isEvolution) return pal.hud.evolution;   // ㊿-s 진화 카드 = 보라(사용자 2026-09-11 「진화 카드 테두리 색은 좀 다르게」)
  if (c.category === 'resupply') return pal.hud.accent;
  if (c.category === 'trait') return pal.hud.accent;              // §11.6 금색 = 구슬과 같은 채널
  return pal.element.normal;
}

/**
 * 카드 표기. ★ 사용자 피드백(§11.1) — 카드는 **이름**이 아니라 **결과를 플레이어 언어로** 말한다.
 *   title = 헤드라인(이름/레벨) · sub = **효과 한 줄(크게, accent)** · desc = 부가 설명(작게).
 *   속성 카드는 키 문자(W/E/R) 대신 속성명(불/물/풀)+색(accent)+글리프로만 말한다.
 */
function cardBody(world, c) {
  if (c.category === 'newWeapon') {
    const def = world.weaponDefs[c.weaponId];
    // §11.1(v1.7) 계열을 밝힌다 — 속성칸(각인 O)인지 유틸칸(각인 X)인지가 곧 «무엇을 포기하는가»다.
    //   슬롯 번호만으로는 그것을 읽을 수 없었다(플레이 피드백).
    const util = def.slotClass === 'utility';
    const kind = util ? '무속성 · 속성이 실리지 않는다' : '속성 · 스탠스가 실린다';
    return { glyph: null, title: def.name, sub: def.desc,
      desc: '' };   // §11.1(v1.7) 계열은 칩이, 수치는 증분 줄이 말한다 — 하단 줄은 중복이었다
  }
  if (c.category === 'weaponLevel') {
    const def = world.weaponDefs[c.weaponId];
    if (c.isEvolution) {
      return { glyph: null, title: def.evolution.name, sub: def.evolution.desc,
        desc: `${def.name} 진화 · Lv.${c.from}/${WEAPON_MAX_LEVEL} → ${c.to}/${WEAPON_MAX_LEVEL}` };
    }
    // ★ "벌컨 Lv.2" — 이름에 도달 레벨을 붙여 "무엇이 얼마나 세지는가"를 헤드라인에서 읽게 한다
    // ★ ㊿-r — 진화 뒤(Lv9·10 = 진화체 강화)는 «진화 무기»의 레벨업이다: 이름·효과 줄이 진화체의 것이어야 한다
    //   (사용자 2026-09-11 「벌컨의 진화 후 이름이 오버드라이브인데, 오버드라이브에 대한 레벨업으로 표현되는지」 — ㊿-q 까지 「벌컨 Lv.9」).
    //   무기 슬롯 줄(drawPanels)이 이미 진화 이름 · EVO 표기를 쓰므로 카드와 슬롯이 같은 말을 하게 한다.
    const slot = world.slots[c.slot];
    if (slot !== undefined && slot.weaponId === c.weaponId && slot.evolved) {
      return { glyph: null, title: `${def.evolution.name} Lv.${c.to}`, sub: def.evolution.desc,
        desc: `Lv.${c.from}/${WEAPON_MAX_LEVEL} → ${c.to}/${WEAPON_MAX_LEVEL}` };   // ㊿-r 검토: 「벌컨 진화 · …」는 진화 카드의 줄과 같아 «두 번째 진화»로 읽혔다
    }
    const util = def.slotClass === 'utility';
    return { glyph: null, title: `${def.name} Lv.${c.to}`, sub: def.desc,
      desc: `Lv.${c.from}/${WEAPON_MAX_LEVEL} → ${c.to}/${WEAPON_MAX_LEVEL}` };   // 계열은 칩이 말한다(중복 제거)
  }
  if (c.category === 'elementLevel') {
    // ★ §11.1 — 키 문자 대신 속성명+결과. prey(먹이)는 draft.js 가 matrix 에서 유도해 실어 보낸다.
    //   부여 프리뷰(앞의 N개 무기)는 §4.3 슬롯 순서를 가르치는 유일한 지점이라 desc 에 유지한다.
    const name = ELEMENT_NAME[c.element];
    const n = c.imbuedAfter;
    // §11.1(v1.7) — v1.6 은 «강한 쪽»만 말했다. 상성은 양날이라 «약한 쪽»을 모르면
    //   스탠스를 언제 바꿔야 하는지 판단할 수 없다(플레이 피드백). 둘 다 매트릭스에서 끌어온다.
    const key = STANCE_KEY[c.element] || '?';
    return {
      glyph: c.element,
      title: `${name} 강화`,
      sub: `속성 슬롯의 앞 ${n}개 무기를 ${name}속성으로 바꿀 수 있다`,
      desc: `${key} 키 = ${name} 스탠스. 그동안 앞 ${n}개 무기가 ${name}속성이 된다.`,
    };
  }
  if (c.category === 'passive') {
    const list = world.data.passives.passives;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].id !== c.passiveId) continue;
      // ★ 테마 이름(예: "학습 회로")만으론 안 와닿는다 → 효과(desc)를 크게 sub 에, 레벨을 작게 desc 에.
      return { glyph: null, title: list[i].name, sub: list[i].desc,
        desc: c.isNew ? '신규 획득' : `Lv.${c.from} → ${c.to} 강화` };
    }
    throw new Error(`hud: 미지의 패시브 "${c.passiveId}" (§9.6)`);
  }
  if (c.category === 'resupply') {
    return { glyph: null, title: c.name, sub: `HP +${Math.round(c.healPct * 100)}%`, desc: '유효한 후보가 부족할 때의 폴백 카드 — 회복.' };
  }
  if (c.category === 'trait') {
    // §11.6(v1.10 ㉒) — 셋 중 하나. 처음이면 «획득», 이미 있으면 «Lv n → n+1 강화»(패시브 카드와 같은 문법)
    const sub = c.level === 0 ? '보스 특성 · 런 내내' : `보스 특성 · Lv.${c.level} → ${c.level + 1} 강화`;
    return { glyph: null, title: c.name, sub, desc: c.desc };
  }
  throw new Error(`hud: 미지의 드래프트 카테고리 "${c.category}" (§11.1)`);
}

/**
 * 폭 maxW 로 자동 줄바꿈. align/weight 는 선택 (기본 left / 400).
 * @returns 마지막으로 그린 줄의 y (다음 블록을 이 아래로 이어 붙일 수 있게)
 */
/**
 * ★ v1.10 ㊴ — 폭 maxW 안으로 줄을 나눈다(순수 함수 · 테스트 가능). **공백이 없는 한 덩어리도 반드시 안에 들어간다**.
 *   옛 판은 공백으로만 쪼개서, 한국어의 긴 토큰(예: 「무기(벌컨·팬아웃·스파이럴·시커·리턴·미사일·핀볼)의」)이
 *   maxW 보다 넓으면 그대로 한 줄에 그려 **카드 밖으로 삐져나갔다**(플레이테스트 스크린샷 2026-09-05).
 *   토큰이 넘치면 글자 단위로 자르되 끊는 자리는 «·」·「,」·「)」·「]」 뒤를 우선한다(읽는 결을 지킨다).
 * @param measure  문자열 → 픽셀 폭 (렌더는 ctx.measureText, 테스트는 길이 × 상수)
 */
/**
 * §9.5(v1.10 ㊹ · ★㊿-d) — 무기 행의 가로 배치. **순수 함수**(폭은 주입받는다)라 렌더 없이 겹침을 테스트할 수 있다.
 *   행은 `[번호] 이름 [분류칩] [진화 힌트] ……… [Lv.7/10]` 이고, 힌트는 **남는 폭에만** 들어간다.
 *   ★ ㊿-d 사용자(2026-09-06): 「궤도진화: 궤도 확장 0/3 가 뭉쳐져 있어서 — 그냥 궤도 확장 0/3 만」.
 *     원인은 둘이었다: ① 힌트를 «이름 뒤»에 놓느라 **분류 칩의 폭을 안 셌다**(칩 위에 겹쳐 찍혔다)
 *     ② 「진화: 」 접두가 폭을 더 먹었다. 그래서 칩 폭을 세고, 접두를 지우고, 그래도 안 맞으면 짧은 형태로 내려간다.
 * @param hints 정보량이 많은 순서. 다 안 맞으면 '' (안 그린다 — 겹쳐 찍는 것보다 낫다).
 */
export function weaponRowLayout(w, nameW, chipW, levelW, hints, measureHint) {
  const NAME_X = 26;          // 번호 뒤 = 이름 시작
  const GAP_NAME_CHIP = 8;
  const GAP_CHIP_HINT = 10;
  const GAP_HINT_LEVEL = 8;
  const LEVEL_RIGHT = w - 46;                 // 레벨 텍스트의 오른쪽 기준선(right 정렬)
  const chipX = NAME_X + nameW + GAP_NAME_CHIP;
  const limit = LEVEL_RIGHT - levelW - GAP_HINT_LEVEL;
  const withChip = chipX + chipW + GAP_CHIP_HINT;
  const noChip = NAME_X + nameW + GAP_CHIP_HINT;
  const base = { chipX, showChip: true, hintX: withChip, hint: '' };
  if (hints.length === 0) return base;
  // ★ 양보 사다리 — «정보량이 많은 것»부터 넣어 보고, 폭이 모자라면 한 칸씩 내려간다.
  //   ② 에서 분류 칩을 접는 이유: 진화 임박 행에서 실제로 행동을 바꾸는 정보는 «어떤 패시브가 몇 레벨 필요한가»이고,
  //   분류는 그 패시브 이름이 이미 말한다(㊲ — 패시브가 분류를 달고 있다). 칩은 다른 다섯 행에 그대로 남는다.
  const full = hints[0];
  if (withChip + measureHint(full) <= limit) return { chipX, showChip: true, hintX: withChip, hint: full };
  if (noChip + measureHint(full) <= limit) return { chipX, showChip: false, hintX: noChip, hint: full };
  for (let i = 1; i < hints.length; i += 1) {
    if (withChip + measureHint(hints[i]) <= limit) return { chipX, showChip: true, hintX: withChip, hint: hints[i] };
  }
  return base;                                 // 다 안 맞으면 칩만 — 겹쳐 찍는 것보다 낫다
}

export function wrapLines(measure, s, maxW) {
  const fits = (t) => measure(t) <= maxW;
  const parts = [];
  for (const word of String(s).split(' ')) {
    if (word === '') continue;
    if (fits(word)) { parts.push(word); continue; }
    let cur = '';
    let lastBreak = -1;
    for (let i = 0; i < word.length; i += 1) {
      const ch = word[i];
      if (cur === '' || fits(cur + ch)) {
        cur += ch;
        if (ch === '·' || ch === ',' || ch === ')' || ch === ']') lastBreak = cur.length;
        continue;
      }
      const cut = lastBreak > 0 && lastBreak < cur.length ? lastBreak : cur.length;
      parts.push(cur.slice(0, cut));
      cur = cur.slice(cut) + ch;
      lastBreak = -1;
    }
    if (cur !== '') parts.push(cur);
  }
  const lines = [];
  let line = '';
  for (let i = 0; i < parts.length; i += 1) {
    const t = line === '' ? parts[i] : `${line} ${parts[i]}`;
    if (!fits(t) && line !== '') { lines.push(line); line = parts[i]; } else line = t;
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** wrapLines 로 나눈 줄을 그린다. 반환 = 마지막 줄의 y. */
function wrap(ctx, world, pal, s, x, y, maxW, px, color, lineH, align, weight) {
  const w = weight === undefined ? 400 : weight;
  const al = align === undefined ? 'left' : align;
  ctx.font = font(world, px, w);
  const lines = wrapLines((t) => ctx.measureText(t).width, s, maxW);
  let cy = y;
  for (let i = 0; i < lines.length; i += 1) {
    text(ctx, world, pal, lines[i], x, cy, px, color, al, w);
    if (i < lines.length - 1) cy += lineH;
  }
  return cy;
}
// hudText 별칭은 importer 0 이었다 → 제거(text 는 이 파일 안에서 직접 쓰인다, 모듈-프라이빗)

// ★ v1.5 — 상점 화면(drawShop)은 폐지됐다: 경제·소비아이템 제거.

// ---------------------------------------------------------------------------
// 결과 화면 (§11.3) — 죽어도 집계된다. 내역을 한 줄씩 보여주고 총점을 크게.
// ---------------------------------------------------------------------------
/**
 * ㊿-u 초 → 「m:ss」(1시간 이상이면 「h:mm:ss」). 초 아래는 버린다 — 결과 화면의 한 줄이다.
 *   ★ 버리기 전에 1e-6 을 더한다 — 틱을 나눠 만든 정초가 소수 오차로 x.9999999 가 되면 1초 모자라게 버려진다(검토).
 */
export function clockText(sec) {
  const s = Math.max(0, Math.floor(sec + 1e-6));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** t = score.tally(world) 결과. seedText = 재현용 시드 표기 */
export function drawResults(ctx, world, pal, t, seedText) {
  const a = world.data.rules.view.arena;
  const h = world.data.rules.hud;

  ctx.fillStyle = rgba(pal.hud.panelBg, 0.95);
  ctx.fillRect(a.x, a.y, a.w, a.h);

  const won = world.run !== undefined && world.run.won;
  const timeout = world.run !== undefined && world.run.deathCause === 'timeout';
  const title = won ? '클리어!' : 'GAME OVER';
  text(ctx, world, pal, title, a.x + a.w / 2, a.y + 60, h.fontHeroPx,
    won ? pal.element.normal : pal.threat.enemyBullet, 'center', 700);
  if (!won && timeout) {
    text(ctx, world, pal, '시간 초과', a.x + a.w / 2, a.y + 92, h.fontBodyPx, pal.hud.textDim, 'center', 500);
  }
  // ㊿-u 클리어하면 「클리어!」 아래에 걸린 시간(실제로 플레이한 초 — score.tally().clearSec). 사망한 판엔 없다.
  if (won && t.clearSec !== null) {
    text(ctx, world, pal, `클리어 시간 ${clockText(t.clearSec)}`, a.x + a.w / 2, a.y + 92, h.fontBodyPx, pal.hud.textPrimary, 'center', 600);
  }

  const rows = [
    ['처치', t.kills],
    ['보스 격파', t.bossClear],
    ['중간보스', t.midBossClear],
    ['시간 보너스', t.time],
    ['런 클리어', t.runClear],
    [`무피격 ${t.noHitCount}/${world.score.noHit.length}`, t.noHitBonus],
    ['퍼펙트', t.perfectBonus],
  ];
  let y = a.y + 140;
  for (let i = 0; i < rows.length; i += 1) {
    const dim = rows[i][1] === 0;
    text(ctx, world, pal, rows[i][0], a.x + 40, y, h.fontBodyPx,
      dim ? pal.hud.textDim : pal.hud.textPrimary, 'left', 500);
    text(ctx, world, pal, `${Math.floor(rows[i][1])}`, a.x + a.w - 40, y, h.fontBodyPx,
      dim ? pal.hud.textDim : pal.hud.textPrimary, 'right', 600);
    y += 30;
  }

  y += 10;
  text(ctx, world, pal, `점수 ×${t.scoreMul}`, a.x + a.w - 40, y, h.fontSmallPx, pal.hud.textDim, 'right', 400);
  y += 40;
  text(ctx, world, pal, '총점', a.x + 40, y, h.fontMediumPx, pal.hud.textPrimary, 'left', 700);
  text(ctx, world, pal, `${t.total}`, a.x + a.w - 40, y, h.fontHeroPx, pal.hud.accent, 'right', 700);

  text(ctx, world, pal, seedText, a.x + a.w / 2, a.y + a.h - 56, h.fontSmallPx, pal.hud.textDim, 'center', 400);
  text(ctx, world, pal, '[Space/Enter] 재시작   ·   [Esc] 타이틀', a.x + a.w / 2, a.y + a.h - 28,
    h.fontSmallPx, pal.hud.textDim, 'center', 400);
}

// ★ v1.5 — 사망 화면(drawDeath)/컨티뉴는 폐지됐다: 경제 제거 + 원데스=게임오버.
//   사망 = 즉시 결과 화면(main.js).

// ---------------------------------------------------------------------------
// §6.7(v1.10 ㊴) 튜토리얼 안내 띠 — 아레나 «위»에 제목 · 설명 · 지금 할 일. 판정 채널을 가리지 않는다.
//   ★ 규칙을 문장으로 늘어놓지 않는다: 한 스텝에 한 가지, 그리고 그것을 «해 보게» 한다(§6.7).
// ---------------------------------------------------------------------------
export function drawTutorial(ctx, world, pal, step) {
  const v = world.data.rules.view;
  const h = world.data.rules.hud;
  const a = v.arena;
  const tu = world.tut;
  const n = world.data.tutorial.steps.length;

  // ★ ㊷ 튜토리얼의 적 체력바는 **여기서 안 그린다** — ㊿-ze3 에서 draw.js 의 개체 바로 합쳤다.
  //   이 함수는 보간(interp·alpha)을 안 받아서 바가 스프라이트보다 한 틱 늦게 따라붙었고,
  //   같은 규격이 두 파일에 흩어져 하나는 클램프가 있고 하나는 없었다(엘리트 바가 3종 두께를 낳았던 것과 같은 기전).

  // 안내 띠 — ★ 아레나 «상단 띠 아래»에 놓는다(위에 겹치면 보스 코어 체력바를 가린다).
  //   ★ ㊻ 높이는 **줄바꿈한 모든 줄**에서 파생한다 — 고정 높이는 문장이 길어지면 글자가 상자 밖으로 넘친다(사용자 스크린샷).
  const padX = 16;
  const maxW = a.w - 16 - padX * 2;
  const measure = (t) => ctx.measureText(t).width;
  ctx.font = font(world, h.fontSmallPx, 400);
  const lines = [];
  if (step !== null) for (let i = 0; i < step.lines.length; i += 1) for (const l of wrapLines(measure, step.lines[i], maxW)) lines.push(l);
  const mult = step === null ? null : tutorialMultiplier(world);
  const LINE_H = 19;
  const bandH = step === null ? 44 : (26 + lines.length * LINE_H + (mult === null ? 0 : 22) + 12);
  const y0 = a.y + v.bandTopH + 6;
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = pal.hud.panelBg;
  ctx.fillRect(a.x + 8, y0, a.w - 16, bandH);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = pal.hud.panelRule;
  ctx.lineWidth = 1;
  ctx.strokeRect(a.x + 8, y0, a.w - 16, bandH);
  const cx = a.x + a.w / 2;
  if (step === null) {
    text(ctx, world, pal, '튜토리얼 완료', cx, y0 + 24, h.fontMediumPx, pal.hud.textPrimary, 'center', 700);
    ctx.restore();
    return;
  }
  text(ctx, world, pal, `${tu.i + 1} / ${n}   ${step.title}`, cx, y0 + 16, h.fontSmallPx, pal.hud.accent, 'center', 700);
  let cy = y0 + 38;
  for (let i = 0; i < lines.length; i += 1) { text(ctx, world, pal, lines[i], cx, cy, h.fontSmallPx, pal.hud.textPrimary, 'center'); cy += LINE_H; }
  // ★ ㊷ 살아 있는 배율 표시 — 「지금 내 공격이 저 적에게 몇 배인가」를 문장이 아니라 **숫자로 지금** 말한다.
  if (mult !== null) text(ctx, world, pal, mult.text, cx, cy + 4, h.fontBodyPx, mult.color(pal), 'center', 800);
  ctx.restore();
}

/**
 * ㊷ — 「지금 내 스탠스 → 가장 가까운 적」의 상성 배율. 값의 소유자는 elements.matrix 다(§3.1 3항과 같은 표를 읽는다).
 *   각인이 안 내려간 슬롯(무속성)이면 ×1 이므로 «투자하면 달라진다»가 그대로 읽힌다. 적이 없으면 null.
 */
function tutorialMultiplier(world) {
  const stamp = world.slots[0].stampElement;
  let best = null;
  let bestD = Infinity;
  const p = world.player;
  for (const e of world.enemies.items) {
    if (!e.alive || (e.isBoss && e.sealedNow)) continue;
    const dx = e.x - p.x; const dy = e.y - p.y; const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = e; }
  }
  if (best === null) return null;
  const m = world.data.elements.matrix[stamp][best.element];
  const label = m === 2 ? '×2' : (m === 0.5 ? '×½' : '×1');
  const EL_KO = { normal: '무', fire: '불', water: '물', grass: '풀' };
  return {
    text: `내 무기 ${EL_KO[stamp]} → 표적 ${EL_KO[best.element]} = 피해 ${label}`,
    color: (pal) => (m === 2 ? pal.element[stamp] : (m === 0.5 ? pal.hud.textDim : pal.hud.textPrimary)),
  };
}
