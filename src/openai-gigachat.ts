import type { IncomingMessage } from 'node:http';

export type OpenAiGigaChatRoute =
  | { kind: 'chat' }
  | { kind: 'models' }
  | { kind: 'model'; model: string };

export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    param: null;
    code: string | null;
    upstream?: {
      statusCode: number;
      contentType: string | null;
      bodyBytes: number;
      bodyPreview?: string;
    };
  };
}

export type ChatRequestTransformResult =
  | { ok: true; body: Record<string, unknown>; originalModel: string; stream: boolean; structuredOutputFunctionName?: string }
  | { ok: false; statusCode: number; error: OpenAiErrorBody };

const RESERVED_TOOL_NAMES = new Map([
  ['web_search', '__gpt2giga_user_search_web']
]);

export const TRANSLATED_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;
export const TRANSLATED_UPSTREAM_BODY_LIMIT_BYTES = 1024 * 1024;
export const TRANSLATED_SSE_EVENT_LIMIT_BYTES = 1024 * 1024;

export class TranslationBufferLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationBufferLimitError';
  }
}

export function getOpenAiGigaChatRoute(method: string | undefined, url: string | undefined): OpenAiGigaChatRoute | undefined {
  const normalizedMethod = (method || 'GET').toUpperCase();
  const pathname = getPathname(url).replace(/\/$/, '') || '/';

  if (normalizedMethod === 'POST' && (pathname === '/chat/completions' || pathname === '/v1/chat/completions')) {
    return { kind: 'chat' };
  }

  if (normalizedMethod === 'GET' && (pathname === '/models' || pathname === '/v1/models')) {
    return { kind: 'models' };
  }

  const modelMatch = /^\/(?:v1\/)?models\/([^/]+)$/.exec(pathname);
  if (normalizedMethod === 'GET' && modelMatch) {
    return { kind: 'model', model: modelMatch[1] };
  }

  return undefined;
}

export function buildGigaChatUpstreamUrl(upstreamBaseUrl: URL, incomingUrl: string | undefined, route: OpenAiGigaChatRoute): URL {
  const incoming = new URL(incomingUrl || '/', 'http://127.0.0.1');
  const target = new URL(upstreamBaseUrl.href);
  const basePath = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');
  const routePath = route.kind === 'chat'
    ? '/chat/completions'
    : route.kind === 'models'
      ? '/models'
      : `/models/${route.model}`;

  target.pathname = `${basePath}${routePath}`;
  target.search = incoming.search;
  return target;
}

export function unsupportedEndpointError(method: string | undefined, url: string | undefined): OpenAiErrorBody {
  return openAiError(
    `Unsupported endpoint in openai-gigachat translation mode: ${method || 'GET'} ${getPathname(url)}`,
    'invalid_request_error',
    'unsupported_endpoint'
  );
}

export function openAiError(message: string, type = 'invalid_request_error', code: string | null = null): OpenAiErrorBody {
  return { error: { message, type, param: null, code } };
}

export function normalizeUpstreamError(statusCode: number, data: unknown): OpenAiErrorBody {
  if (isRecord(data) && isRecord(data.error)) {
    return openAiError(
      typeof data.error.message === 'string' ? data.error.message : `Upstream returned HTTP ${statusCode}`,
      typeof data.error.type === 'string' ? data.error.type : defaultErrorType(statusCode),
      typeof data.error.code === 'string' ? data.error.code : null
    );
  }

  if (isRecord(data) && typeof data.message === 'string') {
    return openAiError(data.message, defaultErrorType(statusCode), null);
  }

  if (isRecord(data) && typeof data.detail === 'string') {
    return openAiError(data.detail, defaultErrorType(statusCode), null);
  }

  return openAiError(`Upstream returned HTTP ${statusCode}`, defaultErrorType(statusCode), null);
}

