#!/usr/bin/env node

/**
 * LocalRAG CLI Publisher
 * 
 * Publishes the lrag CLI tool to npm as a separate lightweight package.
 * The CLI is a standalone tool that communicates with the VS Code extension.
 * 
 * Usage:
 *   node scripts/publish-cli.js [patch|minor|major] [options]
 * 
 * Options:
 *   --skip-bump    Skip version bump
 *   --dry-run      Show what would be published without actually publishing
 *   --tag=<tag>    Publish with a specific npm dist-tag (default: latest)
 *   --help         Show this help message
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Directories
const ROOT_DIR = path.resolve(__dirname, '..');
const CLI_DIR = path.join(ROOT_DIR, 'cli');

// Parse command line arguments
const args = process.argv.slice(2);
const bumpType = args.find(arg => ['patch', 'minor', 'major'].includes(arg)) || 'patch';
const skipBump = args.includes('--skip-bump');
const dryRun = args.includes('--dry-run');
const tagArg = args.find(arg => arg.startsWith('--tag='));
const tag = tagArg ? tagArg.split('=')[1] : 'latest';
const showHelp = args.includes('--help') || args.includes('-h');

if (showHelp) {
  console.log(`
╔═══════════════════════════════════════╗
║   LocalRAG CLI - npm Publisher       ║
╚═══════════════════════════════════════╝

Usage:
  node scripts/publish-cli.js [patch|minor|major] [options]

Version Bump Types:
  patch   Bump patch version (e.g., 0.1.0 → 0.1.1)
  minor   Bump minor version (e.g., 0.1.0 → 0.2.0)
  major   Bump major version (e.g., 0.1.0 → 1.0.0)

Options:
  --skip-bump    Skip version bump and publish current version
  --dry-run      Show what would be published without publishing
  --tag=<tag>    Publish with npm dist-tag (default: latest)
                 Example: --tag=beta
  --help         Show this help message

Examples:
  node scripts/publish-cli.js              # Bump patch and publish
  node scripts/publish-cli.js minor        # Bump minor and publish
  node scripts/publish-cli.js --dry-run    # Test without publishing
  node scripts/publish-cli.js --tag=beta   # Publish as beta
`);
  process.exit(0);
}

function exec(command, cwd = CLI_DIR) {
  try {
    return execSync(command, { 
      cwd, 
      stdio: 'inherit',
      encoding: 'utf-8' 
    });
  } catch (error) {
    console.error(`\n✗ Command failed: ${command}`);
    process.exit(1);
  }
}

function execOutput(command, cwd = CLI_DIR) {
  try {
    return execSync(command, { 
      cwd, 
      encoding: 'utf-8' 
    }).toString().trim();
  } catch (error) {
    console.error(`\n✗ Command failed: ${command}`);
    process.exit(1);
  }
}

function checkNpmAuth() {
  console.log('\n📦 Checking npm authentication...');
  try {
    const user = execOutput('npm whoami', CLI_DIR);
    console.log(`✓ Authenticated as: ${user}`);
    return true;
  } catch (error) {
    console.error('\n✗ Not authenticated with npm');
    console.error('\nPlease run: npm login\n');
    return false;
  }
}

function getCurrentVersion() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf-8')
  );
  return packageJson.version;
}

function bumpVersion(type) {
  console.log(`\n🔢 Bumping version (${type})...`);
  exec(`npm version ${type} --no-git-tag-version`, CLI_DIR);
  const newVersion = getCurrentVersion();
  console.log(`✓ Version bumped to: ${newVersion}`);
  return newVersion;
}

function buildCLI() {
  console.log('\n🔨 Building CLI with Vite...');
  
  // Check if CLI directory has dependencies installed
  if (!fs.existsSync(path.join(CLI_DIR, 'node_modules'))) {
    console.log('📦 Installing CLI dependencies...');
    exec('npm install', CLI_DIR);
  }
  
  // Build with Vite
  exec('npm run build', CLI_DIR);
  
  // Make it executable
  const cliFile = path.join(CLI_DIR, 'lrag.js');
  if (fs.existsSync(cliFile)) {
    fs.chmodSync(cliFile, '755');
    console.log('✓ CLI built and made executable');
  } else {
    console.error('✗ Build failed: lrag.js not found');
    process.exit(1);
  }
}

function publishToNpm(tag, dryRun) {
  const dryRunFlag = dryRun ? '--dry-run' : '';
  const tagFlag = tag !== 'latest' ? `--tag=${tag}` : '';
  
  console.log(`\n📤 Publishing to npm${dryRun ? ' (DRY RUN)' : ''} (tag: ${tag})...`);
  
  exec(`npm publish --access public ${tagFlag} ${dryRunFlag}`, CLI_DIR);
  
  if (!dryRun) {
    const version = getCurrentVersion();
    console.log(`\n✓ Successfully published lrag@${version}`);
    console.log(`\nUsers can now install with:`);
    console.log(`  npm install -g lrag${tag !== 'latest' ? '@' + tag : ''}`);
    console.log(`  npx lrag${tag !== 'latest' ? '@' + tag : ''} --help`);
  }
}

function cleanupAfterPublish() {
  console.log('\n🧹 Cleaning up...');
  // Optionally remove the built CLI file after publish
  // We keep it for local testing
  console.log('✓ Cleanup complete (lrag.js kept for testing)');
}

async function main() {
  console.log(`
╔═══════════════════════════════════════╗
║   LocalRAG CLI - npm Publisher       ║
╚═══════════════════════════════════════╝
`);

  // Check authentication
  if (!checkNpmAuth()) {
    process.exit(1);
  }

  // Show current version
  const currentVersion = getCurrentVersion();
  console.log(`\n📌 Current version: ${currentVersion}`);

  // Bump version if requested
  let newVersion = currentVersion;
  if (!skipBump) {
    newVersion = bumpVersion(bumpType);
  }

  // Build CLI with Vite
  buildCLI();

  // Publish to npm
  try {
    publishToNpm(tag, dryRun);
    
    if (!dryRun) {
      console.log('\n✅ Publication complete!\n');
    } else {
      console.log('\n✅ Dry run complete! No changes were published.\n');
      console.log('To publish for real, run without --dry-run flag\n');
    }
  } finally {
    // Always cleanup
    cleanupAfterPublish();
  }
}

// Run the script
main().catch(error => {
  console.error('\n✗ Error:', error.message);
  process.exit(1);
});
