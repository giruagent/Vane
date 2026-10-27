const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = require('node:path').resolve(__dirname, '..') + '/';
function load(file, mocks) {
  const compiled = ts.transpileModule(fs.readFileSync(root + file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    reportDiagnostics: true,
  });
  assert.equal((compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, crypto: globalThis.crypto, console,
    require(name) { if (!(name in mocks)) throw new Error('Unexpected import ' + name); return mocks[name]; }
  }, { filename: file });
  return module.exports.default;
}
const signature = { google: { thought_signature: 'opaque-test-signature' } };
const BaseLLM = class { constructor(config) { this.config = config; } };
const LLM = load('src/lib/models/providers/openai/openaiLLM.ts', {
  openai: class {}, '../../base/llm': BaseLLM, 'openai/helpers/zod': {},
  'partial-json': { parse: JSON.parse }, zod: {}, '@toolsycc/json-repair': {},
});
async function main() {
  const llm = new LLM({ apiKey: 'test', model: 'test' });
  llm.openAIClient = { chat: { completions: { async create() {
    return { choices: [{ message: { content: '', tool_calls: [{ type: 'function', id: 'a',
      function: { name: 'search', arguments: '{}' }, extra_content: signature }] }, finish_reason: 'tool_calls' }] };
  } } } };
  const response = await llm.generateText({ messages: [] });
  assert.equal(response.toolCalls[0].extra_content, signature);
  const replay = llm.convertToOpenAIMessages([{ role: 'assistant', content: '', tool_calls: response.toolCalls }]);
  assert.equal(replay[0].tool_calls[0].extra_content, signature);
  llm.openAIClient.chat.completions.create = async () => (async function* () {
    yield { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'search', arguments: '{}' } }] }, finish_reason: null }] };
    yield { choices: [{ delta: { tool_calls: [{ index: 1, extra_content: signature }] }, finish_reason: 'tool_calls' }] };
  })();
  const chunks = [];
  for await (const chunk of llm.streamText({ messages: [] })) chunks.push(chunk);
  assert.equal(chunks[1].toolCallChunk[0].extra_content, signature);
  assert.equal(chunks[1].toolCallChunk[0].id, 'b');
  assert.equal(chunks[1].toolCallChunk[0].name, 'search');
  assert.equal(chunks[0].toolCallChunk[0].extra_content, undefined);
  const Researcher = load('src/lib/agents/search/researcher/index.ts', {
    './actions': { ActionRegistry: { getAvailableActionTools: () => [], getAvailableActionsDescriptions: () => '',
      executeAll: async () => [{ type: 'reasoning' }] } },
    '@/lib/prompts/search/researcher': { getResearcherPrompt: () => '' },
    '@/lib/utils/formatHistory': () => '',
  });
  let requests = 0;
  await new Researcher().research({ emitBlock() {}, getBlock() {}, updateBlock() {} }, {
    chatHistory: [], followUp: 'test', classification: {}, config: { mode: 'speed', fileIds: [], sources: [],
      llm: { async *streamText(input) {
        if (requests++ === 0) {
          yield { toolCallChunk: [{ id: 'a', name: 'search', arguments: {} }] };
          yield { toolCallChunk: [{ id: 'a', name: 'search', arguments: {}, extra_content: signature }] };
        } else {
          assert.equal(input.messages.find(m => m.role === 'assistant').tool_calls[0].extra_content, signature);
          yield { toolCallChunk: [] };
        }
      } }
    }
  });
  assert.equal(requests, 2);
  const route = ts.transpileModule(fs.readFileSync(root + 'src/app/api/chat/route.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true,
  });
  assert.equal(route.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  console.log('PASS: non-streamed signature replay, late streamed signatures, sparse tool indexes, unsigned calls, researcher history replay, route syntax.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
