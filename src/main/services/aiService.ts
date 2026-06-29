import type { AIConfig, AICompletionRequest, PromptCoachResult } from '@shared/types'
import { OpenRouterClient, PromptCoach } from '../ai'
import type { SecureStorageAdapter } from '../platform'
import type { SettingsRepository } from '../database/repositories/settingsRepository'
import { getEnv } from './env'

const KEY_API = 'openrouter.apiKey'
const KEY_MODEL = 'openrouter.model'
const KEY_TEMP = 'openrouter.temperature'
const KEY_MAX_TOKENS = 'openrouter.maxTokens'

const DEFAULT_CONFIG: Omit<AIConfig, 'apiKey'> = {
  model: 'meta-llama/llama-3.1-8b-instruct:free',
  temperature: 0.7,
  maxTokens: 1024
}

/**
 * Resolves AI configuration from settings + secure storage and exposes the two
 * AI capabilities used by the renderer: free-form completion and the Prompt Coach.
 */
export class AIService {
  private readonly client = new OpenRouterClient()
  private readonly coach = new PromptCoach(this.client)

  constructor(
    private readonly settings: SettingsRepository,
    private readonly secureStorage: SecureStorageAdapter
  ) {}

  /** Stored key wins; falls back to OPENROUTER_API_KEY from the bundled .env. */
  private async getApiKey(): Promise<string> {
    return (await this.secureStorage.get(KEY_API)) || getEnv('OPENROUTER_API_KEY')
  }

  async resolveConfig(overrides?: Partial<AIConfig>): Promise<AIConfig> {
    const apiKey = overrides?.apiKey ?? (await this.getApiKey())
    if (!apiKey) throw new Error('No OpenRouter API key configured.')
    return {
      apiKey,
      model: overrides?.model ?? this.settings.get(KEY_MODEL) ?? DEFAULT_CONFIG.model,
      temperature:
        overrides?.temperature ?? numberSetting(this.settings.get(KEY_TEMP), DEFAULT_CONFIG.temperature),
      maxTokens:
        overrides?.maxTokens ??
        numberSetting(this.settings.get(KEY_MAX_TOKENS), DEFAULT_CONFIG.maxTokens)
    }
  }

  async complete(request: AICompletionRequest): Promise<string> {
    const config = await this.resolveConfig(request.config)
    return this.client.complete(request.messages, config)
  }

  async promptCoach(prompt: string): Promise<PromptCoachResult> {
    const config = await this.resolveConfig()
    return this.coach.analyze(prompt, config)
  }

  /** Rewrite a prompt for best results, returning only the improved text. */
  async improvePrompt(prompt: string): Promise<string> {
    const config = await this.resolveConfig()
    return this.coach.improve(prompt, config)
  }

  async saveApiKey(key: string): Promise<void> {
    await this.secureStorage.set(KEY_API, key)
  }

  async hasApiKey(): Promise<boolean> {
    return !!(await this.getApiKey())
  }
}

function numberSetting(value: string | null, fallback: number): number {
  if (value === null) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
