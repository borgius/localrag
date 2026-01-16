/**
 * Tree view for displaying RAG topics and documents
 * Refactored to use TopicManager and display agentic metadata
 */

import * as vscode from "vscode";
import { TopicManager } from "./managers/topicManager";
import { Topic, Document, RetrievalStrategy, FolderChunkNode } from "./utils/types";
import { Logger } from "./utils/logger";
import { CONFIG, COMMANDS } from "./utils/constants";
import { EmbeddingService, type AvailableModel } from "./embeddings/embeddingService";
import { ProgressTracker, IndexingProgress } from "./utils/progressTracker";

const logger = new Logger("TopicTreeView");

export class TopicTreeDataProvider
  implements vscode.TreeDataProvider<TopicTreeItem>
{
  private _onDidChangeTreeData: vscode.EventEmitter<
    TopicTreeItem | undefined | null | void
  > = new vscode.EventEmitter<TopicTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    TopicTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  private topicManager: Promise<TopicManager>;
  private embeddingService: EmbeddingService;
  private progressTracker: ProgressTracker;

  constructor() {
    this.topicManager = TopicManager.getInstance();
    this.embeddingService = EmbeddingService.getInstance();
    this.progressTracker = ProgressTracker.getInstance();

    // Listen to progress updates and refresh tree view
    this.progressTracker.on("progress", () => {
      this.refresh();
    });

    this.progressTracker.on("complete", () => {
      this.refresh();
    });
  }

  refresh(): void {
    logger.debug("Refreshing topic tree view");
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TopicTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TopicTreeItem): Promise<TopicTreeItem[]> {
    try {
      const topicManager = await this.topicManager;

      if (!element) {
        // Root level - show configuration status + topics
        const items: TopicTreeItem[] = [];

        // Add configuration status item
        items.push(new TopicTreeItem(null, "config-status"));

        // Add topics
        const topics = await topicManager.getAllTopics();
        logger.debug(`Loaded ${topics.length} topics for tree view`);

        items.push(
          ...topics.map((topic: any) => new TopicTreeItem(topic, "topic"))
        );
        return items;
      } else if (element.type === "config-status") {
        // Show configuration items
        return this.getConfigurationItems();
      } else if (element.type === "local-models") {
        try {
          const models = await this.embeddingService.listAvailableModels();
          if (!models || models.length === 0) return [];
          return models.map((model: AvailableModel) => {
            // Strip leading dots or path separators so names display cleanly (e.g. '.my-model' -> 'my-model')
            const display = (model.name ?? "").replace(/^[.\\/]+/, "");
            return new TopicTreeItem(
              {
                key: "local-model",
                value: model.name,
                display,
                source: model.source,
                downloaded: !!model.downloaded,
              },
              "config-item"
            );
          });
        } catch (err) {
          logger.warn('Failed to load local models for tree children', err);
          return [];
        }
      } else if (element.type === "topic" && element.topic) {
        // Show statistics and documents for this topic
        const items: TopicTreeItem[] = [];

        // Check for active indexing progress
        const progress = this.progressTracker.getProgress(element.topic.id);
        if (progress) {
          items.push(new TopicTreeItem(progress, "progress", element.topic.id));
        }

        // Add stats item with topicId for folder hierarchy
        const stats = await topicManager.getTopicStats(element.topic.id);
        if (stats) {
          items.push(new TopicTreeItem(stats, "topic-stats", element.topic.id));
        }

        // Add documents
        const documents = topicManager.getTopicDocuments(element.topic.id);
        if (documents.length > 0) {
          items.push(
            ...documents.map((doc: any) => new TopicTreeItem(doc, "document"))
          );
        }

        return items;
      } else if (element.type === "topic-stats" && element.data) {
        // Show detailed statistics with folder hierarchy
        return this.getStatisticsItems(element.data, element.topicId);
      } else if (element.type === "folder-stats-root" && element.data) {
        // Show root level folders for a topic
        const topicManager = await this.topicManager;
        const folderStats = topicManager.getFolderChunkStats(element.topicId!);
        if (!folderStats || folderStats.roots.size === 0) {
          return [];
        }
        const items: TopicTreeItem[] = [];
        for (const root of folderStats.roots.values()) {
          items.push(new TopicTreeItem(root, "folder-node", element.topicId));
        }
        return items;
      } else if (element.type === "folder-node" && element.data) {
        // Show children of a folder node
        const node = element.data as FolderChunkNode;
        if (node.children.size === 0) {
          return [];
        }
        const items: TopicTreeItem[] = [];
        // Sort: folders first, then files, both alphabetically
        const children = Array.from(node.children.values()).sort((a, b) => {
          if (a.isFile === b.isFile) {
            return a.name.localeCompare(b.name);
          }
          return a.isFile ? 1 : -1;
        });
        for (const child of children) {
          items.push(new TopicTreeItem(child, "folder-node", element.topicId));
        }
        return items;
      }
      return [];
    } catch (error) {
      logger.error(`Failed to get tree children: ${error}`);
      return [];
    }
  }

  /**
   * Get configuration status items
   */
  private async getConfigurationItems(): Promise<TopicTreeItem[]> {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const items: TopicTreeItem[] = [];

    // Watch folders status - show at the top
    const watchFolders = config.get<string[]>(CONFIG.WATCH_FOLDERS, []);
    const watchOnChanges = config.get<boolean>(CONFIG.WATCH_ON_CHANGES, false);
    if (watchFolders.length > 0) {
      items.push(
        new TopicTreeItem(
          { 
            key: "watch-status", 
            value: watchOnChanges,
            folderCount: watchFolders.length 
          },
          "config-item"
        )
      );
    }

    // Embedding model (actual model currently loaded)
    const currentModel = this.embeddingService.getCurrentModel();
    items.push(
      new TopicTreeItem(
        { key: "embedding-model", value: currentModel },
        "config-item"
      )
    );

    // Embedding models (curated remote options + any discovered local models)
    try {
      const availableModels = await this.embeddingService.listAvailableModels();
      if (availableModels && availableModels.length > 0) {
        items.push(new TopicTreeItem({ key: "local-models", value: "" }, "local-models"));
      }
    } catch (err) {
      logger.warn('Failed to enumerate local models for tree view', err);
    }

    // Retrieval strategy (applies to all modes)
    const strategy = config.get<string>(CONFIG.RETRIEVAL_STRATEGY, "hybrid");
    items.push(
      new TopicTreeItem(
        { key: "retrieval-strategy", value: strategy },
        "config-item"
      )
    );

    // Agentic mode status
    const useAgenticMode = config.get<boolean>(CONFIG.USE_AGENTIC_MODE, false);
    items.push(
      new TopicTreeItem(
        { key: "agentic-mode", value: useAgenticMode },
        "config-item"
      )
    );

    // Indexing pause status
    items.push(
      new TopicTreeItem(
        { key: "indexing-paused", value: this.progressTracker.isPaused },
        "config-item"
      )
    );

    // LLM usage
    if (useAgenticMode) {
      const useLLM = config.get<boolean>(CONFIG.AGENTIC_USE_LLM, false);
      items.push(
        new TopicTreeItem({ key: "use-llm", value: useLLM }, "config-item")
      );

      // Max iterations
      const maxIterations = config.get<number>(
        CONFIG.AGENTIC_MAX_ITERATIONS,
        3
      );
      items.push(
        new TopicTreeItem(
          { key: "max-iterations", value: maxIterations },
          "config-item"
        )
      );

      // Confidence threshold
      const threshold = config.get<number>(
        CONFIG.AGENTIC_CONFIDENCE_THRESHOLD,
        0.7
      );
      items.push(
        new TopicTreeItem(
          { key: "confidence-threshold", value: threshold },
          "config-item"
        )
      );
    }

    return items;
  }

  /**
   * Get detailed statistics items for a topic
   */
  private async getStatisticsItems(stats: any, topicId?: string): Promise<TopicTreeItem[]> {
    const items: TopicTreeItem[] = [];

    // Document count
    items.push(
      new TopicTreeItem(
        { key: "document-count", value: stats.documentCount },
        "stat-item"
      )
    );

    // Chunk count
    items.push(
      new TopicTreeItem(
        { key: "chunk-count", value: stats.chunkCount },
        "stat-item"
      )
    );

    // Embedding model
    items.push(
      new TopicTreeItem(
        { key: "embedding-model", value: stats.embeddingModel },
        "stat-item"
      )
    );

    // Last updated
    const lastUpdated = new Date(stats.lastUpdated).toLocaleString();
    items.push(
      new TopicTreeItem(
        { key: "last-updated", value: lastUpdated },
        "stat-item"
      )
    );

    // Add folder hierarchy if available
    if (topicId) {
      const topicManager = await this.topicManager;
      const folderStats = topicManager.getFolderChunkStats(topicId);
      if (folderStats && folderStats.roots.size > 0) {
        items.push(
          new TopicTreeItem(
            { key: "folder-breakdown", totalChunks: folderStats.totalChunks },
            "folder-stats-root",
            topicId
          )
        );
      }
    }

    return items;
  }
}

