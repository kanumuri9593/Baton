const REPO = "https://github.com/kanumuri9593/Baton";
const ISSUE_NEW = `${REPO}/issues/new`;

const TEAM_ROI = {
  solo: {
    hours: "0.8–1.5 hrs",
    tokens: "60–80%",
    interrupts: "rarely asked",
    note: "One developer, ~50 reloads a week, Flutter or mixed web.",
  },
  squad: {
    hours: "4–8 hrs",
    tokens: "60–80%",
    interrupts: "a few fewer pings",
    note: "Five engineers sharing simulators, worktrees, and one daemon.",
  },
  studio: {
    hours: "10–30 hrs",
    tokens: "workflow-dependent",
    interrupts: "QA/PM self-serve Run",
    note: "Fifteen people: engineers plus people who previously needed a developer to start the app.",
  },
};

/**
 * Boot interactive behavior for the marketing site.
 */
export function initSite() {
  initNav();
  initCopyButtons();
  initReveals();
  initTilt();
  initRoi();
  initRequestForm();
}

function initNav() {
  const nav = document.querySelector("[data-nav]");
  const toggle = document.querySelector("[data-nav-toggle]");
  if (!nav || !toggle) return;
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
}

/**
 * Copy text to the clipboard, with a textarea fallback when the Clipboard API is blocked.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.left = "-9999px";
    document.body.append(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    return ok;
  }
}

function initCopyButtons() {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const text = button.getAttribute("data-copy") ?? "";
      const ok = await copyText(text);
      button.textContent = ok ? "Copied" : "Copy failed";
      window.setTimeout(() => {
        button.textContent = "Copy";
      }, 1400);
    });
  });
}

function initReveals() {
  const nodes = document.querySelectorAll("[data-reveal]");
  if (!nodes.length || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    nodes.forEach((node) => node.classList.add("is-in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.16 },
  );
  nodes.forEach((node) => io.observe(node));
}

function initTilt() {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  document.querySelectorAll("[data-tilt]").forEach((node) => {
    node.addEventListener("pointermove", (event) => {
      const rect = node.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      node.style.transform = `rotateX(${(-y * 8).toFixed(2)}deg) rotateY(${(x * 10).toFixed(2)}deg)`;
    });
    node.addEventListener("pointerleave", () => {
      node.style.transform = "";
    });
  });
}

function initRoi() {
  const root = document.querySelector("[data-roi]");
  if (!root) return;
  const tabs = root.querySelectorAll("[data-team]");
  const hours = root.querySelector("[data-roi-hours]");
  const tokens = root.querySelector("[data-roi-tokens]");
  const interrupts = root.querySelector("[data-roi-interrupts]");
  const note = root.querySelector("[data-roi-note]");

  const apply = (team) => {
    const data = TEAM_ROI[team] ?? TEAM_ROI.solo;
    if (hours) hours.textContent = data.hours;
    if (tokens) tokens.textContent = data.tokens;
    if (interrupts) interrupts.textContent = data.interrupts;
    if (note) note.textContent = data.note;
    tabs.forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.getAttribute("data-team") === team));
    });
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => apply(tab.getAttribute("data-team") ?? "solo"));
  });
  apply("solo");
}

function initRequestForm() {
  const form = document.querySelector("[data-request-form]");
  if (!form) return;

  document.querySelectorAll("[data-request-preset]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const title = form.querySelector("#title");
      const kind = form.querySelector("#kind");
      const want = form.querySelector("#want");
      if (title instanceof HTMLInputElement) title.value = chip.getAttribute("data-title") ?? "";
      if (kind instanceof HTMLSelectElement) kind.value = chip.getAttribute("data-kind") ?? "Other";
      if (want instanceof HTMLTextAreaElement) want.value = chip.getAttribute("data-want") ?? "";
      title?.focus();
    });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim() || "Feature request";
    const body = [
      `**Kind:** ${data.get("kind") ?? ""}`,
      `**Framework / runtime:** ${data.get("framework") ?? ""}`,
      `**Client:** ${data.get("client") ?? ""}`,
      `**OS / Node:** ${data.get("env") ?? ""}`,
      "",
      "## What should Baton do?",
      String(data.get("want") ?? "").trim(),
      "",
      "## What happens today?",
      String(data.get("today") ?? "").trim(),
    ].join("\n");
    const url = `${ISSUE_NEW}?labels=enhancement&title=${encodeURIComponent(`Request: ${title}`)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener");
  });
}

initSite();
