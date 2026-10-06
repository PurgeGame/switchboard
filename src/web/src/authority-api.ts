/** Human-only controls. The server's authenticated principal supplies authority, never JSON fields. */
export async function authorityPost(path: string, body: unknown) {
  const r = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error ?? `HTTP ${r.status}`);
  return data;
}
