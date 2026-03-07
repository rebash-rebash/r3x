import { createSignal, createEffect } from "solid-js";

type Theme = "dark" | "light";

const stored = typeof localStorage !== "undefined" ? localStorage.getItem("r3x-theme") : null;
const [theme, setTheme] = createSignal<Theme>((stored as Theme) || "dark");

createEffect(() => {
  const t = theme();
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("r3x-theme", t);
});

export function toggleTheme() {
  setTheme((prev) => (prev === "dark" ? "light" : "dark"));
}

export { theme };
