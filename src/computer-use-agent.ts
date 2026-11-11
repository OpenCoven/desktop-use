import { COMPUTER_USE_TOOL_NAME } from "./tool-names.js";

export const COMPUTER_USE_AGENT = {
  id: "computer-use",
  name: "Computer Use",
  workspace: "~/.openclaw/workspace/computer-use",
  agentDir: "~/.openclaw/agents/computer-use/agent",
  memory: {
    store: "~/.openclaw/memory/computer-use.sqlite",
    mode: "agent-scoped",
  },
  auth: {
    inheritsMainOAuth: true,
    copyOAuthSecrets: false,
    binding: "per-agent auth order; OAuth refresh tokens stay in the owning profile store",
  },
  toolPolicy: {
    profile: "minimal",
    allow: [COMPUTER_USE_TOOL_NAME],
    deny: ["exec", "bash", "shell", "apply_patch"],
  },
  logs: {
    actions: "~/.openclaw/agents/computer-use/audit/computer-use.jsonl",
    health: "~/.openclaw/agents/computer-use/audit/health.jsonl",
  },
  auditLog: "~/.openclaw/agents/computer-use/audit/computer-use.jsonl",
  identityMarkdown: `# Computer Use

You are OpenCoven's dedicated local machine operator for OpenClaw.

Operate only through explicit OpenClaw tools, approval gates, gateway auth, and audit logs.
Inspect first, prefer accessibility or structured page/app state over raw coordinates, and report concise status.
No hidden automation. Never bypass macOS security prompts, never harvest credentials, and never send, delete, purchase, install, or change system settings without explicit approval.
Do not make the default OpenClaw agent inherit your machine-control powers.
`,
} as const;

export const COMPUTER_USE_HEALTH_CHECK = {
  tool: COMPUTER_USE_TOOL_NAME,
  args: { action: "health" },
} as const;

export const COMPUTER_USE_CONTROL_UI_DESCRIPTOR = {
  id: "computer-use-panel",
  surface: "settings",
  label: "Computer Use",
  description:
    "Dedicated OpenCoven computer-use agent health, permission, approval, action, and repair state.",
  placement: "agents.computer-use",
  requiredScopes: ["operator.read"],
  // Optional host integration metadata, not a state store or a gateway RPC.
  actions: {
    stop: { tool: COMPUTER_USE_TOOL_NAME, args: { action: "stop" } },
    runHealthCheck: { tool: COMPUTER_USE_TOOL_NAME, args: { action: "health" } },
  },
  stateSources: {
    health: { owner: "plugin", source: "health action result", availability: "after an explicit health call" },
    permissions: { owner: "plugin", source: "doctor result and permissionFlow", availability: "after a doctor or health call; backend evidence may be unavailable" },
    activeTarget: { owner: "host", source: "host-selected target", availability: "only when the host tracks a target; absent otherwise" },
    latestObservation: { owner: "host", source: "projection of inspect or screenshot results", availability: "after an observation; the plugin does not retain it" },
    pendingApprovals: { owner: "host", source: "gateway plugin approval events and pending requests", availability: "only with an authenticated gateway approval integration" },
    recentActions: { owner: "host", source: "projection of tool results or redacted action audit records", availability: "only when the host reads those records" },
    errors: { owner: "host", source: "projection of structured failed action results", availability: "after a failed call; the plugin has no error store" },
    repairHints: { owner: "plugin", source: "health result repairHints and permissionFlow", availability: "after an explicit health call" },
    controls: { owner: "host", source: "supported action mappings plus current tool access", availability: "only when the host can invoke the mapped tool under its normal policy" },
  },
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      health: {
        type: "object",
        properties: {
          state: { type: "string" },
          checkedAt: { type: "string" },
          adapter: { type: "string" },
          gateway: { type: "string" },
        },
      },
      permissions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            state: { type: "string" },
            repairHint: { type: "string" },
          },
        },
      },
      activeTarget: {
        type: "object",
        properties: {
          app: { type: "string" },
          windowTitle: { type: "string" },
          url: { type: "string" },
        },
      },
      latestObservation: {
        type: "object",
        properties: {
          summary: { type: "string" },
          capturedAt: { type: "string" },
          evidencePath: { type: "string" },
        },
      },
      pendingApprovals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            action: { type: "string" },
            risk: { type: "string" },
            target: { type: "string" },
          },
        },
      },
      recentActions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            timestamp: { type: "string" },
            action: { type: "string" },
            status: { type: "string" },
            target: { type: "string" },
            approvalId: { type: "string" },
          },
        },
      },
      errors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            occurredAt: { type: "string" },
          },
        },
      },
      repairHints: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            command: { type: "string" },
          },
        },
      },
      controls: {
        type: "object",
        properties: {
          stop: { type: "boolean" },
          runHealthCheck: { type: "boolean" },
        },
      },
    },
  },
} as const;
