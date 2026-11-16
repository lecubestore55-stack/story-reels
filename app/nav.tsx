"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "📖 Stories", match: (p: string) => p === "/" || p.startsWith("/references") },
  { href: "/recipes", label: "🍰 Recipe reels", match: (p: string) => p === "/recipes" },
  { href: "/recipes/mine", label: "🔗 From my recipe", match: (p: string) => p.startsWith("/recipes/mine") },
];

export function Tabs() {
  const path = usePathname() || "/";
  return (
    <nav className="tabs">
      {TABS.map((t) => (
        <a key={t.href} href={t.href} className={t.match(path) ? "active" : ""}>{t.label}</a>
      ))}
    </nav>
  );
}

/** Light / dark switch, remembered in this browser. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem("theme"); } catch {}
    const t = saved === "light" || saved === "dark" ? saved : window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
    setTheme(t);
    document.documentElement.dataset.theme = t;
  }, []);
  return (
    <button className="theme-toggle" title="Light / dark" onClick={() => {
      const t = theme === "dark" ? "light" : "dark";
      setTheme(t);
      document.documentElement.dataset.theme = t;
      try { localStorage.setItem("theme", t); } catch {}
    }}>{theme === "dark" ? "☀️" : "🌙"}</button>
  );
}
