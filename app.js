/* ============================================================
   AI 动态聚合 · 实时看板
   资讯 / 热点 / 日报：运行时读取 AIHOT 公开只读 API
   模型榜单 / 竞品监控：本地 data.js
   ============================================================ */
(function () {
  "use strict";

  var API = "https://aihot.virxact.com/api/v1";
  var COMPETITOR_URL = "https://tarma945-debug.github.io/ai-video-watch/data.js";
  var CACHE_TTL = 5 * 60 * 1000;      /* 5 分钟 */
  var LOCAL = window.SITE_DATA || {};
  var videoModels = LOCAL.videoModels || [];
  var imageModels = LOCAL.imageModels || [];

  /* 竞品监控数据（运行时从 ai-video-watch 拉取） */
  var COMP = { competitors: [], updates: [], updated: "", loaded: false, error: null };

  /* ------------------------------------------------------------
     小工具
     ------------------------------------------------------------ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  /* 转北京时间：10-30 15:46 */
  function bjTime(iso, withYear) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var p = {};
    try {
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
        day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
      }).formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    } catch (e) {
      return d.toISOString().slice(0, 16).replace("T", " ");
    }
    var hm = p.hour + ":" + p.minute;
    return withYear ? (p.year + "-" + p.month + "-" + p.day + " " + hm) : (p.month + "-" + p.day + " " + hm);
  }

  function bjHourMin(iso) {
    var t = bjTime(iso);
    return t.length >= 5 ? t.slice(-5) : "";
  }

  function relTime(iso) {
    if (!iso) return "";
    var d = new Date(iso).getTime();
    if (isNaN(d)) return "";
    var diff = Date.now() - d;
    if (diff < 0) return "刚刚";
    var m = Math.floor(diff / 60000);
    if (m < 1) return "刚刚";
    if (m < 60) return m + " 分钟前";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " 小时前";
    var day = Math.floor(h / 24);
    if (day < 8) return day + " 天前";
    return bjTime(iso);
  }

  /* 今天日期（北京时间） */
  function bjToday() {
    var p = {};
    try {
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    } catch (e) { /* ignore */ }
    return (p.year || "1970") + "-" + (p.month || "01") + "-" + (p.day || "01");
  }

  var WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  function weekdayOf(dateStr) {
    var d = new Date(dateStr + "T00:00:00+08:00");
    return isNaN(d.getTime()) ? "" : WEEKDAYS[d.getDay()];
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* ------------------------------------------------------------
     分类 / 文案
     ------------------------------------------------------------ */
  var CAT_META = {
    "ai-models": { label: "模型", chip: "模型" },
    "ai-products": { label: "产品", chip: "产品" },
    "industry": { label: "行业", chip: "行业" },
    "paper": { label: "论文", chip: "论文" },
    "tip": { label: "技巧与观点", chip: "技巧" }
  };
  function catChip(c) {
    var m = CAT_META[c];
    return m ? '<span class="chip tag-' + c + '">' + esc(m.chip) + "</span>" : "";
  }

  /* ------------------------------------------------------------
     数据层：带缓存的只读请求
     ------------------------------------------------------------ */
  var memCache = {};

  function cacheKey(path, params) {
    var q = Object.keys(params || {}).sort().map(function (k) { return k + "=" + params[k]; }).join("&");
    return "aihot:v1:" + path + (q ? "?" + q : "");
  }

  function readLS(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o !== "object") return null;
      return o;
    } catch (e) { return null; }
  }
  function writeLS(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 配额满就跳过 */ }
  }

  function buildURL(path, params) {
    var qs = Object.keys(params || {}).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    }).join("&");
    return API + path + (qs ? "?" + qs : "");
  }

  /**
   * 请求 AIHOT。命中 5 分钟内的缓存直接返回；失败时退回更旧的缓存并标记 stale。
   * 同一 URL 在飞行中只发一次，重复调用共享同一个 Promise。
   */
  var inflight = {};

  function apiGet(path, params) {
    var key = cacheKey(path, params);
    var now = Date.now();

    if (memCache[key] && now - memCache[key].t < CACHE_TTL) {
      return Promise.resolve({ data: memCache[key].d, stale: false, cached: true });
    }
    var ls = readLS(key);
    if (ls && ls.d && now - ls.t < CACHE_TTL) {
      memCache[key] = ls;
      return Promise.resolve({ data: ls.d, stale: false, cached: true });
    }
    if (inflight[key]) return inflight[key];

    inflight[key] = fetch(buildURL(path, params), {
      method: "GET",
      headers: { "Accept": "application/json" },
      cache: "no-store"
    }).then(function (r) {
      if (!r.ok) {
        var err = new Error("HTTP " + r.status);
        err.status = r.status;
        throw err;
      }
      return r.json();
    }).then(function (json) {
      memCache[key] = { t: Date.now(), d: json };
      writeLS(key, memCache[key]);
      delete inflight[key];
      return { data: json, stale: false, cached: false };
    }).catch(function (e) {
      delete inflight[key];
      /* 网络失败：退回旧缓存 */
      var old = memCache[key] || readLS(key);
      if (old && old.d) {
        memCache[key] = old;
        return { data: old.d, stale: true, cached: true, error: e };
      }
      throw e;
    });

    return inflight[key];
  }

  /* ------------------------------------------------------------
     竞品监控：从 ai-video-watch 拉 data.js 并解析成结构化数据
     ------------------------------------------------------------ */
  var compPromise = null;

  function parseCompetitorScript(src) {
    /* data.js 形如 window.COMPETITOR_DATA = {...};  用 Function 在沙箱对象里求值，避免污染全局 */
    var box = {};
    try {
      new Function("window", "var self=window;" + src + ";return window.COMPETITOR_DATA;")(box);
    } catch (e) {
      /* 兜底：截取第一个 { 到最后一个 } 做 JSON 宽松解析 */
      var a = src.indexOf("{"), b = src.lastIndexOf("}");
      if (a >= 0 && b > a) {
        try { box.COMPETITOR_DATA = JSON.parse(src.slice(a, b + 1)); } catch (e2) { throw new Error("竞品数据解析失败"); }
      } else {
        throw new Error("竞品数据格式不符");
      }
    }
    return box.COMPETITOR_DATA;
  }

  function loadCompetitors(force) {
    if (COMP.loaded && !force) return Promise.resolve(COMP);
    if (compPromise && !force) return compPromise;

    var cacheK = "comp:v1:" + COMPETITOR_URL;
    if (!force) {
      var hit = readLS(cacheK);
      if (hit && hit.d && Date.now() - hit.t < 30 * 60 * 1000) {
        applyComp(hit.d);
        return Promise.resolve(COMP);
      }
    }

    compPromise = fetch(COMPETITOR_URL + "?t=" + Math.floor(Date.now() / 300000), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (txt) {
        var raw = parseCompetitorScript(txt);
        if (!raw) throw new Error("竞品数据为空");
        applyComp(raw);
        writeLS(cacheK, { t: Date.now(), d: raw });
        compPromise = null;
        return COMP;
      })
      .catch(function (e) {
        compPromise = null;
        /* 退回本地缓存（哪怕过期） */
        var old = readLS(cacheK);
        if (old && old.d) { applyComp(old.d); COMP.error = e; return COMP; }
        COMP.error = e;
        COMP.loaded = true;
        return COMP;
      });

    return compPromise;
  }

  function applyComp(raw) {
    var comps = (raw.competitors || []).slice();
    var updates = (raw.updates || []).slice();
    /* 按竞品 id 建索引，日期倒序 */
    var byId = {};
    comps.forEach(function (c) {
      byId[c.id] = { id: c.id, name: c.name, url: c.url, desc: c.tagline || c.desc || "", updates: [] };
    });
    updates.forEach(function (u) {
      var cid = u.competitor || u.siteId || "";
      if (!byId[cid]) {
        byId[cid] = { id: cid, name: cid, url: "", desc: "", updates: [] };
      }
      byId[cid].updates.push({
        date: u.date || "",
        title: u.title || "",
        details: u.details || [],
        type: u.type || "",
        source: u.source || "",
        sourceName: u.sourceName || ""
      });
    });
    var list = Object.keys(byId).map(function (k) {
      var c = byId[k];
      c.updates.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
      return c;
    });
    /* 有动态的排前面，再按动态数降序 */
    list.sort(function (a, b) { return b.updates.length - a.updates.length; });

    COMP.competitors = list;
    COMP.updates = updates;
    COMP.updated = (raw.site && raw.site.updated) || "";
    COMP.loaded = true;
    COMP.error = null;
  }

  /* 取某个日期（或区间）的竞品动态 */
  function compUpdatesOn(date) {
    return COMP.updates.filter(function (u) { return u.date === date; });
  }
  function compUpdatesBetween(from, to) {
    return COMP.updates.filter(function (u) { return u.date >= from && u.date < to; });
  }
  function compName(id) {
    for (var i = 0; i < COMP.competitors.length; i++) {
      if (COMP.competitors[i].id === id) return COMP.competitors[i].name;
    }
    return id;
  }
  function compById(id) {
    for (var i = 0; i < COMP.competitors.length; i++) {
      if (COMP.competitors[i].id === id) return COMP.competitors[i];
    }
    return null;
  }

  /* ------------------------------------------------------------
     全局状态
     ------------------------------------------------------------ */
  var S = {
    cat: "featured",
    query: "",
    searchState: null,          /* {mode, items, q, loading, error} */
    selected: null,             /* items 24h selected */
    all: null,                  /* items 24h all */
    allCursor: null,
    allHasMore: false,
    hot: null,                  /* hot-topics */
    dailyIndex: null,           /* dailies 索引 */
    daily: {},                  /* date -> report */
    storyCache: {},
    stale: false,
    fetchedAt: "",
    booted: false,
    view: {
      allTag: "all",
      dailyDate: "",
      dailyTab: "ai",           /* ai | comp */
      calMonth: "",             /* YYYY-MM */
      siteId: "",
      modelNat: { models: "all", videoModels: "all", imageModels: "all" },
      modelType: { models: "all", videoModels: "all", imageModels: "all" }
    },
    token: 0
  };

  var PAGES = {
    featured:   { title: "精选", desc: "过去 24 小时 AI 圈最值得看的几条，按 AIHOT 编辑精选顺序", nav: "内容" },
    all:        { title: "全部动态", desc: "过去 24 小时全部公开动态，可按类型筛选、继续加载", nav: "内容" },
    hot:        { title: "热点榜", desc: "正在发酵的事件，按独立信源数与信号量排序", nav: "内容" },
    daily:      { title: "日报", desc: "AIHOT 每日成品日报：头条 + 分板块 + 快讯，可回看历史", nav: "内容" },
    models:     { title: "AI 模型总榜", desc: "视频与图片生成模型混合排名，支持类型与国产/开源叠加筛选", nav: "榜单" },
    videoModels:{ title: "视频模型榜", desc: "主流 AI 视频生成模型综合排名", nav: "榜单" },
    imageModels:{ title: "图片模型榜", desc: "主流 AI 图片生成模型综合排名", nav: "榜单" },
    videoSites: { title: "竞品动态", desc: "AI 视频创作站点功能更新时间线，数据来自你自己的 ai-video-watch 监控", nav: "内容" }
  };

  var NAV_ICONS = {
    featured: '<path d="M12 3l2.3 6.1L21 11l-6.7 1.9L12 19l-2.3-6.1L3 11l6.7-1.9z"/>',
    all: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    hot: '<path d="M12 3s4.5 4 4.5 8.2A4.5 4.5 0 0 1 12 21a4.5 4.5 0 0 1-4.5-9.8C9 9 12 6.5 12 3z"/>',
    daily: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
    models: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
    videoModels: '<rect x="3" y="6" width="12" height="12" rx="2.5"/><path d="M15 10l5-3v10l-5-3z"/>',
    imageModels: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l4.5-4.5 3.5 3.5L16 12l4 4"/>',
    videoSites: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 2.4 14.6 0 17M12 3.5c-2.4 2.4-2.4 14.6 0 17"/>'
  };

  /* ------------------------------------------------------------
     导航渲染
     ------------------------------------------------------------ */
  function navCount(id) {
    switch (id) {
      case "featured": return S.selected ? S.selected.length : 0;
      case "all": return S.all ? S.all.length : 0;
      case "hot": return S.hot ? S.hot.length : 0;
      case "daily": return S.dailyIndex ? S.dailyIndex.length : 0;
      case "models": return videoModels.length + imageModels.length;
      case "videoModels": return videoModels.length;
      case "imageModels": return imageModels.length;
      case "videoSites": return COMP.updates.length;
      default: return 0;
    }
  }

  function renderNav() {
    var order = ["featured", "all", "hot", "daily", "videoSites", "models", "videoModels", "imageModels"];
    var grouped = { "内容": [], "榜单": [] };
    order.forEach(function (id) {
      var m = PAGES[id];
      if (!m) return;
      (grouped[m.nav] || (grouped[m.nav] = [])).push(id);
    });

    var html = "";
    Object.keys(grouped).forEach(function (g) {
      html += '<div class="nav-group"><div class="nav-group-title">' + esc(g) + "</div>";
      grouped[g].forEach(function (id) {
        var n = navCount(id);
        html += '<div class="nav-item' + (S.cat === id ? " active" : "") + '" data-cat="' + id + '" role="button" tabindex="0">' +
          '<svg class="nav-ico" viewBox="0 0 24 24">' + (NAV_ICONS[id] || "") + "</svg>" +
          '<span class="nav-label">' + esc(PAGES[id].title) + "</span>" +
          (n ? '<span class="nav-count">' + n + "</span>" : "") +
          "</div>";
      });
      html += "</div>";
    });
    $("#navGroups").innerHTML = html;
  }

  /* ------------------------------------------------------------
     头部信息
     ------------------------------------------------------------ */
  function renderHeader() {
    var m = PAGES[S.cat] || { title: "—", desc: "" };
    if (S.cat === "search") m = { title: "搜索", desc: "在 AIHOT 中检索关键词" };
    $("#pageTitle").textContent = m.title;
    $("#pageDesc").textContent = m.desc;

    var parts = [];
    parts.push('<span class="meta-item">拉取于 ' + (S.fetchedAt ? bjTime(S.fetchedAt, true) : "--") + " 北京时间</span>");
    if (S.selected) parts.push('<span class="meta-sep"></span><span class="meta-item">' + S.selected.length + " 条精选</span>");
    if (S.hot) parts.push('<span class="meta-sep"></span><span class="meta-item">' + S.hot.length + " 个热点事件</span>");
    if (S.dailyIndex) parts.push('<span class="meta-sep"></span><span class="meta-item">日报可回看 ' + S.dailyIndex.length + " 天</span>");
    if (S.stale) parts.push('<span class="meta-sep"></span><span class="meta-item" style="color:var(--amber)">网络异常 · 显示缓存内容</span>');
    $("#metaStrip").innerHTML = parts.join("");
    document.title = m.title + " · AI 动态聚合";

    var sw = $("#searchWrap");
    sw.classList.toggle("has-value", !!$("#searchInput").value);
  }

  /* ------------------------------------------------------------
     骨架屏 / 错误块
     ------------------------------------------------------------ */
  function skeleton(n) {
    var rows = "";
    for (var i = 0; i < (n || 4); i++) {
      rows += '<div class="sk"><div class="sk-line w40"></div><div class="sk-line w92"></div>' +
        '<div class="sk-line w75"></div><div class="sk-line w62"></div></div>';
    }
    return '<div class="skeleton-list">' + rows + "</div>";
  }

  function errorBox(msg, retryCat) {
    return '<div class="err-box"><h3>数据没能拉下来</h3>' +
      "<p>" + esc(msg || "请检查网络后重试。") + "<br>" +
      "如果页面是直接双击打开的本地文件，部分浏览器会限制跨域请求，建议用本地服务器打开。</p>" +
      '<button class="retry" data-retry="' + esc(retryCat || S.cat) + '">重新加载</button></div>';
  }

  function emptyBox(title, sub) {
    return '<div class="empty"><span class="empty-ico">◇</span>' + esc(title) +
      (sub ? '<div class="empty-sub">' + esc(sub) + "</div>" : "") + "</div>";
  }

  /* ------------------------------------------------------------
     通用卡片
     ------------------------------------------------------------ */
  function newsCard(it, opts) {
    opts = opts || {};
    var aihot = (it.links && it.links.aihot) || "#";
    var orig = (it.links && it.links.original) || "";
    var t = it.publishedAt || it.discoveredAt;
    var timeLabel = it.publishedAt ? bjTime(it.publishedAt) : ("收录 " + bjTime(it.discoveredAt));
    var score = (typeof it.score === "number") ? it.score : null;

    var top = "";
    if (opts.rank) top += '<span class="chip chip-accent">#' + opts.rank + "</span>";
    top += catChip(it.category);
    if (score != null) top += '<span class="spacer"></span><span class="chip chip-score" title="AIHOT 综合评分">' + score + " 分</span>";

    return '<article class="news-card" data-open="' + esc(aihot) + '">' +
      '<div class="news-card-top">' + top + "</div>" +
      "<h3><a href=\"" + esc(aihot) + '" target="_blank" rel="noopener">' + esc(it.title) + "</a></h3>" +
      (it.summary ? '<p class="summary">' + esc(it.summary) + "</p>" : "") +
      '<div class="news-card-meta">' +
        '<span class="src">' + esc((it.source && it.source.name) || "AIHOT") + "</span>" +
        '<span class="dot">·</span><span>' + esc(timeLabel) + "</span>" +
        (orig ? '<a class="go" href="' + esc(orig) + '" target="_blank" rel="noopener">原文 ↗</a>' : "") +
      "</div>" +
    "</article>";
  }

  /* ------------------------------------------------------------
     页面：精选
     ------------------------------------------------------------ */
  function pageFeatured() {
    var list = S.selected || [];
    if (!list.length) return emptyBox("过去 24 小时暂无精选", "稍后再来看看，或先翻「全部动态」。");

    var hero = list[0];
    var rest = list.slice(1);
    var hot = (S.hot || []).slice(0, 6);

    var heroHtml = '<section class="feature-card">' +
      '<div class="feature-main">' +
        '<div class="feature-eyebrow"><span class="live-dot"></span>今日头条</div>' +
        "<h2><a href=\"" + esc((hero.links && hero.links.aihot) || "#") + '" target="_blank" rel="noopener">' + esc(hero.title) + "</a></h2>" +
        (hero.summary ? '<p class="summary">' + esc(hero.summary) + "</p>" : "") +
        '<div class="feature-foot">' +
          catChip(hero.category) +
          '<span class="src" style="font-weight:600;color:var(--text-3)">' + esc((hero.source && hero.source.name) || "AIHOT") + "</span>" +
          '<span>' + esc(hero.publishedAt ? bjTime(hero.publishedAt) : "收录 " + bjTime(hero.discoveredAt)) + "</span>" +
          '<a class="btn-primary" style="margin-left:auto" href="' + esc((hero.links && hero.links.aihot) || "#") + '" target="_blank" rel="noopener">阅读全文 ↗</a>' +
        "</div>" +
      "</div>" +
      '<aside class="feature-side">' +
        '<div class="feature-side-title">热度 TOP ' + hot.length + "</div>" +
        (hot.length ? hot.map(function (h, i) {
          return '<div class="mini-row"><span class="rn">' + pad(i + 1) + "</span>" +
            '<a href="' + esc((h.links && h.links.aihot) || "#") + '" target="_blank" rel="noopener">' + esc(h.title) +
            '<span class="mini-meta">' + (h.sourceCount || 0) + " 个信源 · " + esc(relTime(h.latestAt)) + "</span></a></div>";
        }).join("") : '<div style="font-size:12px;color:var(--text-4)">热点数据未加载</div>') +
      "</aside>" +
    "</section>";

    var restHtml = rest.length
      ? '<div class="section-head"><h2>还有这些</h2><span class="count">' + rest.length + " 条</span><span class=\"line\"></span></div>" +
        '<div class="news-list">' + rest.map(function (it, i) { return newsCard(it, { rank: i + 2 }); }).join("") + "</div>"
      : "";

    return heroHtml + restHtml;
  }

  /* ------------------------------------------------------------
     页面：全部动态
     ------------------------------------------------------------ */
  function pageAll() {
    var list = S.all || [];
    if (!list.length) return emptyBox("过去 24 小时暂无公开动态");

    var tags = [
      ["all", "全部"], ["ai-models", "模型"], ["ai-products", "产品"],
      ["industry", "行业"], ["paper", "论文"], ["tip", "技巧与观点"]
    ];
    var cur = S.view.allTag;
    var filtered = cur === "all" ? list : list.filter(function (it) { return it.category === cur; });

    var bar = '<div class="filter-bar">' + tags.map(function (t) {
      return '<button type="button" class="filter-btn' + (cur === t[0] ? " active" : "") + '" data-alltag="' + t[0] + '">' + t[1] + "</button>";
    }).join("") + '<span class="filter-hint">共 ' + filtered.length + " 条</span></div>";

    var body = filtered.length
      ? '<div class="news-list">' + filtered.map(function (it) { return newsCard(it); }).join("") + "</div>"
      : emptyBox("这个类型下暂无动态", "换个类型试试");

    var more = "";
    if (S.allHasMore) {
      more = '<div style="text-align:center;margin-top:18px">' +
        '<button class="filter-btn" id="loadMoreBtn" style="padding:8px 26px">加载更多</button></div>';
    }
    return bar + body + more;
  }

  /* ------------------------------------------------------------
     页面：热点榜
     ------------------------------------------------------------ */
  function pageHot() {
    var list = S.hot || [];
    if (!list.length) return emptyBox("当前没有热点事件");

    var maxSig = 1;
    list.forEach(function (h) { maxSig = Math.max(maxSig, h.signalCount || 0); });

    return '<div class="hot-list">' + list.map(function (h, i) {
      var pct = Math.max(6, Math.round(((h.signalCount || 0) / maxSig) * 100));
      var storyId = storyPublicId(h);
      return '<div class="hot-row">' +
        '<div class="hot-rank' + (i < 3 ? " top" + (i + 1) : "") + '">' + pad(h.rank || i + 1) + "</div>" +
        '<div class="hot-body">' +
          "<h3><a href=\"" + esc((h.links && h.links.aihot) || "#") + '" target="_blank" rel="noopener">' + esc(h.title) + "</a></h3>" +
          '<div class="hot-signals">' +
            "<span>" + esc((h.source && h.source.name) || "") + "</span>" +
            "<span>·</span><span>" + (h.sourceCount || 0) + " 个信源</span>" +
            "<span>·</span><span>" + (h.signalCount || 0) + " 个信号</span>" +
            "<span>·</span><span>" + esc(relTime(h.latestAt)) + "更新</span>" +
            (storyId ? '<button type="button" class="hot-story" data-story="' + esc(storyId) + '">事件时间线 ›</button>' : "") +
          "</div>" +
          '<div class="hot-bar"><i style="width:' + pct + '%"></i></div>' +
        "</div>" +
      "</div>";
    }).join("") + "</div>";
  }

  function storyPublicId(h) {
    var u = h && h.links && h.links.story;
    if (!u) return "";
    var m = String(u).match(/\/story\/([A-Za-z0-9-]+)\/?$/);
    return m ? m[1] : "";
  }

  /* ------------------------------------------------------------
     页面：日报
     ------------------------------------------------------------ */
  function dailyDates() {
    return (S.dailyIndex || []).map(function (x) { return x.date; });
  }

  function pageDaily() {
    var dates = dailyDates();
    if (!dates.length) return emptyBox("暂无日报", "AIHOT 日报尚未发布");

    if (!S.view.dailyDate || dates.indexOf(S.view.dailyDate) < 0) S.view.dailyDate = dates[0];
    var cur = S.view.dailyDate;
    var tab = S.view.dailyTab === "comp" ? "comp" : "ai";
    var rep = S.daily[cur];

    var cal = renderCalendar(dates, cur);
    var compCount = dailyCompCount(cur);
    var tabs = '<div class="daily-tabs">' +
      '<button type="button" class="daily-tab' + (tab === "ai" ? " active" : "") + '" data-dtab="ai">' +
        '<span class="dt-ico">◆</span>AI 日报' +
        (rep ? '<span class="dt-n">' + ((rep.sections || []).reduce(function (a, s) { return a + (s.items || []).length; }, 0)) + "</span>" : "") +
      "</button>" +
      '<button type="button" class="daily-tab' + (tab === "comp" ? " active" : "") + '" data-dtab="comp">' +
        '<span class="dt-ico">◇</span>竞品动态' +
        (compCount ? '<span class="dt-n">' + compCount + "</span>" : "") +
      "</button>" +
    "</div>";

    var body;
    if (tab === "comp") {
      body = renderDailyComp(cur);
    } else if (!rep) {
      body = S.dailyLoading === cur ? skeleton(3) : emptyBox("日报加载中…");
    } else {
      body = renderReport(rep, dates);
    }

    return '<div class="daily-layout">' + cal + '<div class="daily-main">' + tabs + body + "</div></div>";
  }

  /* 某天（含回退的近 7 天）有多少条竞品动态，用于标签上的数字 */
  function dailyCompCount(date) {
    var got = dailyCompWindow(date);
    return got ? got.ups.length : 0;
  }

  /* 计算某天的竞品窗口：优先当天；不足 3 条回退近 7 天。返回 {from,to,ups,fallback} */
  function dailyCompWindow(date) {
    if (!COMP.loaded || !COMP.updates.length) return null;

    var toDay = date;
    var byDate = function (u) { return u.date && u.date === toDay; };
    var ups = COMP.updates.filter(byDate).sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });

    if (ups.length >= 3) return { from: toDay, to: toDay, ups: ups, fallback: false };

    /* 回退：截至当天为止的最近 10 条（不超过 7 天） */
    var endMs = new Date(date + "T23:59:59+08:00").getTime();
    var backMs = endMs - 7 * 24 * 3600 * 1000;
    var backDay = dayOfMs(backMs);
    var week = COMP.updates.filter(function (u) {
      return u.date && u.date <= toDay && u.date >= backDay;
    }).sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    }).slice(0, 10);

    if (week.length > ups.length) return { from: backDay, to: toDay, ups: week, fallback: true };
    return { from: toDay, to: toDay, ups: ups, fallback: false };
  }

  function dayOfMs(ms) {
    var p = {};
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    } catch (e) { return ""; }
    return (p.year || "") + "-" + (p.month || "") + "-" + (p.day || "");
  }

  function renderCalendar(dates, cur) {
    var set = {};
    dates.forEach(function (d) { set[d] = 1; });

    var today = bjToday();
    var month = S.view.calMonth;
    if (!month) month = cur.slice(0, 7);
    var parts = month.split("-");
    var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);

    var first = new Date(Date.UTC(y, m - 1, 1));
    var startWeekday = first.getUTCDay();
    var daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

    var cells = "";
    ["日", "一", "二", "三", "四", "五", "六"].forEach(function (w) {
      cells += '<div class="cal-wd">' + w + "</div>";
    });
    for (var i = 0; i < startWeekday; i++) cells += "<div></div>";
    for (var d = 1; d <= daysInMonth; d++) {
      var ds = y + "-" + pad(m) + "-" + pad(d);
      var cls = "cal-day";
      if (set[ds]) cls += " has";
      if (ds === cur) cls += " sel";
      if (ds === today) cls += " today";
      cells += set[ds]
        ? '<button type="button" class="' + cls + '" data-date="' + ds + '">' + d + "</button>"
        : '<div class="' + cls + '">' + d + "</div>";
    }

    var firstDate = dates[dates.length - 1];
    var lastDate = dates[0];
    var prevMonth = new Date(Date.UTC(y, m - 2, 1));
    var nextMonth = new Date(Date.UTC(y, m, 1));
    var prevKey = prevMonth.getUTCFullYear() + "-" + pad(prevMonth.getUTCMonth() + 1);
    var nextKey = nextMonth.getUTCFullYear() + "-" + pad(nextMonth.getUTCMonth() + 1);
    var canPrev = prevKey >= firstDate.slice(0, 7);
    var canNext = nextKey <= lastDate.slice(0, 7);

    var recent = dates.slice(0, 6).map(function (d) {
      var p = d.split("-");
      return '<button type="button" data-date="' + d + '"' + (d === cur ? ' class="active"' : "") + ">" +
        "<span>" + p[1] + "-" + p[2] + "</span><span style=\"font-size:10.5px;color:var(--text-4)\">" + weekdayOf(d) + "</span></button>";
    }).join("");

    return '<aside class="cal-panel">' +
      '<div class="cal-head">' +
        '<div class="cal-month">' + y + " 年 " + m + " 月</div>" +
        '<div class="cal-nav">' +
          '<button type="button" data-cal="' + prevKey + '"' + (canPrev ? "" : " disabled") + ' aria-label="上个月">‹</button>' +
          '<button type="button" data-cal="' + nextKey + '"' + (canNext ? "" : " disabled") + ' aria-label="下个月">›</button>' +
        "</div>" +
      "</div>" +
      '<div class="cal-grid">' + cells + "</div>" +
      '<div class="cal-empty">共 ' + dates.length + " 天有日报 · 灰点为可看日期</div>" +
      '<div class="cal-quick"><div class="cal-quick-title">最近</div>' + recent + "</div>" +
    "</aside>";
  }

  function renderReport(rep, dates) {
    var idx = dates.indexOf(rep.date);
    var newer = idx > 0 ? dates[idx - 1] : "";
    var older = idx >= 0 && idx < dates.length - 1 ? dates[idx + 1] : "";
    var lead = rep.lead || {};
    var leadLink = (rep.links && rep.links.aihot) || "";

    var head = '<div class="daily-head">' +
      '<div><span class="daily-date-big">' + esc(rep.date) + "</span> " +
        '<span class="daily-weekday">' + weekdayOf(rep.date) + "</span></div>" +
      '<div class="daily-jump">' +
        '<button type="button" data-date="' + esc(newer || "") + '"' + (newer ? "" : " disabled") + ">← 更近</button>" +
        '<button type="button" data-date="' + esc(older || "") + '"' + (older ? "" : " disabled") + ">更早 →</button>" +
      "</div>" +
    "</div>";

    var leadHtml = (lead.title)
      ? '<section class="lead-card">' +
          '<div class="lead-label">当日头条</div>' +
          "<h2>" + (leadLink ? '<a href="' + esc(leadLink) + '" target="_blank" rel="noopener">' + esc(lead.title) + "</a>" : esc(lead.title)) + "</h2>" +
          (lead.leadParagraph ? "<p>" + esc(lead.leadParagraph) + "</p>" : "") +
          '<div class="lead-foot"><span>' + esc(rep.windowStart ? bjTime(rep.windowStart, true) : "") + " 起 24 小时</span>" +
          (leadLink ? '<a class="big-link" href="' + esc(leadLink) + '" target="_blank" rel="noopener">查看全文 ↗</a>' : "") +
          "</div>" +
        "</section>"
      : "";

    var sections = (rep.sections || []).map(function (sec) {
      var items = sec.items || [];
      if (!items.length) return "";
      return '<section class="dsec">' +
        '<div class="dsec-head"><h3>' + esc(sec.label || "") + '</h3><span class="n">' + items.length + "</span></div>" +
        '<div class="dsec-items">' + items.map(function (it) {
          var l = (it.links && it.links.aihot) || (it.links && it.links.original) || "";
          var o = (it.links && it.links.original) || "";
          return '<div class="ditem">' +
            "<h4>" + (l ? '<a href="' + esc(l) + '" target="_blank" rel="noopener">' + esc(it.title) + "</a>" : esc(it.title)) + "</h4>" +
            (it.summary ? "<p>" + esc(it.summary) + "</p>" : "") +
            '<div class="ditem-meta"><span>' + esc((it.source && it.source.name) || "") + "</span>" +
              (o ? '<a class="lnk" href="' + esc(o) + '" target="_blank" rel="noopener">原文 ↗</a>' : "") +
            "</div>" +
          "</div>";
        }).join("") + "</div></section>";
    }).join("");

    var flashes = (rep.flashes || []);
    var flashHtml = flashes.length
      ? '<section class="dsec"><div class="dsec-head"><h3>快讯</h3><span class="n">' + flashes.length + "</span></div>" +
        '<div class="flashes">' + flashes.map(function (f) {
          var l = (f.links && f.links.aihot) || (f.links && f.links.original) || "";
          return '<div class="flash-row"><span class="t">' + esc(bjHourMin(f.publishedAt)) + "</span>" +
            '<span class="b">' + (l ? '<a href="' + esc(l) + '" target="_blank" rel="noopener">' + esc(f.title) + "</a>" : esc(f.title)) +
            '<span class="s">' + esc((f.source && f.source.name) || "") + "</span></span></div>";
        }).join("") + "</div></section>"
      : "";

    return head + leadHtml + sections + flashHtml;
  }

  /* 日报「竞品动态」独立标签页：不再混在 AI 日报里 */
  function renderDailyComp(date) {
    var got = dailyCompWindow(date);

    if (!COMP.loaded) return skeleton(4);
    if (COMP.error && !COMP.updates.length) {
      return errorBox("竞品数据拉取失败：" + COMP.error.message + "（来源 ai-video-watch）", "daily");
    }
    if (!got || !got.ups.length) {
      return '<div class="dcomp-head"><h3>竞品动态</h3></div>' +
        emptyBox("这一天没有任何竞品更新", "换个日期看看，或去「竞品动态」看完整时间线");
    }

    var ups = got.ups;

    /* 按站点分组，组内按日期倒序 */
    var bySite = {};
    ups.forEach(function (u) {
      var k = u.competitor || u.siteId || "其他";
      (bySite[k] = bySite[k] || []).push(u);
    });
    var order = Object.keys(bySite).sort(function (x, y) { return bySite[y].length - bySite[x].length; });

    var groups = order.map(function (k) {
      var arr = bySite[k];
      return '<div class="dc-group">' +
        '<div class="dc-site">' + esc(compName(k)) + '<span class="dc-n">' + arr.length + "</span></div>" +
        arr.map(function (u) {
          var src = u.source
            ? '<a class="lnk" href="' + esc(u.source) + '" target="_blank" rel="noopener">' + esc(u.sourceName || "原文") + " ↗</a>"
            : "";
          var more = (u.details && u.details.length > 1)
            ? '<ul class="dc-more">' + u.details.slice(1).map(function (d) { return "<li>" + esc(d) + "</li>"; }).join("") + "</ul>"
            : "";
          return '<div class="dc-item">' +
            "<h5>" + esc(u.title) + "</h5>" +
            (u.details && u.details.length ? "<p>" + esc(u.details[0]) + "</p>" : "") +
            more +
            '<div class="dc-meta"><span class="upd-date">' + esc(u.date) + "</span>" +
              (u.type ? '<span class="chip chip-gray" style="font-size:10.5px;padding:0 6px">' + esc(u.type) + "</span>" : "") +
              src +
            "</div>" +
          "</div>";
        }).join("") +
      "</div>";
    }).join("");

    var rangeText = got.fallback
      ? "近 7 天精选 · 截至 " + got.to
      : got.from;
    var siteCount = order.length;

    var head = '<div class="dcomp-head">' +
      "<h3>竞品动态</h3>" +
      '<span class="dcomp-n">' + ups.length + " 条 · " + siteCount + " 个站点</span>" +
      '<span class="dcomp-src">来自 ai-video-watch · ' + esc(rangeText) + "</span>" +
      '<a class="dcomp-link" href="#/videoSites">看完整时间线 →</a>' +
    "</div>";

    if (got.fallback) {
      head += '<div class="dcomp-note">当天更新的竞品不足 3 条，已自动扩展为近 7 天精选，避免这一天空白。</div>';
    }

    return head + '<div class="dc-wrap">' + groups + "</div>";
  }

  /* ------------------------------------------------------------
     页面：模型榜单
     ------------------------------------------------------------ */
  var TYPE_OPTIONS = {
    models: [["all", "全部"], ["video", "视频模型"], ["image", "图片模型"]],
    videoModels: [["all", "全部"], ["文生视频", "文生视频"], ["图生视频", "图生视频"], ["视频编辑", "视频编辑"], ["世界模型", "世界模型"]],
    imageModels: [["all", "全部"], ["文生图", "文生图"], ["图生图", "图生图"], ["图像编辑", "图像编辑"]]
  };

  var DOT_COLORS = ["#3D35F2", "#7C6CF5", "#0E9F6E", "#F2721E", "#E02424", "#0EA5B7", "#D6336C", "#B45309", "#5A54C8", "#0891B2"];
  function vendorColor(v) {
    var s = String(v || ""), h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return DOT_COLORS[h % DOT_COLORS.length];
  }
  function vendorInitial(v) {
    var t = String(v || "").trim();
    if (!t) return "?";
    return /[\u4e00-\u9fa5]/.test(t[0]) ? t[0] : t[0].toUpperCase();
  }
  function modelTypeOf(m) { return m.category || m.type || ""; }
  function modelScore(m) { return typeof m.score === "number" ? m.score : (m.heat || 0); }

  function priceCell(m) {
    var i = m.inputPrice, o = m.outputPrice;
    if (i === "待评估" && o === "待评估") return '<span class="td-na">待评估</span>';
    if (i === "待评估") return '输入 <span class="td-na">待评估</span> / 输出 ' + esc(o);
    if (o === "待评估") return "输入 " + esc(i) + ' / 输出 <span class="td-na">待评估</span>';
    return "输入 " + esc(i) + " / 输出 " + esc(o);
  }

  function pageModels(key, list) {
    var nat = S.view.modelNat[key] || "all";
    var typ = S.view.modelType[key] || "all";
    var out = list.slice();

    if (typ === "video") out = out.filter(function (m) { return modelTypeOf(m) === "视频" || String(m.type || "").indexOf("视频") >= 0; });
    else if (typ === "image") out = out.filter(function (m) { return modelTypeOf(m) === "图片" || String(m.type || "").indexOf("图片") >= 0; });
    else if (typ !== "all") out = out.filter(function (m) { return modelTypeOf(m) === typ; });

    if (nat === "domestic") out = out.filter(function (m) { return m.isDomestic; });
    if (nat === "open") out = out.filter(function (m) { return m.isOpenSource; });

    out.sort(function (a, b) { return modelScore(b) - modelScore(a); });

    if (!out.length) return emptyBox("这个筛选组合下没有模型", "换一组条件试试");

    var bar = '<div class="filter-bar">' +
      (TYPE_OPTIONS[key] || [["all", "全部"]]).map(function (b) {
        return '<button type="button" class="filter-btn' + (typ === b[0] ? " active" : "") +
          '" data-mtype="' + esc(b[0]) + '" data-key="' + esc(key) + '">' + esc(b[1]) + "</button>";
      }).join("") +
      '<span class="filter-sep"></span>' +
      [["all", "全部"], ["domestic", "国产"], ["open", "开源"]].map(function (b) {
        return '<button type="button" class="filter-btn' + (nat === b[0] ? " active" : "") +
          '" data-mnat="' + esc(b[0]) + '" data-key="' + esc(key) + '">' + esc(b[1]) + "</button>";
      }).join("") +
      '<span class="filter-hint">按综合得分降序 · ' + out.length + " 个模型</span></div>";

    var rows = out.map(function (m, i) {
      var flags = "";
      if (m.isDomestic) flags += '<span class="flag dom">国产</span>';
      if (m.isOpenSource) flags += '<span class="flag oss">开源</span>';
      var ev = (m.evalCount != null)
        ? esc(m.evalCount) + ' 项<span class="td-na"> / ' + esc(m.evalRatio) + "%</span>"
        : '<span class="td-na">待评估</span>';
      return "<tr>" +
        '<td class="rk' + (i < 3 ? " t" + (i + 1) : "") + '">' + pad(i + 1) + "</td>" +
        '<td><div class="model-cell">' +
          '<span class="vdot" style="background:' + vendorColor(m.vendor) + '">' + esc(vendorInitial(m.vendor)) + "</span>" +
          "<div><div class=\"model-name\">" + esc(m.name) + '</div><div class="model-vendor">' + esc(m.vendor) + "</div>" +
          (flags ? '<div class="model-flag">' + flags + "</div>" : "") +
        "</div></div></td>" +
        '<td class="td-dim">' + esc(m.launchDate || "—") + "</td>" +
        '<td class="td-dim">' + ev + "</td>" +
        '<td class="td-dim">' + priceCell(m) + "</td>" +
        '<td class="score-cell">' + Number(modelScore(m)).toFixed(1) + "</td>" +
      "</tr>";
    }).join("");

    return bar + '<div class="table-wrap"><div class="tbl-scroll"><table class="rank">' +
      "<thead><tr><th class=\"r\">排名</th><th>模型</th><th>上线</th><th>评测量</th><th>价格（¥/万 tokens）</th><th class=\"r\">综合得分</th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table></div>" +
      '<div class="tbl-hint">← 左右滑动查看完整指标 →</div></div>';
  }

  /* ------------------------------------------------------------
     页面：竞品动态
     ------------------------------------------------------------ */
  function pageSites() {
    if (!COMP.loaded) return skeleton(4);
    if (COMP.error && !COMP.updates.length) {
      return errorBox("竞品数据拉取失败：" + COMP.error.message + "（来源 ai-video-watch）", "videoSites");
    }
    if (!COMP.competitors.length) return emptyBox("暂无竞品数据", "来源：tarma945-debug.github.io/ai-video-watch");

    var sites = COMP.competitors;
    var totalUpdates = COMP.updates.length;

    var picked = S.view.siteId || "all";   /* 默认全部 */
    if (picked !== "all" && !compById(picked)) picked = "all";
    S.view.siteId = picked;

    /* 站点胶囊：全部 + 有动态的站点 */
    var pills = '<div class="site-bar">' +
      '<button type="button" class="site-pill' + (picked === "all" ? " active" : "") + '" data-site="all">' +
        '全部<span class="sp-n">' + totalUpdates + "</span></button>" +
      sites.filter(function (s) { return s.updates.length; }).map(function (s) {
        return '<button type="button" class="site-pill' + (picked === s.id ? " active" : "") + '" data-site="' + esc(s.id) + '">' +
          esc(s.name) + '<span class="sp-n">' + s.updates.length + "</span></button>";
      }).join("") +
    "</div>";

    if (picked === "all") {
      /* 全部动态：按日期倒序平铺，每天一个分组 */
      var byDate = {};
      COMP.updates.forEach(function (u) {
        var d = u.date || "未知日期";
        (byDate[d] = byDate[d] || []).push(u);
      });
      var dates = Object.keys(byDate).sort(function (a, b) { return b.localeCompare(a); });

      var head = '<div class="upd-timeline-head">' +
        '<span>共 <b>' + totalUpdates + '</b> 条动态 · <b>' + sites.filter(function (s) { return s.updates.length; }).length + "</b> 个站点" +
        (COMP.updated ? ' · 监控更新于 ' + esc(COMP.updated) : "") + "</span>" +
      "</div>";

      var groups = dates.map(function (d) {
        var ups = byDate[d];
        return '<div class="upd-group">' +
          '<div class="upd-group-title">' + esc(d) + ' <span class="gn">' + ups.length + " 条</span>" +
            '<span class="upd-group-week">' + weekdayOf(d) + "</span></div>" +
          '<div class="upd-list">' + ups.map(function (u) { return updItem(u, true); }).join("") + "</div></div>";
      }).join("");
      return pills + head + groups;
    }

    /* 单站点视图 */
    var site = compById(picked);
    var ups = site.updates.slice();

    var detail = '<div class="site-detail">' +
      '<div class="site-detail-main">' +
        '<h3>' + esc(site.name) + "</h3>" +
        '<p class="desc">' + esc(site.desc || "") + "</p>" +
      "</div>" +
      '<div class="site-detail-side">' +
        (site.url ? '<a class="url" href="' + esc(site.url) + '" target="_blank" rel="noopener">访问站点 ↗</a>' : "") +
        '<span class="n">' + ups.length + " 条动态</span>" +
      "</div>" +
    "</div>";

    var list = ups.length ? '<div class="upd-list">' + ups.map(function (u) { return updItem(u, true); }).join("") + "</div>" : emptyBox("这个站点暂无动态");
    return pills + detail + list;
  }

  function updItem(u, showSite) {
    var typeCls = { "新功能": "chip-green", "模型更新": "chip-accent", "产品升级": "chip-accent", "修复": "chip-gray" }[u.type] || "chip-gray";
    var details = (u.details && u.details.length)
      ? '<ul class="upd-details">' + u.details.map(function (d) { return "<li>" + esc(d) + "</li>"; }).join("") + "</ul>"
      : "";
    var src = u.source
      ? '<a class="upd-src" href="' + esc(u.source) + '" target="_blank" rel="noopener">↗ ' + esc(u.sourceName || u.source) + "</a>"
      : (u.sourceName ? '<span class="upd-src" style="color:var(--text-4)">' + esc(u.sourceName) + "</span>" : "");
    var siteTag = showSite
      ? '<span class="upd-site">' + esc(compName(u.competitor || u.siteId || "")) + "</span>"
      : "";
    return '<div class="upd-item">' +
      '<div class="upd-head">' + siteTag +
        '<span class="upd-date">' + esc(u.date || "") + "</span>" +
        (u.type ? '<span class="chip ' + typeCls + '">' + esc(u.type) + "</span>" : "") + "</div>" +
      '<div class="upd-title">' + esc(u.title) + "</div>" + details +
      (src ? '<div class="upd-meta">' + src + "</div>" : "") +
    "</div>";
  }

  /* ------------------------------------------------------------
     搜索结果
     ------------------------------------------------------------ */
  function pageSearch() {
    var st = S.searchState;
    if (!st) return skeleton(4);

    if (st.loading && !st.items.length) {
      return '<div class="search-summary">正在搜索「<b>' + esc(st.q) + "</b>」…</div>" + skeleton(3);
    }
    if (st.error && !st.items.length) {
      return '<div class="search-summary">搜索「<b>' + esc(st.q) + '</b>」</div>' + errorBox(st.error, "search");
    }
    if (!st.items.length) {
      return '<div class="search-summary">搜索「<b>' + esc(st.q) + "</b>」 · 没有结果" +
        '<button class="search-clear" data-clear-search="1">清除</button></div>' +
        emptyBox("没找到相关内容", "换个关键词，或只输入公司 / 模型名的一部分");
    }

    var note = st.mode === "all"
      ? '<span style="font-size:11.5px;color:var(--text-4)">（精选池中未收录，以下来自全量池）</span>'
      : "";

    return '<div class="search-summary">搜索「<b>' + esc(st.q) + "</b>」找到 <b>" + st.items.length + "</b> 条" + note +
      '<button class="search-clear" data-clear-search="1">清除</button></div>' +
      '<div class="news-list">' + st.items.map(function (it) { return newsCard(it); }).join("") + "</div>";
  }

  /* ------------------------------------------------------------
     渲染调度
     ------------------------------------------------------------ */
  var contentEl = null;

  function currentPageHTML() {
    switch (S.cat) {
      case "featured": return pageFeatured();
      case "all": return pageAll();
      case "hot": return pageHot();
      case "daily": return pageDaily();
      case "models": return pageModels("models", videoModels.concat(imageModels));
      case "videoModels": return pageModels("videoModels", videoModels);
      case "imageModels": return pageModels("imageModels", imageModels);
      case "videoSites": return pageSites();
      case "search": return pageSearch();
      default: return emptyBox("页面不存在");
    }
  }

  function paint() {
    if (!contentEl) contentEl = $("#contentArea");
    contentEl.innerHTML = currentPageHTML();
    renderNav();
    renderHeader();
    contentEl.scrollTop = 0;
  }

  /* ------------------------------------------------------------
     数据加载
     ------------------------------------------------------------ */
  function loadSelected() {
    return apiGet("/items", { mode: "selected", window: "24h", limit: 50 })
      .then(function (r) {
        S.selected = (r.data.items || []).slice();
        S.fetchedAt = new Date().toISOString();
        if (r.stale) S.stale = true;
      });
  }

  function loadAll(reset) {
    var params = { mode: "all", window: "24h", limit: 50 };
    if (!reset && S.allCursor) params.cursor = S.allCursor;
    return apiGet("/items", params).then(function (r) {
      var items = r.data.items || [];
      var page = r.data.page || {};
      S.all = reset || !S.all ? items : S.all.concat(items);
      S.allCursor = page.hasMore ? page.nextCursor : null;
      S.allHasMore = !!page.hasMore;
      if (r.stale) S.stale = true;
    });
  }

  function loadHot() {
    return apiGet("/hot-topics", {}).then(function (r) {
      S.hot = (r.data.items || []).slice();
      if (r.stale) S.stale = true;
    });
  }

  function loadDailyIndex() {
    return apiGet("/dailies", { limit: 120 }).then(function (r) {
      S.dailyIndex = (r.data.items || []).slice().sort(function (a, b) {
        return String(b.date).localeCompare(String(a.date));
      });
      if (r.stale) S.stale = true;
    });
  }

  function loadDaily(date) {
    if (S.daily[date]) return Promise.resolve(S.daily[date]);
    S.dailyLoading = date;
    paint();
    return apiGet("/dailies/" + date, {}).then(function (r) {
      S.daily[date] = r.data.report || null;
      S.dailyLoading = null;
      if (r.stale) S.stale = true;
      return S.daily[date];
    }).catch(function (e) {
      S.dailyLoading = null;
      throw e;
    });
  }

  function loadStory(id) {
    if (S.storyCache[id]) return Promise.resolve(S.storyCache[id]);
    return apiGet("/stories/" + id, {}).then(function (r) {
      S.storyCache[id] = r.data.story || null;
      return S.storyCache[id];
    });
  }

  /* 页面需要哪些数据 */
  function ensureData(cat) {
    var jobs = [];
    if (cat === "featured") {
      jobs.push(S.selected ? null : loadSelected());
      jobs.push(S.hot ? null : loadHot());
    } else if (cat === "all") {
      jobs.push(S.all ? null : loadAll(true));
    } else if (cat === "hot") {
      jobs.push(S.hot ? null : loadHot());
    } else if (cat === "daily") {
      jobs.push(S.dailyIndex ? null : loadDailyIndex());
      jobs.push(COMP.loaded ? null : loadCompetitors());
    } else if (cat === "videoSites") {
      jobs.push(COMP.loaded ? null : loadCompetitors());
    }
    return Promise.all(jobs.filter(Boolean));
  }

  /* ------------------------------------------------------------
     路由与切换
     ------------------------------------------------------------ */
  function go(cat, opts) {
    opts = opts || {};
    if (!PAGES[cat] && cat !== "search") return;
    var token = ++S.token;
    S.cat = cat;
    S.view.siteId = S.view.siteId || "";

    if (cat !== "search") {
      try { history.replaceState(null, "", "#/" + cat); } catch (e) { /* file:// 下可能不允许 */ }
    }

    renderHeader();
    renderNav();
    if (contentEl) contentEl.innerHTML = skeleton(cat === "daily" ? 3 : 4);
    closeSidebar();

    ensureData(cat).then(function () {
      if (token !== S.token) return;
      if (cat === "daily") {
        var dates = dailyDates();
        if (!S.view.dailyDate || dates.indexOf(S.view.dailyDate) < 0) {
          S.view.dailyDate = dates[0] || "";
          if (S.view.dailyDate) S.view.calMonth = S.view.dailyDate.slice(0, 7);
        }
        if (!S.view.dailyDate) { paint(); return; }
        /* 只在「AI 日报」标签下才需要拉日报正文，竞品标签用不到 */
        if (S.view.dailyTab === "comp") { paint(); return; }
        return loadDaily(S.view.dailyDate).then(function () {
          if (token === S.token) paint();
        }).catch(function () {
          if (token === S.token) paint();
        });
      }
      if (token === S.token) paint();
    }).catch(function (e) {
      if (token !== S.token) return;
      contentEl.innerHTML = errorBox(e && e.message, cat);
    });
  }

  /* ------------------------------------------------------------
     事件绑定（统一委托）
     ------------------------------------------------------------ */
  function closeSidebar() {
    var sb = $("#sidebar"), sc = $("#scrim");
    if (sb) sb.classList.remove("open");
    if (sc) sc.classList.remove("open");
  }
  function openSidebar() {
    var sb = $("#sidebar"), sc = $("#scrim");
    if (sb) sb.classList.add("open");
    if (sc) sc.classList.add("open");
  }

  function bind() {
    document.addEventListener("click", function (e) {
      var t = e.target;

      /* 导航 */
      var nav = t.closest ? t.closest(".nav-item") : null;
      if (nav) { go(nav.getAttribute("data-cat")); return; }

      /* 重新加载 */
      var retry = t.closest ? t.closest("[data-retry]") : null;
      if (retry) {
        var cat = retry.getAttribute("data-retry");
        clearCache();
        if (cat === "search") { runSearch(S.query); return; }
        go(cat);
        return;
      }

      /* 菜单 / 遮罩 */
      if (t.closest && t.closest("#menuBtn")) { openSidebar(); return; }
      if (t.closest && t.closest("#scrim")) { closeSidebar(); return; }

      /* 刷新 */
      if (t.closest && t.closest("#refreshBtn")) {
        clearCache();
        S.selected = S.all = S.hot = S.dailyIndex = null;
        S.daily = {}; S.allCursor = null; S.storyCache = {}; S.fetchedAt = "";
        var btn = $("#refreshBtn");
        btn.classList.add("spinning");
        setTimeout(function () { btn.classList.remove("spinning"); }, 900);
        if (S.cat === "search" && S.query) { runSearch(S.query); return; }
        go(S.cat === "search" ? "featured" : S.cat);
        return;
      }

      /* 全部动态：类型筛选 */
      var tagBtn = t.closest ? t.closest("[data-alltag]") : null;
      if (tagBtn) {
        S.view.allTag = tagBtn.getAttribute("data-alltag");
        paint();
        return;
      }

      /* 加载更多 */
      if (t.closest && t.closest("#loadMoreBtn")) {
        var b = $("#loadMoreBtn");
        b.textContent = "加载中…";
        b.disabled = true;
        loadAll(false).then(paint).catch(function () { paint(); });
        return;
      }

      /* 模型筛选 */
      var mt = t.closest ? t.closest("[data-mtype]") : null;
      if (mt) { S.view.modelType[mt.getAttribute("data-key")] = mt.getAttribute("data-mtype"); paint(); return; }
      var mn = t.closest ? t.closest("[data-mnat]") : null;
      if (mn) { S.view.modelNat[mn.getAttribute("data-key")] = mn.getAttribute("data-mnat"); paint(); return; }

      /* 竞品切换 */
      var site = t.closest ? t.closest("[data-site]") : null;
      if (site) { S.view.siteId = site.getAttribute("data-site"); paint(); return; }

      /* 日报：切换 AI / 竞品标签 */
      var dtab = t.closest ? t.closest("[data-dtab]") : null;
      if (dtab) {
        S.view.dailyTab = dtab.getAttribute("data-dtab") === "comp" ? "comp" : "ai";
        paint();
        return;
      }

      /* 日报：选日期 / 换月 / 前后翻 */
      var day = t.closest ? t.closest("[data-date]") : null;
      if (day) {
        var ds = day.getAttribute("data-date");
        if (ds) {
          S.view.dailyDate = ds;
          S.view.calMonth = ds.slice(0, 7);
          loadDaily(ds).then(paint).catch(paint);
        }
        return;
      }
      var cm = t.closest ? t.closest("[data-cal]") : null;
      if (cm) { S.view.calMonth = cm.getAttribute("data-cal"); paint(); return; }

      /* 热点事件抽屉 */
      var st = t.closest ? t.closest("[data-story]") : null;
      if (st) { openStory(st.getAttribute("data-story")); return; }
      if (t.closest && (t.closest("#drawerMask") || t.closest("#drawerClose"))) { closeStory(); return; }

      /* 清除搜索 */
      if (t.closest && t.closest("[data-clear-search]")) {
        var inp = $("#searchInput");
        inp.value = "";
        S.query = ""; S.searchState = null;
        go("featured");
        return;
      }

      /* 点卡片空白处打开 AIHOT */
      var card = t.closest ? t.closest("[data-open]") : null;
      if (card && !(t.closest && t.closest("a"))) {
        var url = card.getAttribute("data-open");
        if (url && url !== "#") window.open(url, "_blank", "noopener");
        return;
      }
    });

    /* 搜索 */
    var input = $("#searchInput");
    var doSearch = debounce(function (q) {
      S.query = q;
      runSearch(q);
    }, 380);

    input.addEventListener("input", function () {
      var q = input.value.trim();
      $("#searchWrap").classList.toggle("has-value", !!input.value);
      if (!q) {
        S.searchState = null;
        if (S.cat === "search") go("featured");
        return;
      }
      if (q.length < 2) return;
      doSearch(q);
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        input.value = ""; S.query = ""; S.searchState = null;
        $("#searchWrap").classList.remove("has-value");
        go("featured");
      }
    });

    /* 搜索图标点击（移动端展开） */
    $("#searchWrap").addEventListener("click", function (e) {
      if (window.innerWidth <= 780 && !this.classList.contains("expanded")) {
        e.preventDefault();
        this.classList.add("expanded");
        setTimeout(function () { input.focus(); }, 30);
      }
    });
    input.addEventListener("blur", function () {
      setTimeout(function () {
        var w = $("#searchWrap");
        if (window.innerWidth <= 780 && !input.value) w.classList.remove("expanded");
      }, 160);
    });

    /* 快捷键 / */
    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && document.activeElement !== input) {
        e.preventDefault();
        var w = $("#searchWrap");
        if (window.innerWidth <= 780) w.classList.add("expanded");
        input.focus();
      }
    });

    /* 回顶 */
    window.addEventListener("scroll", function () {
      var b = $("#toTop");
      if (!b) return;
      b.classList.toggle("show", window.scrollY > 500);
    }, { passive: true });
    $("#toTop").addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  /* ------------------------------------------------------------
     搜索执行
     ------------------------------------------------------------ */
  function runSearch(q) {
    if (!q || q.length < 2) return;
    S.cat = "search";
    S.searchState = { q: q, items: [], loading: true, error: null, mode: "selected" };
    renderNav();
    renderHeader();
    $("#pageTitle").textContent = "搜索";
    $("#pageDesc").textContent = "在 AIHOT 精选池中检索：" + q;
    contentEl.innerHTML = pageSearch();
    try { history.replaceState(null, "", "#/search"); } catch (e) { /* ignore */ }

    var token = ++S.token;

    apiGet("/items", { mode: "selected", q: q, window: "7d", limit: 30 })
      .then(function (r) {
        var items = r.data.items || [];
        if (items.length) return { items: items, mode: "selected" };
        /* 精选池空 → 同参数再查全量池 */
        return apiGet("/items", { mode: "all", q: q, window: "7d", limit: 30 })
          .then(function (r2) { return { items: r2.data.items || [], mode: "all" }; });
      })
      .then(function (res) {
        if (token !== S.token) return;
        S.searchState = { q: q, items: res.items, loading: false, error: null, mode: res.mode };
        contentEl.innerHTML = pageSearch();
      })
      .catch(function (e) {
        if (token !== S.token) return;
        S.searchState = { q: q, items: [], loading: false, error: e.message, mode: "selected" };
        contentEl.innerHTML = pageSearch();
      });
  }

  /* ------------------------------------------------------------
     热点事件抽屉
     ------------------------------------------------------------ */
  var drawerEl = null;

  function buildDrawer() {
    if (drawerEl) return;
    drawerEl = document.createElement("div");
    drawerEl.innerHTML =
      '<div class="drawer-mask" id="drawerMask"></div>' +
      '<aside class="drawer" id="drawer" aria-hidden="true">' +
        '<div class="drawer-head">' +
          '<div class="drawer-head-row">' +
            '<span class="chip chip-accent">事件时间线</span>' +
            '<h2 id="drawerTitle" style="margin:0"></h2>' +
            '<button type="button" class="drawer-close" id="drawerClose" aria-label="关闭">✕</button>' +
          '</div>' +
          '<div class="drawer-meta" id="drawerMeta"></div>' +
        '</div>' +
        '<div class="drawer-body" id="drawerBody"></div>' +
      '</aside>';
    document.body.appendChild(drawerEl);
  }

  function openStory(id) {
    buildDrawer();
    var mask = $("#drawerMask"), dr = $("#drawer");
    $("#drawerTitle").textContent = "加载中…";
    $("#drawerMeta").innerHTML = "";
    $("#drawerBody").innerHTML = skeleton(2);
    mask.classList.add("open");
    dr.classList.add("open");
    dr.setAttribute("aria-hidden", "false");

    loadStory(id).then(function (st) {
      if (!st) {
        $("#drawerTitle").textContent = "事件数据不可用";
        $("#drawerBody").innerHTML = emptyBox("这个事件暂时打不开", "可能已被合并或超出可用范围");
        return;
      }
      $("#drawerTitle").textContent = st.title || "事件";
      var meta = [];
      meta.push("<span>" + (st.sourceCount || 0) + " 个信源</span>");
      meta.push("<span>·</span><span>" + (st.reportCount || 0) + " 篇报道</span>");
      if (st.latestAt) meta.push("<span>·</span><span>最新 " + esc(bjTime(st.latestAt, true)) + "</span>");
      if (st.status === "settled") meta.push('<span class="chip chip-gray">已收束</span>');
      $("#drawerMeta").innerHTML = meta.join("");

      var html = "";
      if (st.latest) {
        html += '<div class="digest-box"><div class="dl">最新进展</div><p>' + esc(st.latest) + "</p></div>";
      }
      if (st.digest) {
        html += '<div class="digest-box"><div class="dl">AI 综述</div><p>' + esc(st.digest) + "</p></div>";
      }
      var reports = (st.reports || []);
      if (reports.length) {
        html += '<div class="section-head"><h2>报道时间线</h2><span class="count">' + reports.length + " 篇</span><span class=\"line\"></span></div>";
        html += '<div class="timeline">' + reports.map(function (r) {
          var l = (r.links && r.links.aihot) || (r.links && r.links.original) || "";
          return '<div class="tl-item"><div class="tl-time">' + esc(bjTime(r.publishedAt || r.discoveredAt, true)) + "</div>" +
            '<div class="tl-title">' + (l ? '<a href="' + esc(l) + '" target="_blank" rel="noopener">' + esc(r.title) + "</a>" : esc(r.title)) + "</div>" +
            '<div class="tl-src">' + esc((r.source && r.source.name) || "") + "</div></div>";
        }).join("") + "</div>";
      }
      $("#drawerBody").innerHTML = html || emptyBox("暂无时间线内容");
    }).catch(function (e) {
      $("#drawerTitle").textContent = "加载失败";
      $("#drawerBody").innerHTML = errorBox(e.message);
    });
  }

  function closeStory() {
    var mask = $("#drawerMask"), dr = $("#drawer");
    if (!mask || !dr) return;
    mask.classList.remove("open");
    dr.classList.remove("open");
    dr.setAttribute("aria-hidden", "true");
  }

  /* ------------------------------------------------------------
     缓存清理
     ------------------------------------------------------------ */
  function clearCache() {
    memCache = {};
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf("aihot:v1:") === 0) localStorage.removeItem(k);
      });
    } catch (e) { /* ignore */ }
    S.stale = false;
  }

  /* ------------------------------------------------------------
     启动
     ------------------------------------------------------------ */
  function init() {
    contentEl = $("#contentArea");
    bind();
    renderNav();

    var hashCat = (location.hash || "").replace(/^#\/?/, "");
    var startCat = PAGES[hashCat] ? hashCat : "featured";

    contentEl.innerHTML = skeleton(4);

    /* 预取：精选 + 热点 + 日报索引 + 竞品动态（四个请求并行） */
    Promise.allSettled([loadSelected(), loadHot(), loadDailyIndex(), loadCompetitors()]).then(function () {
      S.booted = true;
      var first = S.selected && S.selected.length ? S.selected[0] : null;
      if (!first) { S.stale = true; }
      go(startCat);
    });

    window.addEventListener("hashchange", function () {
      var c = (location.hash || "").replace(/^#\/?/, "");
      if (PAGES[c] && c !== S.cat) go(c);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeStory();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