export class TopicTreeItem extends vscode.TreeItem {
  public readonly topicId?: string;
  
  constructor(
    public readonly data: Topic | Document | IndexingProgress | FolderChunkNode | any,
    public readonly type:
      | "topic"
      | "document"
      | "config-status"
      | "config-item"
      | "local-models"
      | "topic-stats"
      | "stat-item"
      | "progress"
      | "folder-stats-root"
      | "folder-node",
    topicId?: string
  ) {
    super(
      TopicTreeItem.getLabel(data, type),
      TopicTreeItem.getCollapsibleState(type, data)
    );

    this.topicId = topicId;
    this.setupTreeItem(data, type);
  }

  private static getLabel(data: any, type: string): string {
    switch (type) {
      case "topic":
        return data.name;
      case "document":
        return `📄 ${data.name}`;
      case "config-status":
        return "⚙️ Configuration";
      case "local-models":
        return "🧠 Embedding Models";
      case "config-item":
        return TopicTreeItem.formatConfigLabel(data);
      case "topic-stats":
        return "📊 Statistics";
      case "stat-item":
        return TopicTreeItem.formatStatLabel(data);
      case "progress":
        return TopicTreeItem.formatProgressLabel(data);
      case "folder-stats-root":
        return `📁 Folder Breakdown (${data.totalChunks} chunks)`;
      case "folder-node":
        const node = data as FolderChunkNode;
        const icon = node.isFile ? "📄" : "📁";
        return `${icon} ${node.name} (${node.chunkCount} chunks)`;
      default:
        return "Unknown";
    }
  }

