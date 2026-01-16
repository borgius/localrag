# Publishing LocalRAG CLI to npm

This guide explains how to publish the `lrag` CLI tool to npm.

## Package Structure

The repository contains two separate packages:
1. **VS Code Extension** (`package.json`) - Published to VS Code Marketplace via `vsce`
2. **CLI Tool** (`cli/package.json`) - Published to npm as a standalone lightweight package

The CLI tool is a minimal standalone package (~6 KB) that communicates with the VS Code extension via REST API. It has zero dependencies and only includes the CLI script.

## Prerequisites

1. **npm Account**: You need an npm account with publish access
2. **Authentication**: Log in to npm before publishing

```bash
npm login
```

3. **Compiled Code**: The TypeScript must be compiled to JavaScript

```bash
npm run compile
```

## Publishing Scripts

### Dry Run (Recommended First)

Test the publish process without actually publishing:

```bash
npm run publish:cli:dry-run
```

This will:
- Check npm authentication
- Show current version
- Compile TypeScript
- Copy CLI file to `cli/` directory
- Simulate what would be published
- Clean up copied files

### Publish with Patch Version Bump

```bash
npm run publish:cli
```

This will:
- Bump patch version (e.g., 0.1.0 → 0.1.1)
- Compile TypeScript
- Copy and prepare CLI file
- Publish to npm with `latest` tag
- Clean up

### Publish with Minor/Major Version Bump

```bash
node scripts/publish-cli.js minor   # 0.1.0 → 0.2.0
node scripts/publish-cli.js major   # 0.1.0 → 1.0.0
```

### Publish Beta Version

```bash
npm run publish:cli:beta
```

This publishes with the `beta` tag, allowing users to install with:
```bash
npm install -g lrag@beta
```

### Publish Current Version (Skip Bump)

```bash
node scripts/publish-cli.js --skip-bump
```

## What Gets Published

The CLI package is extremely lightweight and includes:

**Included:**
- `lrag.js` - Compiled CLI script (~21 KB)
- `README.md` - CLI documentation (~2 KB)
- `package.json` - Package metadata

**Package Size:** ~6.5 KB compressed, ~23.5 KB unpacked

**Excluded (stays in VS Code extension):**
- Embedding models (90+ MB)
- VS Code extension code
- Test files
- All dependencies (CLI uses only Node.js built-ins)

## After Publishing
rag

# Use directly with npx (no installation required)
npx lrag --help
npx lrag "search query"
```

## VS Code Extension Publishing

The VS Code extension is published separately to the Marketplace:

```bash
npm run publish              # Publish all platforms to VS Code Marketplace
npm run publish:darwin-arm64 # Publish specific platform
```

The CLI package (`lrag`) and the VS Code extension (`localrag`) are independent packages with separate versioning. existing scripts for VS Code extension publishing remain unchanged:

```bash
npm run publish              # Publish all platforms to VS Code Marketplace
npm run publish:darwin-arm64 # Publish specific platform
```

## Troubleshooting

### Authentication Issues

If you see "Not authenticated with npm":
```bash
npm login
npm whoami  # Verify login
```

### Publish Failed - Version Already Exists

If the version already exists on npm, bump the version first:
```bash
npm version patch  # or minor/major
npm run publish:npm --skip-bump
```

### CLI Not Found After Install

Make sure the `bin` field in package.json points to the correct compiled file:
```json
"bin": {
  "lrag": "./out/src/cli/lrag.js"
}
```

## Version Strategy

- **Patch** (0.2.9 → 0.2.10): Bug fixes, small improvements
- **Minor** (0.2.9 → 0.3.0): New features, backward compatible
- **Major** (0.2.9 → 1.0.0): Breaking changes

## CI/CD Integration

For automated publishing, set up npm token in CI:

```bash
# In CI environment
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc
node scripts/publish-npm.js --skip-bump
```
