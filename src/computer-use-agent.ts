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
    allow: ["computer_use"],
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
  tool: "computer_use",
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
          pause: { type: "boolean" },
          stop: { type: "boolean" },
          revokeApproval: { type: "boolean" },
          clearTarget: { type: "boolean" },
          runHealthCheck: { type: "boolean" },
        },
      },
    },
  },
} as const;
