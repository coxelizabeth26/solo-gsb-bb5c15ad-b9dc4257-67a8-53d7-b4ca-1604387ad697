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

// 11. 普通拟合返回结构兼容：inliers 全为 true
{
  const dst = SRC.map((p) => apply(TRUE_M, p));
  const r = Affine.fitAffine(SRC, dst);
  assert.strictEqual(r.robust, false);
  assert.strictEqual(r.inlierCount, SRC.length);
  assert.ok(r.inliers.every(Boolean));
  console.log('✓ 普通拟合 inliers 全为 true（与稳健模式结构一致）');
}

// 12. 稳健模式：6 内点（含噪）+ 2 外点 → 剔除外点，矩阵逼近真值，RMSE 仅统计内点
const ROBUST_SRC = SRC.concat([{ x: 250, y: 260 }, { x: 320, y: 120 }]);
const ROBUST_DST = (() => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const noise = 0.4;
  const inDst = SRC.map((p) => {
    const q = apply(TRUE_M, p);
    return { x: q.x + rand() * 2 * noise, y: q.y + rand() * 2 * noise };
  });
  return inDst.concat([{ x: 40, y: 470 }, { x: 610, y: 55 }]); // 严重偏离真值映射
})();
{
  const r = Affine.fitAffineRobust(ROBUST_SRC, ROBUST_DST, { tolerance: 2 });
  assert.strictEqual(r.robust, true);
  assert.strictEqual(r.inlierCount, 6);
  assert.deepStrictEqual(r.inliers, [true, true, true, true, true, true, false, false]);
  for (const k of ['a', 'b', 'd', 'e']) {
    assert.ok(Math.abs(r.matrix[k] - TRUE_M[k]) < 0.02, `稳健拟合 ${k} 偏差过大`);
  }
  for (const k of ['c', 'f']) {
    assert.ok(Math.abs(r.matrix[k] - TRUE_M[k]) < 1.5, `稳健拟合 ${k} 偏差过大`);
  }
  // 外点不计入 RMSE
  const inRes = r.residuals.filter((_, i) => r.inliers[i]);
  const expectRmse = Math.sqrt(inRes.reduce((s, v) => s + v * v, 0) / inRes.length);
  assert.ok(Math.abs(r.rmse - expectRmse) < 1e-12, 'RMSE 应仅统计内点');
  assert.ok(r.rmse < 2 && r.residuals[6] > 10 && r.residuals[7] > 10, '外点残差大但不计入 RMSE');
  console.log('✓ 稳健模式剔除外点，矩阵逼近真值，RMSE 仅统计内点');
}

// 13. 稳健模式：固定顺序评估，结果确定可复现；默认容差生效
{
  const r1 = Affine.fitAffineRobust(ROBUST_SRC, ROBUST_DST);
  const r2 = Affine.fitAffineRobust(ROBUST_SRC, ROBUST_DST);
  assert.deepStrictEqual(r1, r2);
  assert.strictEqual(r1.tolerance, Affine.DEFAULT_TOLERANCE);
  console.log('✓ 稳健模式结果确定可复现，默认容差生效');
}

// 14. 稳健模式：候选按固定顺序评估并受上限截断（C(20,3)=1140 > 500）
{
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ x: (i * 137) % 541 + (i % 3), y: (i * i * 89) % 433 + (i % 5) });
  const dstM = many.map((p) => apply(TRUE_M, p));
  const r = Affine.fitAffineRobust(many, dstM, { tolerance: 1 });
  assert.strictEqual(r.candidatesEvaluated, Affine.MAX_TRIPLE_CANDIDATES);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.inlierCount, 20); // 无噪声，全部内点
  console.log('✓ 三点候选有上限截断，点多时仍快速完成');
}

// 15. 稳健模式：外点数量多于内点时仍按内点数量优先选出正确模型
{
  const inS = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }];
  const inD = inS.map((p) => apply(TRUE_M, p));
  const outS = [{ x: 300, y: 50 }, { x: 60, y: 300 }, { x: 330, y: 330 }, { x: 150, y: 220 }, { x: 260, y: 160 }];
  const outD = [{ x: 500, y: 500 }, { x: 20, y: 610 }, { x: 90, y: 90 }, { x: 640, y: 200 }, { x: 180, y: 640 }];
  const r = Affine.fitAffineRobust(inS.concat(outS), inD.concat(outD), { tolerance: 1.5 });
  assert.strictEqual(r.inlierCount, 4);
  assert.deepStrictEqual(r.inliers.slice(0, 4), [true, true, true, true]);
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.ok(Math.abs(r.matrix[k] - TRUE_M[k]) < 1e-9, `外点主导时 ${k} 偏差过大`);
  }
  console.log('✓ 外点数量多于内点时仍选出正确模型');
}

// 16. 稳健模式：全部共线 → 无非共线三点候选，拒绝
{
  const col = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 200 }, { x: 300, y: 300 }];
  assert.throws(
    () => Affine.fitAffineRobust(col, col.map((p) => apply(TRUE_M, p)), { tolerance: 2 }),
    (e) => e.code === 'NO_VALID_TRIPLE'
  );
  console.log('✓ 稳健模式无非共线候选时抛出 NO_VALID_TRIPLE');
}

// 17. 稳健模式：非法容差 / 候选上限 → BAD_INPUT；点数不足 → TOO_FEW_POINTS
{
  const s3 = SRC.slice(0, 3);
  const d3 = s3.map((p) => apply(TRUE_M, p));
  assert.throws(() => Affine.fitAffineRobust(s3, d3, { tolerance: 0 }), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.fitAffineRobust(s3, d3, { tolerance: -2 }), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.fitAffineRobust(s3, d3, { maxCandidates: 0 }), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.fitAffineRobust(s3.slice(0, 2), d3.slice(0, 2)), (e) => e.code === 'TOO_FEW_POINTS');
  console.log('✓ 非法容差/候选上限/点数不足被拒绝');
}

console.log('\n全部测试通过 ✔');
