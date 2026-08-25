import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mallanet Control Plane",
  description: "Global deployment operations for Mallanet",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
