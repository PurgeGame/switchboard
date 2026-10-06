import { useState } from "react";
import { uploadImage, uploadUrl } from "../api.ts";
import { StatusIcon, XIcon } from "./Icons.tsx";

export interface Attachment {
  id: string;
  path: string | null;
  preview: string;
  status: "uploading" | "ready" | "error";
  error?: string;
}

export function Thumbnails({ paths, size = 56 }: { paths: string[]; size?: number }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {paths.map((p) => (
        <a key={p} href={uploadUrl(p)} target="_blank" rel="noreferrer" title={p}>
          <img src={uploadUrl(p)} alt="Attached image" style={{ width: size, height: size }} className="rounded border border-line object-cover" />
        </a>
      ))}
    </div>
  );
}

export function AttachmentStrip({ items, onRemove }: { items: Attachment[]; onRemove: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((a) => (
        <li key={a.id} className={`relative h-14 w-14 overflow-hidden rounded border ${a.status === "error" ? "border-red" : "border-line-strong"}`}>
          <img src={a.preview} alt="Attached image" className={`h-full w-full object-cover ${a.status === "ready" ? "" : "opacity-40"}`} />
          {a.status === "uploading" && (
            <span className="absolute inset-0 flex items-center justify-center text-ink" role="status" aria-label="Uploading">
              <StatusIcon name="spinner" spin width={18} height={18} />
            </span>
          )}
          {a.status === "error" && (
            <span className="absolute inset-x-0 bottom-0 bg-red px-0.5 text-center text-[9px] font-medium text-[#10141a]" title={a.error}>
              failed
            </span>
          )}
          <button
            onClick={() => onRemove(a.id)}
            aria-label="Remove image"
            className="absolute right-0.5 top-0.5 rounded-full bg-bg/80 p-0.5 text-ink hover:bg-bg"
          >
            <XIcon width={10} height={10} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Image attachments that upload as soon as they are added (paste, drop or file picker). */
export function useAttachments(initialPaths: string[] = []) {
  const [items, setItems] = useState<Attachment[]>(() =>
    initialPaths.map((p) => ({ id: p, path: p, preview: uploadUrl(p), status: "ready" as const })),
  );

  const attach = (files: File[]) => {
    for (const file of files.filter((f) => f.type.startsWith("image/"))) {
      const id = crypto.randomUUID();
      setItems((a) => [...a, { id, path: null, preview: URL.createObjectURL(file), status: "uploading" }]);
      uploadImage(file)
        .then((u) => setItems((a) => a.map((x) => (x.id === id ? { ...x, path: u.path, status: "ready" } : x))))
        .catch((err: Error) => setItems((a) => a.map((x) => (x.id === id ? { ...x, status: "error", error: err.message } : x))));
    }
  };

  return {
    items,
    attach,
    remove: (id: string) => setItems((a) => a.filter((x) => x.id !== id)),
    clear: () => setItems([]),
    uploading: items.some((a) => a.status === "uploading"),
    paths: items.flatMap((a) => (a.status === "ready" && a.path ? [a.path] : [])),
  };
}

/** Handlers that feed pasted or dropped images into attach(). */
export function imageDropProps(attach: (files: File[]) => void) {
  return {
    onPaste: (e: React.ClipboardEvent) => {
      const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
      if (files.length > 0) {
        e.preventDefault();
        attach(files);
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      attach([...e.dataTransfer.files]);
    },
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
  };
}
