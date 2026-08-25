import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "定时任务控制台",
  description: "定时任务管理器 · 自然语言调度 · http/noop 任务 · API 令牌",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
