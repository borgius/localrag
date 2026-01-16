#!/usr/bin/env node
/**
 * Publish lrag CLI to npm
 * 
 * This script handles:
 * - Compiling TypeScript
 * - Publishing to npm registry
 * - Version bumping
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ANSI colors for output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function exec(command, options = {}) {
  try {
    return execSync(command, {
      stdio: options.silent ? 'pipe' : 'inherit',
      encoding: 'utf-8',
      ...options,
    });
  } catch (error) {
    if (!options.ignoreError) {
      throw error;
    }
    return null;
  }
}

function checkNpmAuth() {
  log('\n📦 Checking npm authentication...', 'cyan');
  
  try {
    const whoami = exec('npm whoami', { silent: true });
    if (whoami && whoami.trim()) {
      log(`✓ Authenticated as: ${whoami.trim()}`, 'green');
      return true;
    }
  } catch {
    log('✗ Not authenticated with npm', 'red');
    log('\nPlease run: npm login', 'yellow');
    return false;
  }
  
  return false;
}

function getCurrentVersion() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
  );
  return packageJson.version;
}

function bumpVersion(type = 'patch') {
  log(`\n🔢 Bumping version (${type})...`, 'cyan');
  const newVersion = exec(`npm version ${type} --no-git-tag-version`, { silent: true });
  if (newVersion) {
    log(`✓ Version bumped to: ${newVersion.trim()}`, 'green');
    return newVersion.trim();
  }
  throw new Error('Failed to bump version');
}

function compile() {
  log('\n🔨 Compiling TypeScript...', 'cyan');
  exec('npm run compile');
  log('✓ Compilation complete', 'green');
}

function checkCompiledCLI() {
  const cliPath = path.join(__dirname, '../out/src/cli/lrag.js');
  if (!fs.existsSync(cliPath)) {
    throw new Error('CLI file not found at: ' + cliPath);
  }
  log('✓ CLI file exists', 'green');
}

function publishToNpm(tag = 'latest') {
  log(`\n📤 Publishing to npm (tag: ${tag})...`, 'cyan');
  
  const publishCmd = tag === 'latest' 
    ? 'npm publish'
    : `npm publish --tag ${tag}`;
  
  exec(publishCmd);
  log('✓ Published to npm successfully!', 'green');
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipBump = args.includes('--skip-bump');
  const tag = args.find(arg => arg.startsWith('--tag='))?.split('=')[1] || 'latest';
  const versionType = args.find(arg => ['patch', 'minor', 'major'].includes(arg)) || 'patch';

  log('╔═══════════════════════════════════════╗', 'cyan');
  log('║   LocalRAG CLI - npm Publisher       ║', 'cyan');
  log('╚═══════════════════════════════════════╝', 'cyan');

  try {
    // Check npm authentication
    if (!checkNpmAuth()) {
      process.exit(1);
    }

    // Show current version
    const currentVersion = getCurrentVersion();
    log(`\n📌 Current version: ${currentVersion}`, 'cyan');

    // Bump version if needed
    let newVersion = currentVersion;
    if (!skipBump && !dryRun) {
      newVersion = bumpVersion(versionType);
    } else if (skipBump) {
      log('\n⏭️  Skipping version bump', 'yellow');
    }

    // Compile TypeScript
    compile();

    // Check CLI exists
    checkCompiledCLI();

    // Publish to npm
    if (dryRun) {
      log('\n🔍 Dry run mode - skipping actual publish', 'yellow');
      log('\nWould publish:', 'yellow');
      log(`  Package: localrag`, 'yellow');
      log(`  Version: ${newVersion}`, 'yellow');
      log(`  Tag: ${tag}`, 'yellow');
      log('\nTo publish for real, run without --dry-run', 'yellow');
    } else {
      publishToNpm(tag);
      
      log('\n╔═══════════════════════════════════════╗', 'green');
      log('║          Success!                    ║', 'green');
      log('╚═══════════════════════════════════════╝', 'green');
      log(`\n✓ Published localrag@${newVersion} to npm`, 'green');
      log('\nUsers can now install with:', 'cyan');
      log(`  npm install -g localrag`, 'cyan');
      log(`  npx localrag --help`, 'cyan');
    }

  } catch (error) {
    log('\n✗ Publish failed:', 'red');
    log(error.message, 'red');
    process.exit(1);
  }
}

// Show help if requested
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage: node scripts/publish-npm.js [options]

Options:
  patch|minor|major   Version bump type (default: patch)
  --skip-bump         Don't bump version before publishing
  --dry-run           Simulate publish without actually publishing
  --tag=<tag>         npm dist-tag (default: latest)
  --help, -h          Show this help

Examples:
  node scripts/publish-npm.js                    # Publish with patch bump
  node scripts/publish-npm.js minor              # Publish with minor bump
  node scripts/publish-npm.js --dry-run          # Test without publishing
  node scripts/publish-npm.js --tag=beta         # Publish as beta
  node scripts/publish-npm.js --skip-bump        # Publish current version
`);
  process.exit(0);
}

main();
