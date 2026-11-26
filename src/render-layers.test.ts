/**
 * src/render-layers.test.ts — 图层契约的守卫。
 *
 * 2026-11-24 那次事故的教训不是「某个 renderOrder 写错了」，而是注释与代码说的
 * 不是同一件事：注释写着「与云的先后由批次位置决定」，实际由 renderOrder 硬压
 * （`RenderList.js:45` 先比 renderOrder，相同才比距离；重基只排同图层的批次）。
 *
 * 契约只写在注释里，下一个人就会改坏。这里把顺序关系和「谁必须用常量」钉成断言。
 */
import { describe, expect, it } from 'vitest';

import { LAYER } from './render-layers';

const sources = import.meta.glob(['./*.ts', './land/*.ts'], {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

const source = (path: string): string => {
  const text = sources[path];
  if (text === undefined) throw new Error(`missing raw source: ${path}`);
  return text;
};

/** 云卡 rank 的上界来自 bg-cloud-field 的 field 卡数量（bg_cloud_0..16）。 */
const MAX_CLOUD_FIELD_RANK = 16;

describe('renderOrder 图层契约', () => {
  it('由内向外：穹顶 → 星点 → 远树 → 地平线云卡 → 云卡群', () => {
    expect(LAYER.SKY).toBeLessThan(LAYER.STARS);
    expect(LAYER.STARS).toBeLessThan(LAYER.FAR_TREE);
    // 这一条是 2026-11-24 事故的核心：树必须排在两族云卡之前。
    // 任何把 FAR_TREE 挪到 CLOUD_BACKDROP 之后（含改回 -880）的改动都会红。
    expect(LAYER.FAR_TREE).toBeLessThan(LAYER.CLOUD_BACKDROP);
    expect(LAYER.CLOUD_BACKDROP).toBeLessThan(LAYER.CLOUD_FIELD);
  });

  it('云卡按距离加的 rank 不会溢出到 headlight 层', () => {
    expect(LAYER.CLOUD_FIELD + MAX_CLOUD_FIELD_RANK).toBeLessThan(LAYER.HEADLIGHT);
  });

  it('真实 3D 体与覆盖层在云之上', () => {
    expect(LAYER.HEADLIGHT).toBeLessThan(LAYER.SCENE);
    expect(LAYER.SCENE).toBeLessThan(LAYER.OVERLAY);
    expect(LAYER.OVERLAY).toBeLessThan(LAYER.OVERLAY_TOP);
  });
});

describe('源码不绕开契约写魔数', () => {
  it('天体与两族云卡走 LAYER', () => {
    expect(source('./sky-webgpu.ts')).toMatch(/renderOrder = LAYER\.SKY/);
    expect(source('./stars.ts')).toMatch(/renderOrder = LAYER\.STARS/);
    const cards = source('./bg-cloud-field.ts');
    expect(cards).toMatch(/renderOrder\s*=\s*LAYER\.CLOUD_BACKDROP/);
    expect(cards).toMatch(/renderOrder\s*=\s*LAYER\.CLOUD_FIELD\s*\+\s*rank/);
  });

  it('远树批次用 LAYER.FAR_TREE，且不再写字面量', () => {
    const land = source('./land/archipelago.ts');
    expect(land).toMatch(/farTrees\.renderOrder = LAYER\.FAR_TREE/);
    expect(land).not.toMatch(/farTrees\.renderOrder = -\d/);
  });

  it('体积云显式占 SCENE 层，不靠默认 0', () => {
    // 默认值恰好等于 LAYER.SCENE，所以这条改动**不改变任何行为**；
    // 它保证的是：改图层表时云不会悄悄脱队。
    expect(source('./puff-cloud.ts')).toMatch(/mesh\.renderOrder = LAYER\.SCENE/);
  });
});
