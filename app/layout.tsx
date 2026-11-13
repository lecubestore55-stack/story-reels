import "./globals.css";
import type { ReactNode } from "react";
import { LogoutButton } from "./ui";

export const metadata = { title: "Story Reels Studio" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a className="brand" href="/">▶ <span>Story Reels Studio</span></a>
          <LogoutButton />
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
