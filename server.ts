import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';

const app = express();
app.use(cors());

// ⚠️ IMPORTANT FIX: Removed the global app.use(express.json()) from here!

// ==========================================
// THE VAULT (Database)
// ==========================================
const deploymentVault = new Map<string, {
    apiKey: string;
    endpoints: any[];
    baseUrl: string;
}>();

const activeTransports = new Map<string, SSEServerTransport>();

// ==========================================
// ENDPOINT 1: The React Frontend calls this to Deploy
// ==========================================
// ⚠️ IMPORTANT FIX: We added express.json() ONLY to this specific route
app.post('/api/deploy', express.json(), (req, res) => {
    const { apiKey, endpoints, baseUrl } = req.body;

    const serverId = uuidv4();

    deploymentVault.set(serverId, {
        apiKey: apiKey,
        endpoints: endpoints,
        baseUrl: baseUrl
    });

    console.log(`[VAULT] New server deployed with ID: ${serverId}`);

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

    console.log(`[SSE] AI connected to server: ${serverId}`);

    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);

    const mcpServer = new Server({
        name: "MCP-as-a-Service-Proxy",
        version: "1.0.0"
    }, {
        capabilities: { tools: {} }
    });

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [{
                name: "proxy_api_request",
                description: "Makes a secure request to the user's API",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: { type: "string" },
                        method: { type: "string" }
                    },
                    required: ["path", "method"]
                }
            }]
        };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name === "proxy_api_request") {
            const args = request.params.arguments as any;
            
            try {
                const response = await axios({
                    method: args.method,
                    url: `${vaultData.baseUrl}${args.path}`,
                    headers: {
                        'Authorization': `Bearer ${vaultData.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                });

                return {
                    content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }]
                };
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `Error from API: ${error.message}` }],
                    isError: true
                };
            }
        }
        throw new Error("Tool not found");
    });

    await mcpServer.connect(transport);
});

// ==========================================
// ENDPOINT 3: Claude sends messages here
// ==========================================
app.post('/messages/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    const transport = activeTransports.get(serverId);

    if (!transport) {
        res.status(404).send("Transport not found");
        return;
    }

    // Because we removed the global express.json(), this stream is now 
    // fresh and readable for the MCP SDK to process!
    await transport.handlePostMessage(req, res);
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 MCP Backend running on port ${PORT}`);
});