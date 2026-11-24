# Build & Release Scripts

This directory contains scripts for building, verifying, and releasing the Blok package.

## Private image uploads

[`blok-upload-image.mjs`](./blok-upload-image.mjs) uploads a local PNG, JPEG, GIF or
WebP through the hosted `blok_upload_image` MCP tool. It reads and base64-encodes
the file itself, so image bytes do not need to be copied into model-generated
arguments. It accepts sources up to 25 MiB; the backend validates the actual
image and applies its own dimension and processing limits.

Set `BLOK_MCP_TOKEN` in the environment to a dedicated MCP token from
**Mon compte → Accès MCP**, then run:

```sh
BLOK_MCP_URL=https://blok.example.com/mcp node scripts/blok-upload-image.mjs equipe /path/to/dashboard.png
node scripts/blok-upload-image.mjs equipe /path/to/dashboard.png --server https://blok.example.com
node scripts/blok-upload-image.mjs equipe --url https://images.example.com/dashboard.png --server https://blok.example.com
```

The output is only JSON containing the persistent `/files/` asset URL. The token
and base64 are never printed or passed on the command line. The source file is
not modified. `--url` uses the hosted MCP's HTTPS import support; a local path
is always read by this client, never interpreted as a path on the remote server.
The client accepts JSON or SSE responses, bounds the response size, times out
unfinished requests and does not forward credentials through redirects. A
server origin without a path is expanded to `/mcp`. HTTP is accepted only for
local development on loopback hosts. Use `--help` for the full usage.

Run its local transport tests without loading the editor test runner:

```sh
NODE_OPTIONS=--max-old-space-size=2048 node --test scripts/tests/blok-upload-image.test.mjs
```

## Performance Tracking

### [`analyze-performance.mjs`](./analyze-performance.mjs)

Analyzes Playwright test performance metrics and detects regressions.

**Usage:**
```bash
# Basic analysis
yarn perf:analyze

# Compare with baseline
node scripts/analyze-performance.mjs --baseline path/to/baseline.json --threshold 20

# Save metrics to file
node scripts/analyze-performance.mjs --output metrics.json --format markdown

# Fail build on regression (for CI)
node scripts/analyze-performance.mjs --baseline baseline.json --fail-on-regression
```

**Options:**
- `--current <file>` - Current test results JSON (default: test-results/test-results.json)
- `--baseline <file>` - Baseline for comparison
- `--threshold <percent>` - Regression threshold (default: 20)
- `--output <file>` - Save metrics to JSON file
- `--format <type>` - Output format: console, markdown, json (default: console)
- `--fail-on-regression` - Exit with code 1 if regressions found

**Outputs:**
- Overall metrics (duration, test count, pass/fail/skip counts)
- Project breakdown (per browser)
- Slowest tests (top 10)
- Flaky tests (passed after retries)
- Regressions (if baseline provided)

**See:** [Performance Tracking Documentation](../docs/PERFORMANCE-TRACKING.md)

### [`generate-performance-dashboard.mjs`](./generate-performance-dashboard.mjs)

Generates an interactive HTML dashboard with historical performance trends.

**Usage:**
```bash
# Generate dashboard
yarn perf:dashboard

# Open dashboard
open performance-dashboard/index.html
```

**Requirements:**
- Historical data in `.performance-history/` directory
- Internet connection (for Chart.js CDN)

**Features:**
- Real-time metrics cards
- Duration trend chart
- Pass rate trend chart
- Flaky rate trend chart
- Test count over time
- Slowest tests table

## Internationalization

### [`i18n/check-translations.mjs`](./i18n/check-translations.mjs)

Checks translation completeness and consistency.

**Usage:**
```bash
yarn i18n:check
```

## Directory Structure

```
scripts/
├── README.md                           # This file
├── analyze-performance.mjs            # Performance metrics analyzer
├── generate-performance-dashboard.mjs # Performance dashboard generator
└── i18n/
    └── check-translations.mjs         # Translation checker
```

## CI/CD Integration

These scripts are integrated into GitHub Actions workflows:

- **CI workflow** ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml))
  - Collects performance metrics on every test run
  - Uploads metrics as artifacts

- **Performance tracking** ([`.github/workflows/performance-tracking.yml`](../.github/workflows/performance-tracking.yml))
  - Compares with baseline on PRs
  - Generates performance reports
  - Posts PR comments with regression analysis
  - Updates baseline on main
  - Generates historical dashboard

- **Release workflow** ([`.github/workflows/release.yml`](../.github/workflows/release.yml))
  - Publishes to npm and creates GitHub release on tag push

## Development

All scripts are ES modules (`.mjs`) and can be imported for programmatic use.

## Troubleshooting

### "Failed to download artifact"

This is normal on first run. GitHub artifacts are created after the first release.

## Contributing

When adding new scripts:

1. Use ES modules (`.mjs` extension)
2. Add JSDoc comments for functions
3. Include usage examples in `--help`
4. Update this README
5. Add integration tests if applicable
6. Document in relevant workflow files

## Related Documentation

- [Development Guide](../CLAUDE.md)
- [Contributing Guide](../CONTRIBUTING.md)
