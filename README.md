# AI 动态聚合 · 实时看板

一个纯前端（无后端）的 AI 资讯聚合看板，浅色主题 + 蓝紫主色 `#3D35F2`。
线上地址：https://tarma945-debug.github.io/ai-pulse/

## 数据来源

| 板块 | 数据源 | 获取方式 |
| --- | --- | --- |
| 精选 / 全部动态 / 热点榜 / 日报 | [AIHOT](https://aihot.news/) 公开只读 API | 浏览器运行时实时拉取，无需 Key |
| 竞品动态 | [ai-video-watch](https://tarma945-debug.github.io/ai-video-watch/) | 浏览器运行时抓取（26 家站点、234 条更新） |
| 社区热帖 | Reddit / Hacker News / Product Hunt / GitHub Trending | **本地定时抓取**，落到 `community.js` 后前端同源读取 |
| 模型榜单（视频 / 图片） | 本地 `data.js` | 静态数据，手工维护 |

### 为什么社区热帖要本地抓

Reddit 三道坎，浏览器端过不去：

1. 匿名 `.json` 接口返回 **403**（`You've been blocked by network security`），要求登录或 developer token
2. `reddit.com` **不发 CORS 头**，浏览器跨域必挂
3. 限流很凶，`top` 接口连发两个就 **429**

所以改成：`scripts/fetch-community.mjs` 定时抓 → 写入 `community.js` → 前端当同源静态文件读。

## 特色

- **9 个页面**：精选、全部动态、热点榜、社区热帖、日报、竞品动态、AI 模型总榜、视频模型榜、图片模型榜
- **链接可用**：每条资讯同时给「AIHOT 站内」和「原文」两个链接，点进去能看到正文
- **日报分双标签**：「AI 日报」和「竞品动态」分开看，不混排
- **社区多源筛选**：按来源（Reddit / HN / PH / GitHub）筛，Reddit 内还能按板块二级筛
- **双层缓存**：内存 + localStorage（5 分钟 TTL），请求去重，失败回退旧缓存并标记 stale
- **响应式**：PC 1440×900 与 390px 移动端都做过几何审计（无横向溢出、无文字裁切、点击区 ≥ 32px）

## 本地打开

```bash
# 建议起静态服务器，社区热帖读同源文件更稳
python3 -m http.server 8000
```

直接双击 `index.html` 也能看，但 `community.js` 在部分浏览器下会被 file:// 限制。

## 更新社区热帖

```bash
node scripts/fetch-community.mjs          # 抓取并写入 community.js
node scripts/fetch-community.mjs --dry    # 只看抓取结果，不写文件
```

脚本行为：

- 自动探测可用代理（会验证真实连通性，跳过「端口开着但出不去」的内部服务端口）
- Reddit 串行抓 + 限流退避，其余来源并行
- 某一源整轮失败时，**沿用上一份文件里该源的旧数据**，不会整块清空
- 输出按来源轮流打散，避免一屏全是同一家

耗时约 4 分钟（主要在等 Reddit 限流冷却），产出约 180 条。

## 每日全流程（可脱离 WorkBuddy 独立跑）

```bash
node scripts/daily-report.mjs                # 抓社区 → 判断日报 → 发飞书 → 推送
node scripts/daily-report.mjs --dry          # 只判断和打印正文，不发不推不抓
node scripts/daily-report.mjs --no-community # 跳过社区抓取（省 4 分钟）
node scripts/daily-report.mjs --no-push      # 改了但不推送
```

它固化了一条铁律：**没有真正的新内容就不发**。

- 最新日报 `date` 不是今天 → 不发，群保持安静
- 今天日报正文（`sections[].items` 累加）< 3 条 → 不发
- 群里今天已经发过 → 不发，避免重复
- 竞品动态只取今天/昨天，没有就不写这一段

> ⚠️ AIHOT 详情接口的正文在 `report.sections`，外面套了一层 `report`；
> 列表接口 `/dailies` 的 sections 永远是空的，必须拉 `/dailies/<date>` 详情。
> 另外 `highlights` 字段**不参与**正文条数计算，别拿它凑数。

## 换机器部署

代码和逻辑全在仓库里，任何一台常驻的 Mac / Linux 都能接手：

```bash
git clone https://github.com/tarma945-debug/ai-pulse.git
cd ai-pulse
bash scripts/setup-host.sh --dry    # 先体检：node / curl / git / lark-cli / 代理 / 出网
bash scripts/setup-host.sh          # 装好并注册定时任务（每天 10:00）
```

`setup-host.sh` 会自动判断系统：macOS 写 launchd plist，Linux 写 crontab。
日志落在仓库根目录 `daily.log`。

需要在目标机器上单独准备的两样东西（脚本会检查并提示）：

1. **lark-cli 登录态** —— 设备码授权，必须人工确认一次，无法复制粘贴
2. **git 推送凭据** —— 建议 `osxkeychain`（macOS）或 `git config credential.helper store`（Linux）

## 文件结构

```
index.html                页面骨架
styles.css                全部样式（CSS 变量控制主题）
app.js                    全部逻辑（路由 / 数据 / 渲染）
data.js                   本地模型榜单数据（手工维护）
community.js              社区热帖数据（脚本生成，勿手改）
scripts/fetch-community.mjs  社区热帖抓取脚本
scripts/daily-report.mjs     每日全流程（判断 + 发飞书 + 推送）
scripts/setup-host.sh        新机器一键部署
```


## 部署

推送到 `main` 分支，GitHub Pages 自动发布（分支部署，非 Actions）。
