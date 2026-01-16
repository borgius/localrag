/**
 * lrag - LocalRAG CLI Tool
 * 
 * A command-line interface for searching indexed topics in LocalRAG.
 * Works with the VS Code extension via REST API.
 * 
 * Usage:
 *   lrag [options] [query]
 *   lrag --search "your search query"
 *   lrag --list
 *   lrag --topic <name>
 *   lrag --status
 * 
 * Options:
 *   --search, -s     Search indexed documents (default command)
 *   --list, -l       List all topics
 *   --topic, -t      Show details for a specific topic
 *   --status         Show extension status (indexing, watching, etc.)
 *   --json, -j       Output results in JSON format
 *   --compact, -c    Output compact JSON (requires --json)
 *   --limit, -n      Maximum number of results (default: 10)
 *   --help, -h       Show help message
 *   --version, -v    Show version
 */

import * as http from "http";
import { execSync } from "child_process";
import * as readline from "readline";

const VERSION = "1.0.0";
const DEFAULT_PORT = 3875;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_LIMIT = 10;
const EXTENSION_ID = "borgius.localrag";

// ANSI color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

// Check if colors are supported
const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = supportsColor ? colors : Object.fromEntries(
  Object.keys(colors).map(k => [k, ""])
) as typeof colors;

interface ParsedArgs {
  command: "search" | "list" | "topic" | "status" | "help" | "version";
  query?: string;
  topicName?: string;
  json: boolean;
  compact: boolean;
  limit: number;
}

interface SearchResult {
  content: string;
  path: string;
  score: number;
  topic: string;
  chunkId?: string;
  metadata?: Record<string, unknown>;
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
  totalResults: number;
  executionTime: number;
  strategy: string;
}

interface TopicInfo {
  id: string;
  name: string;
  description?: string;
  documentCount: number;
  chunkCount?: number;
  createdAt: number;
  updatedAt: number;
  embeddingModel?: string;
  documents?: Array<{ id: string; name: string; path: string; chunkCount: number }>;
}

interface StatusResponse {
  status: "idle" | "indexing" | "paused";
  watching: boolean;
  watchFolders: string[];
  activeOperations: Array<{
    topicId: string;
    topicName: string;
    totalFiles: number;
    processedFiles: number;
    percentage: number;
    stage: string;
  }>;
  embeddingModel: string;
  totalTopics: number;
}

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: "search",
    json: false,
    compact: false,
    limit: DEFAULT_LIMIT,
  };

  const positionalArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        result.command = "help";
        return result;

      case "--version":
      case "-v":
        result.command = "version";
        return result;

      case "--search":
      case "-s":
        result.command = "search";
        // Check if next arg is the query
        if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
          result.query = args[++i];
        }
        break;

      case "--list":
      case "-l":
        result.command = "list";
        break;

      case "--topic":
      case "-t":
        result.command = "topic";
        if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
          result.topicName = args[++i];
        }
        break;

      case "--status":
        result.command = "status";
        break;

      case "--json":
      case "-j":
        result.json = true;
        break;

      case "--compact":
      case "-c":
        result.compact = true;
        result.json = true; // compact implies json
        break;

      case "--limit":
      case "-n":
        if (i + 1 < args.length) {
          const limitValue = parseInt(args[++i], 10);
          if (!Number.isNaN(limitValue) && limitValue > 0) {
            result.limit = limitValue;
          }
        }
        break;

      default:
        if (!arg.startsWith("-")) {
          positionalArgs.push(arg);
        }
        break;
    }
  }

  // If no command was specified and we have positional args, treat them as a search query
  if (result.command === "search" && !result.query && positionalArgs.length > 0) {
    result.query = positionalArgs.join(" ");
  }

  return result;
}

/**
 * Make HTTP request to the REST server
 */
async function makeRequest<T>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = `http://${DEFAULT_HOST}:${DEFAULT_PORT}${path}`;
    
    const req = http.get(url, (res) => {
      let data = "";
      
      res.on("data", (chunk) => {
        data += chunk;
      });
      
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed as T);
          }
        } catch {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });

    req.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        reject(new Error("CONNECTION_REFUSED"));
      } else {
        reject(error);
      }
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

/**
 * Check if the extension is installed
 */
