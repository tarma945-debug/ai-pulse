# 执行记录：AI 动态看板维护 + 飞书日报

## 关键踩坑（下次直接用）

1. **AIHOT 域名已迁移**：`aihot.virxact.com` 现在对 `/api/v1/*` 返回 **301** 跳到 `aihot.news`，
   且 301 响应 body 为空 —— 不加 `-L` 会拿到空字符串，看着像接口挂了。
   正确写法：`curl -sL -H "<Chrome UA>" "https://aihot.news/api/v1/dailies?limit=3"`。
2. **日报详情结构变了**：现在是 `{schemaVersion, report:{date, lead:{title,leadParagraph}, sections:[{label, items:[{title,summary,...}]}]}}`，
   不是旧的顶层 `sections`。lead 是 `lead.title` 不是 `lead.title` 之外的同级字段。
3. **竞品 data.js 结构**：`updates[]` 里字段是 `competitor`（站点 id，需用 `competitors[].id→name` 映射）+ `date` + `title`，
   **没有 `site` 字段**。排序后取最新 5 条。
4. `node --check` 只验语法；建议再 `node -e` 加载一遍校验字段完整性与 score 降序。

## 2026-11-01 执行结果

- 榜单：视频 15→16（新增腾讯混元 Hy-Nomas，世界模型类），图片维持 9；另更新 Seedance 2.5 / Kling 4.0 / Vidu Q4 / Flux 3 / Recraft V4 卖点，Kling 4.0 heat 97→98。commit `5977c87`，推送成功，线上 curl 200 且含新条目。
- 飞书：发送成功，message_id `om_x100b615db38ec0acce90e0add39480c`。
- 竞品：日报当日及前一日（10-31/11-01）无数据，按规则取最新 5 条并注明日期。
