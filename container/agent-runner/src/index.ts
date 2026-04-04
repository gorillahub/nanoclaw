/**
 * NanoClaw Agent Runner
 * Token usage tracking added 2026-04-04
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  containerId?: string;
  secrets?: Record<string, string>;
  script?: string;
  model?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

// Token Usage Tracking
const TOKEN_USAGE_TABLE = 'tbl2z3ZhTbNYvD3jx';
const AIRTABLE_BASE_ID_TOKEN = 'appIXTHcT2b65p6BR';

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
}

function emptyUsage(): TokenUsage {
  return { input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
  };
}

function calcCostGbp(u: TokenUsage): number {
  return (
    u.input_tokens * 0.0000024 +
    u.output_tokens * 0.0000119 +
    u.cache_write_tokens * 0.000003 +
    u.cache_read_tokens * 0.00000024
  );
}

function calcCacheHitRate(u: TokenUsage): number {
  const total = u.input_tokens + u.cache_read_tokens;
  if (total === 0) return 0;
  return Math.round((u.cache_read_tokens / total) * 1000) / 10;
}

function inferOperationLabel(prompt: string, isScheduledTask: boolean): string {
  if (!isScheduledTask) return 'conversation';
  const lower = prompt.toLowerCase();
  if (lower.includes('session end') || lower.includes('wrapping up') || lower.includes('logging off') || lower.includes('done for today')) return 'session_end';
  if (lower.includes('daily cycle') || lower.includes('daily coo') || lower.includes('coo briefing') || lower.includes('08:00')) return 'startup';
  if (lower.includes('airtable')) return 'airtable_sync';
  if (lower.includes('git pull') || lower.includes('github pull')) return 'github_pull';
  return 'scheduled_task';
}

let _airtableApiKey: string | undefined;

async function logTokenUsage(
  sessionId: string,
  operationLabel: string,
  usage: TokenUsage,
  isSummary = false,
): Promise<void> {
  if (!_airtableApiKey) return;
  if (usage.input_tokens === 0 && usage.output_tokens === 0) return;
  const costGbp = Math.round(calcCostGbp(usage) * 1000000) / 1000000;
  const cacheHitRate = calcCacheHitRate(usage);
  try {
    const res = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID_TOKEN}/${TOKEN_USAGE_TABLE}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${_airtableApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          records: [{
            fields: {
              Timestamp: new Date().toISOString(),
              'Session ID': sessionId,
              'Operation Label': operationLabel,
              'Input Tokens': usage.input_tokens,
              'Output Tokens': usage.output_tokens,
              'Cache Write Tokens': usage.cache_write_tokens,
              'Cache Read Tokens': usage.cache_read_tokens,
              'Cost GBP': costGbp,
              'Cache Hit Rate %': cacheHitRate,
              'Is Summary': isSummary,
            },
          }],
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      log(`Token log failed ${res.status}: ${text.slice(0, 200)}`);
    } else {
      log(`Token logged: ${operationLabel}${isSummary ? ' [summary]' : ''} in=${usage.input_tokens} out=${usage.output_tokens} cw=${usage.cache_write_tokens} cr=${usage.cache_read_tokens} cost=GBP${costGbp} cache=${cacheHitRate}%`);
    }
  } catch (err) {
    log(`Token log error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');
  if (!fs.existsSync(indexPath)) { log(`Sessions index not found at ${indexPath}`); return null; }
  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) return entry.summary;
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) { log('No transcript found for archiving'); return {}; }
    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) { log('No messages to archive'); return {}; }
      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();
      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);
      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);
      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage { role: 'user' | 'assistant'; content: string; }

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }
  return lines.join('\n');
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR).filter((f) => f.endsWith('.json')).sort();
    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) messages.push(data.text);
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

interface ActiveSession { containerId: string; started: string; type: string; repos?: string[]; }

function readSessionAwareness(ownContainerId?: string): string {
  const awarenessPath = '/workspace/ipc/active_sessions.json';
  try {
    if (!fs.existsSync(awarenessPath)) return '';
    const raw = fs.readFileSync(awarenessPath, 'utf-8');
    if (!raw.trim()) return '';
    const data = JSON.parse(raw);
    const sessions: ActiveSession[] = data?.sessions;
    if (!Array.isArray(sessions) || sessions.length === 0) return '';
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const cutoff = Date.now() - TWO_HOURS_MS;
    const recent = sessions.filter((s) => new Date(s.started).getTime() > cutoff);
    const others = ownContainerId ? recent.filter((s) => s.containerId !== ownContainerId) : recent;
    if (others.length === 0) return '';
    const lines = others.map((s) => `  <session containerId="${s.containerId}" started="${s.started}" type="${s.type}"${s.repos?.length ? ` repos="${s.repos.join(', ')}"` : ''} />`);
    return `<active-sessions>\n${lines.join('\n')}\n</active-sessions>`;
  } catch (err) {
    log(`Failed to read session awareness: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) { resolve(null); return; }
      const messages = drainIpcInput();
      if (messages.length > 0) { resolve(messages.join('\n')); return; }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; usage: TokenUsage; }> {
  const stream = new MessageStream();
  stream.push(prompt);

  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) { log('Close sentinel detected during query, ending stream'); closedDuringQuery = true; stream.end(); ipcPolling = false; return; }
    const messages = drainIpcInput();
    for (const text of messages) { log(`Piping IPC message into active query (${text.length} chars)`); stream.push(text); }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  const queryUsage: TokenUsage = emptyUsage();

  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) extraDirs.push(fullPath);
    }
  }
  if (extraDirs.length > 0) log(`Additional directories: ${extraDirs.join(', ')}`);

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd } : undefined,
      allowedTools: ['Bash','Read','Write','Edit','Glob','Grep','WebSearch','WebFetch','Task','TaskOutput','TaskStop','TeamCreate','TeamDelete','SendMessage','TodoWrite','ToolSearch','Skill','NotebookEdit','mcp__nanoclaw__*'],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
      },
      model: containerInput.model || undefined,    },
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'assistant') {
      const apiUsage = (message as any).message?.usage;
      if (apiUsage) {
        queryUsage.input_tokens += apiUsage.input_tokens || 0;
        queryUsage.output_tokens += apiUsage.output_tokens || 0;
        queryUsage.cache_write_tokens += apiUsage.cache_creation_input_tokens || 0;
        queryUsage.cache_read_tokens += apiUsage.cache_read_input_tokens || 0;
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string; };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const msgAny = message as any;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      if (msgAny.usage) {
        queryUsage.input_tokens = msgAny.usage.input_tokens || queryUsage.input_tokens;
        queryUsage.output_tokens = msgAny.usage.output_tokens || queryUsage.output_tokens;
        queryUsage.cache_write_tokens = msgAny.usage.cache_creation_input_tokens || queryUsage.cache_write_tokens;
        queryUsage.cache_read_tokens = msgAny.usage.cache_read_input_tokens || queryUsage.cache_read_tokens;
      }
      writeOutput({ status: 'success', result: textResult || null, newSessionId });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, closedDuringQuery: ${closedDuringQuery}`);
  log(`Query usage: in=${queryUsage.input_tokens} out=${queryUsage.output_tokens} cw=${queryUsage.cache_write_tokens} cr=${queryUsage.cache_read_tokens}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, usage: queryUsage };
}

interface ScriptResult { wakeAgent: boolean; data?: unknown; }
const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return new Promise((resolve) => {
    execFile('bash', [scriptPath], { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      if (stderr) log(`Script stderr: ${stderr.slice(0, 500)}`);
      if (error) { log(`Script error: ${error.message}`); return resolve(null); }
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) { log('Script produced no output'); return resolve(null); }
      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') { log(`Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`); return resolve(null); }
        resolve(result as ScriptResult);
      } catch {
        log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
        resolve(null);
      }
    });
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;
  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}` });
    process.exit(1);
  }

  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  _airtableApiKey = containerInput.secrets?.AIRTABLE_API_KEY;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) { log(`Draining ${pending.length} pending IPC messages into initial prompt`); prompt += '\n' + pending.join('\n'); }

  const awarenessContext = readSessionAwareness(containerInput.containerId);
  if (awarenessContext) {
    prompt = `${awarenessContext}\n\n${prompt}`;
    const sessionCount = (awarenessContext.match(/<session /g) || []).length;
    log(`Injected session awareness (${sessionCount} other active session${sessionCount !== 1 ? 's' : ''})`);
  }

  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);
    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult ? 'wakeAgent=false' : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({ status: 'success', result: null });
      return;
    }
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  let sessionTotalUsage: TokenUsage = emptyUsage();
  const operationLabel = inferOperationLabel(containerInput.prompt, containerInput.isScheduledTask ?? false);

  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);
      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) sessionId = queryResult.newSessionId;
      if (queryResult.lastAssistantUuid) resumeAt = queryResult.lastAssistantUuid;

      await logTokenUsage(sessionId || 'unknown', operationLabel, queryResult.usage);
      sessionTotalUsage = addUsage(sessionTotalUsage, queryResult.usage);

      if (queryResult.closedDuringQuery) { log('Close sentinel consumed during query, exiting'); break; }
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });
      log('Query ended, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) { log('Close sentinel received, exiting'); break; }
      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: errorMessage });
    process.exit(1);
  }

  await logTokenUsage(sessionId || 'unknown', 'session_summary', sessionTotalUsage, true);
}

main();