function isExtensionInstalled(): boolean {
  try {
    const output = execSync("code --list-extensions", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return output.toLowerCase().includes(EXTENSION_ID.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Ask user a yes/no question
 */
async function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/**
 * Install the extension
 */
async function installExtension(): Promise<boolean> {
  console.log(`\n${c.cyan}Installing LocalRAG extension...${c.reset}\n`);
  
  try {
    execSync(`code --install-extension ${EXTENSION_ID}`, { 
      encoding: "utf-8", 
      stdio: "inherit" 
    });
    console.log(`\n${c.green}✓ Extension installed successfully!${c.reset}`);
    return true;
  } catch {
    console.error(`\n${c.red}✗ Failed to install extension${c.reset}`);
    return false;
  }
}

/**
 * Show connection error and guidance
 */
async function handleConnectionError(): Promise<void> {
  console.error(`\n${c.red}✗ Cannot connect to LocalRAG server${c.reset}\n`);
  console.log(`${c.yellow}The lrag CLI requires the LocalRAG VS Code extension to be running.${c.reset}\n`);

  // Check if extension is installed
  const installed = isExtensionInstalled();

  if (!installed) {
    console.log(`${c.dim}The LocalRAG extension is not installed.${c.reset}\n`);
    
    const shouldInstall = await askYesNo("Would you like to install the extension now?");
    
    if (shouldInstall) {
      const success = await installExtension();
      if (!success) {
        process.exit(1);
      }
    }
  }

  console.log(`\n${c.bold}To start the server:${c.reset}`);
  console.log(`${c.dim}1.${c.reset} Open VS Code with your workspace`);
  console.log(`${c.dim}2.${c.reset} Ensure the LocalRAG extension is enabled`);
  console.log(`${c.dim}3.${c.reset} The server will start automatically on port ${DEFAULT_PORT}\n`);
  
  console.log(`${c.gray}Example: code /path/to/your/workspace${c.reset}\n`);
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
${c.bold}lrag${c.reset} - LocalRAG CLI Tool

${c.bold}USAGE${c.reset}
  lrag [options] [query]
  lrag "your search query"
  lrag --search "your search query"

${c.bold}COMMANDS${c.reset}
  ${c.cyan}--search, -s${c.reset} <query>    Search indexed documents (default)
  ${c.cyan}--list, -l${c.reset}              List all topics
  ${c.cyan}--topic, -t${c.reset} <name>      Show details for a specific topic
  ${c.cyan}--status${c.reset}                Show extension status

${c.bold}OPTIONS${c.reset}
  ${c.cyan}-j, --json${c.reset}              Output results in JSON format
  ${c.cyan}-c, --compact${c.reset}           Output compact JSON (implies --json)
  ${c.cyan}-n, --limit${c.reset} <number>    Maximum results to return (default: ${DEFAULT_LIMIT})
  ${c.cyan}-h, --help${c.reset}              Show this help message
  ${c.cyan}-v, --version${c.reset}           Show version

${c.bold}EXAMPLES${c.reset}
  ${c.dim}# Search for documents${c.reset}
  lrag "how to configure webpack"
  
  ${c.dim}# Search with JSON output${c.reset}
  lrag --json "authentication flow"
  
  ${c.dim}# Search with limit${c.reset}
  lrag -n 5 "error handling"
  
  ${c.dim}# List all topics${c.reset}
  lrag --list
  
  ${c.dim}# Get topic details${c.reset}
  lrag --topic Default
  
  ${c.dim}# Check status${c.reset}
  lrag --status

${c.bold}OUTPUT FORMATS${c.reset}
  ${c.dim}Default:${c.reset}   Markdown-formatted results for human reading
  ${c.dim}--json:${c.reset}    Full JSON with all metadata
  ${c.dim}--compact:${c.reset} Minimal JSON with content, path, and score

${c.bold}NOTES${c.reset}
  This CLI requires the LocalRAG VS Code extension to be running.
  The extension starts a REST server on port ${DEFAULT_PORT} when activated.
`);
}

/**
 * Format search results as markdown
 */
function formatSearchResultsMarkdown(response: SearchResponse): string {
  const lines: string[] = [];
  
  lines.push(`${c.bold}Search Results${c.reset} for "${c.cyan}${response.query}${c.reset}"`);
  lines.push(`${c.dim}Found ${response.totalResults} results in ${response.executionTime}ms (${response.strategy})${c.reset}\n`);

  if (response.results.length === 0) {
    lines.push(`${c.yellow}No results found.${c.reset}`);
    return lines.join("\n");
  }

  // Group results by topic
  const resultsByTopic = new Map<string, SearchResult[]>();
  response.results.forEach((result) => {
    const topicName = result.topic;
    if (!resultsByTopic.has(topicName)) {
      resultsByTopic.set(topicName, []);
    }
    resultsByTopic.get(topicName)!.push(result);
  });

  // Format each topic group
  for (const [topicName, topicResults] of resultsByTopic.entries()) {
    lines.push(`${c.bold}# Topic: ${topicName}${c.reset}\n`);

    topicResults.forEach((result, index) => {
      const scorePercent = Math.round(result.score * 100);
      const scoreColor = scorePercent >= 70 ? c.green : scorePercent >= 40 ? c.yellow : c.red;
      
      lines.push(`${c.bold}${index + 1}.${c.reset} ${c.blue}${result.path}${c.reset} ${scoreColor}(${scorePercent}%)${c.reset}\n`);
      
      // Truncate content for display
      const content = result.content.trim();
      const maxLength = 500;
      const truncated = content.length > maxLength 
        ? content.substring(0, maxLength) + "..."
        : content;
      
      // Show content in code block
      lines.push("```");
      lines.push(truncated);
      lines.push("```\n");
    });
  }

  return lines.join("\n");
}

/**
 * Format search results as JSON
 */
function formatSearchResultsJson(response: SearchResponse, compact: boolean): string {
  if (compact) {
    // Compact format: only essential fields
    const compactResults = response.results.map(r => ({
      content: r.content,
      path: r.path,
      score: r.score,
    }));
    return JSON.stringify({
      query: response.query,
      results: compactResults,
      totalResults: response.totalResults,
    }, null, 2);
  }
  return JSON.stringify(response, null, 2);
}

/**
 * Format topics list as markdown
 */
function formatTopicsListMarkdown(topics: TopicInfo[]): string {
  const lines: string[] = [];
  
  lines.push(`${c.bold}LocalRAG Topics${c.reset} (${topics.length} total)\n`);

  if (topics.length === 0) {
    lines.push(`${c.yellow}No topics found.${c.reset}`);
    return lines.join("\n");
  }

  topics.forEach((topic) => {
    const docCount = topic.documentCount;
    const chunkCount = topic.chunkCount ?? "?";
    
    lines.push(`${c.cyan}●${c.reset} ${c.bold}${topic.name}${c.reset}`);
    if (topic.description) {
      lines.push(`  ${c.dim}${topic.description}${c.reset}`);
    }
    lines.push(`  ${c.dim}Documents: ${docCount} | Chunks: ${chunkCount}${c.reset}`);
    lines.push(`  ${c.dim}Updated: ${new Date(topic.updatedAt).toLocaleString()}${c.reset}`);
    lines.push("");
  });

  return lines.join("\n");
}

/**
 * Format single topic as markdown
 */
function formatTopicMarkdown(topic: TopicInfo): string {
  const lines: string[] = [];
  
  lines.push(`${c.bold}Topic: ${c.cyan}${topic.name}${c.reset}\n`);
  
  if (topic.description) {
    lines.push(`${topic.description}\n`);
  }

  lines.push(`${c.dim}ID:${c.reset} ${topic.id}`);
  lines.push(`${c.dim}Documents:${c.reset} ${topic.documentCount}`);
  lines.push(`${c.dim}Chunks:${c.reset} ${topic.chunkCount ?? "Unknown"}`);
  lines.push(`${c.dim}Embedding Model:${c.reset} ${topic.embeddingModel || "Unknown"}`);
  lines.push(`${c.dim}Created:${c.reset} ${new Date(topic.createdAt).toLocaleString()}`);
  lines.push(`${c.dim}Updated:${c.reset} ${new Date(topic.updatedAt).toLocaleString()}`);

  if (topic.documents && topic.documents.length > 0) {
    lines.push(`\n${c.bold}Documents:${c.reset}`);
    topic.documents.forEach((doc) => {
      lines.push(`  ${c.blue}${doc.path}${c.reset} ${c.dim}(${doc.chunkCount} chunks)${c.reset}`);
    });
  }

  return lines.join("\n");
}

/**
 * Format status as markdown
 */
function formatStatusMarkdown(status: StatusResponse): string {
  const lines: string[] = [];
  
  const statusIcon = status.status === "idle" ? "🟢" : status.status === "indexing" ? "🟡" : "⏸️";
  const statusText = status.status.charAt(0).toUpperCase() + status.status.slice(1);
  
  lines.push(`${c.bold}LocalRAG Status${c.reset}\n`);
  lines.push(`${statusIcon} ${c.bold}Status:${c.reset} ${statusText}`);
  lines.push(`${c.dim}Topics:${c.reset} ${status.totalTopics}`);
  lines.push(`${c.dim}Embedding Model:${c.reset} ${status.embeddingModel}`);
  
  const watchIcon = status.watching ? "👁️" : "⭕";
  lines.push(`\n${watchIcon} ${c.bold}File Watching:${c.reset} ${status.watching ? "Enabled" : "Disabled"}`);
  
  if (status.watchFolders.length > 0) {
    lines.push(`${c.dim}Watch Folders:${c.reset}`);
    status.watchFolders.forEach(folder => {
      lines.push(`  ${c.blue}${folder}${c.reset}`);
    });
  }

  if (status.activeOperations.length > 0) {
    lines.push(`\n${c.bold}Active Operations:${c.reset}`);
    status.activeOperations.forEach(op => {
      const progress = `${op.processedFiles}/${op.totalFiles}`;
      lines.push(`  ${c.yellow}⟳${c.reset} ${op.topicName}: ${op.stage} (${progress}, ${op.percentage}%)`);
    });
  }

  return lines.join("\n");
}

/**
 * Handle search command
 */
async function handleSearch(args: ParsedArgs): Promise<void> {
  if (!args.query) {
    console.error(`${c.red}Error: Search query is required${c.reset}`);
    console.log(`\nUsage: lrag "your search query"`);
    process.exit(1);
  }

  const encodedQuery = encodeURIComponent(args.query);
  const path = `/search?q=${encodedQuery}&limit=${args.limit}`;
  
  const response = await makeRequest<SearchResponse>(path);

  if (args.json) {
    console.log(formatSearchResultsJson(response, args.compact));
  } else {
    console.log(formatSearchResultsMarkdown(response));
  }
}

/**
 * Handle list command
 */
async function handleList(args: ParsedArgs): Promise<void> {
  const response = await makeRequest<{ topics: TopicInfo[] }>("/topics");

  if (args.json) {
    if (args.compact) {
      const compact = response.topics.map(t => ({
        name: t.name,
        documentCount: t.documentCount,
        chunkCount: t.chunkCount,
      }));
      console.log(JSON.stringify(compact, null, 2));
    } else {
      console.log(JSON.stringify(response.topics, null, 2));
    }
  } else {
    console.log(formatTopicsListMarkdown(response.topics));
  }
}

/**
 * Handle topic command
 */
async function handleTopic(args: ParsedArgs): Promise<void> {
  if (!args.topicName) {
    console.error(`${c.red}Error: Topic name is required${c.reset}`);
    console.log(`\nUsage: lrag --topic <name>`);
    process.exit(1);
  }

  const encodedName = encodeURIComponent(args.topicName);
  const response = await makeRequest<TopicInfo>(`/topics/${encodedName}`);

  if (args.json) {
    if (args.compact) {
      const compact = {
        name: response.name,
        documentCount: response.documentCount,
        chunkCount: response.chunkCount,
        documents: response.documents?.map(d => d.path),
      };
      console.log(JSON.stringify(compact, null, 2));
    } else {
      console.log(JSON.stringify(response, null, 2));
    }
  } else {
    console.log(formatTopicMarkdown(response));
  }
}

/**
 * Handle status command
 */
async function handleStatus(args: ParsedArgs): Promise<void> {
  const response = await makeRequest<StatusResponse>("/status");

  if (args.json) {
    if (args.compact) {
      const compact = {
        status: response.status,
        watching: response.watching,
        totalTopics: response.totalTopics,
        activeOperations: response.activeOperations.length,
      };
      console.log(JSON.stringify(compact, null, 2));
    } else {
      console.log(JSON.stringify(response, null, 2));
    }
  } else {
    console.log(formatStatusMarkdown(response));
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Handle help and version first
  if (args.command === "help") {
    printHelp();
    return;
  }

  if (args.command === "version") {
    console.log(`lrag version ${VERSION}`);
    return;
  }

  try {
    switch (args.command) {
      case "search":
        await handleSearch(args);
        break;
      case "list":
        await handleList(args);
        break;
      case "topic":
        await handleTopic(args);
        break;
      case "status":
        await handleStatus(args);
        break;
    }
  } catch (error) {
    if (error instanceof Error && error.message === "CONNECTION_REFUSED") {
      await handleConnectionError();
      process.exit(1);
    }
    
    console.error(`${c.red}Error: ${error instanceof Error ? error.message : String(error)}${c.reset}`);
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  console.error(`${c.red}Fatal error: ${error}${c.reset}`);
  process.exit(1);
});
