import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "shanghaitech-mcp",
  description: "ShanghaiTech campus MCP server",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          maxWidth: 760,
          margin: "4rem auto",
          padding: "0 1.25rem",
          lineHeight: 1.65,
        }}
      >
        {children}
      </body>
    </html>
  );
}
