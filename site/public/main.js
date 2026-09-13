// Theme toggle. The initial class is set inline in <head>.
document.getElementById("theme").addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark");
  try {
    localStorage.setItem("theme", dark ? "dark" : "light");
  } catch {}
});

const cmd = document.querySelector("[data-cmd-text]");
document.querySelector("[data-copy]").addEventListener("click", async (e) => {
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
    if (pkg?.version) document.getElementById("version").textContent = `v${pkg.version}`;
  })
  .catch(() => {});
