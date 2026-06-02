import type { Metadata } from "next";
import { SETTINGS_APP_NAME } from "@/lib/branding";
import "./globals.css";

export const metadata: Metadata = {
  title: SETTINGS_APP_NAME,
  description: `${SETTINGS_APP_NAME} — provider configuration, GPU deployment, and monitoring`,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
