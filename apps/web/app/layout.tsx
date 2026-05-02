import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "asor",
  description: "Multi-agent orchestrator on Gemini CLI",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 min-h-screen antialiased">{children}</body>
    </html>
  );
}
