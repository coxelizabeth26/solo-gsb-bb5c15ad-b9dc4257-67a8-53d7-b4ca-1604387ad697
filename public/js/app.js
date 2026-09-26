/* global Affine */
/*
 * 前端主逻辑：
 *  - 上传参考图 / 扫描图（FileReader 本地读取，不上传服务器）
 *  - 两图成对点击标注控制点（任意一图先点均可，自动配对）
 *  - 拖动微调、右键删除、列表删除；任何变化立即重算仿射拟合
 *  - 可切换稳健模式：有限候选稳健拟合 + 参考图像素容差，内/外点分色显示，
 *    外点不计入 RMSE；调整容差后同步重算
 *  - 残差实时列表，最大残差点红色高亮（稳健模式标出外点）；失败时保留点对并禁用导出
 *  - 叠加画布：参考图 + 经仿射变换的扫描图，透明度滑杆混合
 *  - 导出六参数矩阵 / 残差 JSON（与叠加预览共用同一最终矩阵，并记录内/外点身份）
 */
(function () {
  'use strict';

  // ---------- 状态 ----------
  const state = {
    refImg: null,            // 参考图 HTMLImageElement
    scanImg: null,           // 扫描图 HTMLImageElement
    points: [],              // 已完成配对 {id, ref:{x,y}, scan:{x,y}}
    pending: { ref: null, scan: null }, // 进行中的半对点
    nextId: 1,
    fit: null,               // {matrix, residuals, rmse, maxIndex, pointCount, robust, inliers, inlierCount, ...}
    fitError: null,          // 近共线 / 内点不足等错误提示（中文）
    dragging: null,          // {id, which:'ref'|'scan'}
    opacity: 0.5,
    robust: false,           // 稳健模式开关
    tolerance: Affine.DEFAULT_TOLERANCE // 内点容差（参考图像素）
  };

  const HIT_RADIUS_CSS = 12;   // 命中半径（CSS 像素）
  const COLOR_OK = '#22c55e';
  const COLOR_MAX = '#ef4444';
  const COLOR_PENDING = '#eab308';
  const COLOR_OUTLIER = '#f97316';

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const refCanvas = $('refCanvas');
  const scanCanvas = $('scanCanvas');
  const overlayCanvas = $('overlayCanvas');
  const statusEl = $('status');
  const fitPanelEl = $('fitPanel');
  const ptTableBody = $('ptTable').querySelector('tbody');
  const ptCountEl = $('ptCount');
  const opacityInput = $('opacity');
  const opacityVal = $('opacityVal');
  const robustInput = $('robustMode');
  const toleranceInput = $('tolerance');
  const btnExportMatrix = $('btnExportMatrix');
  const btnExportResiduals = $('btnExportResiduals');
  const btnClear = $('btnClear');

  // ---------- 图像加载 ----------
  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('无法解析图像文件'));
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function handleFile(input, which) {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const img = await loadImageFromFile(file);
      if (which === 'ref') state.refImg = img; else state.scanImg = img;
      clearPoints(); // 图像更换后旧坐标失效，清空控制点
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  // ---------- 坐标换算 ----------
  function eventToCanvas(canvas, e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height)
    };
  }

  // CSS 像素 → 画布像素的缩放系数（保证标记视觉大小一致）
  function canvasScale(canvas) {
    const r = canvas.getBoundingClientRect();
    return r.width > 0 ? canvas.width / r.width : 1;
  }

  // ---------- 拟合 ----------
  function recompute() {
    state.fit = null;
    state.fitError = null;
    if (state.points.length >= Affine.MIN_POINTS) {
      const src = state.points.map((p) => p.scan); // 源：扫描图
      const dst = state.points.map((p) => p.ref);  // 目标：参考图
      try {
        state.fit = state.robust
          ? Affine.fitAffineRobust(src, dst, { tolerance: state.tolerance })
          : Affine.fitAffine(src, dst);
      } catch (err) {
        // 拟合失败：保留点对，仅提示原因并禁用导出（renderButtons）
        state.fitError = err.message || String(err);
      }
    }
    render();
  }

  // ---------- 控制点操作 ----------
  function clearPoints() {
    state.points = [];
    state.pending = { ref: null, scan: null };
    state.dragging = null;
    recompute();
  }

  function deletePoint(id) {
    state.points = state.points.filter((p) => p.id !== id);
    recompute();
  }

  function hitTest(canvas, which, pos) {
    const tol = HIT_RADIUS_CSS * canvasScale(canvas);
    // 后添加的点优先命中（视觉上在上层）
    for (let i = state.points.length - 1; i >= 0; i--) {
      const q = state.points[i][which];
      if (Math.hypot(q.x - pos.x, q.y - pos.y) <= tol) return state.points[i];
    }
    return null;
  }

  function placePoint(which, pos) {
    state.pending[which] = pos;
    if (state.pending.ref && state.pending.scan) {
      state.points.push({
        id: state.nextId++,
        ref: state.pending.ref,
        scan: state.pending.scan
      });
      state.pending = { ref: null, scan: null };
      recompute();
    } else {
      render();
    }
  }

  // ---------- 画布事件 ----------
  function bindCanvas(canvas, which) {
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const img = which === 'ref' ? state.refImg : state.scanImg;
      if (!img) return;
      const pos = eventToCanvas(canvas, e);
      const hit = hitTest(canvas, which, pos);
      if (hit) {
        state.dragging = { id: hit.id, which };
        e.preventDefault();
      } else {
        placePoint(which, pos);
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!state.dragging || state.dragging.which !== which) return;
      const pos = eventToCanvas(canvas, e);
      const pt = state.points.find((p) => p.id === state.dragging.id);
      if (!pt) return;
      pt[which] = {
        x: Math.min(Math.max(pos.x, 0), canvas.width),
        y: Math.min(Math.max(pos.y, 0), canvas.height)
      };
      recompute(); // 拖动中实时重算
    });

    window.addEventListener('mouseup', () => { state.dragging = null; });

    canvas.addEventListener('contextmenu', (e) => {
      const img = which === 'ref' ? state.refImg : state.scanImg;
      if (!img) return;
      const pos = eventToCanvas(canvas, e);
      const hit = hitTest(canvas, which, pos);
      if (hit) {
        e.preventDefault();
        deletePoint(hit.id);
      }
    });
  }

  // ---------- 绘制 ----------
  function drawPlaceholder(canvas, text) {
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#64748b';
    ctx.font = '20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }

  function drawMarker(ctx, p, label, color, scale, dashed) {
    const r = 9 * scale;
    ctx.save();
    ctx.lineWidth = 2 * scale;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (dashed) ctx.setLineDash([4 * scale, 3 * scale]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // 中心十字
    ctx.beginPath();
    ctx.moveTo(p.x - r * 0.55, p.y); ctx.lineTo(p.x + r * 0.55, p.y);
    ctx.moveTo(p.x, p.y - r * 0.55); ctx.lineTo(p.x, p.y + r * 0.55);
    ctx.stroke();
    // 序号标签
    ctx.font = `bold ${12 * scale}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3 * scale;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(label, p.x + r + 2 * scale, p.y - 2 * scale);
    ctx.fillText(label, p.x + r + 2 * scale, p.y - 2 * scale);
    ctx.restore();
  }

  // 标记颜色：稳健模式区分内点（绿）/ 外点（橙）；普通模式标红最大残差点
  function pointColor(i) {
    const f = state.fit;
    if (!f) return COLOR_OK;
    if (f.robust) return f.inliers[i] ? COLOR_OK : COLOR_OUTLIER;
    return i === f.maxIndex ? COLOR_MAX : COLOR_OK;
  }

  function drawImageCanvas(canvas, img, which) {
    if (!img) {
      drawPlaceholder(canvas, which === 'ref' ? '请先上传参考图' : '请先上传扫描图');
      return;
    }
    if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
    }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const scale = canvasScale(canvas);

    state.points.forEach((pt, i) => {
      drawMarker(ctx, pt[which], String(i + 1), pointColor(i), scale, false);
    });
    const pending = state.pending[which];
    if (pending) drawMarker(ctx, pending, '?', COLOR_PENDING, scale, true);
  }

  function drawOverlay() {
    if (!state.refImg) {
      drawPlaceholder(overlayCanvas, '上传参考图后此处显示叠加预览');
      return;
    }
    const img = state.refImg;
    if (overlayCanvas.width !== img.naturalWidth || overlayCanvas.height !== img.naturalHeight) {
      overlayCanvas.width = img.naturalWidth;
      overlayCanvas.height = img.naturalHeight;
    }
    const ctx = overlayCanvas.getContext('2d');
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(img, 0, 0);

    if (state.scanImg && state.fit) {
      const m = state.fit.matrix;
      // canvas 变换矩阵 [a c e; b d f] ↔ u=a·x+b·y+c, v=d·x+e·y+f
      ctx.setTransform(m.a, m.d, m.b, m.e, m.c, m.f);
      ctx.globalAlpha = state.opacity;
      ctx.drawImage(state.scanImg, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }

    const scale = canvasScale(overlayCanvas);
    state.points.forEach((pt, i) => {
      drawMarker(ctx, pt.ref, String(i + 1), pointColor(i), scale, false);
    });
  }

  // ---------- 面板渲染 ----------
  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status ' + (kind || 'info');
  }

  function fmt(v, digits) {
    return Number(v).toFixed(digits === undefined ? 2 : digits);
  }

  function renderStatus() {
    const n = state.points.length;
    if (!state.refImg || !state.scanImg) {
      setStatus('请上传参考图与扫描图（或点击“载入示例图像”），然后在两图上成对点击控制点。', 'info');
      return;
    }
    if (state.pending.ref || state.pending.scan) {
      const wait = state.pending.ref ? '扫描图' : '参考图';
      setStatus(`已记录半对点，请在${wait}上点击对应位置完成配对（Esc 取消）。`, 'info');
      return;
    }
    if (n < Affine.MIN_POINTS) {
      setStatus(`已有 ${n} 对控制点，至少还需 ${Affine.MIN_POINTS - n} 对才能拟合。`, 'info');
      return;
    }
    if (state.fitError) {
      setStatus('拟合失败：' + state.fitError, 'error');
      return;
    }
    const f = state.fit;
    if (f.robust) {
      const outCount = f.pointCount - f.inlierCount;
      setStatus(
        `稳健拟合成功 · 内点 ${f.inlierCount}/${f.pointCount} 对 · RMSE（内点）= ${fmt(f.rmse, 3)} px · ` +
        `容差 ${fmt(f.tolerance, 1)} px` + (outCount > 0 ? ` · ${outCount} 个外点已橙色标出` : ''),
        'ok'
      );
      return;
    }
    setStatus(
      `拟合成功 · ${f.pointCount} 对点 · RMSE = ${fmt(f.rmse, 3)} px · ` +
      `最大残差点：#${f.maxIndex + 1}（${fmt(f.residuals[f.maxIndex], 3)} px，已红色标出）`,
      'ok'
    );
  }

  function renderFitPanel() {
    if (!state.fit) {
      fitPanelEl.innerHTML = state.fitError
        ? `<p class="err">${state.fitError}</p>`
        : '<p class="muted">满足条件后此处显示六参数矩阵。</p>';
      return;
    }
    const f = state.fit;
    const m = f.matrix;
    const rows = ['a', 'b', 'c', 'd', 'e', 'f']
      .map((k) => `<div class="mrow"><span>${k}</span><code>${Number(m[k]).toPrecision(8)}</code></div>`)
      .join('');
    const modeLine = f.robust
      ? `<p>模式：<strong>稳健</strong> · 内点 <strong>${f.inlierCount}/${f.pointCount}</strong> · ` +
        `容差 ${fmt(f.tolerance, 1)} px · 评估候选 ${f.candidatesEvaluated}${f.truncated ? '（已达上限）' : ''}</p>`
      : '<p>模式：普通最小二乘</p>';
    fitPanelEl.innerHTML =
      `<div class="matrix">${rows}</div>` +
      `<p class="muted">u = a·x + b·y + c<br>v = d·x + e·y + f（扫描图 → 参考图）</p>` +
      modeLine +
      `<p>RMSE${f.robust ? '（仅内点）' : ''}：<strong>${fmt(f.rmse, 4)}</strong> px</p>`;
  }

  function renderTable() {
    ptCountEl.textContent = state.points.length ? `（${state.points.length} 对）` : '';
    const maxIdx = state.fit && !state.fit.robust ? state.fit.maxIndex : -1;
    ptTableBody.innerHTML = state.points.map((pt, i) => {
      const r = state.fit ? fmt(state.fit.residuals[i], 3) : '—';
      const inlier = state.fit ? state.fit.inliers[i] : true;
      const cls = i === maxIdx ? ' class="max-row"' : (!inlier ? ' class="outlier-row"' : '');
      const typeCell = state.fit
        ? (inlier ? '<span class="tag-in">内点</span>' : '<span class="tag-out">外点</span>')
        : '—';
      return `<tr${cls}>
        <td>${i + 1}</td>
        <td>${fmt(pt.scan.x, 1)}, ${fmt(pt.scan.y, 1)}</td>
        <td>${fmt(pt.ref.x, 1)}, ${fmt(pt.ref.y, 1)}</td>
        <td>${r}</td>
        <td>${typeCell}</td>
        <td><button class="del" data-id="${pt.id}" title="删除该点">✕</button></td>
      </tr>`;
    }).join('');
  }

  function renderButtons() {
    const hasFit = !!state.fit;
    btnExportMatrix.disabled = !hasFit;
    btnExportResiduals.disabled = !hasFit;
    btnClear.disabled = state.points.length === 0 && !state.pending.ref && !state.pending.scan;
  }

  function render() {
    drawImageCanvas(refCanvas, state.refImg, 'ref');
    drawImageCanvas(scanCanvas, state.scanImg, 'scan');
    drawOverlay();
    renderStatus();
    renderFitPanel();
    renderTable();
    renderButtons();
  }

  // ---------- 导出 ----------
  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  function exportMatrix() {
    if (!state.fit) return;
    const f = state.fit;
    const m = f.matrix;
    downloadJSON('affine-matrix.json', {
      description: '仿射变换六参数：u = a·x + b·y + c，v = d·x + e·y + f（扫描图坐标 → 参考图坐标）',
      matrix: m,
      matrixRowMajor: [[m.a, m.b, m.c], [m.d, m.e, m.f], [0, 0, 1]],
      robust: f.robust,
      tolerance: f.robust ? f.tolerance : null,
      rmse: f.rmse,
      rmseScope: f.robust ? 'inliers' : 'all',
      pointCount: f.pointCount,
      inlierCount: f.inlierCount,
      inliers: f.inliers, // 与 residuals.json 中 points 的顺序一致（第 1..n 对点）
      exportedAt: new Date().toISOString()
    });
  }

  function exportResiduals() {
    if (!state.fit) return;
    const f = state.fit;
    downloadJSON('residuals.json', {
      robust: f.robust,
      tolerance: f.robust ? f.tolerance : null,
      rmse: f.rmse,
      rmseScope: f.robust ? 'inliers' : 'all',
      inlierCount: f.inlierCount,
      maxResidualIndex: f.maxIndex + 1,
      points: state.points.map((pt, i) => ({
        id: i + 1,
        scan: pt.scan,
        ref: pt.ref,
        residualPx: f.residuals[i],
        isInlier: f.inliers[i],
        isMaxResidual: i === f.maxIndex
      })),
      exportedAt: new Date().toISOString()
    });
  }

  // ---------- 示例图像 ----------
  function drawSampleContent(g, w, h) {
    g.fillStyle = '#f8fafc';
    g.fillRect(0, 0, w, h);
    // 网格
    g.strokeStyle = '#cbd5e1';
    g.lineWidth = 1;
    for (let x = 0; x <= w; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    // 套色十字（便于点击的标记）
    const crosses = [[90, 90], [w - 90, 110], [120, h - 100], [w - 130, h - 90], [w / 2, h / 2 - 40], [w / 2 + 160, 90]];
    crosses.forEach(([cx, cy], i) => {
      g.strokeStyle = ['#dc2626', '#2563eb', '#059669', '#7c3aed', '#ea580c', '#0891b2'][i % 6];
      g.lineWidth = 3;
      g.beginPath(); g.arc(cx, cy, 14, 0, Math.PI * 2); g.stroke();
      g.beginPath();
      g.moveTo(cx - 22, cy); g.lineTo(cx + 22, cy);
      g.moveTo(cx, cy - 22); g.lineTo(cx, cy + 22);
      g.stroke();
    });
    g.fillStyle = '#334155';
    g.font = 'bold 28px system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText('REGISTRATION SAMPLE · 套色校准示例', 30, h - 30);
  }

  function loadSampleImages() {
    const w = 960, h = 640;
    const c1 = document.createElement('canvas');
    c1.width = w; c1.height = h;
    drawSampleContent(c1.getContext('2d'), w, h);

    // 模拟扫描偏移：旋转 + 缩放 + 平移
    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    const g2 = c2.getContext('2d');
    g2.fillStyle = '#ffffff';
    g2.fillRect(0, 0, w, h);
    g2.setTransform(0.9962, 0.0119, -0.0105, 0.9974, 17.5, -11.2);
    g2.drawImage(c1, 0, 0);

    const refImg = new Image();
    const scanImg = new Image();
    let loaded = 0;
    const done = () => {
      loaded += 1;
      if (loaded < 2) return;
      state.refImg = refImg;
      state.scanImg = scanImg;
      clearPoints();
    };
    refImg.onload = done;
    scanImg.onload = done;
    refImg.src = c1.toDataURL('image/png');
    scanImg.src = c2.toDataURL('image/png');
  }

  // ---------- 事件绑定 ----------
  function init() {
    $('refFile').addEventListener('change', (e) => handleFile(e.target, 'ref'));
    $('scanFile').addEventListener('change', (e) => handleFile(e.target, 'scan'));
    $('btnSample').addEventListener('click', loadSampleImages);
    btnClear.addEventListener('click', clearPoints);
    btnExportMatrix.addEventListener('click', exportMatrix);
    btnExportResiduals.addEventListener('click', exportResiduals);

    opacityInput.addEventListener('input', () => {
      state.opacity = parseFloat(opacityInput.value);
      opacityVal.textContent = Math.round(state.opacity * 100) + '%';
      drawOverlay();
    });

    // 稳健模式开关与容差：切换 / 调整后同步重算
    const initTol = parseFloat(toleranceInput.value);
    if (Number.isFinite(initTol) && initTol > 0) state.tolerance = initTol;
    toleranceInput.disabled = !state.robust;
    robustInput.addEventListener('change', () => {
      state.robust = robustInput.checked;
      toleranceInput.disabled = !state.robust;
      recompute();
    });
    toleranceInput.addEventListener('input', () => {
      const v = parseFloat(toleranceInput.value);
      if (Number.isFinite(v) && v > 0) {
        state.tolerance = v;
        if (state.robust) recompute();
      }
    });

    ptTableBody.addEventListener('click', (e) => {
      const btn = e.target.closest('button.del');
      if (btn) deletePoint(Number(btn.dataset.id));
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (state.pending.ref || state.pending.scan)) {
        state.pending = { ref: null, scan: null };
        render();
      }
    });

    bindCanvas(refCanvas, 'ref');
    bindCanvas(scanCanvas, 'scan');
    render();
  }

  init();
})();
