# lrag - LocalRAG CLI Tool

A lightweight command-line interface for searching indexed documents in the [LocalRAG VS Code extension](https://github.com/borgius/localrag).

## Prerequisites

The LocalRAG VS Code extension must be installed and running for this CLI to work. The CLI communicates with the extension via REST API.

**Install the VS Code extension:**
```bash
code --install-extension borgius.localrag
```

## Installation

```bash
# Install globally
npm install -g lrag

# Or use directly with npx
npx lrag --help
```

## Usage

```bash
# Search for documents (default command)
lrag "how to configure webpack"

# Search with explicit --search flag
lrag --search "authentication flow"

# List all topics
lrag --list

# Show details for a specific topic
lrag --topic Default

# Show extension status
lrag --status

# Output results in JSON format
lrag --json "error handling"

# Compact JSON output
lrag --compact "error handling"

# Limit number of results
lrag -n 5 "configuration"
```

## Options

- `--search, -s <query>` - Search indexed documents (default)
- `--list, -l` - List all topics
- `--topic, -t <name>` - Show details for a specific topic
- `--status` - Show extension status
- `-j, --json` - Output results in JSON format
- `-c, --compact` - Output compact JSON (implies --json)
- `-n, --limit <number>` - Maximum results to return (default: 10)
- `-h, --help` - Show help message
- `-v, --version` - Show version

## How It Works

The CLI tool communicates with the LocalRAG VS Code extension via a REST API running on `localhost:3875`. The extension must be running in VS Code for the CLI to function.

## Troubleshooting

### "Could not connect to LocalRAG extension"

Make sure:
1. VS Code is running
2. The LocalRAG extension is installed
3. The extension has activated (open the Command Palette and run "LocalRAG: Search Documents" to ensure it's loaded)

### Check if extension is installed

```bash
code --list-extensions | grep localrag
```

### Install the extension

```bash
code --install-extension borgius.localrag
```

## Related

- [LocalRAG VS Code Extension](https://github.com/borgius/localrag)
- [Documentation](https://github.com/borgius/localrag#readme)

## License

MIT