export function transformChatCompletionRequest(data: unknown): ChatRequestTransformResult {
  if (!isRecord(data)) {
    return {
      ok: false,
      statusCode: 400,
      error: openAiError('Chat completion request body must be a JSON object', 'invalid_request_error', 'invalid_json')
    };
  }

  const transformed: Record<string, unknown> = { ...data };
  const originalModel = typeof data.model === 'string' ? data.model : '';
  const stream = data.stream === true;

  if ('max_output_tokens' in transformed) {
    transformed.max_tokens = transformed.max_output_tokens;
    delete transformed.max_output_tokens;
  }

  if ('extra_body' in transformed) {
    transformed.additional_fields = mergeAdditionalFields(transformed.extra_body, transformed.additional_fields);
    delete transformed.extra_body;
  }

  if (isRecord(transformed.reasoning)) {
    if (typeof transformed.reasoning.effort === 'string') {
      transformed.reasoning_effort = transformed.reasoning.effort;
    }
    delete transformed.reasoning;
  }

  const functions = convertFunctions(transformed.functions, transformed.tools);
  delete transformed.tools;
  const structuredOutputFunctionName = appendStructuredOutputFunction(transformed.response_format, functions);
  if (structuredOutputFunctionName) {
    transformed.function_call = { name: structuredOutputFunctionName };
    delete transformed.response_format;
  } else {
    applyToolChoice(transformed, functions);
  }
  if (functions.length > 0) {
    transformed.functions = functions;
  } else {
    delete transformed.functions;
  }

  if (isRecord(transformed.function_call)) {
    transformed.function_call = transformFunctionCall(transformed.function_call);
  }

  const messages = transformMessages(transformed.messages);
  if (!messages.ok) {
    return messages;
  }
  transformed.messages = messages.messages;

  return { ok: true, body: transformed, originalModel, stream, structuredOutputFunctionName };
}

export function translateChatCompletionResponse(data: unknown, originalModel: string, requestId: string, options: { structuredOutputFunctionName?: string } = {}, created = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  const response = isRecord(data) ? data : {};
  const choices = Array.isArray(response.choices) ? response.choices : [];

  return {
    id: `chatcmpl-${requestId}`,
    object: 'chat.completion',
    created,
    model: originalModel,
    choices: choices.map((choice, index) => translateChatChoice(choice, index, requestId, options.structuredOutputFunctionName)),
    usage: translateUsage(response.usage),
    system_fingerprint: `fp_${requestId}`
  };
}

export function translateChatCompletionStreamChunk(data: unknown, originalModel: string, requestId: string, created = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  const response = isRecord(data) ? data : {};
  const choices = Array.isArray(response.choices) ? response.choices : [];

  return {
    id: `chatcmpl-${requestId}`,
    object: 'chat.completion.chunk',
    created,
    model: originalModel,
    choices: choices.map((choice, index) => translateChatStreamChoice(choice, index, requestId)),
    usage: translateUsage(response.usage),
    system_fingerprint: `fp_${requestId}`
  };
}

export function translateModelsResponse(data: unknown, created = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  const models = extractModelList(data);
  return {
    object: 'list',
    data: models.map((model) => normalizeModel(model, created))
  };
}

export function translateModelResponse(data: unknown, created = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  return normalizeModel(data, created);
}

export function readIncomingBody(req: IncomingMessage, limitBytes = TRANSLATED_REQUEST_BODY_LIMIT_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let rejected = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (rejected) {
        return;
      }
      bytes += Buffer.byteLength(chunk);
      if (bytes > limitBytes) {
        rejected = true;
        reject(new TranslationBufferLimitError('Translated request body exceeds limit'));
        req.resume();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (rejected) {
        return;
      }
      resolve(body);
    });
    req.on('error', reject);
  });
}

function getPathname(url: string | undefined): string {
  return new URL(url || '/', 'http://127.0.0.1').pathname;
}

function defaultErrorType(statusCode: number): string {
  if (statusCode === 401) {
    return 'authentication_error';
  }
  if (statusCode === 403) {
    return 'permission_denied_error';
  }
  if (statusCode === 404) {
    return 'not_found_error';
  }
  if (statusCode === 429) {
    return 'rate_limit_error';
  }
  if (statusCode >= 500) {
    return 'server_error';
  }
  return 'invalid_request_error';
}

