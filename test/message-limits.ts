// The default per-session message limits. Fixtures whose tests check how those limits work set
// them explicitly, so they keep working whatever the defaults are.
export const MESSAGE_LIMITS = { perSessionCooldownMs: 10 * 60_000, perSessionPerHour: 6 };
export const withMessageLimits = (cfg: any = {}) => ({ ...cfg, limits: { ...MESSAGE_LIMITS, ...(cfg.limits ?? {}) } });
