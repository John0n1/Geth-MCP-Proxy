
SPDX-License-Identifier; MIT
// mcpServer.js - copyright (c) 2025 John Hauger Mitander
require('dotenv').config();

const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

// Basic upfront env validation
if (!process.env.GETH_URL) {
  console.warn('[mcpServer] Warning: GETH_URL not set. All tools will fail until it is provided.');
}

// Shared McpServer instance (tools registered once)
const mcpServer = new McpServer({
  name: 'geth-mcp-proxy',
  version: '1.1.0',
  description: 'Proxy for Ethereum JSON-RPC queries via Geth endpoint'
});

// Maintain our own registry of tool names + schemas + handlers (SDK doesn't expose a stable public map)
const registeredToolNames = [];
const registeredToolSchemas = {};
const registeredToolHandlers = {};
function normalizeToolName(name) {
  return String(name || '')
}
function registerTool(name, schema, handler, jsonSchema) {
  const safeName = normalizeToolName(name);
  if (safeName !== name) {
    console.warn(`[mcpServer] Normalizing tool name "${name}" -> "${safeName}" to satisfy [a-z0-9_-]`);
  }
  // Enforce prefix policy: only eth_ admin_ debug_ txpool_ tool names are allowed
  if (!/^(eth|admin|debug|txpool)_/.test(safeName)) {
    console.warn(`[mcpServer] Skipping tool registration for "${safeName}" because it does not start with eth_/admin_/debug_/txpool_.`);
    return;
  }
  registeredToolNames.push(safeName);
  if (jsonSchema) registeredToolSchemas[safeName] = { inputSchema: jsonSchema, description: schema.description };
  registeredToolHandlers[safeName] = { handler, schema };
  mcpServer.registerTool(safeName, schema, handler); // Keep SDK registration for future streaming use
}

// Helper: register a friendly alias that maps to an existing tool handler/schema
function registerAlias(aliasName, targetName, descriptionOverride) {
  const alias = normalizeToolName(aliasName);
  const target = normalizeToolName(targetName);
  if (!registeredToolHandlers[target]) {
    console.warn(`[mcpServer] Cannot create alias "${alias}" -> "${target}" because target is not registered.`);
    return;
  }
  // Aliases may not follow the eth_/admin_/debug_/txpool_ prefix; allow them explicitly
  registeredToolNames.push(alias);
  const targetSchema = registeredToolSchemas[target]?.inputSchema;
  const targetDesc = registeredToolSchemas[target]?.description || registeredToolHandlers[target]?.schema?.description || `Alias of ${target}`;
  if (targetSchema) registeredToolSchemas[alias] = { inputSchema: targetSchema, description: descriptionOverride || `Alias of ${target}: ${targetDesc}` };
  registeredToolHandlers[alias] = registeredToolHandlers[target];
  try {
    mcpServer.registerTool(alias, { description: descriptionOverride || `Alias of ${target}: ${targetDesc}`, inputSchema: registeredToolHandlers[target].schema.inputSchema }, registeredToolHandlers[target].handler);
  } catch (e) {
    // Some SDKs may restrict non-prefixed names; keep our own handler map regardless
    console.warn(`[mcpServer] SDK registerTool failed for alias "${alias}": ${e?.message || e}`);
  }
}

// Helper: perform JSON-RPC to Geth
async function queryGeth(method, params) {
  const { GETH_URL } = process.env;
  if (!GETH_URL) {
    throw new Error('Missing GETH_URL in environment');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  // Normalize URL to avoid accidental double slashes
  let normalized = GETH_URL;
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  const url = normalized;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() }),
    signal: controller.signal
  }).catch(e => {
    if (e.name === 'AbortError') throw new Error('Upstream request timed out');
    throw e;
  });

  clearTimeout(timeout);

  if (!res.ok) {
    throw new Error(`Upstream HTTP ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Geth error: ${data.error.message}`);
  }
  return data.result;
}

function hexToDecimalMaybe(hex) {
  if (typeof hex === 'string' && /^0x[0-9a-fA-F]+$/.test(hex)) {
    try {
      return BigInt(hex).toString();
    } catch {
      return null;
    }
  }
  return null;
}