function mergeAdditionalFields(extraBody: unknown, additionalFields: unknown): unknown {
  if (isRecord(extraBody)) {
    if (isRecord(additionalFields)) {
      return { ...extraBody, ...additionalFields };
    }
    return { ...extraBody };
  }

  return additionalFields === undefined ? extraBody : additionalFields;
}

function convertFunctions(legacyFunctions: unknown, tools: unknown): Record<string, unknown>[] {
  const functions: Record<string, unknown>[] = [];

  if (Array.isArray(legacyFunctions)) {
    for (const legacyFunction of legacyFunctions) {
      const converted = convertFunctionDefinition(legacyFunction);
      if (converted) {
        functions.push(converted);
      }
    }
  }

  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (!isRecord(tool) || tool.type !== 'function') {
        continue;
      }

      const converted = convertFunctionDefinition(tool.function);
      if (converted) {
        functions.push(converted);
      }
    }
  }

  return functions;
}

function convertFunctionDefinition(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || !isRecord(value.parameters)) {
    return undefined;
  }

  const converted: Record<string, unknown> = {
    name: mapToolNameToGigaChat(value.name),
    parameters: normalizeJsonSchema(value.parameters)
  };

  if (typeof value.description === 'string') {
    converted.description = value.description;
  }

  return converted;
}

function appendStructuredOutputFunction(responseFormat: unknown, functions: Record<string, unknown>[]): string | undefined {
  if (!isRecord(responseFormat) || responseFormat.type !== 'json_schema') {
    return undefined;
  }

  const jsonSchema = isRecord(responseFormat.json_schema) ? responseFormat.json_schema : responseFormat;
  const rawName = typeof jsonSchema.name === 'string' && jsonSchema.name ? jsonSchema.name : 'structured_output';
  const name = toSafeFunctionName(rawName);
  const schema = isRecord(jsonSchema.schema) ? jsonSchema.schema : {};

  functions.push({
    name,
    description: `Output response in structured format: ${name}`,
    parameters: normalizeJsonSchema(schema)
  });

  return name;
}

function applyToolChoice(transformed: Record<string, unknown>, functions: Record<string, unknown>[]): void {
  const toolChoice = transformed.tool_choice;
  delete transformed.tool_choice;

  if (typeof toolChoice === 'string') {
    if (toolChoice === 'none') {
      functions.length = 0;
      delete transformed.function_call;
    }
    return;
  }

  if (!isRecord(toolChoice)) {
    return;
  }

  const choiceFunction = isRecord(toolChoice.function) ? toolChoice.function : toolChoice;
  if (typeof choiceFunction.name === 'string') {
    transformed.function_call = { name: choiceFunction.name };
  }
}

function normalizeJsonSchema(schema: unknown): unknown {
  const root = cloneJson(schema);
  return normalizeSchemaNode(root, root, new Set<string>());
}

function normalizeSchemaNode(value: unknown, root: unknown, seenRefs: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSchemaNode(item, root, seenRefs));
  }

  if (!isRecord(value)) {
    return value;
  }

  const node: Record<string, unknown> = { ...value };

  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const ref = node.$ref;
    const resolved = resolveJsonPointer(root, ref);
    const siblings = { ...node };
    delete siblings.$ref;

    if (resolved !== undefined && !seenRefs.has(ref)) {
      seenRefs.add(ref);
      const normalizedResolved = normalizeSchemaNode(resolved, root, seenRefs);
      seenRefs.delete(ref);
      const merged = isRecord(normalizedResolved) ? { ...normalizedResolved, ...siblings } : siblings;
      return normalizeSchemaNode(merged, root, seenRefs);
    }
  }

  const combinator = Array.isArray(node.anyOf) ? 'anyOf' : Array.isArray(node.oneOf) ? 'oneOf' : undefined;
  if (combinator) {
    const variants = node[combinator] as unknown[];
    const chosen = variants.find((variant) => !isNullSchema(variant)) ?? variants[0];
    const siblings = { ...node };
    delete siblings.anyOf;
    delete siblings.oneOf;
    const merged = isRecord(chosen) ? { ...chosen, ...siblings } : siblings;
    return normalizeSchemaNode(merged, root, seenRefs);
  }

  delete node.$defs;

  if (Array.isArray(node.type)) {
    node.type = node.type.find((type) => type !== 'null') ?? node.type[0];
  }

  for (const [key, child] of Object.entries(node)) {
    node[key] = normalizeSchemaNode(child, root, seenRefs);
  }

  if (node.type === 'object' && !isRecord(node.properties)) {
    node.properties = {};
  }

  return node;
}

