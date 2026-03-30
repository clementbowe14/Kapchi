import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Geist, Geist_Mono } from "next/font/google";
import { Navbar } from "@/components/Navbar";
import { getClerkPublishableKey } from "@/lib/clerk";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Kapchi",
  description: "Kapchi authentication flow powered by Clerk.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground">
        <ClerkProvider publishableKey={getClerkPublishableKey()}>
          <div className="flex min-h-screen flex-col">
            <Navbar />
            <div className="flex flex-1 flex-col">{children}</div>
          </div>
        </ClerkProvider>
      </body>
    </html>
  );
}
