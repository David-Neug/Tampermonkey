// ==UserScript==
// @name         BookKit last editor + section diff
// @namespace    emfip
// @version      1.0
// @downloadURL  https://raw.githubusercontent.com/David-Neug/Tampermonkey/refs/heads/main/Scripts/bookkit-last-editor-section-diff.user.js
// @updateURL    https://raw.githubusercontent.com/David-Neug/Tampermonkey/refs/heads/main/Scripts/bookkit-last-editor-section-diff.user.js
// @description  Shows last editor on each BookKit section and a side-by-side rendered diff against the previous snapshot.
// @author       David Neugebauer
// @match        https://uuapp.plus4u.net/uu-bookkit-maing01/*/book/page*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const BADGE_CLASS = "tm-bk-last-edit";
  const BTN_CLASS = "tm-bk-diff-btn";
  const OVERLAY_ID = "tm-bk-diff-overlay";
  const ADD_CLASS = "tm-bk-diff-add";
  const DEL_CLASS = "tm-bk-diff-del";
  const LCS_TOKEN_LIMIT = 800;

  const versionCache = new Map();
  let paintTimer = null;
  let escapeBound = false;

  injectStyles();
  const observer = new MutationObserver(() => schedulePaint());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  schedulePaint();

  function injectStyles() {
    if (document.getElementById("tm-bk-diff-style")) return;
    const style = document.createElement("style");
    style.id = "tm-bk-diff-style";
    style.textContent = `
      .${BADGE_CLASS} {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        font-size: 12px;
        color: #555;
        background: #f4f4f4;
        border-left: 3px solid #bbb;
        padding: 4px 8px;
        margin: 4px 0 8px;
        font-family: Segoe UI, Arial, sans-serif;
      }
      .${BTN_CLASS} {
        cursor: pointer;
        font-size: 12px;
        padding: 2px 8px;
        border: 1px solid #888;
        background: #fff;
        border-radius: 3px;
      }
      .${BTN_CLASS}:hover:not(:disabled) { background: #eee; }
      .${BTN_CLASS}:disabled { opacity: 0.45; cursor: not-allowed; }
      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        background: rgba(0,0,0,0.45);
        display: flex;
        flex-direction: column;
        font-family: Segoe UI, Arial, sans-serif;
      }
      #${OVERLAY_ID} .tm-bk-diff-bar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        background: #222;
        color: #fff;
        padding: 8px 12px;
      }
      #${OVERLAY_ID} .tm-bk-diff-bar button {
        cursor: pointer;
        font-size: 14px;
        padding: 4px 10px;
      }
      #${OVERLAY_ID} .tm-bk-diff-note {
        font-size: 12px;
        opacity: 0.8;
        margin-left: 12px;
      }
      #${OVERLAY_ID} .tm-bk-diff-panes {
        flex: 1 1 auto;
        display: flex;
        min-height: 0;
        background: #fff;
      }
      #${OVERLAY_ID} .tm-bk-diff-pane {
        flex: 1 1 50%;
        width: 50%;
        display: flex;
        flex-direction: column;
        min-width: 0;
        border-right: 1px solid #ccc;
      }
      #${OVERLAY_ID} .tm-bk-diff-pane:last-child { border-right: none; }
      #${OVERLAY_ID} .tm-bk-diff-pane-head {
        flex: 0 0 auto;
        padding: 8px 12px;
        background: #f7f7f7;
        border-bottom: 1px solid #ddd;
        font-size: 13px;
      }
      #${OVERLAY_ID} .tm-bk-diff-pane-body {
        flex: 1 1 auto;
        overflow: auto;
        padding: 12px;
      }
      #${OVERLAY_ID} .tm-bk-diff-error {
        color: #a00;
        padding: 16px;
      }
      .${ADD_CLASS} { background: #c8f0c8; box-shadow: 0 0 0 2px #c8f0c8; }
      .${DEL_CLASS} { background: #f8c8c8; box-shadow: 0 0 0 2px #f8c8c8; }
    `;
    document.head.appendChild(style);
  }

  function schedulePaint() {
    clearTimeout(paintTimer);
    paintTimer = setTimeout(paint, 300);
  }

  function paint() {
    document.querySelectorAll(".uudcc-bricks-basic-section").forEach((el) => {
      const section = sectionData(el);
      if (!section) return;

      let row = el.querySelector(`:scope > .${BADGE_CLASS}`);
      if (!row) {
        row = document.createElement("div");
        row.className = BADGE_CLASS;
        const label = document.createElement("span");
        label.className = "tm-bk-last-edit-label";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = BTN_CLASS;
        btn.textContent = "Diff";
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openDiff(section);
        });
        row.append(label, btn);
        el.prepend(row);
      }

      const who = section.uuIdentityName || section.uuIdentity || "(needitováno)";
      const when = section.sys?.mts
        ? new Date(section.sys.mts).toLocaleString("cs-CZ")
        : "";
      const rev = section.sys?.rev ?? "";
      const text = when
        ? `${who} · ${when} · rev ${rev}`
        : "(needitováno)";
      const labelEl = row.querySelector(".tm-bk-last-edit-label");
      if (labelEl && labelEl.textContent !== text) labelEl.textContent = text;

      const btn = row.querySelector(`.${BTN_CLASS}`);
      if (btn) {
        btn.disabled = !section.sys || section.sys.rev === 0;
        btn.title = btn.disabled
          ? "Sekce nemá historickou verzi"
          : "Porovnat s předchozí verzí";
      }
    });
  }

  function sectionData(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let f = key ? el[key] : null;
    for (let d = 0; f && d < 25; d++, f = f.return) {
      const s = f.memoizedProps?.section;
      if (s && s.code && s.sys) return s;
    }
    return null;
  }

  function pageCode() {
    return new URLSearchParams(location.search).get("code");
  }

  function awid() {
    const parts = location.pathname.split("/");
    const i = parts.indexOf("uu-bookkit-maing01");
    return i >= 0 ? parts[i + 1] : null;
  }

  function commandUrl(name) {
    return `${location.origin}/uu-bookkit-maing01/${awid()}/${name}`;
  }

  // A bare fetch reaches the server as uuIdentity 0-0 and gets 403, so the
  // request has to go through the app's own client, which attaches the session.
  function findCalls() {
    const loader = window.Uu5Loader || window.SystemJS || window.System;
    if (!loader || typeof loader.get !== "function") return null;
    for (const name of ["uu_plus4u5g02", "uu_plus4u5g01"]) {
      try {
        const mod = loader.get(name);
        const calls = mod?._Calls || mod?.Calls;
        if (calls && typeof calls.call === "function") return calls;
      } catch (_) {}
    }
    return null;
  }

  async function apiGet(name, dtoIn) {
    const url = commandUrl(name);
    const calls = findCalls();
    if (calls) return await calls.call("get", url, dtoIn);

    const res = await fetch(`${url}?${new URLSearchParams(dtoIn)}`, {
      credentials: "include",
    });
    if (!res.ok) {
      let extra = "";
      try {
        extra = (await res.text()).slice(0, 200);
      } catch (_) {}
      throw new Error(`HTTP ${res.status}${extra ? ": " + extra : ""}`);
    }
    return res.json();
  }

  async function loadPreviousVersion(section) {
    const page = pageCode();
    const cacheKey = `${page}:${section.code}`;
    if (versionCache.has(cacheKey)) return versionCache.get(cacheKey);

    const data = await apiGet("listPageSectionVersion", {
      code: section.code,
      page,
    });
    const list = Array.isArray(data?.itemList) ? data.itemList : [];
    versionCache.set(cacheKey, list);
    return list;
  }

  async function openDiff(section) {
    closeDiff();
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
      <div class="tm-bk-diff-bar">
        <div>
          <strong>Section diff</strong>
          <span class="tm-bk-diff-note">Diagramy v overlayi nemusí vypadat stejně; podbarvení je podle textu.</span>
        </div>
        <button type="button" class="tm-bk-diff-close">Zavřít</button>
      </div>
      <div class="tm-bk-diff-panes">
        <div class="tm-bk-diff-pane">
          <div class="tm-bk-diff-pane-head" data-side="current"></div>
          <div class="tm-bk-diff-pane-body" data-side="current">Načítám…</div>
        </div>
        <div class="tm-bk-diff-pane">
          <div class="tm-bk-diff-pane-head" data-side="previous"></div>
          <div class="tm-bk-diff-pane-body" data-side="previous">Načítám…</div>
        </div>
      </div>
    `;
    overlay.querySelector(".tm-bk-diff-close").addEventListener("click", closeDiff);
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) closeDiff();
    });
    document.body.appendChild(overlay);
    bindEscape();

    const currentHead = overlay.querySelector('.tm-bk-diff-pane-head[data-side="current"]');
    const prevHead = overlay.querySelector('.tm-bk-diff-pane-head[data-side="previous"]');
    const currentBody = overlay.querySelector('.tm-bk-diff-pane-body[data-side="current"]');
    const prevBody = overlay.querySelector('.tm-bk-diff-pane-body[data-side="previous"]');

    currentHead.textContent = `Aktuální verze · ${whoWhen(section)}`;

    try {
      const list = await loadPreviousVersion(section);
      const previous = list[0];
      if (!previous) {
        prevHead.textContent = "Předchozí verze";
        prevBody.innerHTML = '<div class="tm-bk-diff-error">Sekce nemá historická data.</div>';
        currentBody.textContent = "";
        await renderUu5(currentBody, section.content);
        return;
      }

      prevHead.textContent = `Předchozí verze · ${whoWhen(previous)}`;
      currentBody.textContent = "";
      prevBody.textContent = "";
      await Promise.all([
        renderUu5(currentBody, section.content),
        renderUu5(prevBody, previous.content),
      ]);

      highlightRenderedDiff(
        currentBody,
        prevBody,
        paneText(currentBody, section.content),
        paneText(prevBody, previous.content)
      );
    } catch (err) {
      prevHead.textContent = "Předchozí verze";
      prevBody.innerHTML = `<div class="tm-bk-diff-error">${escapeHtml(err.message || String(err))}</div>`;
      currentBody.textContent = "";
      try {
        await renderUu5(currentBody, section.content);
      } catch (_) {}
    }
  }

  function whoWhen(obj) {
    const who = obj?.uuIdentityName || obj?.uuIdentity || "(neznámý)";
    const when = obj?.sys?.mts ? new Date(obj.sys.mts).toLocaleString("cs-CZ") : "";
    return when ? `${who} · ${when}` : who;
  }

  function closeDiff() {
    const el = document.getElementById(OVERLAY_ID);
    if (!el) return;
    el.querySelectorAll(".tm-bk-diff-pane-body").forEach((body) => {
      tryUnmount(body);
    });
    el.remove();
  }

  function bindEscape() {
    if (escapeBound) return;
    escapeBound = true;
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && document.getElementById(OVERLAY_ID)) {
        ev.preventDefault();
        closeDiff();
      }
    });
  }

  function toPlain(uu5) {
    try {
      const fn = window.UU5?.Common?.UU5String?.toPlainText;
      if (typeof fn === "function" && uu5) return fn(uu5) || "";
    } catch (_) {}
    return "";
  }

  // Rendered text is the reliable source: toPlainText returns "" for content
  // whose text lives in component props (Lsi, UuContentKit tables, ...).
  // It must come from the same text nodes that applyOpsToDom walks, otherwise
  // innerText's synthetic whitespace shifts offsets and long spans never match.
  function paneText(container, content) {
    const rendered = collectTextNodes(container)
      .map((n) => n.nodeValue)
      .join("");
    if (rendered.trim()) return rendered;
    return toPlain(content) || String(content || "");
  }

  async function renderUu5(container, content) {
    container.innerHTML = "";
    if (!content) {
      container.textContent = "(prázdná sekce)";
      return;
    }

    const UU5 = window.UU5;
    const create = UU5?.Common?.Element?.create;
    const Section = UU5?.Bricks?.Section;
    const Div = UU5?.Bricks?.Div;
    if (create) {
      const attempts = [];
      if (Section) attempts.push(create(Section, { content, dynamic: false }));
      if (Div) attempts.push(create(Div, { content }));
      try {
        const children = UU5.Common.UU5String.toChildren(content);
        if (Div && children) attempts.push(create(Div, null, children));
      } catch (_) {}
      for (const element of attempts) {
        if (await mountReact(container, element)) return;
      }
    }

    const htmlFallback = escapeHtml(toPlain(content) || String(content)).replace(/\n/g, "<br>");
    container.innerHTML = htmlFallback;
  }

  function isReactRenderer(lib) {
    if (!lib) return false;
    if (typeof lib.createRoot === "function") return true;
    return typeof lib.render === "function" && typeof lib.unmountComponentAtNode === "function";
  }

  let reactDomCache;

  function findReactDOM() {
    if (reactDomCache !== undefined) return reactDomCache;

    const loader = window.Uu5Loader || window.SystemJS || window.System;
    if (loader && typeof loader.get === "function") {
      for (const name of ["react-dom", "reactDom", "uu5g05-react-dom"]) {
        try {
          const lib = loader.get(name);
          if (isReactRenderer(lib)) {
            reactDomCache = lib;
            return lib;
          }
        } catch (_) {}
      }
    }

    for (const lib of [window.ReactDOM, window.UU5?.Common?.DOM]) {
      if (isReactRenderer(lib)) {
        reactDomCache = lib;
        return lib;
      }
    }

    reactDomCache = null;
    return null;
  }

  async function mountReact(container, element) {
    const lib = findReactDOM();
    if (!lib) return false;

    // uu5g04 components use legacy mixins, so prefer the legacy renderer.
    try {
      if (typeof lib.render === "function") {
        lib.render(element, container);
        container.__tmBkReact = lib;
        await waitRendered(container);
        return true;
      }
    } catch (_) {}
    try {
      if (typeof lib.createRoot === "function") {
        const root = lib.createRoot(container);
        root.render(element);
        container.__tmBkRoot = root;
        await waitRendered(container);
        return true;
      }
    } catch (_) {}
    return false;
  }

  async function waitRendered(container) {
    for (let i = 0; i < 40; i++) {
      await waitFrames(2);
      if (container.childElementCount && (container.textContent || "").trim()) return;
    }
  }

  function tryUnmount(container) {
    try {
      if (container.__tmBkRoot?.unmount) container.__tmBkRoot.unmount();
      else       if (container.__tmBkReact?.unmountComponentAtNode) {
        container.__tmBkReact.unmountComponentAtNode(container);
      }
    } catch (_) {}
  }

  function waitFrames(n) {
    return new Promise((resolve) => {
      let left = n;
      const tick = () => {
        left -= 1;
        if (left <= 0) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  function tokenize(text) {
    return (text || "").match(/\s+|[^\s]+/g) || [];
  }

  function highlightRenderedDiff(leftRoot, rightRoot, leftPlain, rightPlain) {
    const a = tokenize(leftPlain);
    const b = tokenize(rightPlain);
    if (!a.length && !b.length) return;

    let ops;
    if (a.length * b.length > LCS_TOKEN_LIMIT * LCS_TOKEN_LIMIT) {
      ops = lineOps(leftPlain, rightPlain);
    } else {
      ops = diffOps(a, b);
    }

    applyOpsToDom(leftRoot, ops.filter((op) => op.type !== "del"), ADD_CLASS);
    applyOpsToDom(rightRoot, ops.filter((op) => op.type !== "add"), DEL_CLASS);
  }

  function diffOps(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const ops = [];
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        ops.push({ type: "eq", text: a[i - 1] });
        i--;
        j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        ops.push({ type: "add", text: a[i - 1] });
        i--;
      } else {
        ops.push({ type: "del", text: b[j - 1] });
        j--;
      }
    }
    while (i > 0) {
      ops.push({ type: "add", text: a[i - 1] });
      i--;
    }
    while (j > 0) {
      ops.push({ type: "del", text: b[j - 1] });
      j--;
    }
    ops.reverse();
    return mergeOps(ops);
  }

  function lineOps(leftPlain, rightPlain) {
    const a = (leftPlain || "").split(/\n/);
    const b = (rightPlain || "").split(/\n/);
    const raw = diffOps(a, b);
    return raw.map((op) => ({
      type: op.type,
      text: op.text + (op.text.endsWith("\n") ? "" : "\n"),
    }));
  }

  function mergeOps(ops) {
    const out = [];
    for (const op of ops) {
      const last = out[out.length - 1];
      if (last && last.type === op.type) last.text += op.text;
      else out.push({ type: op.type, text: op.text });
    }
    return out;
  }

  function applyOpsToDom(root, ops, markClass) {
    const nodes0 = collectTextNodes(root);
    if (!nodes0.length) return;
    const full = nodes0.map((n) => n.nodeValue).join("");
    const compact = (s) => s.replace(/\s+/g, " ");
    const haystack = compact(full);
    let cursor = 0;
    const ranges = [];

    for (const op of ops) {
      if (!op.text) continue;
      const isWs = /^\s+$/.test(op.text);
      if (isWs) {
        cursor = Math.max(cursor, haystack.indexOf(compact(op.text), cursor) + compact(op.text).length);
        continue;
      }
      if (op.type === "eq") {
        const needle = compact(op.text);
        const idx = haystack.indexOf(needle, cursor);
        if (idx >= 0) cursor = idx + needle.length;
        continue;
      }
      const needle = compact(op.text);
      if (!needle) continue;
      const idx = haystack.indexOf(needle, cursor);
      if (idx < 0) continue;
      ranges.push({
        start: mapCompactIndex(full, idx),
        end: mapCompactIndex(full, idx + needle.length),
        className: markClass,
      });
      cursor = idx + needle.length;
    }

    ranges.sort((a, b) => b.start - a.start);
    for (const range of ranges) {
      wrapRange(collectTextNodes(root), range.start, range.end, range.className);
    }
  }

  function mapCompactIndex(raw, compactIndex) {
    let compact = 0;
    let i = 0;
    let inSpace = false;
    while (i < raw.length && compact < compactIndex) {
      const isSpace = /\s/.test(raw[i]);
      if (isSpace) {
        if (!inSpace) {
          compact++;
          inSpace = true;
        }
      } else {
        inSpace = false;
        compact++;
      }
      i++;
    }
    return i;
  }

  function collectTextNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (parent && parent.closest("script,style")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function wrapRange(nodes, start, end, className) {
    let offset = 0;
    for (const node of nodes) {
      const len = node.nodeValue.length;
      const nodeStart = offset;
      const nodeEnd = offset + len;
      offset = nodeEnd;
      const from = Math.max(start, nodeStart);
      const to = Math.min(end, nodeEnd);
      if (from >= to) continue;
      wrapTextNode(node, from - nodeStart, to - nodeStart, className);
    }
  }

  function wrapTextNode(node, from, to, className) {
    if (!node.parentNode || from === to) return;
    const text = node.nodeValue;
    const before = text.slice(0, from);
    const mid = text.slice(from, to);
    const after = text.slice(to);
    if (!mid) return;
    const span = document.createElement("mark");
    span.className = className;
    span.textContent = mid;
    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    frag.appendChild(span);
    if (after) frag.appendChild(document.createTextNode(after));
    node.parentNode.replaceChild(frag, node);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
