import type { Page } from "playwright-core";

/** Same Settings flow on the isolated daemon and the phone fixture. */
export async function usageSettingsUI(page: Page) {
  const open = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Low remaining (%)", { exact: true }).waitFor();
  };
  await open();
  const low = page.getByLabel("Low remaining (%)", { exact: true });
  const original = await low.inputValue();
  await low.fill("27");
  const save = page.getByRole("button", { name: "Save usage thresholds", exact: true });
  await save.scrollIntoViewIfNeeded();
  const b = await save.boundingBox();
  if (!b || b.height < 44 || b.width < 44 || b.x < 0 || b.x + b.width > page.viewportSize()!.width) throw Error("Usage settings save is not a reachable touch target");
  await save.click();
  await page.getByText("Saved. Applies to the next recommendation.", { exact: true }).waitFor();
  await page.reload();
  await open();
  if (await low.inputValue() !== "27") throw Error("Usage thresholds did not persist across reload");
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error("Usage settings overflow horizontally");
  await low.fill(original);
  await save.click();
  await page.getByText("Saved. Applies to the next recommendation.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}
