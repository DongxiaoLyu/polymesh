# PolyMesh — VEM Preprocessor（代码结构说明）

交互式二维网格生成工具（VEM/FEM 前处理）。这个版本把原来**单个 1600 行 HTML 文件**
里的内联脚本，拆分成了 10 个职责单一的小模块，并新增了**图片导入**功能
（上传手绘图 → 自动提取轮廓 → 生成网格）。原有绘制/网格功能与重构前**行为完全一致**
（由 smoke-test.js 逐字节对比验证）。

---

## 一、文件结构

```
index.html          页面骨架 + 样式 + 导入引导弹窗
index.original.html 重构前的原始文件备份（可删）
js/
  constants.js      所有可调参数 & 画布配色（改参数先看这里）
  geometry.js       向量运算 + 几何谓词（点在多边形内、线段求交、多边形简化、缩放居中）
  grid.js           三种背景网格生成（正方形/三角形/六边形）+ 网格吸附
  clipping.js       核心裁剪算法：凸单元 ∩ 多边形（边分裂 + 中点分类 + 环路组装）
  mesh.js           网格构建：单元分类、裁剪、节点去重合并、节点来源标记
  renderer.js       全部画布绘制（含 Path2D 缓存，拖拽时不重复描画静态网格）
  export.js         TXT 网格文件格式化（纯函数，易测试）
  demo.js           内置演示多边形数据（51 节点）
  image.js          图片导入：灰度/高斯模糊/Otsu 阈值/Marching Squares 轮廓/
                    自动识别实心或描边/RDP 化简/缩放居中（纯函数，易测试）
  app.js            控制器：应用状态、鼠标/键盘交互、数据管线、事件绑定
legacy-core.js      测试专用：从原始文件提取的旧算法（勿改，可删）
smoke-test.js       行为一致性测试（见下文「如何测试」）
dom-smoke.js        DOM 接线测试：用桩 DOM 启动 app.js，验证初始化与导入流程（见下文）
```

**加载顺序（index.html 中脚本标签的顺序）不能变**：每个文件依赖前一个文件暴露的模块。

```
constants → geometry → grid → clipping → mesh → renderer → export → demo → image → app
```

## 二、如何运行

直接用浏览器打开 `index.html` 即可（无需服务器）。所有 JS 文件必须和
`index.html` 放在**同一目录**（`js/` 子目录内），移动或重命名会导致页面空白。

## 三、模块之间的调用关系

`app.js` 是唯一的"指挥官"：它持有全部应用状态（`state` 对象）、操作 DOM、
把数据依次喂给各纯函数模块，最后交给 `renderer` 画出来。

```
用户操作 → app.js 更新 state
        → grid.js 生成背景网格
        → mesh.js（内部调用 clipping.js）构建网格
        → renderer.js 绘制
        → export.js 导出 TXT
```

每个模块的顶部注释都写明了「依赖什么、导出什么」。想改某个功能，先找到对应的文件：
- 改网格大小/采样参数/容差 → `constants.js`
- 改颜色 → `constants.js` 的 `COLORS`（另一部分是 index.html 里的 CSS 变量）
- 加一种新网格类型 → `grid.js`
- 改导出格式 / 缩放尺寸 → `export.js`（缩放尺寸 `EXPORT_FIT` 在 `constants.js`）
- 改图片导入（阈值、模糊、轮廓提取）→ `image.js`
- 改载荷/支撑（选择逻辑、弹窗）→ `app.js`（边界边提取在 `mesh.js` 的 `boundaryEdges`）
- 改交互（快捷键、画法、导入弹窗）→ `app.js`

**导出格式**：应用内部是屏幕坐标系（y 向下）；导出的 TXT 会把 Y 翻转成
**Y-UP 坐标系**（`y' = 画布高度 − y`），并**等比缩放到 100×100 框内**（保持纵横比、
居中，节点坐标全部落在 [0,100]²）。文件头保持简洁的 `# NODES (ID X Y)`；
用标准笛卡尔系（y 向上）的工具打开时，网格方向与屏幕绘制一致。
**单元统一按逆时针（CCW）顺序输出**（Y 翻转会镜像绕序，导出时反转节点顺序
恢复 CCW，保证求解器雅可比为正）。

## 四、边界条件（载荷与支撑）

网格生成后，点击顶栏 **Set BCs** 进入**边界条件阶段**（按钮变为 "Edit Mesh" 可返回）。
此阶段**网格被锁定**（网格类型、尺寸、绘制、Clear、Demo 等全部禁用），只能添加
载荷/支撑；网格参数一旦改动，条件会自动清空（节点编号会变）。

- **Point Load（点载荷）**：点选节点或拖拽框选多个节点 → Enter 确认 → 命名
  （默认 `Point_load_1`）+ 输入载荷向量 (fx, fy)——**有限元惯例：+X 向右、+Y 向上**，
  画布箭头按此方向显示，导出文件（Y-UP）也与此一致