function isNullSchema(value: unknown): boolean {
  return isRecord(value) && (value.type === 'null' || (Array.isArray(value.type) && value.type.every((type) => type === 'null')));
}

function resolveJsonPointer(root: unknown, ref: string): unknown {
  const parts = ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current = root;

  for (const part of parts) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

function transformMessages(value: unknown):
  | { ok: true; messages: Record<string, unknown>[] }
  | { ok: false; statusCode: number; error: OpenAiErrorBody } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      statusCode: 400,
      error: openAiError('Chat completion request messages must be an array', 'invalid_request_error', 'invalid_messages')
    };
  }

  let sawSystemLike = false;
  const toolCallNames = new Map<string, string>();
  const transformed: Record<string, unknown>[] = [];

  for (const message of value) {
    if (!isRecord(message)) {
      return {
        ok: false,
        statusCode: 400,
        error: openAiError('Chat completion messages must be JSON objects', 'invalid_request_error', 'invalid_messages')
      };
    }

    const originalRole = typeof message.role === 'string' ? message.role : 'user';
    const role = mapMessageRole(originalRole, sawSystemLike);
    if (originalRole === 'system' || originalRole === 'developer') {
      sawSystemLike = true;
    }

    const content = role === 'function'
      ? normalizeToolResultContent(message.content)
      : normalizeMessageContent(message.content);
    if (!content.ok) {
      return content;
    }

    const converted: Record<string, unknown> = { role, content: content.content };

    if (role === 'function') {
      const name = typeof message.name === 'string'
        ? message.name
        : typeof message.tool_call_id === 'string' && toolCallNames.has(message.tool_call_id)
          ? toolCallNames.get(message.tool_call_id) as string
        : typeof message.tool_call_id === 'string'
          ? message.tool_call_id
          : 'tool_result';
      converted.name = toSafeFunctionName(name);
    }

    const firstToolCall = getFirstToolCall(message.tool_calls);
    if (firstToolCall && typeof firstToolCall.id === 'string' && typeof firstToolCall.function.name === 'string') {
      toolCallNames.set(firstToolCall.id, firstToolCall.function.name);
    }

    const functionCall = firstToolCall?.function ?? (isRecord(message.function_call) ? message.function_call : undefined);
    if (functionCall && role === 'assistant') {
      converted.function_call = transformFunctionCall(functionCall);
    }

    transformed.push(converted);
  }

  const firstSystemIndex = transformed.findIndex((message) => message.role === 'system');
  if (firstSystemIndex > 0) {
    const [systemMessage] = transformed.splice(firstSystemIndex, 1);
    transformed.unshift(systemMessage);
  }

  return { ok: true, messages: mergeConsecutiveMessages(transformed) };
}

function mapMessageRole(role: string, sawSystemLike: boolean): string {
  if (role === 'system' || role === 'developer') {
    return sawSystemLike ? 'user' : 'system';
  }
  if (role === 'user' || role === 'assistant') {
    return role;
  }
  if (role === 'tool' || role === 'function') {
    return 'function';
  }
  return 'user';
}

function normalizeMessageContent(value: unknown):
  | { ok: true; content: string }
  | { ok: false; statusCode: number; error: OpenAiErrorBody } {
  if (value === null || value === undefined) {
    return { ok: true, content: '' };
  }

  if (typeof value === 'string') {
    return { ok: true, content: value };
  }

  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const part of value) {
      if (isRecord(part) && part.type === 'text') {
        texts.push(typeof part.text === 'string' ? part.text : String(part.text ?? ''));
        continue;
      }

      const type = isRecord(part) && typeof part.type === 'string' ? part.type : 'unknown';
      return {
        ok: false,
        statusCode: 400,
        error: openAiError(`Unsupported chat message content part for openai-gigachat MVP: ${type}`, 'invalid_request_error', 'unsupported_content')
      };
    }
    return { ok: true, content: texts.join('\n') };
  }

  return {
    ok: false,
    statusCode: 400,
    error: openAiError('Unsupported chat message content for openai-gigachat MVP', 'invalid_request_error', 'unsupported_content')
  };
}

