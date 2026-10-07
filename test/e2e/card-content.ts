import type { Locator, Page } from "playwright-core";

export const longCardText = [
  "Finished the update. Run `bun run typecheck` before approving.",
  "This line break belongs to the same paragraph.",
  "",
  "- Paragraphs and bullets stay readable.",
  "- The action buttons stay below the result.",
  "",
  ...Array.from({ length: 48 }, (_, i) => `Review detail ${i + 1}: confirmed the complete output is available before approval.`),
  "",
  `Long path: \`src/${"nested/".repeat(20)}result.ts\``,
  "",
  "END OF THE COMPLETE RESULT: the final detail is available.",
].join("\n");

/** A real overflowing card, including its final line, formatting, and stationary actions. */
export async function checkFullCard(page: Page, card: Locator, label: string, buttons: string[]) {
  const content = card.getByRole("region", { name: label, exact: true });
  await content.waitFor({ timeout: 10_000 });
  const text = await content.innerText();
  if (!text.includes("END OF THE COMPLETE RESULT") || text.includes("…")) throw new Error(`${label}: text was truncated`);
  for (let i = 1; i <= 48; i++) if (!text.includes(`Review detail ${i}:`)) throw new Error(`${label}: missing detail ${i}`);
  if (await content.locator("code", { hasText: "bun run typecheck" }).count() !== 1) throw new Error(`${label}: inline code was not rendered`);
  if (await content.locator("ul > li").count() < 2) throw new Error(`${label}: bullets were not rendered`);
  const paragraph = content.locator("p").first();
  if (!(await paragraph.textContent())?.includes("approving.\nThis line break")) throw new Error(`${label}: line break was lost`);
  if (await paragraph.evaluate((e) => getComputedStyle(e).whiteSpace) !== "pre-wrap") throw new Error(`${label}: line break is collapsed`);
  const geometry = await content.evaluate((e) => {
    const s = getComputedStyle(e);
    return { height: e.clientHeight, total: e.scrollHeight, width: e.clientWidth, totalWidth: e.scrollWidth, track: (e as HTMLElement).offsetWidth - e.clientWidth, max: parseFloat(s.maxHeight), overflow: s.overflowY, gutter: s.scrollbarGutter, scrollbar: s.scrollbarWidth, clamp: s.webkitLineClamp, ellipsis: s.textOverflow };
  });
  if (geometry.total <= geometry.height || geometry.height <= 0 || geometry.max > page.viewportSize()!.height * 0.4 + 1 || geometry.overflow !== "auto") throw new Error(`${label}: not a bounded scroll area: ${JSON.stringify(geometry)}`);
  if (geometry.gutter !== "stable" || geometry.scrollbar === "none" || geometry.track < 6) throw new Error(`${label}: missing visible scrollbar`);
  if (geometry.clamp !== "none" || geometry.ellipsis === "ellipsis") throw new Error(`${label}: CSS truncates text`);
  if (geometry.totalWidth > geometry.width + 1) throw new Error(`${label}: long code overflows horizontally`);
  const actions = card.locator(".needs-you-actions");
  if (await content.locator("button").count()) throw new Error(`${label}: actions are inside the scroll area`);
  // Check immediately after expansion: the outer list must not clip the text or actions.
  const visible = await content.evaluate((e) => {
    const r = e.getBoundingClientRect();
    for (let p = e.parentElement; p; p = p.parentElement) {
      if (!/auto|scroll|hidden|clip/.test(getComputedStyle(p).overflowY)) continue;
      const bounds = p.getBoundingClientRect();
      const top = bounds.top + p.clientTop;
      if (r.top < top - 1 || r.bottom > top + p.clientHeight + 1) return false;
    }
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  if (!visible) throw new Error(`${label}: the outer list clips the text area`);
  const area = await content.boundingBox();
  const before = await actions.boundingBox();
  if (!area || !before || area.y + area.height > before.y + 1) throw new Error(`${label}: actions cover the text`);
  for (const fraction of [0, 0.5, 1]) {
    await content.evaluate((e, f) => e.scrollTop = (e.scrollHeight - e.clientHeight) * f, fraction);
    for (const name of buttons) await actions.getByRole("button", { name, exact: true }).click({ trial: true, timeout: 5_000 });
    const after = await actions.boundingBox();
    if (!before || !after || Math.abs(after.y - before.y) > 1) throw new Error(`${label}: scrolling moved the actions`);
    if (after.x < 0 || after.x + after.width > page.viewportSize()!.width + 1 || after.y < 0 || after.y + after.height > page.viewportSize()!.height) throw new Error(`${label}: actions are off screen`);
  }
  const tailVisible = await content.evaluate((e) => {
    const tail = e.querySelector(".needs-you-text > :last-child")!.getBoundingClientRect();
    const area = e.getBoundingClientRect();
    return tail.top >= area.top - 1 && tail.bottom <= area.bottom + 1;
  });
  if (!tailVisible) throw new Error(`${label}: scrolling cannot reveal the final line`);
}
