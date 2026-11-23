#!/usr/bin/env node
/* ============================================================
   AI 动态看板 · 每日全流程（可脱离 WorkBuddy 独立运行）

   这个脚本把原来由 AI 助手人工判断的整条链路固化下来，任何一台
   常驻机器（macOS / Linux）都能用 cron 或 launchd 跑：

     1. 抓社区热帖（调用 fetch-community.mjs，约 4 分钟）
     2. 拉 AIHOT 当天日报，按铁律判断「今天到底该不该发」
     3. 判定通过才发飞书「周会同步」群，并做同日去重
     4. 有文件变化才 git commit + push

   核心原则（用户 2026-11-01 明确要求）：
   **没有真正的新内容就不发**。宁可不发，也不发一条没有信息量的消息。
   绝对不拿昨天的日报改个日期顶替。

   用法：
     node scripts/daily-report.mjs                 全流程（抓社区 + 发飞书 + 推送）
     node scripts/daily-report.mjs --dry           只判断和打印，不发不推不抓
     node scripts/daily-report.mjs --no-community  跳过社区抓取（省 4 分钟）
     node scripts/daily-report.mjs --no-push       改了文件但不推送

   退出码：
     0  正常（含「判定不该发」这种正常跳过）
     1  环境或依赖有问题（缺 node / lark-cli 未登录 / 网络全挂）
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DRY = process.argv.includes("--dry");
const NO_COMMUNITY = process.argv.includes("--no-community");
const NO_PUSH = process.argv.includes("--no-push");

const CHAT_ID = "oc_1881e7db8f3bf3d377624224fad9d1ea"; // 群名：周会同步
const BOARD = "https://tarma945-debug.github.io/ai-pulse/#/daily";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/* AIHOT 旧域名 aihot.virxact.com 已 301 到 aihot.news，且 301 响应 body 为空，
   不加 -L 会拿到空字符串。这里直接用新域名，也不省 -L。 */
const AIHOT = "https://aihot.news/api/v1";

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

/* ---------- 基础：今天（北京时间）---------- */
function todayCN() {
  const d = new Date(Date.now() + 8 * 3600e3);
  return d.toISOString().slice(0, 10);
}

/* ---------- 网络：curl ----------
   本机 curl 走代理需要显式 -x；Node 内置 fetch 不读 HTTP_PROXY。
   代理端口每次会变，所以先探测再决定。 */
let PROXY = null;

async function curl(url, { timeout = 25, proxy = PROXY } = {}) {
  const args = ["-sL", "--max-time", String(timeout), "-A", UA];
  if (proxy) args.push("-x", proxy);
  args.push(url);
  try {
    const { stdout } = await run("curl", args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    return "";
  }
}

async function probeProxy() {
  /* 环境变量里给了就直接用 */
  const envProxy = (process.env.HTTPS_PROXY || process.env.https_proxy || "").replace(/\/$/, "");
  const cands = [];
  if (envProxy) cands.push(envProxy);
  for (const p of [7897, 7890, 1087, 8118, 8119]) {
    cands.push(`http://127.0.0.1:${p}`);
  }
  /* 探针用 Google 204：只走代理可达、不限流、响应极小。
     别用 reddit 当探针——它限流返 429 时会被误判成「代理出不去」。 */
  for (const c of cands) {
    const code = await new Promise((res) => {
      const a = ["-s", "-o", "/dev/null", "--max-time", "8", "-x", c,
                 "-w", "%{http_code}", "https://www.google.com/generate_204"];
      execFile("curl", a, { timeout: 12000 }, (err, stdout) => res(stdout || ""));
    });
    if (["204", "200"].includes(String(code).trim())) return c;
  }
  return null;
}

/* ---------- AIHOT ---------- */
async function getDailies(limit = 3) {
  const raw = await curl(`${AIHOT}/dailies?limit=${limit}`);
  if (!raw) return [];
  try {
    const d = JSON.parse(raw);
    return d.items || d.dailies || d.data || [];
  } catch {
    return [];
  }
}

async function getDailyDetail(date) {
  const raw = await curl(`${AIHOT}/dailies/${date}`);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    /* ⚠️ 详情接口外面套了一层 report，正文在 report.sections。
       直接读顶层 sections 会拿到空数组，误判成「内容过薄」。 */
    return d.report || d;
  } catch {
    return null;
  }
}

