/*
 * 仿射最小二乘拟合（浏览器 / Node 通用模块）
 *
 * 给定 n ≥ 3 对控制点 (x_i, y_i) → (u_i, v_i)，求解六参数仿射变换：
 *     u = a·x + b·y + c
 *     v = d·x + e·y + f
 * 使 Σ|(u_i, v_i) − A·(x_i, y_i)|² 最小。
 *
 * 数值实现：先对源点与目标点分别中心化，正规方程退化为两个 2×2 线性方程组
 * （平移量 c、f 由质心回代），避免大坐标下直接解 3×3 正规方程的病态问题。
 *
 * 近共线判定：源点（或目标点）协方差矩阵的最小/最大特征值之比小于
 * COLLINEAR_RATIO 时视为近共线（含全部重合），拒绝拟合。
 *
 * 稳健模式（fitAffineRobust）：按固定字典序遍历三点组合，跳过近共线候选，
 * 评估上限 MAX_TRIPLE_CANDIDATES 个（点对增多时截断，保证拖动实时重算不卡顿）；
 * 以“内点数量优先、内点平方误差次之”选出最优候选，再对其内点重新做最小二乘
 * 拟合得到最终矩阵。最终内/外点按最终矩阵残差与容差重新判定，RMSE 仅统计内点。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Affine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_POINTS = 3;
  // 近共线阈值：λmin/λmax < 1e-4，即点集垂直方向展宽不足主方向的 1%
  const COLLINEAR_RATIO = 1e-4;
  // 稳健模式默认内点容差（目标图 / 参考图像素）
  const DEFAULT_TOLERANCE = 2;
  // 稳健模式三点候选评估上限：固定顺序截断，避免点对增多时重算卡顿
  const MAX_TRIPLE_CANDIDATES = 500;

  class FitError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'FitError';
      this.code = code;
    }
  }

  function centroid(points) {
    let sx = 0, sy = 0;
    for (const p of points) { sx += p.x; sy += p.y; }
    return { x: sx / points.length, y: sy / points.length };
  }

  /**
   * 评估点集共线程度。
   * @returns {{degenerate: boolean, ratio: number}} ratio 为 λmin/λmax
   */
  function collinearity(points) {
    const c = centroid(points);
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of points) {
      const dx = p.x - c.x, dy = p.y - c.y;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const trace = sxx + syy;
    if (trace <= 0) return { degenerate: true, ratio: 0 }; // 所有点重合
    let det = sxx * syy - sxy * sxy;
    if (det < 0) det = 0; // 浮点误差兜底
    const disc = Math.sqrt(Math.max(trace * trace - 4 * det, 0));
    const lMax = (trace + disc) / 2;
    const lMin = (trace - disc) / 2;
    const ratio = lMax > 0 ? lMin / lMax : 0;
    return { degenerate: ratio < COLLINEAR_RATIO, ratio };
  }

  function validate(src, dst) {
    if (!Array.isArray(src) || !Array.isArray(dst) || src.length !== dst.length) {
      throw new FitError('BAD_INPUT', '源点与目标点必须为等长数组');
    }
    if (src.length < MIN_POINTS) {
      throw new FitError('TOO_FEW_POINTS', `至少需要 ${MIN_POINTS} 对控制点`);
    }
    for (const p of src.concat(dst)) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        throw new FitError('BAD_INPUT', '控制点坐标必须为有限数字');
      }
    }
  }

  /** 无校验最小二乘核心：调用方保证 n ≥ 3 且源点非近共线 */
  function leastSquares(src, dst) {
    const cs = centroid(src), cd = centroid(dst);
    let sxx = 0, sxy = 0, syy = 0, sxu = 0, syu = 0, sxv = 0, syv = 0;
    for (let i = 0; i < src.length; i++) {
      const dx = src[i].x - cs.x, dy = src[i].y - cs.y;
      const du = dst[i].x - cd.x, dv = dst[i].y - cd.y;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
      sxu += dx * du; syu += dy * du;
      sxv += dx * dv; syv += dy * dv;
    }
    const D = sxx * syy - sxy * sxy; // 共线检查已保证 D > 0

    const a = (sxu * syy - syu * sxy) / D;
    const b = (syu * sxx - sxu * sxy) / D;
    const d = (sxv * syy - syv * sxy) / D;
    const e = (syv * sxx - sxv * sxy) / D;
    const c = cd.x - a * cs.x - b * cs.y;
    const f = cd.y - d * cs.x - e * cs.y;
    return { a, b, c, d, e, f };
  }

  /** 矩阵对全部点对的逐点残差 */
  function residualsOf(m, src, dst) {
    return src.map((p, i) => Math.hypot(
      m.a * p.x + m.b * p.y + m.c - dst[i].x,
      m.d * p.x + m.e * p.y + m.f - dst[i].y
    ));
  }

  function argMax(arr) {
    let k = 0;
    for (let i = 1; i < arr.length; i++) if (arr[i] > arr[k]) k = i;
    return k;
  }

  function rmseOf(residuals) {
    return Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
  }

  /**
   * 仿射最小二乘拟合（全部点参与）。
   * @param {Array<{x:number,y:number}>} src 源点（扫描图）
   * @param {Array<{x:number,y:number}>} dst 目标点（参考图）
   * @returns {{matrix:{a,b,c,d,e,f}, residuals:number[], rmse:number, maxIndex:number,
   *           pointCount:number, robust:boolean, inliers:boolean[], inlierCount:number}}
   * @throws {FitError} code ∈ TOO_FEW_POINTS | COLLINEAR_SRC | COLLINEAR_DST | BAD_INPUT
   */
  function fitAffine(src, dst) {
    validate(src, dst);

    if (collinearity(src).degenerate) {
      throw new FitError('COLLINEAR_SRC', '扫描图控制点过于接近共线（或重合），无法求解仿射变换，请调整点位分布');
    }
    if (collinearity(dst).degenerate) {
      throw new FitError('COLLINEAR_DST', '参考图控制点过于接近共线（或重合），无法求解仿射变换，请调整点位分布');
    }

    const matrix = leastSquares(src, dst);
    const residuals = residualsOf(matrix, src, dst);

    return {
      matrix,
      residuals,
      rmse: rmseOf(residuals),
      maxIndex: argMax(residuals),
      pointCount: src.length,
      robust: false,
      inliers: src.map(() => true), // 普通模式全部点参与拟合，皆为内点
      inlierCount: src.length
    };
  }

  function parseRobustOptions(options) {
    const opts = options || {};
    let tolerance = DEFAULT_TOLERANCE;
    if (opts.tolerance !== undefined) {
      if (!Number.isFinite(opts.tolerance) || opts.tolerance <= 0) {
        throw new FitError('BAD_INPUT', '内点容差必须为正数');
      }
      tolerance = opts.tolerance;
    }
    let maxCandidates = MAX_TRIPLE_CANDIDATES;
    if (opts.maxCandidates !== undefined) {
      if (!Number.isInteger(opts.maxCandidates) || opts.maxCandidates < 1) {
        throw new FitError('BAD_INPUT', '候选上限必须为正整数');
      }
      maxCandidates = opts.maxCandidates;
    }
    return { tolerance, maxCandidates };
  }

  /**
   * 稳健仿射拟合：固定顺序评估有上限的非共线三点候选，内点数量优先、
   * 内点平方误差次之选择模型，再对内点重新最小二乘拟合。
   * @param {Array<{x:number,y:number}>} src 源点（扫描图）
   * @param {Array<{x:number,y:number}>} dst 目标点（参考图）
   * @param {{tolerance?:number, maxCandidates?:number}} [options]
   *        tolerance 为内点判定阈值（目标图 / 参考图像素）
   * @returns 同 fitAffine，另含 tolerance / candidatesEvaluated / truncated；
   *          inliers 标记各点是否内点，rmse 仅统计内点
   * @throws {FitError} code ∈ TOO_FEW_POINTS | BAD_INPUT | NO_VALID_TRIPLE | NO_INLIERS
   */
  function fitAffineRobust(src, dst, options) {
    validate(src, dst);
    const { tolerance, maxCandidates } = parseRobustOptions(options);
    const n = src.length;
    const tol2 = tolerance * tolerance;

    // 固定字典序遍历三点组合，跳过近共线候选，最多评估 maxCandidates 个
    let best = null; // {inlierCount, sse, inliers}
    let evaluated = 0;
    let truncated = false;
    outer:
    for (let i = 0; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        for (let k = j + 1; k < n; k++) {
          const triS = [src[i], src[j], src[k]];
          const triD = [dst[i], dst[j], dst[k]];
          if (collinearity(triS).degenerate || collinearity(triD).degenerate) continue;
          if (evaluated >= maxCandidates) { truncated = true; break outer; }
          evaluated++;
          const m = leastSquares(triS, triD); // 三点非共线时为精确解
          let inlierCount = 0, sse = 0;
          const inliers = new Array(n);
          for (let p = 0; p < n; p++) {
            const du = m.a * src[p].x + m.b * src[p].y + m.c - dst[p].x;
            const dv = m.d * src[p].x + m.e * src[p].y + m.f - dst[p].y;
            const r2 = du * du + dv * dv;
            inliers[p] = r2 <= tol2;
            if (inliers[p]) { inlierCount++; sse += r2; }
          }
          // 内点数量优先，内点平方误差次之
          if (!best || inlierCount > best.inlierCount ||
              (inlierCount === best.inlierCount && sse < best.sse)) {
            best = { inlierCount, sse, inliers };
          }
        }
      }
    }
    if (!best) {
      throw new FitError('NO_VALID_TRIPLE',
        '稳健拟合失败：找不到非共线的三点候选（点集过于接近共线或重合），请调整点位分布');
    }

    // 对最优候选的内点重新最小二乘拟合，得到最终矩阵
    const pick = (inliers) => {
      const s = [], d = [];
      inliers.forEach((ok, p) => { if (ok) { s.push(src[p]); d.push(dst[p]); } });
      return { s, d };
    };
    const sub = pick(best.inliers);
    const matrix = leastSquares(sub.s, sub.d);

    // 用最终矩阵重新判定内/外点，保证残差表、RMSE 与导出相互一致
    const residuals = residualsOf(matrix, src, dst);
    const inliers = residuals.map((r) => r <= tolerance);
    const inlierCount = inliers.reduce((s, ok) => s + (ok ? 1 : 0), 0);
    if (inlierCount < MIN_POINTS) {
      throw new FitError('NO_INLIERS',
        `稳健拟合失败：容差 ${tolerance} px 内不足 ${MIN_POINTS} 对内点，请增大容差或检查点位`);
    }
    const fin = pick(inliers);
    if (collinearity(fin.s).degenerate || collinearity(fin.d).degenerate) {
      throw new FitError('NO_INLIERS',
        '稳健拟合失败：容差内的内点过于接近共线，无法稳定求解，请增大容差或调整点位分布');
    }

    return {
      matrix,
      residuals,
      rmse: rmseOf(residuals.filter((_, i) => inliers[i])), // 外点不计入 RMSE
      maxIndex: argMax(residuals),
      pointCount: n,
      robust: true,
      tolerance,
      inliers,
      inlierCount,
      candidatesEvaluated: evaluated,
      truncated
    };
  }

  /** 对单个点应用六参数矩阵 */
  function applyMatrix(m, p) {
    return { x: m.a * p.x + m.b * p.y + m.c, y: m.d * p.x + m.e * p.y + m.f };
  }

  return {
    fitAffine, fitAffineRobust, applyMatrix, collinearity, FitError,
    MIN_POINTS, COLLINEAR_RATIO, DEFAULT_TOLERANCE, MAX_TRIPLE_CANDIDATES
  };
});
