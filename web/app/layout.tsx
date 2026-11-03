import type { Metadata } from "next";
import { Geist, Inter } from "next/font/google";

import { getDayIconHref } from "../domain/day-logo";
import { READY_FIXED_LIGHT_PATHS, READY_THEME_STORAGE_KEY } from "../domain/theme";
import { workspaceDemoStorageBootScript } from "../domain/workspace-demo/demo-path";

import { Providers } from "./providers";

import "../presentation/styles/globals.css";
import "../presentation/components/relationship-memory.css";
import "../presentation/components/memory-stack/memory-stack.css";

const themeBootScript = `try{var p=location.pathname;var f=${JSON.stringify(READY_FIXED_LIGHT_PATHS)}.some(function(x){return x==='/'?p==='/':p===x||p.indexOf(x+'/')===0});var t=f?'light':localStorage.getItem(${JSON.stringify(READY_THEME_STORAGE_KEY)});if(t!=='dark'&&t!=='light')t='light';var r=document.documentElement;r.dataset.theme=t;r.classList.toggle('dark',t==='dark');r.style.colorScheme=t}catch(e){document.documentElement.dataset.theme='light'}`;

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

export const metadata: Metadata = {
  title: "Ready",
  description: "Video meetings with summaries and task workflows",
  icons: {
    icon: [{ url: getDayIconHref(), type: "image/svg+xml" }],
    shortcut: [getDayIconHref()],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${geist.variable}`} data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: workspaceDemoStorageBootScript }} />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