function normalizeToolResultContent(value: unknown):
  | { ok: true; content: string }
  | { ok: false; statusCode: number; error: OpenAiErrorBody } {
  if (isRecord(value)) {
    return { ok: true, content: JSON.stringify(value) };
  }

  const normalized = normalizeMessageContent(value);
  if (!normalized.ok) {
    return normalized;
  }

  const trimmed = normalized.content.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      return { ok: true, content: JSON.stringify(parsed) };
    }
    return { ok: true, content: JSON.stringify({ content: parsed }) };
  } catch {
    return { ok: true, content: JSON.stringify({ content: normalized.content }) };
  }
}

function getFirstToolCall(toolCalls: unknown): { id: unknown; function: Record<string, unknown> } | undefined {
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }

  for (const toolCall of toolCalls) {
    if (isRecord(toolCall) && toolCall.type === 'function' && isRecord(toolCall.function)) {
      return { id: toolCall.id, function: toolCall.function };
    }
  }

  return undefined;
}

function transformFunctionCall(functionCall: Record<string, unknown>): Record<string, unknown> {
  const transformed: Record<string, unknown> = { ...functionCall };
  if (typeof transformed.name === 'string') {
    transformed.name = mapToolNameToGigaChat(transformed.name);
  }
  if (typeof transformed.arguments === 'string') {
    transformed.arguments = parseJsonStringIfPossible(transformed.arguments);
  }
  return transformed;
}

function translateChatChoice(choice: unknown, index: number, requestId: string, structuredOutputFunctionName?: string): Record<string, unknown> {
  const source = isRecord(choice) ? choice : {};
  const sourceMessage = isRecord(source.message) ? source.message : {};
  const message: Record<string, unknown> = {
    role: typeof sourceMessage.role === 'string' ? sourceMessage.role : 'assistant',
    content: 'content' in sourceMessage ? sourceMessage.content : null,
    refusal: null
  };

  if (structuredOutputFunctionName && isRecord(sourceMessage.function_call) && sourceMessage.function_call.name === structuredOutputFunctionName) {
    message.content = stringifyFunctionArguments(sourceMessage.function_call.arguments);
    return {
      index: typeof source.index === 'number' ? source.index : index,
      message,
      finish_reason: 'stop',
      logprobs: null
    };
  }

  if (isRecord(sourceMessage.function_call)) {
    message.tool_calls = [translateFunctionCallToToolCall(sourceMessage.function_call, requestId, index)];
  }

  return {
    index: typeof source.index === 'number' ? source.index : index,
    message,
    finish_reason: source.finish_reason === 'function_call' ? 'tool_calls' : source.finish_reason ?? null,
    logprobs: null
  };
}

function translateFunctionCallToToolCall(functionCall: Record<string, unknown>, requestId: string, index: number): Record<string, unknown> {
  const name = typeof functionCall.name === 'string' ? mapToolNameFromGigaChat(functionCall.name) : '';
  return {
    id: `call_${requestId}_${index}`,
    type: 'function',
    function: {
      name,
      arguments: stringifyFunctionArguments(functionCall.arguments)
    }
  };
}

function translateChatStreamChoice(choice: unknown, index: number, requestId: string): Record<string, unknown> {
  const source = isRecord(choice) ? choice : {};
  const sourceDelta = isRecord(source.delta) ? source.delta : {};
  const delta: Record<string, unknown> = {};

  if (typeof sourceDelta.role === 'string') {
    delta.role = sourceDelta.role;
  }
  if ('content' in sourceDelta) {
    delta.content = sourceDelta.content;
  }
  if (isRecord(sourceDelta.function_call)) {
    delta.tool_calls = [translateFunctionCallDeltaToToolCall(sourceDelta.function_call, requestId, index)];
  }

  return {
    index: typeof source.index === 'number' ? source.index : index,
    delta,
    finish_reason: source.finish_reason === 'function_call' ? 'tool_calls' : source.finish_reason ?? null,
    logprobs: null
  };
}

