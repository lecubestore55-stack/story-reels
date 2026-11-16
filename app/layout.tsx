import "./globals.css";
import type { ReactNode } from "react";
import { LogoutButton } from "./ui";
import { Tabs, ThemeToggle } from "./nav";

export const metadata = { title: "Reels Studio" };

// Set the saved theme before the page paints, so there is no flash.
const themeScript = `try{var t=localStorage.getItem("theme");if(!t)t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <header className="topbar">
          <a className="brand" href="/"><span className="logo">▶</span>Reels Studio</a>
          <Tabs />
          <div className="tools">
            <ThemeToggle />
            <LogoutButton />
          </div>
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
