const routeData = {
  official: {
    wake: "MCP Events subscription",
    host: "ChatGPT Work",
    source: "Open source",
  },
  codex: {
    wake: "Private gateway",
    host: "Codex workspace",
    source: "Architecture shared",
  },
};

const root = document.documentElement;
const buttons = Array.from(document.querySelectorAll("[data-route-button]"));
const readouts = Array.from(document.querySelectorAll("[data-route-copy]"));
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function playPacket(route) {
  if (reduceMotion.matches) return;
  const animation = document.querySelector(`#packet-${route}`);
  if (animation && typeof animation.beginElement === "function") {
    animation.beginElement();
  }
}

function setRoute(route, shouldAnimate = true) {
  if (!routeData[route]) return;
  root.dataset.route = route;

  buttons.forEach((button) => {
    const active = button.dataset.routeButton === route;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  readouts.forEach((element) => {
    const key = element.dataset.routeCopy;
    element.textContent = routeData[route][key];
  });

  if (shouldAnimate) playPacket(route);
}

buttons.forEach((button) => {
  button.addEventListener("click", () => setRoute(button.dataset.routeButton));
});

window.addEventListener("load", () => {
  window.setTimeout(() => setRoute("official", true), 420);
});
