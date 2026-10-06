import { useState } from "react";
import { CopyIcon } from "./Icons.tsx";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => undefined);
  };
  return (
    <button onClick={copy} aria-label={label} title={label} className="ml-1.5 inline-flex rounded p-1 align-middle text-ink-3 hover:bg-hover hover:text-ink">
      {copied ? <span className="text-[10px]">Copied</span> : <CopyIcon width={12} height={12} />}
    </button>
  );
}
