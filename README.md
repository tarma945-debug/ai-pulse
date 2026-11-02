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

## 文件结构

```
index.html                页面骨架
styles.css                全部样式（CSS 变量控制主题）
app.js                    全部逻辑（路由 / 数据 / 渲染）
data.js                   本地模型榜单数据（手工维护）
community.js              社区热帖数据（脚本生成，勿手改）
scripts/fetch-community.mjs  社区热帖抓取脚本
```

## 部署

推送到 `main` 分支，GitHub Pages 自动发布（分支部署，非 Actions）。
