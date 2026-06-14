# Synapse Telemetry & Privacy

## Overview

Synapse includes an **opt-in only** telemetry system. It is **disabled by default** and collects no data until you explicitly enable it.

## What We Collect (when enabled)

Only anonymous, aggregate metrics:

| Metric | Example | Purpose |
|--------|---------|---------|
| Files indexed count | `42` | Understand scale of usage |
| Indexing duration (ms) | `1200` | Performance benchmarking |
| Query latency (ms) | `15` | Identify slow queries |
| Error category | `parse_error` | Prioritize bug fixes |
| Language distribution | `typescript: 80%` | Prioritize adapter work |

## What We NEVER Collect

- File paths or names
- Symbol names or signatures
- Source code content
- Repository URLs or names
- User identity or IP address
- Environment variables (other than the telemetry flag itself)
- Any personally identifiable information (PII)

## How to Enable

Set the environment variable:

```bash
export CODEGRAPH_TELEMETRY=1
```

Or programmatically:

```typescript
import { enableTelemetry } from '@synapse/core';
enableTelemetry();
```

## How to Disable

Remove or unset the environment variable:

```bash
unset CODEGRAPH_TELEMETRY
```

Or programmatically:

```typescript
import { disableTelemetry } from '@synapse/core';
disableTelemetry();
```

## Data Storage

When enabled, events are buffered in memory and flushed periodically. By default, data is only stored locally. No data is transmitted to any remote server unless you explicitly configure an endpoint.

## Third-Party Services

Synapse does NOT use any third-party analytics services by default. If a remote endpoint is configured, it must be explicitly set via `CODEGRAPH_TELEMETRY_ENDPOINT`.

## Changes to This Policy

Any changes to telemetry behavior will be:
1. Documented in release notes
2. Require a new opt-in (never auto-enabled)
3. Follow semver (telemetry changes = minor version bump)

## Questions

Open an issue on the repository if you have questions about data handling.
