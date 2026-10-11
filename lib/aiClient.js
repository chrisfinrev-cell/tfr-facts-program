'use strict';

// OpenAI access for every AI feature. Requires OPENAI_API_KEY.
// OPENAI_BASE_URL is honored only when it is not a third-party proxy we no longer use.

const OpenAI = require('openai');

const DEFAULT_MODEL = 'gpt-4o-mini';

function aiModel() {
  return process.env.OPENAI_MODEL || DEFAULT_MODEL;
}

function baseUrl() {
  const configured = String(process.env.OPENAI_BASE_URL || '').trim();
  if (!configured || /polsia/i.test(configured)) return 'https://api.openai.com/v1';
  return configured;
}

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: baseUrl() });
}

/**
 * Sends a chat and returns the reply text.
 * @param {{role: 'user'|'assistant', content: string}[]} messages
 * @param {string} [systemPrompt]
 * @param {{maxTokens?: number, model?: string}} [options]
 */
async function chat(messages, systemPrompt, options = {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  const all = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
  const completion = await getOpenAI().chat.completions.create({
    model: options.model || aiModel(),
    max_tokens: options.maxTokens || 1024,
    messages: all
  });
  return completion.choices?.[0]?.message?.content || '';
}

module.exports = { getOpenAI, chat, aiModel };
