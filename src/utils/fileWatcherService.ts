/**
 * File Watcher Service
 * Monitors a folder for changes and automatically updates the default topic
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { Logger } from "./logger";
import { TopicManager } from "../managers/topicManager";
import { CONFIG, EXTENSION } from "./constants";
import { ProgressTracker } from "./progressTracker";

export class FileWatcherService {
  private logger: Logger;
  private watcher: vscode.FileSystemWatcher | null = null;
  private topicManager: TopicManager;
  private context: vscode.ExtensionContext;
  private watchFolder: string = "";
  private isRecursive: boolean = true;
  private includeExtensions: string[] = [];
  private defaultTopicId: string | null = null;
  private progressTracker: ProgressTracker;
  
  // Debounce timer to batch multiple changes
  private updateTimer: NodeJS.Timeout | null = null;
  private pendingChanges: Set<string> = new Set();

  constructor(context: vscode.ExtensionContext, topicManager: TopicManager) {
    this.logger = new Logger("FileWatcherService");
    this.context = context;
    this.topicManager = topicManager;
    this.progressTracker = ProgressTracker.getInstance();
  }

  /**
   * Initialize the file watcher based on current configuration
   */
  public async initialize(): Promise<void> {
    this.logger.info("Initializing FileWatcherService");

    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    this.watchFolder = config.get<string>(CONFIG.WATCH_FOLDER, "");
    this.isRecursive = config.get<boolean>(CONFIG.WATCH_FOLDER_RECURSIVE, true);
    this.includeExtensions = config.get<string[]>("includeExtensions", []);

    if (!this.watchFolder || this.watchFolder.trim().length === 0) {
      this.logger.info("No watch folder configured, skipping file watcher setup");
      return;
    }

    // Ensure the watch folder exists
    try {
      const stats = await fs.stat(this.watchFolder);
      if (!stats.isDirectory()) {
        this.logger.warn("Watch folder is not a directory", { path: this.watchFolder });
        vscode.window.showWarningMessage(
          `Watch folder is not a directory: ${this.watchFolder}`
        );
        return;
      }
    } catch (error) {
      this.logger.warn("Watch folder does not exist", { path: this.watchFolder });
      vscode.window.showWarningMessage(
        `Watch folder does not exist: ${this.watchFolder}`
      );
      return;
    }

    // Ensure default topic exists (reuses TopicManager's method)
    await this.topicManager.ensureInitialized();
    const defaultTopic = await this.topicManager.ensureDefaultTopic();
    this.defaultTopicId = defaultTopic.id;
    this.logger.info("Default topic ready for folder watching", { topicId: this.defaultTopicId });

    // Setup file watcher
    await this.setupWatcher();
  }

  /**
   * Setup file system watcher for the configured folder
   */
  private async setupWatcher(): Promise<void> {
    if (!this.watchFolder || !this.defaultTopicId) {
      return;
    }

    // Dispose existing watcher if any
    if (this.watcher) {
      this.watcher.dispose();
    }

    // Create pattern for watching
    const pattern = this.isRecursive
      ? new vscode.RelativePattern(this.watchFolder, "**/*")
      : new vscode.RelativePattern(this.watchFolder, "*");

    this.logger.info("Creating file watcher", {
      folder: this.watchFolder,
      recursive: this.isRecursive,
      pattern: pattern.pattern
    });

    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    // Handle file creation
    this.watcher.onDidCreate((uri) => {
      this.logger.debug("File created", { path: uri.fsPath });
      this.handleFileChange(uri, "create");
    });

    // Handle file changes
    this.watcher.onDidChange((uri) => {
      this.logger.debug("File changed", { path: uri.fsPath });
      this.handleFileChange(uri, "change");
    });

    // Handle file deletion
    this.watcher.onDidDelete((uri) => {
      this.logger.debug("File deleted", { path: uri.fsPath });
      this.handleFileChange(uri, "delete");
    });

    this.logger.info("File watcher active", { folder: this.watchFolder });
    
    vscode.window.showInformationMessage(
      `Watching folder: ${this.watchFolder} (${this.isRecursive ? "recursive" : "non-recursive"})`
    );
  }

  /**
   * Handle file change events
   */
  private handleFileChange(uri: vscode.Uri, changeType: "create" | "change" | "delete"): void {
    const filePath = uri.fsPath;
    
    // Check if file has a supported extension
    const ext = path.extname(filePath);
    if (!this.includeExtensions.some(e => e.toLowerCase() === ext.toLowerCase())) {
      this.logger.debug("Skipping file with unsupported extension", { path: filePath, ext });
      return;
    }

    // Add to pending changes
    this.pendingChanges.add(filePath);

    // Debounce: wait for 2 seconds of inactivity before processing
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }

    this.updateTimer = setTimeout(() => {
      this.processQueuedChanges();
    }, 2000);
  }

  /**
   * Process all queued file changes
   */
  private async processQueuedChanges(): Promise<void> {
    if (this.pendingChanges.size === 0 || !this.defaultTopicId) {
      this.logger.debug("Skipping update - no changes or no default topic");
      return;
    }

    const changedFiles = Array.from(this.pendingChanges);
    this.pendingChanges.clear();
    this.updateTimer = null;

    this.logger.info("Processing file changes", { count: changedFiles.length });

    try {
      // Filter to only existing files (new or modified)
      const existingFiles: string[] = [];
      for (const filePath of changedFiles) {
        try {
          await fs.access(filePath);
          existingFiles.push(filePath);
        } catch {
          // File was deleted or doesn't exist, skip it
          this.logger.debug("Skipping deleted or inaccessible file", { path: filePath });
        }
      }

      if (existingFiles.length === 0) {
        this.logger.info("No files to add after filtering");
        return;
      }

      // Get topic name for progress tracking
      const defaultTopic = this.topicManager.getTopic(this.defaultTopicId!);
      const topicName = defaultTopic?.name || EXTENSION.DEFAULT_TOPIC_NAME;

      // Start progress tracking
      this.progressTracker.startTracking(
        this.defaultTopicId!,
        topicName,
        existingFiles.length
      );

      // Add documents to default topic
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Updating watched folder documents...`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: `Processing ${existingFiles.length} file(s)...` });

          await this.topicManager.ensureInitialized();
          
          // Remove old versions of documents before adding new ones
          // This ensures that modified files don't have duplicate chunks
          let processedCount = 0;
          for (const filePath of existingFiles) {
            try {
              const fileName = path.basename(filePath);
              progress.report({ message: `Removing old version of ${fileName}...` });
              this.progressTracker.updateProgress(this.defaultTopicId!, {
                stage: "removing",
                currentFile: fileName,
                processedFiles: processedCount,
              });
              
              await this.topicManager.removeDocumentByFilePath(
                this.defaultTopicId!,
                filePath
              );
            } catch (error) {
              // If removal fails, log but continue - might be a new file
              this.logger.debug("Could not remove old document (might be new)", {
                filePath,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          
          // Add documents to default topic
          progress.report({ message: `Adding ${existingFiles.length} file(s)...` });
          processedCount = 0;
          const results = await this.topicManager.addDocuments(
            this.defaultTopicId!,
            existingFiles,
            {
              onProgress: (pipelineProgress) => {
                progress.report({ message: pipelineProgress.message });
                
                // Update progress tracker with pipeline details
                this.progressTracker.updateProgress(this.defaultTopicId!, {
                  stage: pipelineProgress.stage,
                  currentFile: pipelineProgress.details?.fileName || undefined,
                  processedFiles: processedCount,
                  percentage: Math.round((processedCount / existingFiles.length) * 100),
                });
                
                // Increment when a file completes
                if (pipelineProgress.stage === "complete") {
                  processedCount++;
                }
              },
            }
          );

          const successCount = results.length;
          this.logger.info("Watch folder update complete", {
            processed: existingFiles.length,
            successful: successCount,
          });

          // Complete progress tracking
          this.progressTracker.completeTracking(this.defaultTopicId!);

          if (successCount > 0) {
            vscode.window.showInformationMessage(
              `Watched folder updated: ${successCount} document(s) processed`
            );
          }
        }
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("Failed to process file changes", { error: errorMessage });
      
      // Cancel progress tracking on error
      if (this.defaultTopicId) {
        this.progressTracker.cancelTracking(this.defaultTopicId);
      }
      
      vscode.window.showErrorMessage(
        `Failed to update watched folder: ${errorMessage}`
      );
    }
  }

  /**
   * Update configuration and restart watcher if needed
   */
  public async updateConfiguration(): Promise<void> {
    this.logger.info("Updating configuration");

    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const newWatchFolder = config.get<string>(CONFIG.WATCH_FOLDER, "");
    const newRecursive = config.get<boolean>(CONFIG.WATCH_FOLDER_RECURSIVE, true);
    const newExtensions = config.get<string[]>("includeExtensions", []);

    // Check if configuration changed
    const configChanged =
      newWatchFolder !== this.watchFolder ||
      newRecursive !== this.isRecursive ||
      JSON.stringify(newExtensions) !== JSON.stringify(this.includeExtensions);

    if (!configChanged) {
      this.logger.debug("Configuration unchanged, no restart needed");
      return;
    }

    // Update configuration
    this.watchFolder = newWatchFolder;
    this.isRecursive = newRecursive;
    this.includeExtensions = newExtensions;

    // Restart watcher
    await this.dispose();
    await this.initialize();
  }

  /**
   * Dispose of the file watcher
   */
  public async dispose(): Promise<void> {
    this.logger.info("Disposing FileWatcherService");

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }

    this.pendingChanges.clear();
    this.defaultTopicId = null;
  }
}
