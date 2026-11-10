import { DuplicatesTabs } from "./duplicates-tabs";

/** OPE-1597 — one Duplicates section, with its two work queues as tabs. */
export default function DuplicatesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <DuplicatesTabs />
      {children}
    </div>
  );
}
