import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Markdown to sanitized HTML. Output is always passed through DOMPurify. */
export function renderMarkdown(text: string): string {
  // Transcript text is untrusted. Links: http(s)/mailto only. The daemon also sends a strict CSP.
  return DOMPurify.sanitize(marked.parse(text, { async: false }), { ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i });
}
