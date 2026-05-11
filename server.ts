import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';

const app = express();
app.use(cors({
  origin: [
    'http://localhost:5173', // For local testing
    'https://eleayuen-png.github.io' // Your new GitHub Pages URL
  ],
  credentials: true
}));
app.use(express.json());

// ==========================================
// THE VAULT (Database)
// ==========================================
// For this beginner version, we are storing data in the computer's memory (RAM).
// Later, you can upgrade this to a real database like SQLite or PostgreSQL.
const deploymentVault = new Map<string, {
    apiKey: string;
    endpoints: any[];
    baseUrl: string;
}>();

// We need to keep track of active SSE connections
const activeTransports = new Map<string, SSEServerTransport>();

// ==========================================
// ENDPOINT 1: The React Frontend calls this to Deploy
// ==========================================
app.post('/api/deploy', (req, res) => {
    const { apiKey, endpoints, baseUrl } = req.body;

    // 1. Generate a unique ID for this specific user's MCP Server
    const serverId = uuidv4();

    // 2. Lock the API key and settings in the "Vault"
    deploymentVault.set(serverId, {
        apiKey: apiKey,
        endpoints: endpoints,
        baseUrl: baseUrl
    });

    console.log(`[VAULT] New server deployed with ID: ${serverId}`);

    // 3. Send the unique URLs back to the React frontend
    res.json({
        success: true,
        serverId: serverId,
        sseUrl: `https://mcp-proxy-backend.onrender.com/sse/${serverId}`,
    });
});

// ==========================================
// ENDPOINT 2: Claude/Cursor connects here (The SSE Connection)
// ==========================================
// SSE (Server-Sent Events) is like a radio broadcast. Claude tunes into this URL
// and listens for messages from our server.
app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;

    // Check if this server ID exists in our vault
    const vaultData = deploymentVault.get(serverId);
    if (!vaultData) {
        res.status(404).send("Server configuration not found.");
        return;
    }

    console.log(`[SSE] Claude connected to server: ${serverId}`);

    // Create the MCP Transport (The Radio Antenna)
    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);

    // Create the actual MCP Server instance
    const mcpServer = new Server({
        name: "MCP-as-a-Service-Proxy",
        version: "1.0.0"
    }, {
        capabilities: { tools: {} }
    });

    // --- MCP Tool Setup ---
    // Tell Claude what tools (endpoints) it is allowed to use based on the vault data
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        // Here you would dynamically format the stored `vaultData.endpoints` 
        // into the format MCP expects. For now, we return a mock tool.
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

    // --- MCP Tool Execution (The Proxy) ---
    // When Claude says "Use the tool!", this code runs.
    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name === "proxy_api_request") {
            const args = request.params.arguments as any;
            
            try {
                // THIS IS THE MAGIC! We take the secret key from the vault 
                // and use it to make the real API request. Claude never sees the key!
                const response = await axios({
                    method: args.method,
                    url: `${vaultData.baseUrl}${args.path}`,
                    headers: {
                        'Authorization': `Bearer ${vaultData.apiKey}`, // Injecting the secret!
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

    // Connect the server to the antenna
    await mcpServer.connect(transport);
});

// ==========================================
// ENDPOINT 3: Claude sends messages here
// ==========================================
// Because SSE is a one-way radio (Server -> Claude), Claude needs a separate URL 
// to send messages back to the server (Claude -> Server).
app.post('/messages/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    const transport = activeTransports.get(serverId);

    if (!transport) {
        res.status(404).send("Transport not found");
        return;
    }

    // Pass Claude's message into our MCP Transport system
    await transport.handlePostMessage(req, res);
});

// Start the server!
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 MCP Backend running at http://localhost:${PORT}`);
});

