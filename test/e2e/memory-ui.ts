// Shared Settings exercise: run against real HTTP/SQLite in run.ts and authority.ts,
// and the phone harness at touch width. No models or live sessions involved.
import type { Page, Locator } from "playwright-core";

async function tap(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  const viewport = page.viewportSize()!;
  if (!box || box.width < 44 || box.height < 44 || box.x < 0 || box.x + box.width > viewport.width || box.y < 0 || box.y + box.height > viewport.height)
    throw Error(`Memory control is not a reachable 44px touch target: ${JSON.stringify(box)}`);
  await target.click();
}

export async function memoryUI(page: Page) {
  const original = "Use a short release summary with the checked files.";
  const edited = "Use a concise release summary with the checked files and test results.";
  const settings = () => page.getByRole("dialog", { name: "Settings", exact: true });
  const memory = () => settings().getByRole("region", { name: "Coordinator memory", exact: true });
  const open = async () => { await page.getByRole("button", { name: "Settings", exact: true }).click(); await memory().getByText(/lessons · about/).waitFor(); };
  await open();
  await tap(page, memory().getByRole("button", { name: "Add lesson", exact: true }));
  await memory().getByLabel("Lesson", { exact: true }).fill(original);
  await memory().getByLabel("Category", { exact: true }).selectOption("repo-specific");
  await memory().getByLabel("Repository path (optional)", { exact: true }).fill("/sim/memory-ui/repository");
  await memory().getByLabel("Source", { exact: true }).fill("chat #phone-memory-test");
  await tap(page, memory().getByRole("button", { name: "Save lesson", exact: true }));
  await memory().getByText(original, { exact: true }).waitFor();
  await page.reload();
  await open();
  await memory().getByText(original, { exact: true }).waitFor();
  await memory().getByText("Source: chat #phone-memory-test", { exact: true }).waitFor();
  await tap(page, memory().getByRole("button", { name: `Edit lesson: ${original}`, exact: true }));
  if (await memory().getByLabel("Repository path (optional)").inputValue() !== "/sim/memory-ui/repository") throw Error("Editing lost repo path");
  await memory().getByLabel("Lesson", { exact: true }).fill(edited);
  await tap(page, memory().getByRole("button", { name: "Save lesson", exact: true }));
  await memory().getByText(edited, { exact: true }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error("Memory editor overflows horizontally");
  await tap(page, memory().getByRole("button", { name: `Delete lesson: ${edited}`, exact: true }));
  await memory().getByText(edited, { exact: true }).waitFor({ state: "detached" });
  await page.reload();
  await open();
  if (await memory().getByText(edited, { exact: true }).count()) throw Error("Deleted lesson reappeared");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}
