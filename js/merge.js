// 多张截图合成一张大图（界面那一侧）：在后台线程找重叠（stitch.js），这里按找到的位置在画布上拼起来。
import { runBoard } from './boardasync.js';
import { ownership, gridLayout } from './stitch.js';
import { makeCanvas, getImageData } from './image.js';

const MAX_PIXELS = 12_000_000; // iPhone 上单个画布太大会失败：超过就整体缩小

/** 截图的内容部分（去掉黑边）按 k 缩放成一张新画布 */
function contentCanvas(work, k = 1) {
  const c = work.content;
  const cv = makeCanvas(c.w * k, c.h * k);
  const g = cv.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(work.canvas, c.x, c.y, c.w, c.h, 0, 0, cv.width, cv.height);
  return cv;
}

/** 按位置拼：pieces[i] 画在 rects[i]；重叠处用离自己边缘最远的那张。总像素太多时整体缩小 */
export function compose(pieces, rects, W, H) {
  const k = Math.min(1, Math.sqrt(MAX_PIXELS / (W * H)));
  const out = makeCanvas(W * k, H * k);
  const g = out.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, out.width, out.height);
  g.imageSmoothingQuality = 'high';
  for (const row of ownership(rects, W, H, 2)) {
    for (const run of row.runs) {
      const r = rects[run.i];
      g.drawImage(pieces[run.i], run.x0 - r.x, row.y0 - r.y, run.x1 - run.x0, row.y1 - row.y0,
        run.x0 * k, row.y0 * k, (run.x1 - run.x0) * k, (row.y1 - row.y0) * k);
    }
  }
  return out;
}

/**
 * 找重叠：works = [{ canvas, content }]。返回
 *   { groups: [{ members: [图序号], canvas }]（每组拼好的图）, plan }
 * 一组 = 互相找到了重叠、对齐拼好的几张；找不到重叠的各自一组（要手动排）
 */
export async function autoMerge(works) {
  const imgs = works.map(w => { const d = getImageData(w.canvas, w.content); return { data: d.data, width: d.width, height: d.height }; });
  const plan = await runBoard('stitch', null, { imgs });
  const pieces = works.map((w, i) => (plan.scales[i] === 1 ? contentCanvas(w) : contentCanvas(w, plan.scales[i])));
  const groups = plan.groups.map(members => {
    const rects = members.map(i => ({ x: plan.pos[i].x, y: plan.pos[i].y, w: plan.sizes[i].w, h: plan.sizes[i].h }));
    const W = Math.max(...rects.map(r => r.x + r.w)), H = Math.max(...rects.map(r => r.y + r.h));
    const canvas = members.length === 1 ? pieces[members[0]] : compose(members.map(i => pieces[i]), rects, W, H);
    return { members, canvas, rects };
  });
  return { groups, plan };
}

/** 手动排：几块（画布）按顺序、每行 perRow 块接在一起（不去重叠） */
export function manualMerge(canvases, perRow) {
  const { rects, W, H } = gridLayout(canvases.map(c => ({ w: c.width, h: c.height })), perRow);
  return compose(canvases, rects, W, H);
}
