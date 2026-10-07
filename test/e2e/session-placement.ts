import type { Page, Request } from "playwright-core";

/** Exercise the same controls with mouse clicks on desktop and real taps on a phone. */
export async function checkSessionPlacement(page: Page, sessionId: string, project: string, phone = false) {
  const timeout = 10_000;
  const rowSelector = `[data-session-id="${sessionId}"]`;
  const main = page.getByRole("region", { name: `Project ${project}`, exact: true, includeHidden: true });
  const background = page.getByRole("region", { name: "Background agents", exact: true });
  const row = page.locator(rowSelector);
  const menu = () => row.locator("..").getByRole("button", { name: /^Actions for / });
  const activate = async (loc: ReturnType<Page["locator"]>) => {
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.boundingBox();
    if (!box || box.x < 0 || box.x + box.width > page.viewportSize()!.width) throw Error("placement control is off screen");
    if (phone && box.height < 44) throw Error("placement control is too small to tap");
    if (phone) await loc.tap();
    else await loc.click();
  };
  const showList = async () => {
    if (phone && await page.getByRole("button", { name: "Back to session list" }).isVisible()) {
      await page.getByRole("button", { name: "Back to session list" }).tap();
    }
  };
  const mutations: string[] = [];
  const onRequest = (r: Request) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith("/api/") && !["GET", "HEAD"].includes(r.method()) && path !== "/api/ws-ticket") mutations.push(path);
  };
  page.on("request", onRequest);
  try {
    await showList();
    const expand = background.getByRole("button", { name: /^Background agents/ });
    if (await expand.getAttribute("aria-expanded") !== "true") await expand.click();
    await background.locator(rowSelector).waitFor({ timeout });
    const selected = await page.locator('[data-session-id][aria-current="true"]').getAttribute("data-session-id");
    await activate(menu());
    await page.getByRole("menuitem", { name: "Pin to main", exact: true }).waitFor({ timeout });
    // Escape dismisses the menu without changing placement or opening the session.
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden", timeout });
    await background.locator(rowSelector).waitFor({ timeout });
    await activate(menu());
    await activate(page.getByRole("menuitem", { name: "Pin to main", exact: true }));
    await main.locator(rowSelector).waitFor({ timeout });
    if (await background.locator(rowSelector).count()) throw Error("pinned session is still duplicated in Background agents");
    if (await page.locator('[data-session-id][aria-current="true"]').getAttribute("data-session-id") !== selected) throw Error("the row menu changed the selected session");
    await page.reload();
    await showList();
    await main.locator(rowSelector).waitFor({ timeout });

    await activate(menu());
    await activate(page.getByRole("menuitem", { name: "Move to background", exact: true }));
    await background.locator(rowSelector).waitFor({ timeout });
    if (await main.locator(rowSelector).count()) throw Error("session still appears in main after sending it back");
    await page.reload();
    await showList();
    await background.locator(rowSelector).waitFor({ timeout });

    // The session view offers both actions too, without changing the open conversation.
    const heading = await row.locator(".font-medium").first().innerText();
    if (phone) await row.tap();
    else await row.click();
    await page.getByRole("heading", { name: heading, exact: true }).waitFor({ timeout });
    await activate(page.getByRole("button", { name: "Pin to main", exact: true }));
    await page.getByRole("button", { name: "Move to background", exact: true }).waitFor({ timeout });
    await main.locator(rowSelector).waitFor({ state: "attached", timeout });
    await page.reload();
    await page.getByRole("button", { name: "Move to background", exact: true }).waitFor({ timeout });
    await page.getByRole("heading", { name: heading, exact: true }).waitFor({ timeout });
    await activate(page.getByRole("button", { name: "Move to background", exact: true }));
    await page.getByRole("button", { name: "Pin to main", exact: true }).waitFor({ timeout });
    await showList();
    await background.locator(rowSelector).waitFor({ timeout });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error("placement UI overflows sideways");
    if (mutations.length) throw Error(`placement sent backend mutations: ${mutations.join(", ")}`);
  } finally {
    page.off("request", onRequest);
    await showList();
  }
}
