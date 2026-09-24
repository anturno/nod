// Theme toggle. The initial class is set inline in <head>.
document.getElementById("theme").addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark");
  try {
    localStorage.setItem("theme", dark ? "dark" : "light");
  } catch {}
});

const cmd = document.querySelector("[data-cmd-text]");
document.querySelector("[data-copy]")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(cmd.textContent);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Select to copy";
  }
  setTimeout(() => (btn.textContent = "Copy"), 1600);
});

// Current version from package.json on main; the static value stays if this fails.
fetch("https://raw.githubusercontent.com/anturno/nod/main/package.json")
  .then((r) => (r.ok ? r.json() : null))
  .then((pkg) => {
    const el = document.getElementById("version");
    if (pkg?.version && el) el.textContent = `v${pkg.version}`;
  })
  .catch(() => {});

// Terminal demo: type the two prompt lines, then reveal the rest line by line, and loop.
// Without JS or with reduced motion, the full transcript shows as static text.
const demo = document.querySelector("[data-demo]");
if (demo && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const lines = demo.innerHTML.split("\n");
  const typed = (line, n) => line.replace(/(<span class="text-fg">)([^<]*)(<\/span>)$/, (_, a, t, c) => a + t.slice(0, n) + c);
  const textLength = (line) => line.match(/<span class="text-fg">([^<]*)<\/span>$/)?.[1].length ?? 0;
  const caret = '<span class="caret"></span>';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  demo.style.minHeight = `${demo.offsetHeight}px`;

  (async () => {
    for (;;) {
      const shown = [];
      for (const i of [0, 1]) {
        for (let n = 0; n <= textLength(lines[i]); n++) {
          demo.innerHTML = [...shown, typed(lines[i], n) + caret].join("\n");
          await wait(i === 0 ? 90 : 28);
        }
        shown.push(lines[i]);
        await wait(450);
      }
      for (const line of lines.slice(2)) {
        shown.push(line);
        demo.innerHTML = shown.join("\n");
        await wait(line.includes("●") ? 520 : 140);
      }
      await wait(4500);
    }
  })();
}
