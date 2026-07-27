import { app } from "../../../scripts/app.js";

let lastActivity = 0;
const report = (kind) => {
  const now = Date.now();
  if (now - lastActivity < 5000) return;
  lastActivity = now;
  fetch("/aitk/activity", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  }).catch(() => {});
};

app.registerExtension({
  name: "ai-toolkit.workspace-activity",
  async setup() {
    for (const eventName of ["pointerdown", "keydown", "wheel", "touchstart"]) {
      window.addEventListener(eventName, () => report(eventName), { passive: true });
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") report("visible");
    });
    const queuePrompt = app.queuePrompt.bind(app);
    app.queuePrompt = async (...args) => {
      report("prompt");
      return queuePrompt(...args);
    };
  },
});