function translateFunctionCallDeltaToToolCall(functionCall: Record<string, unknown>, requestId: string, index: number): Record<string, unknown> {
  const functionDelta: Record<string, unknown> = {};
  if (typeof functionCall.name === 'string') {
    functionDelta.name = mapToolNameFromGigaChat(functionCall.name);
  }
  if (Object.prototype.hasOwnProperty.call(functionCall, 'arguments')) {
    functionDelta.arguments = stringifyFunctionArguments(functionCall.arguments);
  }

  return {
    index,
    id: `call_${requestId}_${index}`,
    type: 'function',
    function: functionDelta
  };
}

function translateUsage(usage: unknown): Record<string, unknown> | null {
  if (!isRecord(usage)) {
    return null;
  }

  return {
    prompt_tokens: toNumber(usage.prompt_tokens) ?? 0,
    completion_tokens: toNumber(usage.completion_tokens) ?? 0,
    total_tokens: toNumber(usage.total_tokens) ?? 0,
    prompt_tokens_details: {
      cached_tokens: toNumber(usage.precached_prompt_tokens) ?? 0
    },
    completion_tokens_details: {
      reasoning_tokens: 0
    }
  };
}

function extractModelList(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }
  if (!isRecord(data)) {
    return [];
  }
  if (Array.isArray(data.data)) {
    return data.data;
  }
  if (Array.isArray(data.models)) {
    return data.models;
  }
  return [];
}

function normalizeModel(model: unknown, fallbackCreated: number): Record<string, unknown> {
  if (!isRecord(model)) {
    return {
      id: String(model),
      object: 'model',
      created: fallbackCreated,
      owned_by: 'gigachat'
    };
  }

  return {
    id: getFirstString(model, ['id', 'name', 'id_', 'model', 'model_name']) ?? 'unknown',
    object: 'model',
    created: getCreated(model, fallbackCreated),
    owned_by: getFirstString(model, ['owned_by', 'ownedBy', 'owned']) ?? 'gigachat'
  };
}

function getFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string') {
      return record[key];
    }
  }
  return undefined;
}

function getCreated(record: Record<string, unknown>, fallback: number): number {
  const numeric = toNumber(record.created) ?? toNumber(record.created_at);
  if (numeric !== undefined) {
    return numeric;
  }
  if (typeof record.created_at === 'string') {
    const timestampMs = Date.parse(record.created_at);
    if (Number.isFinite(timestampMs)) {
      return Math.floor(timestampMs / 1000);
    }
  }
  return fallback;
}

function stringifyFunctionArguments(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '{}';
  }
  return JSON.stringify(value);
}

function mapToolNameFromGigaChat(name: string): string {
  for (const [openAiName, gigaChatName] of RESERVED_TOOL_NAMES.entries()) {
    if (name === gigaChatName) {
      return openAiName;
    }
  }
  return name;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mergeConsecutiveMessages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const merged: Record<string, unknown>[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous && canMergeMessages(previous, message)) {
      previous.content = `${previous.content as string}\n${message.content as string}`;
      continue;
    }
    merged.push(message);
  }

  return merged;
}

function canMergeMessages(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return left.role === right.role
    && left.role !== 'function'
    && typeof left.content === 'string'
    && typeof right.content === 'string'
    && left.function_call === undefined
    && right.function_call === undefined;
}

function mapToolNameToGigaChat(name: string): string {
  return RESERVED_TOOL_NAMES.get(name) ?? name;
}

function toSafeFunctionName(name: string): string {
  const mapped = mapToolNameToGigaChat(name).replace(/[^A-Za-z0-9_-]/g, '_');
  return mapped || 'tool_result';
}

function parseJsonStringIfPossible(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function cloneJson<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