/* ---------- 竞品 ---------- */
async function getCompetitorUpdates() {
  const raw = await curl("https://tarma945-debug.github.io/ai-video-watch/data.js", { proxy: null });
  if (!raw) return [];
  const i = raw.indexOf("{");
  const j = raw.lastIndexOf("}");
  if (i < 0 || j < 0) return [];
  try {
    const d = JSON.parse(raw.slice(i, j + 1));
    const names = new Map((d.competitors || []).map((c) => [c.id, c.name]));
    const today = todayCN();
    const yest = new Date(Date.now() + 8 * 3600e3 - 86400e3).toISOString().slice(0, 10);
    return (d.updates || [])
      .filter((u) => u.date === today || u.date === yest)
      /* 字段是 competitor（id），没有 site，要用 id→name 映射 */
      .map((u) => ({ date: u.date, site: names.get(u.competitor) || u.competitor, title: u.title }));
  } catch {
    return [];
  }
}

/* ---------- 飞书 ---------- */
async function lark(args, { timeout = 60000 } = {}) {
  try {
    const { stdout } = await run("lark-cli", args, { timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    return e.stdout || "";
  }
}

function parseJsonLoose(out) {
  const i = out.indexOf("{");
  if (i < 0) return null;
  for (let end = out.length; end > i; end--) {
    try { return JSON.parse(out.slice(i, end)); } catch { /* keep shrinking */ }
  }
  return null;
}

/* 同日去重：群里最后一条已经是今天的日报就不再发。
   用 +chat-messages-list（有序）；+messages-search 返回 20 条且不保证顺序。 */
async function alreadySentToday(today) {
  const out = await lark(["im", "+chat-messages-list", "--as", "user",
    "--chat-id", CHAT_ID, "--page-size", "5", "--order", "desc"]);
  const d = parseJsonLoose(out);
  const msgs = (d && d.data && d.data.messages) || [];
  return msgs.some((m) => (m.content || "").includes(`AI 动态日报 · ${today}`));
}

async function sendText(text) {
  const out = await lark(["im", "+messages-send", "--as", "user",
    "--chat-id", CHAT_ID, "--text", text]);
  const d = parseJsonLoose(out);
  if (!d) return { ok: false, reason: "返回里没有 JSON：" + out.slice(0, 200) };
  if (!d.ok) return { ok: false, reason: JSON.stringify(d).slice(0, 300) };
  return { ok: true, messageId: (d.data || {}).message_id };
}

/* ---------- 日报正文 ---------- */
function buildMessage(today, report, competitors, maxItems = 4) {
  const lead = report.lead || {};
  const sections = report.sections || [];
  const items = sections.flatMap((s) => s.items || []);

  /* 头条那条通常在 sections 里也有一份，跳过避免重复 */
  const cands = [];
  for (const it of items) {
    const t = (it.title || "").trim();
    if (!t) continue;
    if (lead.title && (t === lead.title || lead.title.includes(t.slice(0, 20)))) continue;
    if (cands.includes(t)) continue;
    cands.push(t);
  }
  const picked = cands.slice(0, maxItems);

  const lines = [`【AI 动态日报 · ${today}】`, ""];
  if (lead.title) lines.push("今日头条", `· ${lead.title}`, "");
  if (picked.length) {
    lines.push(`重点 ${picked.length} 条`, ...picked.map((t) => `· ${t}`), "");
  }
  if (competitors.length) {
    lines.push(`竞品动态（${competitors.length} 条）`,
      ...competitors.map((c) => `· ${c.site}（${c.date.slice(5)}）：${c.title}`), "");
  }
  lines.push(`完整看板 👉 ${BOARD}`);
  const text = lines.join("\n");

  /* 飞书超 1200 字符容易发失败，超了就逐条砍重点 */
  if (text.length > 1200 && picked.length > 2) {
    return buildMessage(today, report, competitors, maxItems - 1);
  }
  return text;
}

/* ---------- git ---------- */
async function gitPush(commitMsg) {
  const g = (args, opts = {}) =>
    run("git", args, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024, ...opts });

  const { stdout: status } = await g(["status", "--porcelain"]);
  if (!status.trim()) {
    log("· 没有文件变化，跳过提交");
    return false;
  }
  /* .workbuddy/ 已在 .gitignore，但 double check 防止误提交 */
  const staged = status.split("\n").filter((l) => l.includes(".workbuddy/"));
  if (staged.length) log(`⚠ 有 ${staged.length} 个 .workbuddy 文件被标记，检查 .gitignore`);

  await g(["add", "-A"]);
  await g(["-c", "user.name=Tarma", "-c", "user.email=491285547@qq.com",
           "commit", "-m", commitMsg]);

  if (NO_PUSH) { log("· --no-push，已提交未推送"); return true; }

  /* 代理不可用时硬写 -c http.proxy 会直接连不上，所以先探端口 */
  const useProxy = !!PROXY;
  const pushArgs = ["push", "origin", "main"];
  if (useProxy) pushArgs.unshift("-c", `http.proxy=${PROXY}`, "-c", "http.version=HTTP/1.1");
  try {
    await g(pushArgs, { timeout: 120000 });
    log(`· 已推送${useProxy ? `（经代理 ${PROXY}）` : "（直连）"}`);
    return true;
  } catch (e) {
    console.error("✗ 推送失败：", (e.stderr || e.message || "").slice(0, 400));
    return false;
  }
}

/* ---------- 主流程 ---------- */
async function main() {
  const today = todayCN();
  log(`=== ${today} 每日任务开始 ${DRY ? "（试跑）" : ""} ===`);

  PROXY = await probeProxy();
  log(`· 代理：${PROXY || "直连"}`);

  /* --- 1. 社区热帖 --- */
  if (!NO_COMMUNITY && !DRY) {
    log("· 抓社区热帖（约 4 分钟，别掐）…");
    await new Promise((res) => {
      const p = spawn(process.execPath, [path.join(__dirname, "fetch-community.mjs")],
        { cwd: ROOT, stdio: "inherit" });
      p.on("close", res);
    });
  }

  /* --- 2. AIHOT 判定 --- */
  const dailies = await getDailies(3);
  if (!dailies.length) fail("AIHOT 列表接口拿不到数据（网络或接口问题）");
  const latest = String(dailies[0].date || "").slice(0, 10);
  log(`· AIHOT 最新日报：${latest}`);

  let shouldSend = false;
  let reason = "";
  let report = null;

  if (latest !== today) {
    reason = `今天还没有新日报（最新是 ${latest}），群里不发`;
  } else {
    report = await getDailyDetail(latest);
    if (!report) {
      reason = "日报详情拉取失败，保守起见不发";
    } else {
      const sections = report.sections || [];
      const n = sections.reduce((a, s) => a + (s.items || []).length, 0);
      const flashes = (report.flashes || []).length;
      log(`· 今日正文 ${n} 条 / 快讯 ${flashes} 条`);
      if (n < 3) {
        /* ⚠️ highlights 不参与计数。规则只认 sections 的 items 累加。 */
        reason = `今天日报正文只有 ${n} 条，太薄，没发`;
      } else {
        shouldSend = true;
      }
    }
  }

  /* --- 3. 发飞书 --- */
  let messageId = null;
  let outcome;
  if (!shouldSend) {
    log(`⊘ ${reason}`);
    outcome = `未发｜${reason}`;
  } else if (DRY) {
    const text = buildMessage(today, report, await getCompetitorUpdates());
    log("—— 试跑，正文如下（未发送）——");
    log(text);
    log(`—— ${text.length} 字符 ——`);
    outcome = "试跑，未发送";
  } else if (await alreadySentToday(today)) {
    log(`⊘ 群里今天已发过（${today}），跳过避免重复`);
    outcome = "未发｜今天已发过，避免重复";
  } else {
    const competitors = await getCompetitorUpdates();
    const text = buildMessage(today, report, competitors);
    log(`· 正文 ${text.length} 字符，竞品 ${competitors.length} 条`);
    if (text.length > 1200) log("⚠ 正文超 1200 字符，可能发失败");
    const r = await sendText(text);
    if (r.ok) {
      messageId = r.messageId;
      log(`✓ 已发飞书 message_id=${messageId}`);
      outcome = `已发 ${messageId}`;
    } else {
      log(`✗ 发送失败：${r.reason}`);
      outcome = `发送失败｜${r.reason}`;
    }
  }

  /* --- 4. 提交推送 --- */
  if (!DRY) {
    const pushed = await gitPush(`每日更新：${today}`);
    log(pushed ? "· git 已处理" : "· git 无变化或未推送");
  }

  log(`=== 完成：${outcome} ===`);
}

main().catch((e) => fail(e.stack || String(e)));
