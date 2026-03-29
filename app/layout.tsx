import type { Metadata } from "next";
import { Space_Grotesk, Source_Serif_4 } from "next/font/google";

import "./globals.css";
import { Providers } from "./providers";

const displayFont = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
});

const bodyFont = Source_Serif_4({
  variable: "--font-body",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PFM Generative UI Demo",
  description: "Demonstrateur Personal Financial Management avec CopilotKit + LangGraph",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" className={`${displayFont.variable} ${bodyFont.variable} h-full`}>
      <body className="min-h-full antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

