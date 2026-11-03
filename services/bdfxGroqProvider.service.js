const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

// The OpenAI-compatible SDK is only a client library. Every inference request
// uses Groq's fixed endpoint and a Groq key; never fall back to OpenAI billing.
function createGroqGenerate({ apiKey, Client = require('openai') }) {
  const client = new Client({ apiKey, baseURL: GROQ_BASE_URL, maxRetries: 0, timeout: 12000 });
  return async params => {
    const messages = [{ role: 'system', content: params.instructions }];
    for (const item of params.input) {
      if (item.role === 'user') messages.push({ role: 'user', content: item.content });
      else if (item.type === 'function_call') messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }] });
      else if (item.type === 'function_call_output') messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
    }
    const result = await client.chat.completions.create({
      model: params.model, messages,
      tools: params.tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } })),
      tool_choice: params.tool_choice, parallel_tool_calls: false,
      max_completion_tokens: params.max_output_tokens, reasoning_effort: 'low', stream: false,
    });
    const choice = result?.choices?.[0], message = choice?.message;
    if (!message || !['stop', 'tool_calls'].includes(choice.finish_reason) || (message.tool_calls && !Array.isArray(message.tool_calls))) return { status: 'incomplete', output: [] };
    const calls = message.tool_calls || [];
    if (calls.some(call => call.type !== 'function')) return { status: 'incomplete', output: [] };
    return { status: 'completed', output: calls.length ? calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.function?.name, arguments: call.function?.arguments })) : [{ type: 'message', role: 'assistant' }], output_text: message.content };
  };
}
module.exports = { GROQ_BASE_URL, createGroqGenerate };
