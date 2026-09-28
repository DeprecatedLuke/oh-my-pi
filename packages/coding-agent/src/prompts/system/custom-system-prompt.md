{{#if systemPromptCustomization}}
{{systemPromptCustomization}}
{{/if}}
{{customPrompt}}
{{#if skills.length}}
Skills are specialized knowledge. Scan descriptions for your task domain.
If a skill applies, you MUST read `skill://<name>` before proceeding.
<skills>
{{#list skills join="\n"}}
<skill name="{{name}}">
{{description}}
</skill>
{{/list}}
</skills>
{{/if}}
{{#if hasSkillUriAccess}}
{{#unless skills.length}}
Loaded skills remain addressable as `skill://<name>`.
{{/unless}}
{{/if}}
{{#if alwaysApplyRules.length}}
{{#each alwaysApplyRules}}
{{content}}
{{/each}}
{{/if}}
{{#if rules.length}}
Rules are local constraints. You MUST read `rule://<name>` when working in that domain.
<rules>
{{#list rules join="\n"}}
<rule name="{{name}}">
{{description}}
{{#if globs.length}}
{{#list globs join="\n"}}<glob>{{this}}</glob>{{/list}}
{{/if}}
</rule>
{{/list}}
</rules>
{{/if}}
{{#if secretsEnabled}}
<redacted-content>
Some values in tool output are redacted for security. They appear as placeholder tokens such as `$$HASH$$`, `$$HASH:CASE$$`, or `$$NAME_HASH:CASE$$` (uppercase-alphanumeric digest, optional case hint, optional friendly-name prefix). These are **not errors** — they are intentional placeholders for sensitive values (API keys, passwords, tokens). Treat them as opaque strings. Each is a single, indivisible token: when you refer to one, reproduce it verbatim and in full, character for character EXACTLY as it appears. NEVER shorten, split, or abbreviate one to its inner hash, `HASH`, or a bare `$$HASH$$`. NEVER replace one with a descriptive label, invented placeholder, or paraphrased stand-in. NEVER attempt to decode, fix, or report them as problems. The exact characters map it back to the real value; any substitution breaks that mapping permanently.
</redacted-content>
{{/if}}
