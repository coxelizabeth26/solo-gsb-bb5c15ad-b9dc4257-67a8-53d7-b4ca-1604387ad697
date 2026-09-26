/* affine.js 单元测试：node test/affine.test.js */
'use strict';

const assert = require('assert');
const Affine = require('../public/js/affine.js');

const TRUE_M = { a: 1.02, b: 0.01, c: 15, d: -0.005, e: 0.98, f: -20 };
const SRC = [
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 },
  { x: 100, y: 100 }, { x: 50, y: 80 }, { x: 200, y: 30 }
];

function apply(m, p) {
  return { x: m.a * p.x + m.b * p.y + m.c, y: m.d * p.x + m.e * p.y + m.f };
}

// 1. 无噪声：精确还原六参数
{
  const dst = SRC.map((p) => apply(TRUE_M, p));
  const r = Affine.fitAffine(SRC, dst);
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.ok(Math.abs(r.matrix[k] - TRUE_M[k]) < 1e-9, `参数 ${k} 偏差过大: ${r.matrix[k]}`);
  }
  assert.ok(r.rmse < 1e-9, '无噪声时 RMSE 应接近 0');
  console.log('✓ 无噪声 6 点精确还原矩阵');
}

// 2. 恰好 3 点：精确解，残差为 0
{
  const src = SRC.slice(0, 3);
  const dst = src.map((p) => apply(TRUE_M, p));
  const r = Affine.fitAffine(src, dst);
  assert.ok(r.rmse < 1e-9);
  assert.deepStrictEqual(r.residuals.every((v) => v < 1e-9), true);
  console.log('✓ 3 点精确拟合');
}

// 3. 含噪声：最小二乘逼近真值，残差量级与噪声一致
{
  const noise = 0.5;
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const dst = SRC.map((p) => {
    const q = apply(TRUE_M, p);
    return { x: q.x + rand() * 2 * noise, y: q.y + rand() * 2 * noise };
  });
  const r = Affine.fitAffine(SRC, dst);
  // 旋转/缩放参数无量纲，容差取噪声/点距量级；平移参数单位为 px，容差取噪声量级
  for (const k of ['a', 'b', 'd', 'e']) {
    assert.ok(Math.abs(r.matrix[k] - TRUE_M[k]) < 0.02, `含噪拟合 ${k} 偏差过大`);
  }
  for (const k of ['c', 'f']) {
    assert.ok(Math.abs(r.matrix[k] - TRUE_M[k]) < 1.5, `含噪拟合 ${k} 偏差过大`);
  }
  assert.ok(r.rmse > 0 && r.rmse < 2, 'RMSE 应在噪声量级内');
  assert.strictEqual(r.maxIndex, r.residuals.indexOf(Math.max(...r.residuals)));
  console.log('✓ 含噪最小二乘逼近，maxIndex 正确');
}

// 4. 点数不足：拒绝
{
  assert.throws(() => Affine.fitAffine(SRC.slice(0, 2), SRC.slice(0, 2)), /至少需要 3 对/);
  console.log('✓ 少于 3 点抛出 TOO_FEW_POINTS');
}

// 5. 源点共线：拒绝
{
  const collinear = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 200 }, { x: 300, y: 300 }];
  const dst = collinear.map((p) => apply(TRUE_M, p));
  assert.throws(() => Affine.fitAffine(collinear, dst), (e) => e.code === 'COLLINEAR_SRC');
  console.log('✓ 源点共线抛出 COLLINEAR_SRC');
}

// 6. 源点近共线（1000px 基线、0.1px 垂直偏移）：拒绝
{
  const nearCol = [{ x: 0, y: 0 }, { x: 500, y: 0.1 }, { x: 1000, y: 0 }, { x: 250, y: -0.1 }];
  const dst = nearCol.map((p) => apply(TRUE_M, p));
  assert.throws(() => Affine.fitAffine(nearCol, dst), (e) => e.code === 'COLLINEAR_SRC');
  console.log('✓ 源点近共线被拒绝');
}

// 7. 目标点共线：拒绝
{
  const dstCol = [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 100 }, { x: 150, y: 150 }];
  assert.throws(() => Affine.fitAffine(SRC.slice(0, 4), dstCol), (e) => e.code === 'COLLINEAR_DST');
  console.log('✓ 目标点共线抛出 COLLINEAR_DST');
}

// 8. 点全部重合：拒绝
{
  const same = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }];
  assert.throws(() => Affine.fitAffine(same, same), (e) => e.code === 'COLLINEAR_SRC');
  console.log('✓ 点重合被拒绝');
}

// 9. 非法输入：拒绝
{
  const good3 = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  const bad3 = [{ x: 0, y: 0 }, { x: 10 }, { x: 0, y: 10 }];
  assert.throws(() => Affine.fitAffine(good3, bad3), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.fitAffine('x', []), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.fitAffine(good3, good3.slice(0, 2)), (e) => e.code === 'BAD_INPUT');
  console.log('✓ 非法输入抛出 BAD_INPUT');
}

// 10. 大坐标（扫描仪高分辨率量级）数值稳定
{
  const big = SRC.map((p) => ({ x: p.x * 10 + 5000, y: p.y * 10 + 8000 }));
  const dst = big.map((p) => apply(TRUE_M, p));
  const r = Affine.fitAffine(big, dst);
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.ok(Math.abs(r.matrix[k] - TRUE_M[k]) < 1e-6, `大坐标下 ${k} 偏差过大`);
  }
  console.log('✓ 大坐标数值稳定');
}

console.log('\n全部测试通过 ✔');
