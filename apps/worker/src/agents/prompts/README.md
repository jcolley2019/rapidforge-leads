# Agent prompts

One prompt module per LLM agent (CLAUDE.md 6.6). Cascading variables
(`{your_offer}`, `{target_industry}`, `{ideal_website_traits}`,
`{sales_tone}`, `{user_location}`, `{user_brand}`) come from
`workspace_config` through ONE shared template function — never hardcoded
in prompt text (CLAUDE.md 6.4).

Populated starting Sprint 3 (Filter edge-pass, audit summaries).