- **Distributed Load（分布载荷）**：点选或框选**任意网格边**（边界边 + 内部边，
  如内部线载荷/接触分析；标准面力场景一般选边界边），命名（默认
  `Distributed_load_1`）+ 向量；向量按**单位长度载荷**理解
- **Support（支撑）**：点选/框选节点，命名（默认 `Support_1`）+ 类型
  **Fixed（固定）/ Hinge（铰）**
- 画布上按组着色显示标记（点载荷箭头、分布载荷沿边箭头、固定支撑三角、铰支撑圆环）；
  右下角面板列出所有条件组，可单独删除

**导出中的条件小节**（分组块格式，组名行带成员数，解析器按 数量→成员行→向量行 循环）：

```
# POINT LOADS (NAME COUNT | NODE LINES | FX FY)
Point_load_1 3
1
2
3
1000 0
# DISTRIBUTED LOADS (NAME COUNT | EDGE LINES N1 N2 | FX FY)
Distributed_load_1 2
3 4
7 8
500 866.025
# SUPPORTS (NAME TYPE COUNT | NODE LINES)
Support_1 fixed 2
6
7
```

所有节点/边编号与 NODES/ELEMENTS 小节一致（1-based）。

## 五、图片导入功能（Import）

点击顶栏 **Import** 按钮会弹出引导弹窗，说明支持的两种图片形式（弹窗里用
demo 图形分别画了"线条描边"和"实心填充"两个示例）。选择图片后自动处理：

```
图片 → 灰度化 → 高斯模糊降噪 → Otsu 自动阈值 → 二值化前景掩膜
     → Marching Squares 提取最大轮廓 → 自动判断"实心/描边"（填充率启发式）
     → RDP 化简（复用 geometry.js 的 rdpSimplify）→ 缩放居中 → 生成网格
```

- **自动判断**：实心图形（前景铺满轮廓内部）直接取外轮廓；描边线条取**线条环内部
  区域**的轮廓（更贴近手绘线）。识别结果会以 toast 提示（"Imported filled shape /
  stroke outline"）。
- **要求**：深色图形、浅色背景、轮廓闭合；图形大小建议占图片较小边 15% 以上
  （过小的噪点会被自动忽略）。
- 处理分辨率上限 1200px（超大图自动降采样），所有处理都在本地浏览器完成，图片不会上传。
- 已知特性：高斯模糊会把尖锐直角"切"掉 1-2px（抗锯齿副作用），对网格生成无实际影响。

## 五、本次重构修复的问题

| 问题 | 位置 | 处理 |
|------|------|------|
| CSS 笔误 `-sizing: border-box`（从未生效） | index.html | 改为 `box-sizing: border-box` |
| 双击闭合时会在闭合处多出一个冗余顶点 | app.js `onPointerDown` | 双击的第二下不再落点 |
| 每帧重建整张网格的 Path2D（大网格掉帧） | renderer.js | 缓存 Path2D，仅在数据变化时重建 |
| 拖拽窗口时 resize 每帧全量重算 | app.js `scheduleResize` | 合并到每帧一次 |
| Enter 键在按钮聚焦时会"重新点击按钮 + 闭合多边形"双触发 | app.js `onKeydown` | 抑制按钮原生重复触发 |
| `showToast` 用函数属性存定时器（hack） | app.js | 改为模块级变量 |
| 颜色在 CSS 与 JS 中重复硬编码 | constants.js | 统一收进 `COLORS` |

其余算法（裁剪、求交、网格构建等）逐行保留原样，行为完全一致。

## 六、如何测试

需要安装 [Node.js](https://nodejs.org/)。在项目目录运行：

```
node smoke-test.js    # 行为一致性：新旧实现输出逐字节对比 + 图像管线 + 边界边/条件导出
node dom-smoke.js     # DOM 接线：桩 DOM 启动 app.js，验证初始化/图片导入/边界条件全流程
```

`smoke-test.js` 用**同一组输入**分别驱动"新模块"和"从原始文件提取的旧算法
（legacy-core.js）"，逐一对比输出（网格的节点/单元/类型），全部一致才算通过；
图像部分用合成掩膜（实心矩形、描边圆环、噪点）验证轮廓提取与自动分类；
边界条件部分验证 `boundaryEdges`（仅被一个单元使用的边）与载荷/支撑导出格式。
`legacy-core.js` 是自动生成的测试基准，删掉后冒烟测试会跳过旧算法对比
（`demo` 网格那几项会报错，属正常）。

## 七、常见问题

- **页面空白 / 控制台报错**：检查 `js/` 目录是否与 `index.html` 同层、文件是否齐全、
  脚本标签顺序是否被打乱（见第一节）。
- **导入图片没反应**：确认图形是深色、背景是浅色、轮廓闭合；换一张更清晰的图试试。
- **条件组不见了**：网格参数（尺寸/类型）改动后节点重新编号，条件会自动清空——
  进入 BC 阶段后再添加条件，避免再改网格。
- **想还原成单文件**：直接用 `index.original.html`。
- **改了算法想确认没破坏行为**：跑 `node smoke-test.js` 和 `node dom-smoke.js`。
