/*
 * 前端冒烟测试：node test/ui.smoke.js
 * 用最小 DOM/Canvas 桩在 Node 中执行 app.js，模拟完整用户流程：
 * 载入示例 → 成对点击 4 对控制点 → 拟合成功 → 导出矩阵/残差 →
 * 右键删点 → 清空 → 共线点被拒绝 → 透明度滑杆 →
 * 稳健模式（外点剔除、内外点导出、容差调整重算、失败时保留点对并禁用导出）。
 * 同时校验 app.js 引用的所有 DOM id 都存在于 index.html。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---------- 浏览器环境桩 ----------
const requestedIds = new Set();
const els = {};

function makeCtx() {
  return new Proxy({}, { get: () => () => {}, set: () => true });
}

function makeEl(tag) {
  return {
    tag,
    listeners: {},
    _q: {},
    className: '', textContent: '', innerHTML: '', value: '0.5',
    disabled: false, checked: false, files: [], dataset: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() {},
    querySelector(sel) { return this._q[sel] || (this._q[sel] = makeEl(sel)); },
    closest() { return null; },
    click() {}, remove() {}, appendChild() {}, setAttribute() {}
  };
}

function makeCanvas() {
  const el = makeEl('canvas');
  el.width = 300; el.height = 150;
  el.getContext = () => makeCtx();
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: el.width, height: el.height });
  el.toDataURL = () => 'data:image/png;base64,xxxx';
  return el;
}

global.window = { addEventListener() {} };
global.document = {
  getElementById(id) {
    requestedIds.add(id);
    if (!els[id]) els[id] = id.endsWith('Canvas') ? makeCanvas() : makeEl(id);
    return els[id];
  },
  createElement(tag) { return tag === 'canvas' ? makeCanvas() : makeEl(tag); },
  body: { appendChild() {} }
};
global.Affine = require('../public/js/affine.js');
global.Image = class {
  constructor() { this.naturalWidth = 960; this.naturalHeight = 640; this.onload = null; }
  set src(v) { setImmediate(() => this.onload && this.onload()); }
};
global.FileReader = class {
  readAsDataURL() { this.result = 'data:image/png;base64,xxxx'; setImmediate(() => this.onload && this.onload()); }
};
const blobs = [];
global.URL.createObjectURL = (b) => { blobs.push(b); return 'blob:fake'; };
global.URL.revokeObjectURL = () => {};

// ---------- 加载前端 ----------
require('../public/js/app.js');

// ---------- 工具 ----------
const fire = (el, type, ev = {}) => (el.listeners[type] || []).forEach((fn) => fn(ev));
const clickCanvas = (canvas, x, y) =>
  fire(canvas, 'mousedown', { button: 0, clientX: x, clientY: y, preventDefault() {} });
const tick = () => new Promise((r) => setImmediate(r));
const rowCount = () => (els.ptTable.querySelector('tbody').innerHTML.match(/<tr/g) || []).length;

(async () => {
  // 0. app.js 引用的 id 必须都存在于 index.html
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const id of requestedIds) {
    assert.ok(htmlIds.has(id), `app.js 引用了 index.html 中不存在的 id: ${id}`);
  }
  assert.ok(els.status.textContent.includes('请上传参考图与扫描图'));
  console.log('✓ 初始渲染正常，DOM id 与 index.html 一致');

  // 1. 载入示例图像
  fire(els.btnSample, 'click');
  await tick(); await tick();
  assert.strictEqual(els.refCanvas.width, 960);
  assert.strictEqual(els.scanCanvas.width, 640 > 0 ? 960 : 0); // 两图同尺寸
  assert.ok(els.status.textContent.includes('至少还需 3 对'));
  console.log('✓ 示例图像载入，提示需要 3 对控制点');

  // 2. 成对点击 4 对控制点（scan = M·ref，M 为示例图像的生成矩阵）
  const M = { a: 0.9962, b: -0.0105, c: 17.5, d: 0.0119, e: 0.9974, f: -11.2 };
  const refPts = [[90, 90], [870, 110], [120, 540], [830, 550]];
  const scanPt = ([x, y]) => [M.a * x + M.b * y + M.c, M.d * x + M.e * y + M.f];
  for (const rp of refPts) {
    clickCanvas(els.refCanvas, rp[0], rp[1]);
    const sp = scanPt(rp);
    clickCanvas(els.scanCanvas, sp[0], sp[1]);
  }
  assert.ok(els.status.textContent.includes('拟合成功'), '状态应显示拟合成功: ' + els.status.textContent);
  assert.ok(els.status.textContent.includes('RMSE'));
  assert.ok(els.fitPanel.innerHTML.includes('u = a·x + b·y + c'));
  assert.strictEqual(rowCount(), 4);
  assert.strictEqual(els.btnExportMatrix.disabled, false);
  console.log('✓ 4 对点拟合成功，矩阵面板与残差表渲染');

  // 3. 导出矩阵 JSON，并验证其逆映射精度
  fire(els.btnExportMatrix, 'click');
  const mj = JSON.parse(await blobs[0].text());
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) assert.ok(Number.isFinite(mj.matrix[k]));
  assert.deepStrictEqual(mj.matrixRowMajor[2], [0, 0, 1]);
  const sp0 = scanPt(refPts[0]);
  const bx = mj.matrix.a * sp0[0] + mj.matrix.b * sp0[1] + mj.matrix.c;
  const by = mj.matrix.d * sp0[0] + mj.matrix.e * sp0[1] + mj.matrix.f;
  assert.ok(Math.hypot(bx - refPts[0][0], by - refPts[0][1]) < 1e-6, '导出矩阵应精确反映扫描→参考映射');
  console.log('✓ 导出矩阵 JSON 正确（六参数 + 行主序矩阵）');

  // 4. 导出残差 JSON
  fire(els.btnExportResiduals, 'click');
  const rj = JSON.parse(await blobs[1].text());
  assert.strictEqual(rj.points.length, 4);
  assert.strictEqual(rj.points.filter((p) => p.isMaxResidual).length, 1);
  assert.ok(Number.isFinite(rj.rmse));
  console.log('✓ 导出残差 JSON 正确（唯一最大残差点标记）');

  // 5. 右键删除一个点 → 立即重算，剩 3 行
  fire(els.refCanvas, 'contextmenu', { clientX: refPts[0][0], clientY: refPts[0][1], preventDefault() {} });
  assert.strictEqual(rowCount(), 3);
  assert.ok(els.status.textContent.includes('3 对点'));
  console.log('✓ 右键删点后立即重算（剩 3 对）');

  // 6. 清空后点击共线三点 → 拒绝并提示
  fire(els.btnClear, 'click');
  assert.ok(els.status.textContent.includes('至少还需'));
  const refs = [[90, 90], [870, 110], [120, 540]];
  const line = [[100, 100], [200, 200], [300, 300]]; // 扫描图侧共线
  for (let i = 0; i < 3; i++) {
    clickCanvas(els.refCanvas, refs[i][0], refs[i][1]);
    clickCanvas(els.scanCanvas, line[i][0], line[i][1]);
  }
  assert.ok(els.status.textContent.includes('共线'), '共线应被拒绝: ' + els.status.textContent);
  assert.ok(els.status.className.includes('error'));
  assert.ok(els.btnExportMatrix.disabled, '拟合失败时导出按钮应禁用');
  console.log('✓ 共线控制点被拒绝并提示，导出按钮禁用');

  // 7. 透明度滑杆
  els.opacity.value = '0.8';
  fire(els.opacity, 'input');
  assert.strictEqual(els.opacityVal.textContent, '80%');
  console.log('✓ 透明度滑杆联动');

  // 8. 稳健模式：4 对正常点 + 1 对外点 → 外点被识别剔除
  fire(els.btnClear, 'click');
  for (const rp of refPts) {
    clickCanvas(els.refCanvas, rp[0], rp[1]);
    const sp = scanPt(rp);
    clickCanvas(els.scanCanvas, sp[0], sp[1]);
  }
  clickCanvas(els.refCanvas, 480, 280);
  const spO = scanPt([480, 280]);
  clickCanvas(els.scanCanvas, spO[0] + 60, spO[1] - 40); // 外点：偏离约 72px
  assert.ok(els.status.textContent.includes('拟合成功'));
  assert.ok(!els.status.textContent.includes('内点'), '普通模式不应区分内外点');
  console.log('✓ 普通模式：外点参与拟合');

  els.tolerance.value = '2';
  fire(els.tolerance, 'input'); // 未开稳健模式时仅记录容差
  els.robustMode.checked = true;
  fire(els.robustMode, 'change');
  assert.ok(els.status.textContent.includes('内点 4/5'), '稳健模式应剔除外点: ' + els.status.textContent);
  assert.ok(els.status.textContent.includes('RMSE（内点）'));
  assert.ok(els.ptTable.querySelector('tbody').innerHTML.includes('外点'), '残差表应标出外点');
  assert.strictEqual(els.tolerance.disabled, false, '稳健模式下容差输入应可用');
  console.log('✓ 稳健模式：外点被识别，双图标记与残差表区分内外点');

  // 9. 导出残差 JSON：记录内外点身份，RMSE 仅统计内点
  fire(els.btnExportResiduals, 'click');
  const rj2 = JSON.parse(await blobs[blobs.length - 1].text());
  assert.strictEqual(rj2.robust, true);
  assert.strictEqual(rj2.rmseScope, 'inliers');
  assert.strictEqual(rj2.points.filter((p) => p.isInlier).length, 4);
  assert.strictEqual(rj2.points[4].isInlier, false);
  const expectRmse = Math.sqrt(
    rj2.points.filter((p) => p.isInlier).reduce((s, p) => s + p.residualPx ** 2, 0) / 4
  );
  assert.ok(Math.abs(rj2.rmse - expectRmse) < 1e-9, 'RMSE 应仅统计内点');
  console.log('✓ 残差 JSON 记录内外点身份，RMSE 仅统计内点');

  // 10. 导出矩阵 JSON：与残差导出使用同一最终矩阵
  fire(els.btnExportMatrix, 'click');
  const mj2 = JSON.parse(await blobs[blobs.length - 1].text());
  assert.strictEqual(mj2.robust, true);
  assert.strictEqual(mj2.tolerance, 2);
  assert.deepStrictEqual(mj2.inliers, [true, true, true, true, false]);
  assert.strictEqual(mj2.rmse, rj2.rmse, '两种导出应使用同一最终矩阵与 RMSE');
  const sp1 = scanPt(refPts[0]);
  const ex = mj2.matrix.a * sp1[0] + mj2.matrix.b * sp1[1] + mj2.matrix.c;
  const ey = mj2.matrix.d * sp1[0] + mj2.matrix.e * sp1[1] + mj2.matrix.f;
  assert.ok(Math.hypot(ex - refPts[0][0], ey - refPts[0][1]) < 1e-6, '外点不应污染最终矩阵');
  console.log('✓ 矩阵 JSON 记录内外点身份，两种导出共用同一最终矩阵');

  // 11. 调整容差后同步重算：容差调大 → 外点变为内点
  els.tolerance.value = '100';
  fire(els.tolerance, 'input');
  assert.ok(els.status.textContent.includes('内点 5/5'), '调大容差后应全部内点: ' + els.status.textContent);
  console.log('✓ 调整容差后同步重算（5/5 内点）');

  // 12. 稳健模式找不到非共线内点：保留点对、说明原因、禁用导出
  els.tolerance.value = '2';
  fire(els.tolerance, 'input');
  fire(els.btnClear, 'click');
  const refs2 = [[90, 90], [870, 110], [120, 540]];
  const line2 = [[100, 100], [200, 200], [300, 300]]; // 扫描图侧共线
  for (let i = 0; i < 3; i++) {
    clickCanvas(els.refCanvas, refs2[i][0], refs2[i][1]);
    clickCanvas(els.scanCanvas, line2[i][0], line2[i][1]);
  }
  assert.ok(els.status.textContent.includes('共线'), '应说明失败原因: ' + els.status.textContent);
  assert.ok(els.status.className.includes('error'));
  assert.strictEqual(rowCount(), 3, '拟合失败时点对应保留');
  assert.ok(els.btnExportMatrix.disabled && els.btnExportResiduals.disabled, '导出应禁用');
  console.log('✓ 找不到非共线内点时保留点对、说明原因并禁用导出');

  // 13. 关闭稳健模式 → 回到普通最小二乘
  els.robustMode.checked = false;
  fire(els.robustMode, 'change');
  assert.ok(els.status.textContent.includes('共线'), '普通模式同样拒绝共线');
  assert.strictEqual(els.tolerance.disabled, true, '关闭稳健模式后容差输入应禁用');
  console.log('✓ 稳健模式可切换关闭');

  console.log('\n前端冒烟测试全部通过 ✔');
})().catch((err) => {
  console.error('冒烟测试失败:', err);
  process.exit(1);
});
