# UI-managed runtime configuration design

## Goal

Move operator-managed service configuration from environment variables into the desktop settings UI. Secrets are encrypted in PostgreSQL, never returned to the browser, and automatically applied by the Worker without restarting containers.

This is deliberately a small configuration center, not a generic environment-variable editor.

## Scope

### Managed in the settings UI

- Runtime mode: mock/live, Worker concurrency, retry policy.
- Image route: Headless or Canvas.
- Headless planner: base URL, model, API key.
- Headless image provider: base URL, model, API key.
- Canvas: base URL, canvas ID, workflow name, API key, daily limit.
- Listing LLM: base URL, model, API key.
- Exchange-rate service: base URL.
- Miaoshou: base URL, app key, app secret, account ID, authorization value, cookie.
- Asset publishing: S3-compatible endpoint, region, bucket, access-key ID, secret-access key, public base URL.
- Browser extension token.

### Kept as deployment configuration

- PostgreSQL connection URLs.
- `CONFIG_ENCRYPTION_KEY`, the single master key used to encrypt stored secrets.
- Node environment, application ports, Docker volume mounts and LAN/network safety controls.
- Local operator identity and low-level Worker lease timing.

Deployment fields may be displayed as read-only diagnostics when useful, but cannot be edited in the browser.

## Chosen architecture

PostgreSQL is the source of truth for operator-managed runtime configuration. The existing singleton `workspace_settings` record remains the public settings record and gains:

- a structured service-configuration JSON document for non-secret values;
- one authenticated encrypted envelope containing all secret values;
- the existing optimistic `version`, incremented for every successful save.

A singleton runtime-application status record stores the latest Worker-applied version, state, safe error code and update time. It does not store secret values or raw provider responses.

The web and Worker receive the database URL and encryption master key at startup. All provider configuration is then loaded from PostgreSQL.

## Secret storage

- Use AES-256-GCM with a random nonce for every save.
- Require a 32-byte master key supplied as base64 through `CONFIG_ENCRYPTION_KEY`.
- Store a versioned envelope containing the nonce, authentication tag and ciphertext.
- Treat the settings record identity and envelope version as authenticated additional data.
- Never log decrypted configuration, request bodies containing secrets, encryption errors with values, or remote provider response bodies.
- Backups are usable only together with the matching master key; deployment documentation must state this clearly.

The settings API represents each secret with a status and an explicit mutation:

- omitted: retain the stored value;
- `{ action: "replace", value: "..." }`: encrypt and replace it;
- `{ action: "clear" }`: remove it.

GET responses expose only `configured: true/false`. They never return a masked fragment, ciphertext or decrypted value.

## Initial migration

On the first startup after this change, if the database has no encrypted service configuration, the application seeds it from the existing environment variables. The imported values are encrypted immediately. After the record exists, PostgreSQL becomes authoritative and legacy provider environment variables are ignored.

Existing PostgreSQL data, local assets and Docker volumes are preserved. Deployment startup checks fail safely when the master key is missing or malformed; they do not silently create an unrecoverable key.

## Automatic Worker application

The Worker checks the settings version at the boundary between processing cycles. When it sees a newer version it:

1. loads and decrypts the candidate configuration;
2. validates required field groups for the selected mode and image route;
3. constructs the replacement adapters and runtime limits;
4. atomically swaps to the new runtime for subsequent jobs;
5. closes replaced network resources after the previous cycle has finished;
6. records the applied version and success time.

Jobs already leased by the previous cycle finish with the configuration snapshot they started with. Newly leased jobs use the new version. No container restart is required.

If validation or adapter construction fails, the Worker keeps the last valid runtime, records a safe field-level error code and continues polling. A bad save therefore does not stop processing with the last known-good configuration.

“Applied” means the Worker accepted and activated the configuration. It does not promise that an external provider is currently reachable; provider network failures remain normal task errors.

## API behavior

The existing settings GET and PATCH endpoints remain the public boundary.

- GET returns public configuration, per-secret configured status, saved version and Worker application status.
- PATCH accepts the full public draft plus explicit secret mutations and the expected version.
- Server-side validation covers URL schemes, numeric ranges, selected-route requirements and complete credential groups.
- Version conflicts return HTTP 409 without applying either public or secret changes.
- Encryption and database update occur in one transaction.
- Secret changes and public settings are audited by field name and action only; values are excluded.

## Desktop UI

The UI follows the project-local `frontend-design-pro` guidance using `/distill` and `/harden` principles.

- Keep the existing left navigation and desktop-only content width.
- Use four flat sections: basic runtime, image generation, external services and reliability.
- Use compact two-column form grids; do not nest a separate card around every provider.
- Switching Headless/Canvas shows only fields for the selected route.
- A saved secret renders as “已配置”; its empty input says that entering a value will replace it.
- Clearing a secret is a separate explicit action and requires confirmation in place.
- Show `已应用`, `待应用` or `配置错误` at the relevant service group rather than duplicating a large status dashboard.
- Show the bottom action bar only while the draft is dirty. The primary action is “保存并应用”.
- During save, say “正在加密并应用配置”. After save, show saved and applied versions independently until the Worker catches up.
- Put actionable validation directly below the relevant field and focus the first error.
- Use the existing native CSS approach, an 8px spacing scale, visible focus states and restrained 100-200ms transitions. Do not add a new component framework, gradients, bounce motion or decorative nested cards.

## Error handling

- Missing required field: identify the specific field and selected route.
- Invalid URL: require HTTP or HTTPS as appropriate and explain the accepted format.
- Invalid master key or decryption failure: fail closed with a static safe message; keep the previous runtime when possible.
- Worker apply failure: retain the last valid applied version and show the safe reason in settings.
- Concurrent edits: preserve the existing optimistic version conflict behavior.
- Clearing a credential required by the active route is blocked unless the user also switches away from that route or to mock mode.

## Testing

- Crypto unit tests: round trip, random nonce, wrong key, tampering and non-disclosure.
- Settings service and database tests: retain/replace/clear, atomic version updates, migration import and conflict handling.
- API tests: secret values never appear in GET, PATCH responses, logs or error payloads.
- Worker tests: detects a new version, swaps only after validation, preserves in-flight snapshots and falls back to last known-good configuration.
- UI tests: conditional route fields, secret status and mutations, dirty-state save bar, field errors and saved/applied version feedback.
- Mocked end-to-end test: save a new Headless provider configuration, observe the Worker applied version, then process a new image-generation job with that version.

## Out of scope

- Editing database URLs, ports, Docker mounts or the encryption master key in the UI.
- Exposing decrypted secrets, masked suffixes or a generic environment editor.
- Controlling Docker through its socket.
- Master-key rotation UI, multi-tenant secret stores or external vault integration.
- Mobile-specific settings layouts.
