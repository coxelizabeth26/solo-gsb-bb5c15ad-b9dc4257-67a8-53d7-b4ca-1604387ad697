# 扫描印刷稿套色偏移校准工具

用于校准扫描印刷稿套色（Registration）偏移的 Web 应用。上传参考图与扫描图，成对标注控制点，系统以**仿射最小二乘拟合**求出扫描图 → 参考图的六参数变换，实时显示各点残差并标出最大异常点，叠加预览校准效果，并可导出矩阵与残差 JSON。

可切换**稳健模式**：按固定顺序评估有上限的非共线三点候选，以"内点数量优先、内点平方误差次之"选出模型，再对内点重新最小二乘拟合——自动剔除标错的控制点，外点不参与最终矩阵与 RMSE。

- 后端：Node.js + Express（静态托管 + `/api/fit` 拟合接口）
- 前端：原生 Canvas（无任何前端框架/构建步骤）
- 拟合计算在浏览器本地完成，图像不会上传服务器

## 快速开始

### 方式一：Docker（单条命令，含依赖安装与启动）

```bash
docker compose up --build
```

### 方式二：本地 Node.js（≥ 18）

```bash
npm install && npm start
```

### 访问地址

启动后在浏览器打开：**http://localhost:3000**（端口可通过环境变量 `PORT` 修改）

## 使用说明

1. **上传图像**：分别选择参考图与扫描图（或点击「载入示例图像」快速体验，示例内置已知偏移）。
2. **标注控制点**：在任意一幅图上点击开始一对点，再在另一幅图上点击对应位置完成配对；至少 **3 对**才能拟合，建议 4 对以上且点位尽量分散（残差才有统计意义，3 对时为精确解、残差恒为 0）。
3. **微调与删除**：拖动标记微调位置；右键标记或点击列表中的 ✕ 删除；`Esc` 取消未完成的半对点。任何点位变化都会**立即重算**。
4. **稳健模式（可选）**：勾选工具栏「稳健模式」并设置**容差**（参考图像素，默认 2 px）。残差不超过容差的点判为**内点**（绿色标记），其余为**外点**（橙色标记）；外点不参与最终矩阵与 RMSE。调整容差、拖动或删除点位都会同步重算。适合点对中存在个别标错位置的场景。
5. **查看结果**：右侧面板显示六参数矩阵与 RMSE（稳健模式下为内点 RMSE 及内点/总数）；残差表以「类型」列区分内外点，普通模式下**红色行**为最大残差点。控制点近共线（或重合）时拒绝计算并给出提示。
6. **叠加预览**：底部画布将扫描图按最终拟合矩阵变换后与参考图叠加，用透明度滑杆对比校准效果。
7. **导出**：可下载六参数矩阵 JSON（含行主序 3×3 形式）与逐点残差 JSON，两者与叠加预览使用**同一最终矩阵**，并记录各点的内/外点身份。拟合失败（如稳健模式下找不到至少三对非共线内点）时保留已标点对、显示原因并禁用导出。

## 拟合模型

求解六参数仿射变换，使所有控制点的残差平方和最小：

```
u = a·x + b·y + c
v = d·x + e·y + f        (x, y)：扫描图坐标 → (u, v)：参考图坐标
```

实现上先对坐标中心化，正规方程退化为两个 2×2 线性方程组，避免大坐标（高分辨率扫描）下的数值病态。近共线判定基于点集协方差矩阵最小/最大特征值之比（阈值 `1e-4`，见 `public/js/affine.js` 中 `COLLINEAR_RATIO`）。

### 稳健模式

`fitAffineRobust(src, dst, { tolerance, maxCandidates })`：

