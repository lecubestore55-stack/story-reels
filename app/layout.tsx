import "./globals.css";
import type { ReactNode } from "react";
import { LogoutButton } from "./ui";

export const metadata = { title: "Story Reels Studio" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a className="brand" href="/">▶ <span>Reels Studio</span></a>
          <nav className="tabs">
            <a href="/">📖 Stories</a>
            <a href="/recipes">🍰 Recipes</a>
            <a href="/recipes/mine">🔗 From my recipe</a>
          </nav>
          <LogoutButton />
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
