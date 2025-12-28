/**
 * Central constants for the LocalRAG extension
 * All identifiers, command names, and configuration keys are defined here
 */

/**
 * Extension identifiers
 */
export const EXTENSION = {
  ID: "localrag",
  DISPLAY_NAME: "LocalRAG",
  DATABASE_DIR: "database",
  TOPICS_INDEX_FILENAME: "topics.json",
  DEFAULT_TOPIC_NAME: "Default",
} as const;

/**
 * Configuration keys
 */
export const CONFIG = {
  ROOT: "localrag",
  // Basic configuration
  LOCAL_MODEL_PATH: "localModelPath",
  TOP_K: "topK",
  CHUNK_SIZE: "chunkSize",
  CHUNK_OVERLAP: "chunkOverlap",
  LOG_LEVEL: "logLevel",
  RETRIEVAL_STRATEGY: "retrievalStrategy",
  // Agentic RAG configuration
  USE_AGENTIC_MODE: "useAgenticMode",
  AGENTIC_MAX_ITERATIONS: "agenticMaxIterations",
  AGENTIC_CONFIDENCE_THRESHOLD: "agenticConfidenceThreshold",
  AGENTIC_ITERATIVE_REFINEMENT: "agenticIterativeRefinement",
  AGENTIC_USE_LLM: "agenticUseLLM",
  AGENTIC_LLM_MODEL: "agenticLLMModel",
  AGENTIC_INCLUDE_WORKSPACE: "agenticIncludeWorkspaceContext",
  // Folder watching configuration
  WATCH_FOLDER: "watchFolder",
  WATCH_FOLDER_RECURSIVE: "watchFolderRecursive",
} as const;

/**
 * Default configuration values
 */
export const DEFAULTS = {
  LOCAL_MODEL_PATH: "",
  EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
  INCLUDE_EXTENSIONS: [".pdf", ".md", ".markdown", ".html", ".htm", ".txt"],
};

/**
 * Command identifiers
 */
export const COMMANDS = {
  CREATE_TOPIC: "localrag.createTopic",
  DELETE_TOPIC: "localrag.deleteTopic",
  ADD_DOCUMENT: "localrag.addDocument",
  ADD_GITHUB_REPO: "localrag.addGithubRepo",
  REFRESH_TOPICS: "localrag.refreshTopics",
  CLEAR_MODEL_CACHE: "localrag.clearModelCache",
  CLEAR_DATABASE: "localrag.clearDatabase",
  SET_EMBEDDING_MODEL: "localrag.setEmbeddingModel",
  // GitHub token management
  ADD_GITHUB_TOKEN: "localrag.addGithubToken",
  LIST_GITHUB_TOKENS: "localrag.listGithubTokens",
  REMOVE_GITHUB_TOKEN: "localrag.removeGithubToken",
} as const;

/**
 * View identifiers
 */
export const VIEWS = {
  RAG_TOPICS: "ragTopics",
} as const;

/**
 * Global state keys
 */
export const STATE = {
  HAS_SHOWN_WELCOME: "localrag.hasShownWelcome",
} as const;

/**
 * Tool identifiers
 */
export const TOOLS = {
  RAG_QUERY: "ragQuery",
} as const;
