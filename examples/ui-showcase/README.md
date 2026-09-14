# Token Studio 组件实验室

独立的交互选型样例，不修改主看板、不调用统计 API、不读取数据库、不调用模型。

## 本地运行

在此目录运行 `npm ci`，然后运行 `npm run dev`，访问 http://127.0.0.1:5174/ 。运行 `npm run build` 检查独立构建。

## 展示范围

| 名称 | 接入方式 | 验证边界 |
| --- | --- | --- |
| Bklit UI | 官方 registry 的 LineChart、RingChart 及相关源码 | 多环代表独立预算进度，不是来源份额饼图 |
| shadcn/ui | 官方 registry 的 ChartContainer / Tooltip + Recharts 3 | 样例布局为本项目编排，不是整站复制 |
| Tremor | @tremor/react 3.18.7 的 AreaChart / DonutChart | npm 版本依赖 Recharts 2，不能代表官网新版复制式组件 |
| NumberFlow | @number-flow/react 0.6.2 | 数字切换与位数变化 |
| Motion | motion 13.2.0 | 摘要展开和收起 |
| Tambo | 本地交互概念模拟 | 未安装 SDK、未调用模型，不用于判断框架真实表现 |
| CopilotKit | 本地交互概念模拟 | 未安装 SDK、未调用模型，不影响主看板 |

统一数据为内存中的虚构数组，日期、比例和摘要均为样例。收藏仅在当前页面状态保留。返回看板链接指向本机 5173 端口。

## 官方来源

- https://bklit.com/docs/installation
- https://ui.shadcn.com/docs/components/chart
- https://npm.tremor.so/docs/visualizations/area-chart
- https://number-flow.barvian.me/
- https://motion.dev/docs/react
- https://docs.tambo.co/
- https://docs.copilotkit.ai/concepts/generative-ui-overview

第三方源码通过官方 shadcn registry 安装；正式移植前需保留并核对各自许可证。独立依赖不会加入主项目 package.json。

## 本次验证与已知限制

- 已验证三家图表显示、样例切换、NumberFlow 数字更新、Motion 展开、候选清单和 AI 操作确认流程。
- 已检查桌面和 390px 手机布局，未见横向溢出。
- 修复 Bklit registry 在当前目录结构中的 shimmering-text 相对导入；适配 shadcn 的一处 Tailwind 4 变量类到本演示的 Tailwind 3。
- Bklit 当前 registry 使用 Visx 4 alpha 依赖；Tremor npm 版使用已停止维护的 Recharts 2。两者都需正式接入评估。
- 独立样例构建通过，生产依赖审计为 0 漏洞。多套库同屏使构建包约 1.58 MB（gzip 459 KB），有大包警告，不应直接整套搬入主看板。
- 热更新/尺寸变更期间观察到图表零尺寸警告；图表最终正常显示。修复演示入口重复创建 React Root 的热更新问题。
- 目前仅浅色样例，未做真实手机、跨浏览器、模型端到端或性能基准验收。
