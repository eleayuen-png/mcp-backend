#!/usr/bin/env node
'use strict';

/**
 * MCP Studio Link
 *
 * Automatically writes your MCP server URL into Claude Desktop and Cursor configs.
 *
 * Usage:
 *   node mcp-link.js <sse-url>
 *
 * Example:
 *   node mcp-link.js https://mcp-backend-q8y7.onrender.com/sse/YOUR-SERVER-ID
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const sseUrl = process.argv[2];

if (!sseUrl || !/^https?:\/\//i.test(sseUrl)) {
  console.error('\n  Usage:   node mcp-link.js <sse-url>');
  console.error('  Example: node mcp-link.js https://mcp-backend-q8y7.onrender.com/sse/YOUR-ID\n');
  process.exit(1);
}

const SERVER_NAME = 'mcp-studio';
const home        = os.homedir();
const isWin       = process.platform === 'win32';
const isMac       = process.platform === 'darwin';
const appData     = isWin ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming')) : '';

// Candidate config file locations for each tool
const targets = [
  {
    label : 'Claude Desktop',
    file  : isWin  ? path.join(appData, 'Claude', 'claude_desktop_config.json')
          : isMac  ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
          :          path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    // Claude Desktop uses a stdio bridge; entry must use command/args
    entry : { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sse', sseUrl] },
  },
  {
    label : 'Cursor',
    file  : path.join(home, '.cursor', 'mcp.json'),
    // Cursor natively supports SSE
    entry : { type: 'sse', url: sseUrl },
  },
];

console.log('\n  \u{1F517}  MCP Studio Link');
console.log('  ' + '─'.repeat(44));
console.log('  Server: ' + sseUrl + '\n');

let linked = 0;

for (const { label, file, entry } of targets) {
  try {
    const dir = path.dirname(file);
    let config = {};

    if (fs.existsSync(file)) {
      try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* corrupted — overwrite */ }
    } else {
      // Create directory tree if the app exists but the config doesn't yet
      fs.mkdirSync(dir, { recursive: true });
    }

    config.mcpServers = config.mcpServers || {};
    config.mcpServers[SERVER_NAME] = entry;

    fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
    console.log('  ✓  ' + label);
    console.log('     ' + file);
    linked++;
  } catch (_err) {
    // App not installed, directory not writable, or json parse failed — skip silently
  }
}

if (linked === 0) {
  console.log('  No Claude Desktop or Cursor config found on this machine.\n');
  console.log('  Add this block manually to your MCP config file:\n');
  const manual = { mcpServers: { [SERVER_NAME]: { type: 'sse', url: sseUrl } } };
  console.log(JSON.stringify(manual, null, 2).split('\n').map(l => '  ' + l).join('\n'));
  console.log('');
} else {
  console.log('\n  ✅  Done! Restart Claude Desktop / Cursor to activate your new tools.\n');
}
