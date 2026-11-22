const routeData = {
  official: { edition: "官端卷 · 可复现基线", title: "从微信，抵达 ChatGPT Work", wake: "MCP Events", runtime: "ChatGPT Work", source: "Open source", stop: "Work", steps: ["Windows Adapter 读取白名单私聊", "VPS Bridge 合并消息并排队", "MCP Events 唤醒 ChatGPT Work", "发送确认与 ACK 回到微信"] },
  codex: { edition: "Codex 卷 · 私有工作系统", title: "从微信，进入日常 Codex 环境", wake: "Private gateway", runtime: "Codex workspace", source: "Architecture shared", stop: "Codex", steps: ["沿用 Windows 适配与鉴权入口", "入站消息先持久化，断网后续传", "进入 Codex 会话与工具运行环境", "文本、媒体与桌面能力逐项扩展"] },
};
const root = document.documentElement;
const folio = document.querySelector(".hero-folio");
const buttons = Array.from(document.querySelectorAll("[data-route-button]"));
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
function setText(key, value) { document.querySelectorAll(`[data-route-text="${key}"]`).forEach((node) => { node.textContent = value; }); }
function setRoute(route, animate = true) {
  const data = routeData[route]; if (!data) return;
  root.dataset.route = route;
  buttons.forEach((button) => { const active = button.dataset.routeButton === route; button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active)); });
  ["edition", "title", "wake", "runtime", "source", "stop"].forEach((key) => setText(key, data[key]));
  data.steps.forEach((step, index) => { const node = document.querySelector(`[data-route-step="${index}"]`); if (node) node.textContent = step; });
  if (animate && !reduceMotion.matches && folio) { folio.classList.remove("is-turning"); requestAnimationFrame(() => folio.classList.add("is-turning")); window.setTimeout(() => folio.classList.remove("is-turning"), 560); }
}
buttons.forEach((button) => button.addEventListener("click", () => setRoute(button.dataset.routeButton)));
window.addEventListener("load", () => { window.setTimeout(() => document.body.classList.add("is-open"), 80); window.setTimeout(() => setRoute("official", false), 180); });
