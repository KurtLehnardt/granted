"use client";

import CrashNotice from "@/components/CrashNotice";

// The app's React error boundary (Next.js): a render error anywhere under the
// root layout lands here — logged, with its id and a "Report this problem" link.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <CrashNotice error={error} reset={reset} />;
}