  private static getCollapsibleState(
    type: string,
    data?: any
  ): vscode.TreeItemCollapsibleState {
    switch (type) {
      case "topic":
      case "config-status":
      case "local-models":
      case "topic-stats":
      case "folder-stats-root":
        return vscode.TreeItemCollapsibleState.Collapsed;
      case "folder-node":
        const node = data as FolderChunkNode;
        if (node && !node.isFile && node.children.size > 0) {
          return vscode.TreeItemCollapsibleState.Collapsed;
        }
        return vscode.TreeItemCollapsibleState.None;
      default:
        return vscode.TreeItemCollapsibleState.None;
    }
  }

  private static formatConfigLabel(configData: any): string {
    const { key, value } = configData;
    switch (key) {
      case "agentic-mode":
        return `Agentic Mode: ${value ? "✅ Enabled" : "❌ Disabled"}`;
      case "use-llm":
        return `LLM Planning: ${value ? "✅ Enabled" : "❌ Disabled"}`;
      case "indexing-paused":
        return `Indexing: ${value ? "⏸️ Paused" : "▶️ Active"}`;
      case "retrieval-strategy":
        return `Strategy: ${
          value === RetrievalStrategy.HYBRID
            ? "🔀 Hybrid"
            : value === RetrievalStrategy.VECTOR
            ? "🎯 Vector"
            : value === RetrievalStrategy.ENSEMBLE
            ? "🎭 Ensemble"
            : value === RetrievalStrategy.BM25
            ? "🔍 BM25"
            : "❓ Unknown"
        }`;
      case "embedding-model":
        return `🤖 Embedding Model: ${value}`;
      case "local-models":
        return `Embedding Models:`;
      case "local-model":
        // Show a download indicator for curated models that have not been pulled yet
        return `${configData.source === "curated" && !configData.downloaded ? "🔻 " : "🔸"}${configData.display ?? value}`;
      case "max-iterations":
        return `Max Iterations: ${value}`;
      case "confidence-threshold":
        return `Confidence: ${(value * 100).toFixed(0)}%`;
      default:
        return `${key}: ${value}`;
    }
  }

  private static formatStatLabel(statData: any): string {
    const { key, value } = statData;
    switch (key) {
      case "document-count":
        return `📄 Documents: ${value}`;
      case "chunk-count":
        return `📦 Chunks: ${value}`;
      case "embedding-model":
        return `🤖 Model: ${value}`;
      case "last-updated":
        return `🕒 Updated: ${value}`;
      default:
        return `${key}: ${value}`;
    }
  }

