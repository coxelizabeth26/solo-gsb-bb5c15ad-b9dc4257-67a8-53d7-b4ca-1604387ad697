/*
 * 前端冒烟测试：node test/ui.smoke.js
 * 用最小 DOM/Canvas 桩在 Node 中执行 app.js，模拟完整用户流程：
 * 载入示例 → 成对点击 4 对控制点 → 拟合成功 → 导出矩阵/残差 →
 * 右键删点 → 清空 → 共线点被拒绝 → 透明度滑杆。
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
    disabled: false, files: [], dataset: {},
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

  console.log('\n前端冒烟测试全部通过 ✔');
})().catch((err) => {
  console.error('冒烟测试失败:', err);
  process.exit(1);
});
