import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Personal 3D Activity Tracker",
  description: "3D Activity Tracker & Route Builder",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id">
      <body className="antialiased select-none">{children}</body>
    </html>
  );
}
