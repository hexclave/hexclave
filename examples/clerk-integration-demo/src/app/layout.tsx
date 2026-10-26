import type { Metadata } from "next";
import Script from "next/script";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clerk + Hexclave",
  description: "Clerk session exchange demo",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Script
          src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
          data-clerk-publishable-key={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
          strategy="beforeInteractive"
        />
        {children}
      </body>
    </html>
  );
}
