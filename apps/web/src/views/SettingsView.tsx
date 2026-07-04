import { StubView } from "./StubView";

export function SettingsView() {
  return (
    <StubView
      sprint="Lands Sprint 5"
      title="Settings"
      description="Workspace settings and the cascading agent variables (your_offer, target_industry, ideal_website_traits, sales_tone, user_location, user_brand) from workspace_config. API keys are NOT here — they live in the worker env only."
    />
  );
}
