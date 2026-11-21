import { ChevronLeft } from "lucide-react";
import { findPaper, BookBody } from "../V2Paper";
import { ReadOnly } from "../V2Controls";
import { link } from "./route";

// A paper book on the phone: a back link to home, then the book's own page, its settings view-only
// (they're changed on the full site).

export default function MobileBook({ id }) {
  const m = findPaper(id);
  return (
    <div className="flex flex-col gap-2">
      <a href="/mobile" onClick={link("/mobile")} className="-ml-1 flex w-fit items-center gap-1 py-1 text-sm font-medium" style={{ color: "var(--accent)" }}>
        <ChevronLeft className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        Paper books
      </a>
      {m ? (
        <>
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
            {m.group.title}
          </p>
          <ReadOnly>
            <BookBody m={m} />
          </ReadOnly>
          <p className="mt-2 text-[0.6875rem]" style={{ color: "var(--faint)" }}>Settings are view-only here: change them on the full site.</p>
        </>
      ) : (
        <p className="text-sm" style={{ color: "var(--muted)" }}>No such paper book.</p>
      )}
    </div>
  );
}