  private static formatProgressLabel(progress: IndexingProgress): string {
    const remaining = progress.totalFiles - progress.processedFiles;
    const percentage = progress.percentage;
    
    // Create a simple text-based progress bar
    const barLength = 10;
    const filled = Math.round((percentage / 100) * barLength);
    const empty = barLength - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    
    return `⏳ Indexing: ${bar} ${percentage}% (${remaining} files remaining)`;
  }

  private setupTreeItem(data: any, type: string): void {
    switch (type) {
      case "topic":
        const topic = data as Topic;
        this.tooltip = topic.description || topic.name;
        this.description = `${topic.documentCount} document${
          topic.documentCount !== 1 ? "s" : ""
        }`;
        this.contextValue = "topic";
        this.iconPath = new vscode.ThemeIcon("folder");
        break;

      case "document":
        const doc = data as Document;
        this.tooltip = `${doc.name} (${doc.fileType})`;
        this.description = `${doc.chunkCount} chunks`;
        this.contextValue = "document";
        this.iconPath = new vscode.ThemeIcon("file");
        break;

      case "config-status":
        this.tooltip = "View current RAG configuration";
        this.contextValue = "config-status";
        this.iconPath = new vscode.ThemeIcon("settings-gear");
        break;

      case "config-item":
        this.tooltip = `Click to change this setting`;
        this.contextValue = "config-item";
        // this.iconPath = new vscode.ThemeIcon("symbol-property");

        // If this is a discovered local model entry, make it clickable to load
        if (data && data.key === 'local-model') {
            this.command = {
              command: COMMANDS.SET_EMBEDDING_MODEL,
              title: 'Set Embedding Model',
              arguments: [data.value],
            };
          const needsDownload = data.source === "curated" && !data.downloaded;
          const sourceLabel = data.source === "curated" ? "curated" : "local";
          this.tooltip = needsDownload
            ? `Click to download and load ${sourceLabel} model: ${data.display ?? data.value}`
            : `Click to load ${sourceLabel} model: ${data.display ?? data.value}`;
        }

        // Make indexing pause status clickable to toggle
        if (data && data.key === 'indexing-paused') {
          this.command = {
            command: COMMANDS.TOGGLE_INDEXING_PAUSE,
            title: 'Toggle Indexing Pause',
          };
          this.tooltip = data.value
            ? "Click to resume indexing"
            : "Click to pause indexing";
          this.iconPath = new vscode.ThemeIcon(data.value ? "debug-pause" : "debug-start");
        }

        // Make watch status clickable to toggle
        if (data && data.key === 'watch-status') {
          this.command = {
            command: COMMANDS.TOGGLE_WATCH,
            title: 'Toggle Watch',
          };
          this.tooltip = data.value
            ? `Click to pause watching ${data.folderCount} folder(s)`
            : `Click to resume watching ${data.folderCount} folder(s)`;
          this.iconPath = new vscode.ThemeIcon(data.value ? "eye" : "eye-closed");
        }
        break;

      case "topic-stats":
        this.tooltip = "Topic statistics and metadata";
        this.contextValue = "topic-stats";
        this.iconPath = new vscode.ThemeIcon("graph");
        break;

      case "stat-item":
        this.tooltip = `${data.key}: ${data.value}`;
        this.contextValue = "stat-item";
        this.iconPath = new vscode.ThemeIcon("symbol-numeric");
        break;

      case "progress":
        const progress = data as IndexingProgress;
        this.tooltip = `Processing: ${progress.currentFile || "..."}`;
        this.description = progress.stage;
        this.contextValue = "progress";
        this.iconPath = new vscode.ThemeIcon("loading~spin");
        this.command = {
          command: COMMANDS.TOGGLE_INDEXING_PAUSE,
          title: "Toggle Indexing Pause",
        };
        break;

      case "folder-stats-root":
        this.tooltip = "Click to expand folder breakdown by chunks";
        this.contextValue = "folder-stats-root";
        this.iconPath = new vscode.ThemeIcon("folder-library");
        break;

      case "folder-node":
        const folderNode = data as FolderChunkNode;
        this.tooltip = folderNode.path;
        this.contextValue = folderNode.isFile ? "folder-file" : "folder-folder";
        this.iconPath = new vscode.ThemeIcon(folderNode.isFile ? "file" : "folder");
        break;
    }
  }

  get topic(): Topic | undefined {
    return this.type === "topic" ? (this.data as Topic) : undefined;
  }

  get document(): Document | undefined {
    return this.type === "document" ? (this.data as Document) : undefined;
  }
}