1. **候选评估**：按固定字典序遍历三点组合，跳过近共线候选，最多评估 `maxCandidates` 个（默认 `MAX_TRIPLE_CANDIDATES = 500`）。固定顺序 + 上限保证结果可复现，且点对增多时拖动实时重算不卡顿。
2. **模型选择**：每个候选由三点精确解出仿射矩阵，统计残差 ≤ 容差的内点；以**内点数量优先、内点平方误差次之**选出最优候选。
3. **重新拟合**：对最优候选的内点再做一次最小二乘拟合，得到最终矩阵；最终内/外点按最终矩阵残差与容差重新判定，**RMSE 仅统计内点**。
4. **失败情形**：找不到任何非共线三点候选（`NO_VALID_TRIPLE`），或容差内不足 3 对非共线内点（`NO_INLIERS`）时抛出错误，界面保留点对、说明原因并禁用导出。

## API

拟合逻辑（`public/js/affine.js`）在浏览器与 Node 间共用，服务器同时暴露接口供程序化调用：

```bash
curl -X POST http://localhost:3000/api/fit \
  -H 'Content-Type: application/json' \
  -d '{"src":[{"x":0,"y":0},{"x":100,"y":0},{"x":0,"y":100}],
       "dst":[{"x":15,"y":-20},{"x":117,"y":-19},{"x":14,"y":78}]}'
```

稳健模式：

```bash
curl -X POST http://localhost:3000/api/fit \
  -H 'Content-Type: application/json' \
  -d '{"src":[...], "dst":[...], "robust": true, "tolerance": 2}'
```

| 接口 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `POST /api/fit` | 仿射拟合。请求体 `{src, dst}` 为等长控制点数组（≥ 3）；可选 `robust`（默认 `false`）、`tolerance`（内点容差，参考图像素，默认 `2`）、`maxCandidates`（三点候选上限，默认 `500`）。成功返回 `{ok, matrix, residuals, rmse, maxIndex, pointCount, robust, inliers, inlierCount}`（稳健模式另含 `tolerance`、`candidatesEvaluated`、`truncated`）；参数非法 `400`，点数不足/近共线/内点不足 `422` |

## 导出文件格式

**affine-matrix.json**

```json
{
  "matrix": { "a": 1.0, "b": 0.0, "c": 0.0, "d": 0.0, "e": 1.0, "f": 0.0 },
  "matrixRowMajor": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  "robust": true,
  "tolerance": 2,
  "rmse": 0.123,
  "rmseScope": "inliers",
  "pointCount": 5,
  "inlierCount": 4,
  "inliers": [true, true, true, true, false]
}
```

**residuals.json**：`{ robust, tolerance, rmse, rmseScope, inlierCount, maxResidualIndex, points: [{ id, scan, ref, residualPx, isInlier, isMaxResidual }] }`

- `rmseScope`：`"all"`（普通模式，全部点）或 `"inliers"`（稳健模式，仅内点）。
- `inliers` / `isInlier` 记录各点内/外点身份，两种导出与叠加预览使用同一最终矩阵；普通模式下所有点均为内点。

## 项目结构

```
├── server.js              # Express 入口：静态托管 + /api/fit
├── public/
│   ├── index.html         # 页面
│   ├── css/style.css
│   └── js/
│       ├── affine.js      # 仿射最小二乘 + 稳健拟合（浏览器/Node 共用）
│       └── app.js         # 画布交互、实时重算、叠加预览、导出
├── test/
│   ├── affine.test.js     # 拟合数学单元测试（含稳健模式）
│   └── ui.smoke.js        # 前端全流程冒烟测试（DOM 桩）
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## 测试

```bash
npm test
```

覆盖：无噪声精确还原、含噪最小二乘逼近、点数不足/共线/重合/非法输入拒绝、大坐标数值稳定性；稳健模式的外点剔除、内点优先选模、候选上限截断、结果可复现、RMSE 仅统计内点；以及前端完整交互流程（打点→拟合→导出→删点→共线拒绝→稳健模式切换与容差调整）。

## 说明

- 更换任一图像会清空已有控制点（坐标随图像失效）。
- 画布按图像原始分辨率渲染、CSS 自适应缩放，点击坐标按缩放比换算回图像像素，保证取点精度。

