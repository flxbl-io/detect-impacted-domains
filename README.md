# Detect Impacted Domains

Detect which release domains are impacted based on git changes. This action analyzes file changes and maps them to packages defined in release configs, outputting a matrix for parallel builds.

## Usage

```yaml
- uses: flxbl-io/detect-impacted-domains@v1
  id: detect
  with:
    release-config-path: 'config/release-config-*.yaml'
    base-ref: 'origin/main'

- name: Build impacted domains
  if: steps.detect.outputs.has-changes == 'true'
  strategy:
    matrix: ${{ fromJson(steps.detect.outputs.matrix) }}
  uses: flxbl-io/build-domain@v1
  with:
    release-config: ${{ matrix.release-config }}
    # ...
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `release-config-path` | No | `config/release-config-*.yaml` | Glob pattern to find release config files |
| `base-ref` | No | `origin/main` | Base ref for git diff comparison |
| `head-ref` | No | `HEAD` | Head ref for git diff comparison |
| `sfdx-project-path` | No | `sfdx-project.json` | Path to sfdx-project.json |

## Outputs

| Output | Description |
|--------|-------------|
| `has-changes` | Whether any domains have changes (`true`/`false`) |
| `impacted-domains` | JSON array of impacted domain names |
| `matrix` | GitHub Actions matrix JSON for parallel jobs |

## Matrix Output Format

The `matrix` output is formatted for use with GitHub Actions matrix strategy:

```json
{
  "include": [
    { "domain": "core", "release-config": "config/release-config-core.yaml" },
    { "domain": "sales", "release-config": "config/release-config-sales.yaml" }
  ]
}
```

## How It Works

1. **Finds Release Configs** - Scans for release config files matching the glob pattern
2. **Loads Package Mappings** - For each release config, determines which packages are included using `includeOnlyArtifacts` or `excludeArtifacts`
3. **Gets Changed Files** - Runs `git diff` between base and head refs
4. **Maps Changes to Packages** - Checks which package directories contain changed files
5. **Outputs Impacted Domains** - Returns domains that have at least one package with changes

## Example Workflow

```yaml
name: Build Impacted Domains

on:
  push:
    branches: [main]

jobs:
  detect:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.detect.outputs.matrix }}
      has-changes: ${{ steps.detect.outputs.has-changes }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: flxbl-io/detect-impacted-domains@v1
        id: detect

  build:
    needs: detect
    if: needs.detect.outputs.has-changes == 'true'
    runs-on: ubuntu-latest
    strategy:
      matrix: ${{ fromJson(needs.detect.outputs.matrix) }}
      fail-fast: false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: flxbl-io/build-domain@v1
        with:
          sfp-server-url: ${{ secrets.SFP_SERVER_URL }}
          sfp-server-token: ${{ secrets.SFP_SERVER_TOKEN }}
          release-config: ${{ matrix.release-config }}
```

## Release Config Format

The action expects release configs in YAML format:

```yaml
releaseName: core
includeOnlyArtifacts:
  - core-utils
  - core-auth
  - core-data
```

Or with exclusions:

```yaml
releaseName: sales
excludeArtifacts:
  - experimental-feature
```

## License

Proprietary - see [LICENSE](LICENSE)
