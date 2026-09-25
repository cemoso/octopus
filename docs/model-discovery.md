# Model discovery

The existing pg-boss scheduler checks configured provider catalogs daily at 07:00 UTC. It stores the latest check in SystemConfig.modelDiscovery; the vendor Models page displays that result without requiring a manual pull. Refresh performs the existing on-demand read. A failed provider is shown as unavailable, never as an empty authoritative catalog or automatic retirement.

Discovery does not enable models, change defaults, replace pins or send mail. Provider lists often lack prices and compatibility details. Review them before using the existing add-model controls. A newly released model can change its request contract: Opus 5.5 requires native JSON-schema output instead of forced tool selection. Provider/API failures remain visible and the last-check timestamp exposes stale or absent scheduling.

Claude Opus 5.5 is an opt-in catalog entry. Official model ID claude-opus-5-5, input/output $4/$20 per million tokens, cache read $0.20, 5m/1h writes $5/$8. Existing platform markup applies. Native JSON output uses output_config.format and adaptive thinking; earlier model behavior is unchanged. No customer defaults or pins change.

Sources (verified September25,2026):
- https://platform.claude.com/docs/en/models/opus-5-5/overview
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://www.anthropic.com/claude-opus-5-5

Deploy the main application and additive migration before the admin UI. Verify the actual catalog row, request adapter tests, persisted scheduled check and authenticated cached response; a schedule declaration alone does not prove a completed discovery. The subscriber touchbase template is prepared separately in octopus-admin. Do not send it until release availability and the opted-in audience are verified and a send is authorized.
