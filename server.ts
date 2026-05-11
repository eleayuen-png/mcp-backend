import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 🛡️ PII MASKING UTILITY
// ==========================================
/**
 * Scans API responses for sensitive patterns and redacts them.
 */
const maskSensitiveData = (data: any): any => {
    if (!data) return data;
    
    // Convert object to string to perform global regex replacement
    let jsonString = JSON.stringify(data);
    
    // Regex for Email
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    
    // Regex for basic international phone format
    const phoneRegex = /(\+\d{1,2}\s?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;

    jsonString = jsonString
        .replace(emailRegex, "[REDACTED_EMAIL]")
        .replace(phoneRegex, "[REDACTED_PHONE]");

    return JSON.parse(jsonString);
};

// ==========================================
// 📂 THE VAULT (In-Memory Database)
// ==========================================
const deploymentVault = new Map<string, {
    apiKey: string;
    endpoints: any[];
    baseUrl: string;
    macros: any[];
    piiMasking: boolean;
}>();

const activeTransports = new Map<string, SSEServerTransport>();

// ==========================================
// ENDPOINT 1: Deploy (Called by React Frontend)
// ==========================================
app.post('/api/deploy', (req, res) => {
    const { apiKey, endpoints, baseUrl, macros, piiMasking } = req.body;
    const serverId = uuidv4();

    deploymentVault.set(serverId, {
        apiKey: apiKey,
        endpoints: endpoints || [],
        baseUrl: baseUrl,
        macros: macros || [],
        piiMasking: !!piiMasking
    });

    console.log(`[VAULT] Deployed ${serverId}. PII Masking: ${!!piiMasking}`);

    // NOTE: In production on Render, update this URL to your actual Render URL
    const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

    res.json({
        success: true,
        serverId: serverId,
        sseUrl: `${publicUrl}/sse/${serverId}`, 
    });
});

// ==========================================
// ENDPOINT 2: SSE Connection (Claude/Cursor connects here)
// ==========================================
app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    const vaultData = deploymentVault.get(serverId);
    
    if (!vaultData) {
        return res.status(404).send("Configuration not found. Please re-deploy from MCP Studio.");
    }

    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);

    const mcpServer = new Server({
        name: "MCP-Studio-Managed-Proxy",
        version: "1.1.0"
    }, { 
        capabilities: { tools: {} } 
    });

    // 1. List Available Tools
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools: any[] = [];
        
        // Add Pruned Endpoints as individual tools
        vaultData.endpoints.forEach(ep => {
            const safeName = `${ep.method}_${ep.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase();
            tools.push({
                name: safeName,
                description: ep.description || `Execute ${ep.method} on ${ep.path}`,
                inputSchema: { 
                    type: "object", 
                    properties: {
                        // For a dynamic proxy, you'd expand this to include path params/query/body
                        params: { type: "object", description: "Query or Path parameters" },
                        body: { type: "object", description: "Request JSON body" }
                    } 
                }
            });
        });

        // Add Macro Tools
        vaultData.macros.forEach(m => {
            tools.push({
                name: m.name.replace(/\s+/g, '_').toLowerCase(),
                description: m.description,
                inputSchema: { type: "object", properties: {} }
            });
        });

        return { tools };
    });

    // 2. Handle Tool Execution
    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name.toLowerCase();
        const args = request.params.arguments as any;
        
        // --- Logic A: Check if it's a Macro ---
        const macro = vaultData.macros.find(m => m.name.toLowerCase() === toolName);
        if (macro) {
            console.log(`[EXEC] Running Macro: ${toolName}`);
            let sequenceResults = [];
            
            for (const step of macro.steps) {
                const response = await axios({
                    method: step.method,
                    url: `${vaultData.baseUrl}${step.path}`,
                    headers: { 'Authorization': `Bearer ${vaultData.apiKey}` }
                });
                
                let stepData = response.data;
                if (vaultData.piiMasking) stepData = maskSensitiveData(stepData);
                
                sequenceResults.push({ step: step.path, data: stepData });
            }
            return { content: [{ type: "text", text: JSON.stringify(sequenceResults, null, 2) }] };
        }

        // --- Logic B: Check if it's an Individual Tool ---
        const endpoint = vaultData.endpoints.find(e => {
            const safeName = `${e.method}_${e.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase();
            return safeName === toolName;
        });

        if (endpoint) {
            console.log(`[EXEC] Running Tool: ${toolName}`);
            try {
                const response = await axios({
                    method: endpoint.method,
                    url: `${vaultData.baseUrl}${endpoint.path}`,
                    params: args?.params,
                    data: args?.body,
                    headers: { 
                        'Authorization': `Bearer ${vaultData.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                });

                let finalData = response.data;
                
                // Apply Privacy Redaction if enabled
                if (vaultData.piiMasking) {
                    finalData = maskSensitiveData(finalData);
                }

                return { content: [{ type: "text", text: JSON.stringify(finalData, null, 2) }] };
            } catch (err: any) {
                return {
                    content: [{ type: "text", text: `API Error: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}` }],
                    isError: true
                };
            }
        }
        
        throw new Error(`Tool ${toolName} not recognized.`);
    });

    await mcpServer.connect(transport);
});

// ==========================================
// ENDPOINT 3: Message Routing (Claude -> Server)
// ==========================================
app.post('/messages/:serverId', async (req, res) => {
    const transport = activeTransports.get(req.params.serverId);
    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(404).send("Transport session expired.");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Proxy Backend Live on port ${PORT}`);
    console.log(`🔒 PII Redaction Engine: Initialized`);
});