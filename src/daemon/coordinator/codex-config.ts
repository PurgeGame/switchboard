// Codex 0.160.1: the catalog can enable built-ins even when feature flags are off.
// Both layers are restricted. The offline wire test checks the actual model tool surface.
export const CODEX_VERSION = "codex-cli 0.160.1";
export const CODEX_MODELS = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"] as const;

/** Standard API-equivalent budget rates, USD / million tokens, checked 2026-10-07.
 * https://developers.openai.com/api/docs/models/compare
 * https://developers.openai.com/api/docs/pricing
 * Codex login usage reports tokens, not dollars; these are estimates, not subscription charges.
 */
const RATES: Record<string, [number, number, number]> = {
  "gpt-6-astra": [10, 1, 50],
  "gpt-6.1-sol": [2, 0.1, 10],
  "gpt-6-sol": [2, 0.2, 10],
  "gpt-6-luna": [0.1, 0.01, 0.5],
};

export interface CodexTokens {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
}

export function codexCost(model: string, u: CodexTokens): number {
  const rates = RATES[model];
  if (!rates) throw new Error(`No coordinator budget rate for Codex model ${model}; choose ${CODEX_MODELS.join(", ")}`);
  const { inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: write = 0, outputTokens: output } = u;
  if (![input, cached, write, output].every((n) => Number.isSafeInteger(n) && n >= 0) || cached + write > input)
    throw new Error("invalid Codex token usage; stopping to preserve the budget cap");
  const [i, c, o] = rates;
  return ((input - cached - write) * i + cached * c + write * i * 1.25) * (input > 272_000 ? 2 : 1) / 1e6
    + output * o * (input > 272_000 ? 1.5 : 1) / 1e6;
}

export const CODEX_RESTRICTIONS: Record<string, unknown> = {
  model_provider: "openai",
  forced_login_method: "chatgpt",
  cli_auth_credentials_store: "file",
  approval_policy: "never",
  sandbox_mode: "read-only",
  service_tier: "default",
  project_doc_max_bytes: 0,
  web_search: "disabled",
  "tools.update_plan.enabled": false,
  "tools.experimental_request_user_input.enabled": false,
  "skills.include_instructions": false,
  "features.skip_host_skill_discovery": true,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  include_environment_context: false,
  ...Object.fromEntries([
    "shell_tool", "apply_patch_freeform", "unified_exec", "code_mode", "code_mode_only", "view_image",
    "multi_agent", "multi_agent_v2", "apps", "plugins", "hooks", "plugin_hooks", "js_repl", "image_generation",
    "memories", "goals", "sleep_tool", "exec_permission_approvals", "request_permissions_tool", "tool_search",
    "skill_search", "search_tool", "remote_models", "collaboration_modes", "default_mode_request_user_input",
    "browser_use", "computer_use", "shell_snapshot", "shell_snapshot_v2", "undo", "remote_control",
    "tool_suggest", "skill_mcp_dependency_install", "enable_fanout", "send_message_to_user_async",
  ].map((f) => [`features.${f}`, false])),
};

/** No provider/project instructions, patch/shell tools, code-mode tools or child agents. */
export function restrictedCodexCatalog(catalog: any, model: string) {
  codexCost(model, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  const m = catalog?.models?.find((m: any) => m.slug === model);
  if (!m) throw new Error(`Installed Codex catalog has no model ${model}`);
  return { models: [{ ...m, shell_type: "disabled", apply_patch_tool_type: null, experimental_supported_tools: [],
    tool_mode: "direct", multi_agent_version: null, multi_agent_reasoning_effort: null, use_responses_lite: false,
    model_messages: null, base_instructions: "", supports_search_tool: false }] };
}

/** TOML values for argv, never shell text. */
export function toml(value: unknown): string {
  if (value === null) throw new Error("TOML has no null");
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
