import { z } from "zod";

const toolRuleSchema = z.object({
	/** Tool name or glob pattern (e.g. "read_file", "github_*") */
	tool: z.string(),
	/** Whether this tool is allowed */
	allow: z.boolean().default(true),
	/** If true, only read operations are permitted */
	readOnly: z.boolean().optional(),
});

export const policyConfigSchema = z.object({
	/** Policy version for forward compatibility */
	version: z.literal(1),
	/** Default action when no rule matches */
	defaultAction: z.enum(["allow", "deny"]).default("deny"),
	/** Ordered list of tool rules — first match wins */
	rules: z.array(toolRuleSchema),
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;
export type ToolRule = z.infer<typeof toolRuleSchema>;
