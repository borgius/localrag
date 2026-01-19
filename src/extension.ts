/**
 * Main extension entry point
 * Refactored to use new LangChain-based architecture
 */

import * as vscode from "vscode";
import { TopicManager } from "./managers/topicManager";
import { EmbeddingService } from "./embeddings/embeddingService";
import { RAGTool } from "./ragTool";
import { CommandHandler } from "./commands";
import { TopicTreeDataProvider } from "./topicTreeView";
import { VIEWS, STATE, COMMANDS, CONFIG } from "./utils/constants";
import { Logger } from "./utils/logger";
import { GitHubTokenManager } from "./utils/githubTokenManager";
import { FileWatcherService } from "./utils/fileWatcherService";
import { getRestServer, disposeRestServer } from "./server/restServer";

// Initialize logger immediately - before any other code
Logger.initialize();

const logger = new Logger("Extension");
let fileWatcherService: FileWatcherService | null = null;

export function getFileWatcherService(): FileWatcherService | null {
  return fileWatcherService;
}

export async function activate(context: vscode.ExtensionContext) {
  logger.info("========================================");
  logger.info("LocalRAG Extension Activation Starting");
  logger.info("========================================");
  
  // Initialize logger with configuration as early as possible
  logger.actionStart("Logger configuration initialization");
  Logger.initializeFromConfig();
  logger.actionComplete("Logger configuration initialized");
  
  logger.debug("Extension context received", {
    extensionPath: context.extensionPath,
    storagePath: context.storageUri?.fsPath,
    globalStoragePath: context.globalStorageUri?.fsPath
  });

  logger.debug("Extension context received", {
    extensionPath: context.extensionPath,
    storagePath: context.storageUri?.fsPath,
    globalStoragePath: context.globalStorageUri?.fsPath
  });

  try {
    // Initialize TopicManager (singleton with automatic initialization)
    logger.actionStart("TopicManager initialization");
    const topicManager = await TopicManager.getInstance(context);
    logger.actionComplete("TopicManager initialized");

    // Initialize embedding service instance (will load model on first use)
    logger.actionStart("EmbeddingService initialization");
    const embeddingService = EmbeddingService.getInstance();
    logger.actionComplete("EmbeddingService instance created");
    logger.debug("Embedding service created (model will load on first use)");

    // Initialize GitHub token manager
    logger.actionStart("GitHub token manager initialization");
    GitHubTokenManager.initialize(context);
    logger.actionComplete("GitHub token manager initialized");

    // Ensure a default topic exists if no topics are present
    logger.actionStart("Default topic verification");
    logger.debug("Checking for existing topics");
    await topicManager.ensureInitialized();
    const existingTopics = topicManager.getAllTopics();
    logger.debug(`Found ${existingTopics.length} existing topics`);
    logger.debug(`Found ${existingTopics.length} existing topics`);
    if (existingTopics.length === 0) {
      logger.info("No topics found, creating default topic");
      await topicManager.ensureDefaultTopic();
      logger.actionComplete("Default topic created");
    } else {
      logger.debug("Default topic verification complete - topics exist");
    }
    logger.actionComplete("Default topic verification");

    // Register tree view
    logger.actionStart("Tree view registration");
    const treeDataProvider = new TopicTreeDataProvider();
    const treeView = vscode.window.createTreeView(VIEWS.RAG_TOPICS, {
      treeDataProvider,
      showCollapseAll: true,
    });
    context.subscriptions.push(treeView);
    context.subscriptions.push(treeDataProvider); // Dispose model change subscription
    logger.actionComplete("Tree view registered", { viewId: VIEWS.RAG_TOPICS });

    // Register commands
    logger.actionStart("Command registration");
    await CommandHandler.registerCommands(context, treeDataProvider);
    logger.actionComplete("Commands registered");

    // Load topics with error handling
    logger.actionStart("Topics loading");
    try {
      const topics = await topicManager.getAllTopics();
      logger.info(`Loaded ${topics.length} topics`);
      logger.debug("Topics loaded successfully", { 
        topicCount: topics.length,
        topicNames: topics.map(t => t.name)
      });
      logger.actionComplete("Topics loaded");
    } catch (dbError) {
      logger.actionFailed("Topics loading", dbError);
      logger.actionFailed("Topics loading", dbError);
      // If topics index is corrupted, offer to reset it
      const response = await vscode.window.showErrorMessage(
        "Failed to load RAG topics. Would you like to reset the database?",
        "Reset Database",
        "Cancel"
      );

      if (response === "Reset Database") {
        logger.actionStart("Database reset");
        // Delete all topics to reset
        const topics = await topicManager.getAllTopics();
        logger.debug(`Deleting ${topics.length} topics for database reset`);
        for (const topic of topics) {
          logger.debug(`Deleting topic: ${topic.name}`);
          await topicManager.deleteTopic(topic.id);
        }
        vscode.window.showInformationMessage(
          "Database has been reset successfully."
        );
        logger.actionComplete("Database reset");
      } else {
        logger.debug("User cancelled database reset");
      }
      // Don't throw - let the extension continue working
    }

    // Register RAG tool for Copilot/LLM agents
    logger.actionStart("RAG tool registration");
    try {
      // Check if Language Model API is available
      logger.debug("Checking Language Model API availability");
      if (!vscode.lm || typeof vscode.lm.registerTool !== "function") {
        logger.warn(
          "Language Model API not available. Requires VS Code 1.90+ and GitHub Copilot Chat."
        );
        logger.actionComplete("RAG tool registration skipped - API not available");
        logger.actionComplete("RAG tool registration skipped - API not available");
        vscode.window
          .showWarningMessage(
            "RAG Tool requires VS Code 1.90+ and GitHub Copilot Chat extension to be visible.",
            "Learn More"
          )
          .then((selection) => {
            if (selection === "Learn More") {
              logger.debug("User requested more information about RAG tool requirements");
              vscode.env.openExternal(
                vscode.Uri.parse(
                  "https://code.visualstudio.com/docs/copilot/copilot-chat"
                )
              );
            }
          });
      } else {
        logger.debug("Language Model API is available, registering RAG tool");
        const ragToolDisposable = RAGTool.register(context);
        logger.actionComplete("RAG tool registered successfully");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.actionFailed("RAG tool registration", error);
      logger.actionFailed("RAG tool registration", error);
      vscode.window.showWarningMessage(
        `RAG tool registration failed: ${errorMessage}`
      );
    }

    // Note: Welcome message removed - default topic is created automatically
    // Mark as shown so we don't need to track this anymore
    if (!context.globalState.get(STATE.HAS_SHOWN_WELCOME, false)) {
      await context.globalState.update(STATE.HAS_SHOWN_WELCOME, true);
    }

    // Initialize FileWatcherService
    logger.actionStart("FileWatcherService initialization");
    fileWatcherService = new FileWatcherService(context, topicManager);
    await fileWatcherService.initialize();
    logger.actionComplete("FileWatcherService initialized");

    // Start REST server for CLI integration
    logger.actionStart("REST server initialization");
    try {
      const restServer = getRestServer();
      await restServer.start(topicManager, fileWatcherService);
      logger.actionComplete("REST server started");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`REST server failed to start: ${errorMessage}`);
      // Don't fail extension activation if server fails
    }

    // Register configuration change listener for embedding model
    logger.actionStart("Configuration change listener registration");
    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(
      async (event) => {
        logger.debug("Configuration change detected");
        const localModelPathSetting = `${CONFIG.ROOT}.${CONFIG.LOCAL_MODEL_PATH}`;
        const watchFolderSettings = [
          `${CONFIG.ROOT}.${CONFIG.WATCH_FOLDERS}`,
          `${CONFIG.ROOT}.${CONFIG.WATCH_FOLDER}`,
          `${CONFIG.ROOT}.${CONFIG.WATCH_ON_CHANGES}`,
          `${CONFIG.ROOT}.includeExtensions`,
        ];
        const treeViewConfigPaths = [
          `${CONFIG.ROOT}.${CONFIG.RETRIEVAL_STRATEGY}`,
          `${CONFIG.ROOT}.${CONFIG.USE_AGENTIC_MODE}`,
          `${CONFIG.ROOT}.${CONFIG.AGENTIC_USE_LLM}`,
          `${CONFIG.ROOT}.${CONFIG.AGENTIC_MAX_ITERATIONS}`,
          `${CONFIG.ROOT}.${CONFIG.AGENTIC_CONFIDENCE_THRESHOLD}`,
          `${CONFIG.ROOT}.${CONFIG.AGENTIC_ITERATIVE_REFINEMENT}`,
        ];
        
        // Check for log level changes
        const logLevelSetting = `${CONFIG.ROOT}.${CONFIG.LOG_LEVEL}`;
        if (event.affectsConfiguration(logLevelSetting)) {
          logger.actionStart("Log level configuration update");
          Logger.initializeFromConfig();
          logger.actionComplete("Log level updated from configuration");
        }

        if (
          event.affectsConfiguration(localModelPathSetting)
        ) {
          logger.actionStart("Embedding model path change");
          logger.info("Embedding local model path changed");

          try {
            const applyModel = async (): Promise<void> => {
              await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: `LocalRAG: Updating embedding model...`,
                },
                async (progress) => {
                  logger.debug("Embedding model update progress started");
                  progress.report({ message: "Loading embedding model..." });
                  await embeddingService.initialize();

                  progress.report({ message: "Reinitializing services..." });
                  await topicManager.reinitializeWithNewModel();
                  logger.debug("Embedding model reinitialization complete");
                }
              );

              const model = embeddingService.getCurrentModel();

              logger.info(`Embedding model ready: ${model}`);
              vscode.window.showInformationMessage(
                `LocalRAG: Embedding model set to "${model}"`
              );
            };

            await applyModel();
            // Refresh the tree view so local models / current model are visible
            treeDataProvider.refresh();
            logger.actionComplete("Embedding model path change");
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            logger.error("Failed to handle embedding model configuration change", {
              error: errorMessage,
            });
            logger.actionFailed("Embedding model path change", error);
            vscode.window.showErrorMessage(
              `LocalRAG: Failed to update embedding model: ${errorMessage}`
            );
          }
        }

        // Handle watch folder configuration changes
        const affectsWatchFolder = watchFolderSettings.some((configPath) =>
          event.affectsConfiguration(configPath)
        );
        if (affectsWatchFolder && fileWatcherService) {
          logger.info("Watch folder configuration changed");
          try {
            logger.actionStart("File watcher configuration update");
            await fileWatcherService.updateConfiguration();
            treeDataProvider.refresh(); // Refresh tree to show watch status
            logger.actionComplete("File watcher configuration update");
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            logger.error("Failed to update file watcher configuration", {
              error: errorMessage,
            });
            logger.actionFailed("File watcher configuration update", error);
          }
        }

        // Handle Common Database Path change
        if (event.affectsConfiguration(`${CONFIG.ROOT}.${CONFIG.COMMON_DATABASE_PATH}`)) {
          logger.info("Common database path configuration changed");
          await topicManager.loadCommonDatabase();
          treeDataProvider.refresh();
          vscode.window.showInformationMessage("Common database reloaded");
        }

        const affectsTreeViewConfig = treeViewConfigPaths.some((configPath) =>
          event.affectsConfiguration(configPath)
        );
        if (affectsTreeViewConfig) {
          logger.actionStart("Tree view refresh");
          logger.debug(
            "Configuration affecting tree view changed, refreshing view"
          );
          treeDataProvider.refresh();
          logger.actionComplete("Tree view refresh");
        }
      }
    );
    context.subscriptions.push(configChangeDisposable);
    logger.actionComplete("Configuration change listener registration");

    logger.info("Extension activation complete");
    logger.info("========================================");
    logger.info("LocalRAG Extension Activation Complete");
    logger.info("========================================");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to activate extension", { error: errorMessage });
    throw error; // Re-throw to signal activation failure
  }
}

export async function deactivate() {
  logger.info("========================================");
  logger.info("LocalRAG Extension Deactivation Starting");
  logger.info("========================================");

  try {
    // Stop REST server
    logger.actionStart("REST server shutdown");
    await disposeRestServer();
    logger.actionComplete("REST server stopped");

    // Dispose of FileWatcherService
    if (fileWatcherService) {
      logger.actionStart("FileWatcherService disposal");
      await fileWatcherService.dispose();
      fileWatcherService = null;
      logger.actionComplete("FileWatcherService disposed");
    }

    // Dispose of TopicManager (includes all caches and dependencies)
    logger.actionStart("TopicManager disposal");
    const topicManager = await TopicManager.getInstance();
    topicManager.dispose();
    logger.actionComplete("TopicManager disposed");

    // Dispose of EmbeddingService
    logger.actionStart("EmbeddingService disposal");
    const embeddingService = EmbeddingService.getInstance();
    embeddingService.dispose();
    logger.actionComplete("EmbeddingService disposed");

    logger.info("Extension deactivation complete");
    logger.info("========================================");
    logger.info("LocalRAG Extension Deactivation Complete");
    logger.info("========================================");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Error during deactivation", { error: errorMessage });
    // Don't throw - deactivation should be best-effort
  }
}
