import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';

const app = express();
app.use(cors());

// ==========================================
// THE VAULT (Database)
// ==========================================
const deploymentVault = new Map<string, {
    apiKey: string;
    endpoints: any[];
    baseUrl: string;
    macros: any[]; 
}>();

const activeTransports = new Map<string, SSEServerTransport>();

// ==========================================
// ENDPOINT 1: The React Frontend calls this to Deploy
// ==========================================
app.post('/api/deploy', express.json(), (req, res) => {
    const { apiKey, endpoints, baseUrl, macros } = req.body;

    const serverId = uuidv4();

    deploymentVault.set(serverId, {
        apiKey: apiKey,
        endpoints: endpoints || [],
        baseUrl: baseUrl,
        macros: macros || []
    });

    console.log(`[VAULT] New server deployed with ID: ${serverId} including ${macros?.length || 0} macros`);

    res.json({
        success: true,
        serverId: serverId,
        sseUrl: `https://mcp-proxy-backend.onrender.com/sse/${serverId}`, 
    });
});

// ==========================================
// ENDPOINT 2: Claude/Cursor connects here (The SSE Connection)
// ==========================================
app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;

    const vaultData = deploymentVault.get(serverId);
    if (!vaultData) {
        res.status(404).send("Server configuration not found.");
        return;
    }

    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);

    const mcpServer = new Server({
        name: "MCP-Studio-Proxy",
        version: "1.0.0"
    }, {
        capabilities: { tools: {} }
    });

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools: any[] = [];

        // 1. Add individual pruned endpoints
        vaultData.endpoints.forEach(ep => {
            const toolName = `${ep.method}_${ep.path.replace(/[^a-zA-Z0-9]/g, '_')}`;
            tools.push({
                name: toolName,
                description: ep.description || `Execute ${ep.method} on ${ep.path}`,
                inputSchema: { 
                  type: "object", 
                  properties: {} 
                }
            });
        });

        // 2. Add Macros
        vaultData.macros.forEach(macro => {
            tools.push({
                name: macro.name,
                description: macro.description,
                inputSchema: { type: "object", properties: {} }
            });
        });

        return { tools };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name;
        const vaultData = deploymentVault.get(serverId);
        if (!vaultData) throw new Error("Vault data missing");

        // Check for Macro execution
        const macro = vaultData.macros.find(m => m.name === toolName);
        
        if (macro) {
            console.log(`[MACRO] Executing: ${macro.name}`);
            let results = [];
            
            for (const step of macro.steps) {
                try {
                    const response = await axios({
                        method: step.method,
                        url: `${vaultData.baseUrl}${step.path}`,
                        headers: {
                            'Authorization': `Bearer ${vaultData.apiKey}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    results.push({ step: step.path, status: 'Success', data: response.data });
                } catch (err: any) {
                    results.push({ step: step.path, status: 'Failed', error: err.message });
                    break; 
                }
            }
            return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
        }

        // Check for individual Tool execution
        const endpoint = vaultData.endpoints.find(ep => 
            `${ep.method}_${ep.path.replace(/[^a-zA-Z0-9]/g, '_')}` === toolName
        );

        if (endpoint) {
          try {
              const response = await axios({
                  method: endpoint.method,
                  url: `${vaultData.baseUrl}${endpoint.path}`,
                  headers: {
                      'Authorization': `Bearer ${vaultData.apiKey}`,
                      'Content-Type': 'application/json'
                  }
              });
              return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
          } catch (err: any) {
              return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
          }
        }
        
        throw new Error("Tool not found");
    });

    await mcpServer.connect(transport);
});

app.post('/messages/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    const transport = activeTransports.get(serverId);
    if (!transport) return res.status(404).send("Transport not found");
    await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend live on ${PORT}`));