// Tool: eth_blockNumber (correct JSON-RPC name)
registerTool(
  'eth_blockNumber',
  { description: 'Retrieve the current block number (hex + decimal).', inputSchema: z.object({}) },
  async () => {
    const hex = await queryGeth('eth_blockNumber', []); const dec = hexToDecimalMaybe(hex);
    return { content: [{ type: 'text', text: JSON.stringify({ blockNumberHex: hex, blockNumberDecimal: dec }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);

// Tool: getBalance
registerTool(
  'eth_getBalance',
  { description: 'Get balance of an address (hex + decimal).', inputSchema: z.object({ address: z.string(), block: z.string().optional() }) },
  async ({ address, block = 'latest' }) => {
    const hex = await queryGeth('eth_getBalance', [address, block]); const dec = hexToDecimalMaybe(hex);
    return { content: [{ type: 'text', text: JSON.stringify({ address, balanceHex: hex, balanceWei: dec }) }] };
  },
  { type: 'object', properties: { address: { type: 'string' }, block: { type: 'string' } }, required: ['address'], additionalProperties: false }
);

// Additional Ethereum convenience tools
registerTool(
  'eth_syncing',
  { description: 'Returns syncing status: false (not syncing) or an object with progress fields.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('eth_syncing', []);
    return { content: [{ type: 'text', text: JSON.stringify(result === false ? { syncing: false } : { syncing: true, details: result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
registerTool(
  'eth_chainId',
  { description: 'Get current chain ID (hex + decimal).', inputSchema: z.object({}) },
  async () => {
    const hex = await queryGeth('eth_chainId', []); const dec = hexToDecimalMaybe(hex);
    return { content: [{ type: 'text', text: JSON.stringify({ chainIdHex: hex, chainIdDecimal: dec }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
registerTool(
  'eth_gasPrice',
  { description: 'Get current gas price (hex + wei decimal).', inputSchema: z.object({}) },
  async () => {
    const hex = await queryGeth('eth_gasPrice', []); const dec = hexToDecimalMaybe(hex);
    return { content: [{ type: 'text', text: JSON.stringify({ gasPriceHex: hex, gasPriceWei: dec }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
registerTool(
  'eth_getBlockByNumber',
  { description: 'Fetch block by number/tag.', inputSchema: z.object({ block: z.string(), full: z.boolean().optional() }) },
  async ({ block, full = false }) => {
    const result = await queryGeth('eth_getBlockByNumber', [block, full]);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
  { type: 'object', properties: { block: { type: 'string' }, full: { type: 'boolean' } }, required: ['block'], additionalProperties: false }
);
registerTool(
  'eth_getTransactionByHash',
  { description: 'Fetch a transaction by hash.', inputSchema: z.object({ hash: z.string() }) },
  async ({ hash }) => {
    const result = await queryGeth('eth_getTransactionByHash', [hash]);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
  { type: 'object', properties: { hash: { type: 'string' } }, required: ['hash'], additionalProperties: false }
);

// Admin/debug/txpool canonical tools (Geth-specific)
registerTool(
  'admin_peers',
  { description: 'List currently connected peers (Geth admin).', inputSchema: z.object({}) },
  async () => {
    const peers = await queryGeth('admin_peers', []);
    return { content: [{ type: 'text', text: JSON.stringify(peers) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
registerTool(
  'admin_nodeInfo',
  { description: 'Get local node information (Geth admin).', inputSchema: z.object({}) },
  async () => {
    const info = await queryGeth('admin_nodeInfo', []);
    return { content: [{ type: 'text', text: JSON.stringify(info) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
registerTool(
  'txpool_status',
  { description: 'Get transaction pool status (pending/queued counts).', inputSchema: z.object({}) },
  async () => {
    const status = await queryGeth('txpool_status', []);
    // Typically returns hex counts; include decimal conversions if possible
    const pendingDec = hexToDecimalMaybe(status?.pending);
    const queuedDec = hexToDecimalMaybe(status?.queued);
    return { content: [{ type: 'text', text: JSON.stringify({ ...status, pendingDecimal: pendingDec, queuedDecimal: queuedDec }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
registerTool(
  'debug_metrics',
  { description: 'Get node metrics (Geth debug). May be raw Prometheus text or JSON depending on config.', inputSchema: z.object({ raw: z.boolean().optional() }) },
  async ({ raw = false } = {}) => {
    // Some Geth versions accept a boolean parameter; if not supported, upstream will error.
    const result = await queryGeth('debug_metrics', [raw]);
    // Could be string or object; always stringify for consistent output shape
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  },
  { type: 'object', properties: { raw: { type: 'boolean' } }, additionalProperties: false }
);
registerTool(
  'eth_call',
  { description: 'Execute a call without a transaction.', inputSchema: z.object({ to: z.string(), data: z.string(), block: z.string().optional() }) },
  async ({ to, data, block = 'latest' }) => {
    const result = await queryGeth('eth_call', [{ to, data }, block]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { to: { type: 'string' }, data: { type: 'string' }, block: { type: 'string' } }, required: ['to','data'], additionalProperties: false }
);
registerTool(
  'eth_estimateGas',
  { description: 'Estimate gas for a transaction.', inputSchema: z.object({ to: z.string().optional(), from: z.string().optional(), data: z.string().optional(), value: z.string().optional() }) },
  async (tx) => {
    const result = await queryGeth('eth_estimateGas', [tx]); const dec = hexToDecimalMaybe(result);
    return { content: [{ type: 'text', text: JSON.stringify({ gasHex: result, gasDecimal: dec }) }] };
  },
  { type: 'object', properties: { to: { type: 'string' }, from: { type: 'string' }, data: { type: 'string' }, value: { type: 'string' } }, additionalProperties: false }
);
registerTool(
  'eth_sendRawTransaction',
  { description: 'Broadcast a signed raw transaction (hex). WARNING: ensure the tx is trusted.', inputSchema: z.object({ rawTx: z.string() }) },
  async ({ rawTx }) => {
    if (!process.env.ALLOW_SEND_RAW_TX) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Disabled. Set ALLOW_SEND_RAW_TX=1 to enable.' }) }] };
    }
    const hash = await queryGeth('eth_sendRawTransaction', [rawTx]);
    return { content: [{ type: 'text', text: JSON.stringify({ txHash: hash }) }] };
  },
  { type: 'object', properties: { rawTx: { type: 'string' } }, required: ['rawTx'], additionalProperties: false }
);
registerTool(
  'eth_getTransactionReceipt',
  { description: 'Get transaction receipt by hash.', inputSchema: z.object({ hash: z.string() }) },
  async ({ hash }) => {
    const receipt = await queryGeth('eth_getTransactionReceipt', [hash]);
    return { content: [{ type: 'text', text: JSON.stringify(receipt) }] };
  },
  { type: 'object', properties: { hash: { type: 'string' } }, required: ['hash'], additionalProperties: false }
);
registerTool(
  'eth_getLogs',
  { description: 'Fetch logs by filter (address, topics, block range).', inputSchema: z.object({
    address: z.string().optional(),
    topics: z.array(z.string()).optional(),
    fromBlock: z.string().optional(),
    toBlock: z.string().optional()
  }) },
  async ({ address, topics, fromBlock = 'earliest', toBlock = 'latest' }) => {
    const filter = { address, topics, fromBlock, toBlock };
    const logs = await queryGeth('eth_getLogs', [filter]);
    return { content: [{ type: 'text', text: JSON.stringify(logs) }] };
  },
  { type: 'object', properties: { address: { type: 'string' }, topics: { type: 'array', items: { type: 'string' } }, fromBlock: { type: 'string' }, toBlock: { type: 'string' } }, additionalProperties: false }
);
registerTool(
  'eth_getProof',
  { description: 'Get account proof for a given address and block.', inputSchema: z.object({
    address: z.string(),
    storageKeys: z.array(z.string()).optional(),
    block: z.string().optional()
  }) },
  async ({ address, storageKeys = [], block = 'latest' }) => {
    const proof = await queryGeth('eth_getProof', [address, storageKeys, block]);
    return { content: [{ type: 'text', text: JSON.stringify(proof) }] };
  },
  { type: 'object', properties: { address: { type: 'string' }, storageKeys: { type: 'array', items: { type: 'string' } }, block: { type: 'string' } }, required: ['address'], additionalProperties: false }
);
registerTool(
  'debug_traceTransaction',
  { description: 'Trace a transaction by hash (Geth debug).', inputSchema: z.object({ hash: z.string(), tracer: z.string().optional() }) },
  async ({ hash, tracer = 'callTracer' }) => {
    const trace = await queryGeth('debug_traceTransaction', [hash, { tracer }]);
    return { content: [{ type: 'text', text: JSON.stringify(trace) }] };
  },
  { type: 'object', properties: { hash: { type: 'string' }, tracer: { type: 'string' } }, required: ['hash'], additionalProperties: false }
);
registerTool(
  'debug_blockProfile',
  { description: 'Get block profile (Geth debug).', inputSchema: z.object({ block: z.string() }) },
  async ({ block }) => {
    const profile = await queryGeth('debug_blockProfile', [block]);
    return { content: [{ type: 'text', text: JSON.stringify(profile) }] };
  },
  { type: 'object', properties: { block: { type: 'string' } }, required: ['block'], additionalProperties: false }
);
registerTool(
  'debug_getBlockRlp',
  { description: 'Get RLP encoding of a block by number or hash (Geth debug).', inputSchema: z.object({ block: z.string() }) },
  async ({ block }) => {
    const rlp = await queryGeth('debug_getBlockRlp', [block]);
    return { content: [{ type: 'text', text: JSON.stringify({ rlp }) }] };
  },
  { type: 'object', properties: { block: { type: 'string' } }, required: ['block'], additionalProperties: false }
);

  

// Friendly aliases requested: isSyncing, getBlock, getPeers, etc.
registerAlias('isSyncing', 'eth_syncing', 'Friendly alias for eth_syncing');
registerAlias('getBlock', 'eth_getBlockByNumber', 'Friendly alias for eth_getBlockByNumber');
registerAlias('getPeers', 'admin_peers', 'Friendly alias for admin_peers');
registerAlias('getBlockNumber', 'eth_blockNumber', 'Friendly alias for eth_blockNumber');
registerAlias('getBalance', 'eth_getBalance', 'Friendly alias for eth_getBalance');
registerAlias('getChainId', 'eth_chainId', 'Friendly alias for eth_chainId');
registerAlias('getGasPrice', 'eth_gasPrice', 'Friendly alias for eth_gasPrice');
registerAlias('call', 'eth_call', 'Friendly alias for eth_call');
registerAlias('estimateGas', 'eth_estimateGas', 'Friendly alias for eth_estimateGas');
registerAlias('sendRawTransaction', 'eth_sendRawTransaction', 'Friendly alias for eth_sendRawTransaction');
registerAlias('getTransactionReceipt', 'eth_getTransactionReceipt', 'Friendly alias for eth_getTransactionReceipt');
registerAlias('getLogs', 'eth_getLogs', 'Friendly alias for eth_getLogs');
registerAlias('getProof', 'eth_getProof', 'Friendly alias for eth_getProof');
registerAlias('traceTransaction', 'debug_traceTransaction', 'Friendly alias for debug_traceTransaction');
registerAlias('blockProfile', 'debug_blockProfile', 'Friendly alias for debug_blockProfile');
registerAlias('getBlockRlp', 'debug_getBlockRlp', 'Friendly alias for debug_getBlockRlp');


// Middleware: apply JSON parsing only for non-MCP routes (avoid consuming body stream needed by MCP transport)
app.use((req, res, next) => {
  if (req.path.startsWith('/mcp')) return next();
  return express.json({ verify: (r, _res, buf) => { r.rawBody = buf.toString(); } })(req, res, next);
});

// Health check (supports /mcp and /mcp/ + HEAD)
function healthHandler(_req, res) {
  res.json({ status: 'ok', name: 'geth-mcp-proxy', port, tools: registeredToolNames });
}
app.get(['/mcp','/mcp/'], healthHandler);
app.head(['/mcp','/mcp/'], (req, res) => { res.status(200).end(); });

// MCP endpoint (both /mcp and /mcp/)
async function mcpHandler(req, res) {
  // Force connection close per request to avoid clients reusing stale keep-alive sockets
  try { res.setHeader('Connection', 'close'); } catch (_) { /* noop */ }
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    if (!body) return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Empty request body' }, id: null });
    let payload;
    try { payload = JSON.parse(body); } catch {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    }
    const { id, method, params } = payload;

    // 1. initialize (pure JSON-RPC, stateless)
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'geth-mcp-proxy', version: '1.1.0' },
          capabilities: { tools: registeredToolSchemas, roots: { listChanged: false } }
        }
      });
    }

    // 2. tools/list (MCP convenience)
  if (method === 'tools/list') {
  console.log('[mcpServer] tools/list requested');
      const tools = registeredToolNames.map(name => ({ name, description: registeredToolSchemas[name]?.description, inputSchema: registeredToolSchemas[name]?.inputSchema }));
  console.log('[mcpServer] tools/list responding with', tools.length, 'tools');
      return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }

    // 2b. MCP notifications (ack politely with empty result to avoid transport errors)
    if (typeof method === 'string' && method.startsWith('notifications/')) {
      console.log('[mcpServer] notification received:', method);
      // Some clients send id=null; respond 200 with empty result to satisfy status checks
      return res.json({ jsonrpc: '2.0', id: id ?? null, result: {} });
    }

    // 3. tools/call (direct invoke) - bypass streaming transport for single-call HTTP use
    if (method === 'tools/call') {
      console.log('[mcpServer] tools/call requested', params?.name);
      if (!params || typeof params !== 'object') {
        return res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing params' }, id });
      }
      const { name, arguments: args = {} } = params;
      const safeName = normalizeToolName(name);
      if (!safeName || !registeredToolHandlers[safeName]) {
        console.warn('[mcpServer] Unknown tool requested', name, '->', safeName);
        return res.status(404).json({ jsonrpc: '2.0', error: { code: -32601, message: `Unknown tool: ${name}` }, id });
      }
      try {
        // Zod validation if available
        const zodSchema = registeredToolHandlers[safeName].schema.inputSchema;
        const parsed = zodSchema ? zodSchema.parse(args) : args;
        const toolResult = await registeredToolHandlers[safeName].handler(parsed);
        console.log('[mcpServer] tools/call success', safeName);
        return res.json({ jsonrpc: '2.0', id, result: toolResult });
      } catch (err) {
        const message = err?.message || 'Tool execution error';
        console.error('[mcpServer] tools/call error', safeName, message);
        return res.status(500).json({ jsonrpc: '2.0', id, error: { code: -32000, message } });
      }
    }

  // 4. Default: respond with JSON-RPC method-not-found (HTTP 200)
  console.warn('[mcpServer] Unknown method received, responding with -32601:', method);
  return res.json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Unknown method: ${method}` } });
  });
}
app.post(['/mcp','/mcp/'], mcpHandler);

// Simple REST fallback to fetch latest block (bypasses MCP entirely)
app.get('/blockNumber', async (_req, res) => {
  try {
    const hex = await queryGeth('eth_blockNumber', []);
    res.json({ blockNumberHex: hex, blockNumberDecimal: hexToDecimalMaybe(hex) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down MCP HTTP server...');
  if (server && typeof server.close === 'function') {
    server.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
  setTimeout(() => process.exit(1), 4000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start only when run directly (avoid starting on require in tests/tools)
let server;
if (require.main === module) {
  server = app.listen(port, () => {
    // Relax Node HTTP defaults to support long-lived MCP streaming connections
    try {
      // Disable overall request inactivity timeout (prevents 5-minute drops)
      if (typeof server.requestTimeout !== 'undefined') server.requestTimeout = 0; // No limit
      if (typeof server.setTimeout === 'function') server.setTimeout(0); // Back-compat: no inactivity timeout

      // Keep sockets alive for longer so clients can reuse connections
      if (typeof server.keepAliveTimeout !== 'undefined') server.keepAliveTimeout = 600_000; // 10 minutes
      // headersTimeout must be greater than keepAliveTimeout
      if (typeof server.headersTimeout !== 'undefined') server.headersTimeout = 610_000; // 10m10s

      // Ensure TCP keepalive on connections
      server.on('connection', (socket) => {
        try { socket.setKeepAlive(true, 60_000); } catch (_) { /* noop */ }
      });
    } catch (e) {
      console.warn('[mcpServer] Warning configuring HTTP timeouts:', e?.message || e);
    }

    console.log(`🚀 MCP server listening at http://localhost:${port}/mcp/`);
  });
  // Handle low-level client socket errors cleanly
  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) { /* noop */ }
  });
}