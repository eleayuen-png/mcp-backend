import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
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
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        if (getApps().length === 0) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            initializeApp({ credential: cert(serviceAccount) });
        }
        db = getFirestore();
        console.log("🔥 Firebase Admin Initialized Successfully.");
    } else {
        console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT not found. Data will not persist across restarts.");
    }
} catch (e: any) { 
    console.error("❌ Firebase Admin Init Failed:", e.message); 
}

// ==========================================
// 📡 2. MIDDLEWARE & HELPERS
// ==========================================

// Custom middleware to handle JSON but skip for MCP message streams
app.use((req, res, next) => {
    if (req.path.startsWith('/messages/')) {
        next(); 
    } else {
        express.json()(req, res, next);
    }
});

async function getDeployment(serverId: string) {
    if (!db) return null;
    try {
        const doc = await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).get();
        return doc.exists ? doc.data() : null;
    } catch (e) { return null; }
}

// ==========================================
// 📡 3. PUBLIC API ROUTES
// ==========================================

/**
 * 🪄 MAGIC SUGGEST (RESTORED)
 */
app.post('/api/analyze-schema', async (req, res) => {
    const { endpoints } = req.body;
    
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "Gemini API key not configured on server." });
    if (!endpoints || !Array.isArray(endpoints)) return res.status(400).json({ error: "No endpoints provided." });

    try {
        const schemaSummary = endpoints.map((e: any) => `- ID: ${e.id}\n  Description: ${e.description}`).join('\n');
        const systemPrompt = `Analyze the API list and suggest the top 5-10 most 'agentic' ones. Return ONLY JSON with a "suggestions" key.`;
        const userPrompt = `Suggest tools:\n\n${schemaSummary}`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        const result = await axios.post(url, {
            contents: [{ parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        });
        
        const aiText = result.data.candidates?.[0]?.content?.parts?.[0]?.text;
        res.json(JSON.parse(aiText || '{"suggestions": []}'));
    } catch (error: any) {
        console.error("AI Analysis Error:", error.message);
        res.status(500).json({ error: "Failed to analyze schema." });
    }
});

/**
 * 🚀 DEPLOYMENT (FIXED 500 ERROR)
 */
app.post('/api/deploy', async (req, res) => {
    try {
        const { apiKey, endpoints, baseUrl, piiMasking } = req.body;
        
        if (!baseUrl) return res.status(400).json({ error: "Base URL is required." });

        const serverId = uuidv4();
        const config = { 
            apiKey: apiKey || 'no-key', 
            endpoints: endpoints || [], 
            baseUrl, 
            piiMasking: !!piiMasking, 
            createdAt: new Date().toISOString() 
        };
        
        // Wrap database call in try-catch to prevent 500 crashes
        if (db) {
            try {
                await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).set(config);
            } catch (dbErr: any) {
                console.error("Firestore Save Error:", dbErr.message);
                // We continue even if DB fails, though it won't persist after restart
            }
        }

        const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
        res.json({ success: true, sseUrl: `${publicUrl}/sse/${serverId}` });
    } catch (err: any) {
        console.error("Global Deploy Error:", err.message);
        res.status(500).json({ error: "Internal Server Error during deployment." });
    }
});

// ==========================================
// 📡 4. MCP SSE SERVER LOGIC
// ==========================================
const activeTransports = new Map<string, SSEServerTransport>();

app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    const vaultData = await getDeployment(serverId);
    
    if (!vaultData) return res.status(404).send("Server configuration not found.");

    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);

    const mcpServer = new Server({ name: "MCP-Studio-Proxy", version: "1.2.4" }, { capabilities: { tools: {} } });

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

app.post('/sse/:serverId', (req, res) => res.status(200).send("OK"));

app.post('/messages/:serverId', async (req, res) => {
    const transport = activeTransports.get(req.params.serverId);
    if (!transport) return res.status(404).send("Session expired.");
    await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Proxy Backend Live on port ${PORT}`));