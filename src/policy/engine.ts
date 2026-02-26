import type { PolicyConfig, ToolRule } from "./schema.js";

export interface PolicyDecision {
	allowed: boolean;
	reason: string;
	matchedRule?: ToolRule;
}

/**
 * Evaluates tool calls against a set of policy rules.
 * First matching rule wins. Falls back to defaultAction if no rule matches.
 */
export class PolicyEngine {
	private readonly config: PolicyConfig;

	constructor(config: PolicyConfig) {
		this.config = config;
	}

	/** Evaluate whether a tool call is allowed. */
	evaluate(toolName: string): PolicyDecision {
		for (const rule of this.config.rules) {
			if (this.matchesTool(rule.tool, toolName)) {
				return {
					allowed: rule.allow,
					reason: rule.allow ? `Allowed by rule: ${rule.tool}` : `Denied by rule: ${rule.tool}`,
					matchedRule: rule,
				};
			}
		}

		const allowed = this.config.defaultAction === "allow";
		return {
			allowed,
			reason: `No matching rule — default action: ${this.config.defaultAction}`,
		};
	}

	/** Simple glob matching: supports trailing * only (e.g. "github_*"). */
	private matchesTool(pattern: string, toolName: string): boolean {
		if (pattern === "*") return true;
		if (pattern.endsWith("*")) {
			return toolName.startsWith(pattern.slice(0, -1));
		}
		return pattern === toolName;
	}
}
