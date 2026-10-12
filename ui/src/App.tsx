import { useState } from "react";
import Doctor from "./components/Doctor.tsx";

export default function App() {
  const [ready, setReady] = useState(false);

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">WP Site Builder</h1>
        <p className="mt-1 text-slate-600">
          Describe a site, and it is built in WordPress with Elementor pages, a theme,
          and plugins — no wp-admin clicking.
        </p>
      </header>

      <div className="space-y-6">
        <Doctor onReadyChange={setReady} />

        <section className="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-slate-200">
          <h2 className="font-semibold">Build a site</h2>
          <p className="mt-1 text-sm text-slate-600">
            {ready
              ? "Environment looks good. The site form lands here next."
              : "Waiting on the environment checks above."}
          </p>
        </section>
      </div>
    </div>
  );
}
