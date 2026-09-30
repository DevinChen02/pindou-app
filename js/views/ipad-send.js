// iPhone 这边的“在 iPad 上拼”：把拼豆板变成二维码给 iPad 扫；iPad 上打的勾，用 iPhone 扫 iPad 的进度码带回来。
// 库存、图纸只在 iPhone 上；iPad 只拿到拼豆板本身（色号、格子、摆放），扣库存还是在 iPhone 上点。
import { h, toast, sheet, copyText } from '../ui.js';
import * as store from '../store.js';
import { isCode, hexOf } from '../palette.js';
import { placeOf } from '../boardview.js';
import { KIND, packPayload, unpackPayload, toFrames } from '../transfer.js';
import { qrShow, keepAwake, scanQR, loadScanner } from '../qr.js';

export const sentToIpad = p => !!p.build?.ipadAt;
export const ipadUrl = () => new URL('ipad.html', document.baseURI).href;

/** 发给 iPad 的内容：拼豆板 + 每种颜色的颗数（items：拼的页面底部那一排，按清单顺序）+ 已经打的勾 */
export function boardPayload(p, items) {
  const b = p.board;
  const P = placeOf({ ...b, cells: null });
  return {
    t: 'board', v: 1, id: p.id, name: p.name || '拼豆', at: Date.now(),
    rows: b.rows, cols: b.cols, codes: b.codes,
    hex: b.codes.map(c => (isCode(c) ? hexOf(c) : null)), // 自定义色卡的颜色也带过去
    cells: b.cells, // packCells 的字符串
    place: { W: P.W, H: P.H, ox: P.ox, oy: P.oy, mirror: P.mirror, native: P.native },
    items: [...items].sort((x, y) => x.i - y.i).map(it => [it.code, it.count, it.listCount ?? it.count, isCode(it.code) ? hexOf(it.code) : null]),
    done: p.build?.done || [],
  };
}

/**
 * “在 iPad 上拼”弹层：二维码（大的拼豆板几张轮流显示）+ 第一次怎么装 iPad 看板 + 把 iPad 的进度扫回来。
 * items：拼的页面底部的颜色（buildItems）
 */
export async function ipadSheet(app, p, items) {
  let frames;
  try { frames = toFrames(KIND.board, await packPayload(boardPayload(p, items))); } catch (e) { toast(e.message, 'error'); return; }
  const first = !sentToIpad(p);
  if (first) await store.markSentToIpad(p.id);
  const show = qrShow(frames);
  const release = await keepAwake();
  const url = ipadUrl();
  loadScanner().catch(() => {}); // 先把扫码引擎下好，等会儿扫 iPad 的进度码不用等
  const s = sheet([
    h('div.ipad-send',
      show.el,
      h('p.small.center', h('b', '在 iPad 的「拼豆看板」里点“扫码”，对准这里')),
      frames.length > 1 ? h('p.tiny.muted.center', `拼豆板比较大，分 ${frames.length} 张轮流显示，对准不动就会自动收齐`) : null,
      h('details.ipad-first',
        h('summary', 'iPad 上还没有「拼豆看板」？'),
        h('ol.small',
          h('li', 'iPad 用 Safari 打开 ', h('span.mono', url)),
          h('li', '点分享按钮 → “添加到主屏幕”'),
          h('li', '从主屏幕打开「拼豆看板」，点“扫码”')),
        h('button.btn.sm.soft', { onclick: async () => { await copyText(url); toast('网址已复制，可以用“隔空投送”或备忘录发到 iPad', 'ok'); } }, '复制网址')),
      h('div.ipad-back',
        h('div.small', h('b', 'iPad 上打的勾带回 iPhone')),
        h('div.tiny.muted', '全部拼完了，直接点拼豆页面下面的“🎉 全拼好了”就行；中途想结算（先拼到这里），先把 iPad 的进度扫回来，才知道哪些颜色拼好了。'),
        h('button.btn.soft', { onclick: async () => { s.close(); await scanProgress(app, p, items); } }, '📷 扫 iPad 上的进度码'))),
  ], {
    title: '在 iPad 上拼',
    tall: true,
    onClose: () => { show.stop(); release(); if (first) app.rerender(); },
  });
}

/** 扫 iPad 上的进度码，把打的勾换成 iPad 上的；成功返回 true */
export async function scanProgress(app, p, items) {
  const bytes = await scanQR({
    kind: KIND.progress,
    title: '扫 iPad 上的进度码',
    hint: 'iPad 看板里点“进度传回 iPhone”，会显示一个二维码',
    wrongKind: k => (k === KIND.board ? '这是发给 iPad 的拼豆板二维码，要在 iPad 上扫' : '这个二维码不是进度码'),
  });
  if (!bytes) return false;
  let obj;
  try { obj = await unpackPayload(bytes); } catch (e) { toast(e.message, 'error'); return false; }
  if (obj?.t !== 'progress' || !Array.isArray(obj.done)) { toast('这个二维码不是进度码', 'error'); return false; }
  let target = p, codes = items.map(i => i.code);
  if (obj.id !== p.id) {
    target = await store.getPattern(obj.id);
    if (!target) { toast(`这是「${obj.name || '另一张图纸'}」的进度，iPhone 上已经没有这张图纸了`, 'error'); return false; }
    codes = [...new Set((target.items || []).map(i => i.code))];
  }
  const has = new Set(codes);
  const done = obj.done.filter(c => has.has(c));
  await store.setDoneColors(target.id, done);
  toast(`${target.id === p.id ? '' : `「${target.name}」：`}已带回 iPad 的进度，拼好 ${done.length}/${has.size} 色`, 'ok');
  app.rerender();
  return true;
}
