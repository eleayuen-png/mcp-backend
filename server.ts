import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import Stripe from 'stripe';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const app = express();
app.use(cors());

// ==========================================
// 🚀 1. INITIALIZATION
// ==========================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; 
const GEMINI_MODEL = "gemini-2.0-flash-exp";
const APP_ID = 'mcp-studio-v1';

let db: any = null;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT && getApps().length === 0) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        initializeApp({ credential: cert(serviceAccount) });
        db = getFirestore();
        console.log("🔥 Persistent Vault Active.");
    }
} catch (e) { console.error("❌ Firebase Admin Init Failed"); }

// ==========================================
// 🛡️ DATA HELPERS
// ==========================================
async function getDeployment(serverId: string) {
    if (!db) return null;
    try {
        // Path matches what the frontend saves to
        const doc = await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).get();
        return doc.exists ? doc.data() : null;
    } catch (e) { return null; }
}

// ==========================================
// 📡 2. MIDDLEWARE (The "Pipe" Fix)
// ==========================================

// 🚩 CRITICAL: We only use express.json() for regular API calls.
// We MUST NOT use it for /messages/:serverId because it breaks the MCP stream.
app.use((req, res, next) => {
    if (req.path.startsWith('/messages/')) {
        next(); // Let the raw stream pass through to the MCP SDK
    } else {
        express.json()(req, res, next);
    }
});

// ==========================================
// 📡 3. ROUTES
// ==========================================

app.post('/api/deploy', async (req, res) => {
    const { apiKey, endpoints, baseUrl, piiMasking } = req.body;
    const serverId = uuidv4();
    const config = { apiKey, endpoints, baseUrl, piiMasking, createdAt: new Date().toISOString() };
    
    if (db) {
        await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).set(config);
    }

    const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    res.json({ success: true, sseUrl: `${publicUrl}/sse/${serverId}` });
});

/**
 * SSE HANDSHAKE
 */
const activeTransports = new Map<string, SSEServerTransport>();

app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    const vaultData = await getDeployment(serverId);
    
    if (!vaultData) {
        console.error(`❌ 404: Deployment ${serverId} not found in Firestore.`);
        return res.status(404).send("Server configuration expired or deleted. Please redeploy in MCP Studio.");
    }

    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);

    const mcpServer = new Server({ name: "MCP-Studio-Proxy", version: "1.2.3" }, { capabilities: { tools: {} } });

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: (vaultData.endpoints || []).map((ep: any) => ({
            name: `${ep.method}_${ep.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase(),
            description: ep.description || `Execute ${ep.method} on ${ep.path}`,
            inputSchema: { type: "object", properties: { params: { type: "object" }, body: { type: "object" } } }
        }))
    }));

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name.toLowerCase();
        const args = request.params.arguments as any;
        const endpoint = vaultData.endpoints.find((e: any) => `${e.method}_${e.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase() === toolName);
        
        if (!endpoint) throw new Error(`Tool ${toolName} not found.`);

        const isGet = endpoint.method.toUpperCase() === 'GET';
        const response = await axios({ 
            method: endpoint.method, 
            url: `${vaultData.baseUrl}${endpoint.path}`, 
            params: args?.params, 
            data: isGet ? undefined : (args?.body || {}), 
            headers: { 
                'Authorization': `Bearer ${vaultData.apiKey}`,
                ...(isGet ? {} : { 'Content-Type': 'application/json' })
            } 
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    });

    await mcpServer.connect(transport);
});

// 🚩 FIX: Handle Cursor's "Probe" POST gracefully
app.post('/sse/:serverId', (req, res) => {
    res.status(200).send("OK"); // Respond successfully so Cursor moves to the GET step
});

/**
 * MESSAGE ROUTE
 */
app.post('/messages/:serverId', async (req, res) => {
    const transport = activeTransports.get(req.params.serverId);
    if (!transport) return res.status(404).send("Session expired.");
    
    // We use a helper to manually parse the stream if middleware was skipped
    await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));