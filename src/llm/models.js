import { GatewayChat, GatewayEmbedder } from './gateway.js';
import { OllamaChat, OllamaEmbedder } from './ollama.js';

function requireRouter(models) {
  if (!models.llmRouterUrl) {
    throw new Error('LLM router URL is not configured: set LLM_ROUTER_BASE_URL, "llmRouterUrl" in the user config or --llm-router-url');
  }
  return models.llmRouterUrl;
}

// Model route: `gateway` (private LiteLLM, default) or `ollama` (local).
export function createEmbedder(models) {
  if (!models.embeddingsEnabled) return null;
  if (models.provider === 'ollama') {
    return new OllamaEmbedder({ baseUrl: models.ollamaUrl, model: models.embedModel, approvedHosts: models.approvedHosts });
  }
  return new GatewayEmbedder({ baseUrl: requireRouter(models), apiKey: models.llmRouterApiKey, model: models.embedModel });
}

export function createChat(models) {
  if (models.provider === 'ollama') {
    return new OllamaChat({ baseUrl: models.ollamaUrl, model: models.chatModel, approvedHosts: models.approvedHosts });
  }
  return new GatewayChat({ baseUrl: requireRouter(models), apiKey: models.llmRouterApiKey, model: models.chatModel });
}
