// Tools/AskGemini.js — the only tool: a prompt in, Gemini's answer out.

import { z } from 'zod';
import { askGemini } from '../GeminiClient.js';

export function createAskGemini(config) {
  return {
    name: 'ask_gemini',

    config: {
      title: 'Ask Gemini',
      description: [
        'Sends a prompt to Google Gemini and returns its answer as text.',
        'Use it for a second opinion, a review, or a task that benefits from another model.',
        'Gemini sees only the prompt - include all the context it needs.',
        'The server picks the best available Gemini model and falls back to another one on its own.',
        'On failure the result is an error whose text says whether and when to retry.',
      ].join('\n'),
      inputSchema: z.object({
        prompt: z.string().min(1).max(config.maxPromptChars)
          .describe(`The question or instruction for Gemini, with all needed context (max ${config.maxPromptChars} chars).`),
      }),
      annotations: {
        readOnlyHint:    true,
        destructiveHint: false,
        idempotentHint:  false,
        openWorldHint:   true,
      },
    },

    async handler({ prompt }) {
      const result = await askGemini(prompt);
      return result.ok
        ? { content: [{ type: 'text', text: result.text }] }
        : { content: [{ type: 'text', text: result.message }], isError: true };
    },
  };
}
