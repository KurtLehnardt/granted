"use client";

import "./globals.css";
import CrashNotice from "@/components/CrashNotice";

// The last-resort boundary: an error in the root layout itself. It replaces
// the whole document, so it brings its own <html> and <body>.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="font-body antialiased">
        <CrashNotice error={error} reset={reset} />
      </body>
    </html>
  );
}
